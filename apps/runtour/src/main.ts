import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { parseGpx, type GpxPoint } from '@running/core/gpx/parse';
import { haversineMeters } from '@running/core/geo';
import { buildPlaces, firstPassProjection } from '@running/core/poi/pipeline';
import { interestScore } from '@running/core/poi/score';
import type { Place, PlaceCandidate } from '@running/core/poi/types';
import { countWords, WORDS_PER_SECOND } from '@running/core/text/trim';
import {
  DEFAULT_TOUR_SETTINGS,
  tourToGpx,
  validateTour,
  type Tour,
} from '@running/core/tour/types';
import { fetchCandidates, searchPlacesByName } from './places';
import { fetchPlaceText, type PlaceText } from './texts';
import { initSheet } from './ui/sheet';

const NARRATION_LANG = 'en';

const sheet = document.getElementById('sheet')!;
const handle = document.getElementById('sheet-handle')!;
initSheet(sheet, handle);

const map = L.map('map', { zoomControl: true }).setView([57.7089, 11.9746], 13);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const gpxInput = el<HTMLInputElement>('gpx-input');
const tourInput = el<HTMLInputElement>('tour-input');
const stats = el<HTMLParagraphElement>('course-stats');
const hint = el<HTMLParagraphElement>('hint');
const placesRow = el<HTMLDivElement>('places-row');
const langInput = el<HTMLInputElement>('lang-input');
const findButton = el<HTMLButtonElement>('find-places');
const status = el<HTMLParagraphElement>('status');
const textControls = el<HTMLDivElement>('text-controls');
const targetSlider = el<HTMLInputElement>('target-seconds');
const targetOutput = el<HTMLOutputElement>('target-output');
const fetchTextsBtn = el<HTMLButtonElement>('fetch-texts');
const exportTourBtn = el<HTMLButtonElement>('export-tour');
const exportGpxBtn = el<HTMLButtonElement>('export-gpx');
const toggleRow = el<HTMLLabelElement>('toggle-row');
const toggleMarkers = el<HTMLInputElement>('toggle-markers');
const searchRow = el<HTMLDivElement>('search-row');
const nameSearch = el<HTMLInputElement>('name-search');
const searchBtn = el<HTMLButtonElement>('search-btn');
const searchResults = el<HTMLUListElement>('search-results');
const placeList = el<HTMLOListElement>('place-list');

interface Course {
  name: string;
  points: GpxPoint[];
  lats: number[];
  lons: number[];
  distance: number;
}

let course: Course | null = null;
let courseLine: L.Polyline | null = null;
let candidates: PlaceCandidate[] = [];
/** Places added by hand; they bypass the corridor and the thinning. */
let manual: Place[] = [];
let places: Place[] = [];
const removedIds = new Set<string>();
const texts = new Map<string, PlaceText>();
const markerLayer = L.layerGroup().addTo(map);
/** Which place editors are open, so render() keeps them open. */
const openEditors = new Set<string>();

/** A manually added place is pinned to the course with a very wide corridor. */
const MANUAL_CORRIDOR_M = 1000;

function setStatus(text: string): void {
  status.textContent = text;
  status.hidden = text.length === 0;
}

function allPlaces(): Place[] {
  return [...places, ...manual]
    .filter((p) => !removedIds.has(p.id))
    .sort((a, b) => a.d - b.d);
}

function targetSeconds(): number {
  return Number(targetSlider.value);
}

function setCourse(name: string, points: GpxPoint[]): void {
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  let distance = 0;
  for (let i = 1; i < points.length; i++) {
    distance += haversineMeters(lats[i - 1]!, lons[i - 1]!, lats[i]!, lons[i]!);
  }
  course = { name, points, lats, lons, distance };
  candidates = [];
  manual = [];
  places = [];
  removedIds.clear();
  texts.clear();
  openEditors.clear();
  courseLine?.remove();
  courseLine = L.polyline(
    lats.map((lat, i) => [lat, lons[i]!] as [number, number]),
    { color: '#2d7a4f', weight: 4 },
  ).addTo(map);
  map.fitBounds(courseLine.getBounds(), { padding: [24, 24] });
  stats.textContent = `${name} — ${(distance / 1000).toFixed(1)} km, ${points.length} points`;
  stats.hidden = false;
  hint.hidden = true;
  placesRow.hidden = false;
  setStatus('');
}

function markerFor(p: Place, isManual: boolean): L.CircleMarker {
  const marker = L.circleMarker([p.lat, p.lon], {
    radius: 5 + (p.score / 100) * 5,
    color: isManual ? '#b4762d' : '#2d7a4f',
    fillOpacity: 0.6,
    weight: 2,
  });
  marker.bindTooltip(`${p.name} (${p.score})`);
  const links = p.sources
    .map((s) => `<a href="${s.url}" target="_blank" rel="noopener">${s.kind}</a>`)
    .join(' · ');
  const box = document.createElement('div');
  box.innerHTML =
    `<strong>${p.name}</strong><br>` +
    `score ${p.score} · at ${(p.d / 1000).toFixed(2)} km<br>${links}<br>`;
  const remove = document.createElement('button');
  remove.textContent = 'Remove';
  remove.addEventListener('click', () => {
    removedIds.add(p.id);
    recompute();
  });
  box.appendChild(remove);
  marker.bindPopup(box);
  return marker;
}

function textBadge(p: Place): string {
  const t = texts.get(p.id);
  if (!t || t.text.length === 0) return '✎ no text';
  if (t.needsReview && !t.reviewed) return `⚠ review (${t.sourceLang ?? '?'})`;
  if (t.reviewed) return '✓ reviewed';
  return `${Math.round(countWords(t.text) / WORDS_PER_SECOND)} s`;
}

function renderEditor(p: Place, body: HTMLElement): void {
  body.innerHTML = '';
  const entry = texts.get(p.id) ?? { text: '', needsReview: false, reviewed: false };
  const area = document.createElement('textarea');
  area.rows = 5;
  area.value = entry.text;
  const counts = document.createElement('p');
  counts.className = 'hint';
  const updateCounts = (): void => {
    const w = countWords(area.value);
    counts.textContent = `${w} words ≈ ${Math.round(w / WORDS_PER_SECOND)} s spoken`;
  };
  updateCounts();
  area.addEventListener('input', () => {
    texts.set(p.id, { ...entry, text: area.value, reviewed: false });
    updateCounts();
  });

  const row = document.createElement('div');
  row.className = 'row';
  const refetch = document.createElement('button');
  refetch.textContent = 'Refetch';
  refetch.addEventListener('click', () => {
    refetch.disabled = true;
    void (async () => {
      const got = await fetchPlaceText(p, NARRATION_LANG, targetSeconds()).catch(() => null);
      if (got) texts.set(p.id, got);
      else setStatus(`No Wikipedia text found for ${p.name}.`);
      refetch.disabled = false;
      render();
    })();
  });
  const reviewed = document.createElement('button');
  reviewed.textContent = entry.reviewed ? 'Reviewed ✓' : 'Mark reviewed';
  reviewed.addEventListener('click', () => {
    texts.set(p.id, { ...entry, text: area.value, reviewed: !entry.reviewed });
    render();
  });
  const clear = document.createElement('button');
  clear.textContent = 'Clear text';
  clear.addEventListener('click', () => {
    texts.delete(p.id);
    render();
  });
  row.append(refetch, reviewed, clear);

  const src = document.createElement('p');
  src.className = 'hint';
  if (entry.sourceUrl) {
    src.innerHTML = `Source: <a href="${entry.sourceUrl}" target="_blank" rel="noopener">Wikipedia</a> (CC BY-SA)`;
  }
  body.append(area, counts, row, src);
}

function render(): void {
  markerLayer.clearLayers();
  const manualIds = new Set(manual.map((m) => m.id));
  const list = allPlaces();
  for (const p of list) markerFor(p, manualIds.has(p.id)).addTo(markerLayer);

  placeList.innerHTML = '';
  for (const p of list) {
    const li = document.createElement('li');
    const details = document.createElement('details');
    details.open = openEditors.has(p.id);
    details.addEventListener('toggle', () => {
      if (details.open) openEditors.add(p.id);
      else openEditors.delete(p.id);
    });
    const summary = document.createElement('summary');
    summary.textContent = `${(p.d / 1000).toFixed(2)} km — ${p.name} `;
    const badge = document.createElement('small');
    badge.textContent = `(${p.score}) · ${textBadge(p)}`;
    summary.appendChild(badge);
    const body = document.createElement('div');
    renderEditor(p, body);
    const remove = document.createElement('button');
    remove.textContent = 'Remove place';
    remove.className = 'remove-place';
    remove.addEventListener('click', () => {
      removedIds.add(p.id);
      recompute();
    });
    body.appendChild(remove);
    details.append(summary, body);
    li.appendChild(details);
    summary.addEventListener('click', () => map.panTo([p.lat, p.lon]));
    placeList.appendChild(li);
  }
  const any = list.length > 0;
  toggleRow.hidden = !any && candidates.length === 0;
  textControls.hidden = !any;
  searchRow.hidden = course === null;
}

function recompute(): void {
  if (!course) return;
  if (candidates.length > 0) {
    places = buildPlaces(course.lats, course.lons, candidates, {}, removedIds);
  } else {
    places = places.filter((p) => !removedIds.has(p.id));
  }
  render();
  if (allPlaces().length > 0) setStatus(`${allPlaces().length} places along the course.`);
}

toggleMarkers.addEventListener('change', () => {
  if (toggleMarkers.checked) markerLayer.addTo(map);
  else markerLayer.remove();
});

targetSlider.addEventListener('input', () => {
  targetOutput.textContent = targetSlider.value;
});

gpxInput.addEventListener('change', () => {
  const file = gpxInput.files?.[0];
  if (!file) return;
  void (async () => {
    try {
      const gpx = parseGpx(await file.text());
      if (gpx.points.length < 2) throw new Error('No track points found in the file.');
      setCourse(gpx.name ?? file.name, gpx.points);
      render();
    } catch (err) {
      stats.textContent = err instanceof Error ? err.message : String(err);
      stats.hidden = false;
    }
  })();
});

tourInput.addEventListener('change', () => {
  const file = tourInput.files?.[0];
  if (!file) return;
  void (async () => {
    try {
      const tour = validateTour(JSON.parse(await file.text()));
      const points: GpxPoint[] = tour.route.points.map((p) => ({
        lat: p[0]!,
        lon: p[1]!,
        ele: p[2] ?? null,
      }));
      setCourse(tour.name, points);
      targetSlider.value = String(tour.settings.targetSeconds);
      targetOutput.textContent = targetSlider.value;
      places = tour.places.map((p) => ({
        ...p,
        types: [],
        offset: 0,
        sources: p.sources,
      }));
      for (const p of tour.places) {
        if (p.text) {
          texts.set(p.id, {
            text: p.text,
            sourceUrl: p.sources.find((s) => s.kind === 'wikipedia')?.url,
            needsReview: p.needsReview ?? false,
            reviewed: !(p.needsReview ?? false),
          });
        }
      }
      render();
      setStatus(`Tour “${tour.name}” loaded: ${tour.places.length} places.`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  })();
});

findButton.addEventListener('click', () => {
  if (!course) return;
  findButton.disabled = true;
  void (async () => {
    try {
      const report = await fetchCandidates(
        course!.lats,
        course!.lons,
        langInput.value.trim().toLowerCase(),
        setStatus,
      );
      candidates = report.candidates;
      recompute();
      if (report.failures.length > 0) {
        setStatus(
          `${allPlaces().length} places along the course (${report.failures.join(', ')} failed).`,
        );
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      findButton.disabled = false;
    }
  })();
});

fetchTextsBtn.addEventListener('click', () => {
  const list = allPlaces().filter((p) => (texts.get(p.id)?.text.length ?? 0) === 0);
  if (list.length === 0) {
    setStatus('Every place already has a text; use Refetch inside a place to redo one.');
    return;
  }
  fetchTextsBtn.disabled = true;
  void (async () => {
    let done = 0;
    let missing = 0;
    for (const p of list) {
      const got = await fetchPlaceText(p, NARRATION_LANG, targetSeconds()).catch(() => null);
      if (got) texts.set(p.id, got);
      else missing++;
      done++;
      setStatus(`Fetching texts ${done}/${list.length}…`);
    }
    fetchTextsBtn.disabled = false;
    render();
    setStatus(
      missing === 0
        ? `Texts fetched for all ${done} places.`
        : `Texts fetched; ${missing} of ${done} places have no Wikipedia page and need a hand-written text.`,
    );
  })();
});

function buildTour(): Tour {
  const c = course!;
  return {
    version: 1,
    id: crypto.randomUUID(),
    name: c.name,
    lang: NARRATION_LANG,
    createdAt: new Date().toISOString(),
    route: {
      points: c.points.map((p) => (p.ele === null ? [p.lat, p.lon] : [p.lat, p.lon, p.ele])),
      distance: c.distance,
    },
    settings: { ...DEFAULT_TOUR_SETTINGS, targetSeconds: targetSeconds() },
    places: allPlaces().map((p) => {
      const t = texts.get(p.id);
      return {
        id: p.id,
        name: p.name,
        lat: p.lat,
        lon: p.lon,
        d: p.d,
        triggerD: p.triggerD,
        score: p.score,
        sources: p.sources,
        text: t?.text ?? '',
        needsReview: t ? t.needsReview && !t.reviewed : true,
      };
    }),
  };
}

function download(name: string, type: string, content: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function slug(): string {
  return (course?.name ?? 'tour').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

exportTourBtn.addEventListener('click', () => {
  if (!course) return;
  download(`${slug()}.tour.json`, 'application/json', JSON.stringify(buildTour(), null, 2));
});

exportGpxBtn.addEventListener('click', () => {
  if (!course) return;
  download(`${slug()}.gpx`, 'application/gpx+xml', tourToGpx(buildTour()));
});

function addManualPlace(c: PlaceCandidate): void {
  if (!course) return;
  const pass = firstPassProjection(course.lats, course.lons, c.lat, c.lon, MANUAL_CORRIDOR_M);
  if (!pass) {
    setStatus(`${c.name} is more than ${MANUAL_CORRIDOR_M} m from the course.`);
    return;
  }
  const id = c.wikidataId ?? `manual:${c.name.toLowerCase()}`;
  removedIds.delete(id);
  manual = manual.filter((m) => m.id !== id);
  manual.push({
    ...c,
    id,
    score: Math.max(interestScore(c), 1),
    d: pass.along,
    triggerD: Math.max(0, pass.along - 30),
    offset: pass.offset,
  });
  searchResults.hidden = true;
  searchResults.innerHTML = '';
  nameSearch.value = '';
  recompute();
}

searchBtn.addEventListener('click', () => {
  const text = nameSearch.value.trim();
  if (!text || !course) return;
  searchBtn.disabled = true;
  void (async () => {
    try {
      const found = await searchPlacesByName(text, langInput.value.trim().toLowerCase());
      searchResults.innerHTML = '';
      searchResults.hidden = found.length === 0;
      if (found.length === 0) setStatus(`Nothing with coordinates found for “${text}”.`);
      for (const c of found) {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.textContent = `${c.name} (${c.wikipedia?.lang ?? '?'})`;
        btn.addEventListener('click', () => addManualPlace(c));
        li.appendChild(btn);
        searchResults.appendChild(li);
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      searchBtn.disabled = false;
    }
  })();
});

nameSearch.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') searchBtn.click();
});
