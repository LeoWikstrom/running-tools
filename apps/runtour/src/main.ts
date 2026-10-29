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
import {
  deleteArea,
  findCoveringArea,
  listAreas,
  saveArea,
  saveAreaBuildings,
  saveAreaPlaces,
} from '@running/core/net/areaStore';
import type { BuildingPoly } from '@running/core/geo/los';
import { fetchAreaBuildings } from '@running/core/poi/buildings';
import { fetchNetwork } from '@running/core/net/overpass';
import { fetchCandidates, searchPlacesByName } from './places';
import {
  fetchAreaCandidates,
  generateCourse,
  generationCircle,
  refineCourse,
  regenerateCourse,
  type GenerationContext,
} from './generate';
import {
  startGpsPreview,
  startSimulatedPreview,
  type PreviewHandle,
  type PreviewPlace,
} from './preview';
import { native, saveTourToPhone } from './native';
import { translatorAvailable } from './translate';
import { initRunMode } from './run';
import { initShelf } from './shelf';
import { fetchPlaceText, placeDisplayName, type PlaceText } from './texts';
import { closeDialog, openDialog } from './ui/dialog';
import { APP_NAME, PLACE_COLOR, THEME_COLOR, VARIANT, VARIANT_DEFAULTS } from './variant';
import { initBusLines } from './bus';
import { initLocate } from './locate';
import { fitVisible, panToVisible } from './ui/visibleMap';
import { initSheet } from './ui/sheet';
import { toast } from './ui/toast';

const narrationLang = (): string =>
  (document.getElementById('narration-lang') as HTMLSelectElement).value;

const nativeOnly = (): boolean =>
  (document.getElementById('native-only') as HTMLInputElement).checked;

const hasNarrationPage = (c: { wikipedia?: { lang: string }; wikipedias?: { lang: string }[] }): boolean =>
  [c.wikipedia, ...(c.wikipedias ?? [])].some((w) => w?.lang === narrationLang());

document.body.classList.add(`variant-${VARIANT}`);
document.title = APP_NAME;
document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR);
document.querySelector('#controls h1')!.textContent = APP_NAME;

const sheet = document.getElementById('sheet')!;
const handle = document.getElementById('sheet-handle')!;
initSheet(sheet, handle);

const map = L.map('map', { zoomControl: true }).setView([57.7089, 11.9746], 13);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const locate = initLocate(map, sheet, el<HTMLButtonElement>('locate-btn'));
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
const exportTourBtn = el<HTMLButtonElement>('export-tour');
const exportGpxBtn = el<HTMLButtonElement>('export-gpx');
const toggleRow = el<HTMLLabelElement>('toggle-row');
const toggleMarkers = el<HTMLInputElement>('toggle-markers');
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
/** Stable across saves of the same tour, so re-saving updates in place. */
let tourId: string | null = null;
let courseLine: L.Polyline | null = null;
let candidates: PlaceCandidate[] = [];
/** Footprints along the course; empty means line of sight is not filtered. */
let buildings: BuildingPoly[] = [];
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
  const pipelineIds = new Set(places.map((p) => p.id));
  return [...places, ...manual.filter((m) => !pipelineIds.has(m.id))]
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
  stopPreview();
  course = { name, points, lats, lons, distance };
  tourId = null;
  candidates = [];
  buildings = [];
  manual = [];
  places = [];
  removedIds.clear();
  texts.clear();
  openEditors.clear();
  courseLine?.remove();
  courseLine = L.polyline(
    lats.map((lat, i) => [lat, lons[i]!] as [number, number]),
    { color: PLACE_COLOR, weight: 4 },
  ).addTo(map);
  fitVisible(map, sheet, courseLine.getBounds());
  stats.textContent = `${name} — ${(distance / 1000).toFixed(1)} km, ${points.length} points`;
  stats.hidden = false;
  hint.hidden = true;
  placesRow.hidden = false;
  genContext = null;
  setStatus('');
  reflectGenButtons();
}

/** Swap the course's geometry in place, keeping places, texts and removals. */
function updateCourseGeometry(pts: [number, number][]): void {
  if (!course) return;
  const points: GpxPoint[] = pts.map(([lat, lon]) => ({ lat, lon, ele: null }));
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  let distance = 0;
  for (let i = 1; i < points.length; i++) {
    distance += haversineMeters(lats[i - 1]!, lons[i - 1]!, lats[i]!, lons[i]!);
  }
  course = { ...course, points, lats, lons, distance };
  courseLine?.remove();
  courseLine = L.polyline(
    lats.map((lat, i) => [lat, lons[i]!] as [number, number]),
    { color: PLACE_COLOR, weight: 4 },
  ).addTo(map);
  stats.textContent = `${course.name} — ${(distance / 1000).toFixed(1)} km, ${points.length} points`;
}

/** A removed place may have been the sole reason for a detour; re-improve the
    generated course without it so the detour can straighten. */
function refineGeneratedCourse(removed: Place): void {
  if (!genContext || refining) return;
  genContext.places = genContext.places.filter(
    (p) =>
      p.id !== removed.wikidataId &&
      haversineMeters(p.lat, p.lon, removed.lat, removed.lon) > 80,
  );
  refining = true;
  setStatus('Updating the course around the removed place…');
  toast('Updating course…');
  void (async () => {
    try {
      const sameEdges = (edges: number[]): boolean =>
        edges.length === genContext!.edges.length &&
        edges.every((e, i) => e === genContext!.edges[i]);
      let result = await refineCourse(genContext!, () => {});
      let verb = 'updated';
      if (sameEdges(result.edges)) {
        // No local fix exists: a dropped detour leaves the length short, which
        // one window swap cannot repair. A fresh search rebalances the loop.
        setStatus('No local fix — searching for a fresh course without it…');
        result = await regenerateCourse(genContext!, (text, fraction) =>
          setGenStatus(`${text} ${(fraction * 100).toFixed(0)} %`),
        );
        setGenStatus('');
        verb = 'rerouted';
        if (sameEdges(result.edges)) {
          setStatus('Place removed; it did not shape the course.');
          toast('Place removed; it did not shape the course.');
          return;
        }
      }
      genContext!.edges = result.edges;
      updateCourseGeometry(result.points);
      recompute();
      setStatus(`Course ${verb} — now ${(result.lengthM / 1000).toFixed(2)} km.`);
      toast(`Course ${verb} — now ${(result.lengthM / 1000).toFixed(2)} km.`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      refining = false;
    }
  })();
}

/** Pipeline places wear the accent, hand-pinned ones orange, must-pass vias teal. */
const MANUAL_COLOR = '#b4762d';
const VIA_COLOR = VARIANT === 'bus' ? '#1f8a8a' : '#2d6fb4';

function markerFor(p: Place, kind: 'place' | 'manual' | 'via'): L.CircleMarker {
  const marker = L.circleMarker([p.lat, p.lon], {
    radius: 5 + (p.score / 100) * 5,
    color: kind === 'via' ? VIA_COLOR : kind === 'manual' ? MANUAL_COLOR : PLACE_COLOR,
    fillOpacity: 0.6,
    weight: 2,
  });
  marker.bindTooltip(`${placeDisplayName(p, narrationLang())} (${p.score})`);
  // The wikipedia link goes to the narration language's page when there is one.
  const narrationWiki = [p.wikipedia, ...(p.wikipedias ?? [])].find(
    (w) => w?.lang === narrationLang(),
  );
  const links = p.sources
    .map((s) => {
      const url =
        s.kind === 'wikipedia' && narrationWiki
          ? `https://${narrationWiki.lang}.wikipedia.org/wiki/` +
            encodeURIComponent(narrationWiki.title.replaceAll(' ', '_'))
          : s.url;
      return `<a href="${url}" target="_blank" rel="noopener">${s.kind}</a>`;
    })
    .join(' · ');
  const box = document.createElement('div');
  box.innerHTML =
    `<strong>${placeDisplayName(p, narrationLang())}</strong><br>` +
    `score ${p.score} · at ${(p.d / 1000).toFixed(2)} km<br>${links}<br>`;
  const remove = document.createElement('button');
  remove.textContent = 'Remove';
  remove.addEventListener('click', () => {
    removedIds.add(p.id);
    recompute();
    refineGeneratedCourse(p);
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
      const got = await fetchPlaceText(p, narrationLang(), targetSeconds()).catch(() => null);
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

const placeMarkers = new Map<string, L.CircleMarker>();

/** Swell a marker for a moment — the eye finds it among the dots. */
let highlighted: { marker: L.CircleMarker; radius: number } | null = null;
let highlightTimer: number | undefined;
function highlightMarker(id: string): void {
  const marker = placeMarkers.get(id);
  if (!marker) return;
  if (highlighted) {
    highlighted.marker.setRadius(highlighted.radius);
    highlighted.marker.setStyle({ weight: 2, fillOpacity: 0.6 });
  }
  clearTimeout(highlightTimer);
  const radius = marker.getRadius();
  highlighted = { marker, radius };
  marker.setRadius(radius + 5);
  marker.setStyle({ weight: 6, fillOpacity: 1 });
  marker.bringToFront();
  highlightTimer = window.setTimeout(() => {
    marker.setRadius(radius);
    marker.setStyle({ weight: 2, fillOpacity: 0.6 });
    highlighted = null;
  }, 1800);
}

function render(): void {
  markerLayer.clearLayers();
  placeMarkers.clear();
  const manualIds = new Set(manual.map((m) => m.id));
  const viaIds = new Set(vias.map(viaId));
  const list = allPlaces();
  for (const p of list) {
    const kind = viaIds.has(p.id) ? 'via' : manualIds.has(p.id) ? 'manual' : 'place';
    const marker = markerFor(p, kind).addTo(markerLayer);
    marker.on('click', () => highlightMarker(p.id));
    placeMarkers.set(p.id, marker);
  }

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
    summary.textContent = `${(p.d / 1000).toFixed(2)} km — ${placeDisplayName(p, narrationLang())} `;
    const badge = document.createElement('small');
    const side = p.side === 'left' ? ' · ◀ left' : p.side === 'right' ? ' · right ▶' : '';
    badge.textContent = `(${p.score}) · ${textBadge(p)}${side}`;
    summary.appendChild(badge);
    const body = document.createElement('div');
    renderEditor(p, body);
    const remove = document.createElement('button');
    remove.textContent = 'Remove place';
    remove.className = 'remove-place';
    remove.addEventListener('click', () => {
      removedIds.add(p.id);
      recompute();
      refineGeneratedCourse(p);
    });
    body.appendChild(remove);
    details.append(summary, body);
    li.appendChild(details);
    summary.addEventListener('click', () => {
      // At click time the toggle has not happened: open means it is closing.
      if (details.open) return;
      panToVisible(map, sheet, p.lat, p.lon);
      highlightMarker(p.id);
    });
    placeList.appendChild(li);
  }
  const any = list.length > 0;
  toggleRow.hidden = !any && candidates.length === 0;
  textControls.hidden = !any;
  previewControls.hidden = !any;
  el<HTMLDivElement>('list-lang-row').hidden = !any;
}

function recompute(): void {
  if (!course) return;
  if (candidates.length > 0) {
    const pool = nativeOnly() ? candidates.filter(hasNarrationPage) : candidates;
    places = buildPlaces(
      course.lats,
      course.lons,
      pool,
      { leadDistance: VARIANT_DEFAULTS.leadDistance, minSpacing: VARIANT_DEFAULTS.minSpacing },
      removedIds,
      buildings,
    );
  } else {
    places = places.filter((p) => !removedIds.has(p.id));
  }
  render();
  if (allPlaces().length > 0) setStatus(`${allPlaces().length} places along the course.`);
}

/** Swap every fetched text to the new narration language in one go; places
    without a Wikipedia page keep their hand-written text. */
let relanging = false;
async function relangTexts(): Promise<void> {
  const list = allPlaces().filter((p) => (texts.get(p.id)?.text.length ?? 0) > 0);
  if (list.length === 0 || relanging) return;
  relanging = true;
  const lang = narrationLang();
  let done = 0;
  for (const p of list) {
    const got = await fetchPlaceText(p, lang, targetSeconds()).catch(() => null);
    if (got) texts.set(p.id, got);
    done++;
    setStatus(`Switching texts to ${lang} ${done}/${list.length}…`);
  }
  relanging = false;
  render();
  setStatus(`Texts switched to ${lang}.`);
  toast(`Texts switched to ${lang}.`);
}

// The narration select exists twice (panel top and above the place list);
// changing either updates both and swaps the texts.
const narrationSelects = ['narration-lang', 'narration-lang-list'].map((id) =>
  el<HTMLSelectElement>(id),
);
for (const select of narrationSelects) {
  select.addEventListener('change', () => {
    for (const other of narrationSelects) other.value = select.value;
    if (nativeOnly()) recompute();
    else render();
    void relangTexts();
  });
}

const nativeOnlyBox = el<HTMLInputElement>('native-only');
const nativeOnlyInfo = el<HTMLButtonElement>('native-only-info');
nativeOnlyInfo.hidden = !translatorAvailable;
nativeOnlyInfo.addEventListener('click', (e) => {
  e.preventDefault();
  toast(
    'Ticked, only places whose Wikipedia exists in the narration language are included — no machine translations are used.',
    6000,
  );
});
nativeOnlyBox.addEventListener('change', () => {
  if (candidates.length > 0) recompute();
});

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

/** Restore a tour into the editor: course, places, texts, settings. */
function applyTour(tour: Tour): void {
  const points: GpxPoint[] = tour.route.points.map((p) => ({
    lat: p[0]!,
    lon: p[1]!,
    ele: p[2] ?? null,
  }));
  setCourse(tour.name, points);
  tourId = tour.id;
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
}

tourInput.addEventListener('change', () => {
  const file = tourInput.files?.[0];
  if (!file) return;
  void (async () => {
    try {
      applyTour(validateTour(JSON.parse(await file.text())));
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  })();
});

async function runFindPlaces(): Promise<boolean> {
  if (!course) return false;
  findButton.disabled = true;
  try {
    const report = await fetchCandidates(
      course.lats,
      course.lons,
      langInput.value.trim().toLowerCase(),
      setStatus,
    );
    candidates = report.candidates;
    buildings = report.buildings;
    recompute();
    if (report.failures.length > 0) {
      setStatus(
        `${allPlaces().length} places along the course (${report.failures.join(', ')} failed).`,
      );
    }
    return true;
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err));
    return false;
  } finally {
    findButton.disabled = false;
  }
}

findButton.addEventListener('click', () =>
  void (async () => {
    if (await runFindPlaces()) await runFetchTexts();
  })(),
);

async function runFetchTexts(): Promise<void> {
  const list = allPlaces().filter((p) => (texts.get(p.id)?.text.length ?? 0) === 0);
  if (list.length === 0) {
    setStatus('Every place already has a text; use Refetch inside a place to redo one.');
    return;
  }
  let done = 0;
  let missing = 0;
  for (const p of list) {
    const got = await fetchPlaceText(p, narrationLang(), targetSeconds()).catch(() => null);
    if (got) texts.set(p.id, got);
    else missing++;
    done++;
    setStatus(`Fetching texts ${done}/${list.length}…`);
  }
  render();
  const summary =
    missing === 0
      ? `Texts fetched for all ${done} places.`
      : `Texts fetched; ${missing} of ${done} places have no Wikipedia page and need a hand-written text.`;
  setStatus(summary);
  toast(summary);
}

function buildTour(): Tour {
  const c = course!;
  tourId ??= crypto.randomUUID();
  return {
    version: 1,
    id: tourId,
    name: c.name,
    lang: narrationLang(),
    createdAt: new Date().toISOString(),
    route: {
      points: c.points.map((p) => (p.ele === null ? [p.lat, p.lon] : [p.lat, p.lon, p.ele])),
      distance: c.distance,
    },
    settings: {
      ...DEFAULT_TOUR_SETTINGS,
      ...VARIANT_DEFAULTS,
      targetSeconds: targetSeconds(),
    },
    places: allPlaces().map((p) => {
      const t = texts.get(p.id);
      return {
        id: p.id,
        name: placeDisplayName(p, narrationLang()),
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

// --- Must-pass places: picked before generating, the course routes past them.

let vias: PlaceCandidate[] = [];
const viaMarkers = new Map<string, L.CircleMarker>();

const viaId = (c: PlaceCandidate): string => c.wikidataId ?? `name:${c.name.toLowerCase()}`;

function addVia(c: PlaceCandidate): void {
  const id = viaId(c);
  if (viaMarkers.has(id)) return;
  const marker = L.circleMarker([c.lat, c.lon], {
    radius: 7,
    color: VIA_COLOR,
    fillOpacity: 0.9,
  }).addTo(map);
  marker.bindTooltip(`${c.name} — must-pass`);
  const box = document.createElement('div');
  box.innerHTML = `<strong>${c.name}</strong><br>must-pass place<br>`;
  const remove = document.createElement('button');
  remove.textContent = 'Remove';
  remove.addEventListener('click', () => {
    vias = vias.filter((v) => viaId(v) !== id);
    marker.remove();
    viaMarkers.delete(id);
  });
  box.appendChild(remove);
  marker.bindPopup(box);
  viaMarkers.set(id, marker);
  vias.push(c);
  searchResults.hidden = true;
  searchResults.innerHTML = '';
  nameSearch.value = '';
  setSearchStatus('');
  setStatus(`${c.name} added — the generated course will pass it.`);
  toast(`${c.name} will be on the course.`);
}

function addManualPlace(c: PlaceCandidate): void {
  if (!course) {
    if (VARIANT === 'bus') {
      // No generator consumes vias in the bus build; places need a route first.
      setSearchStatus('Pick a bus line first, then add places along it.');
      return;
    }
    addVia(c);
    return;
  }
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
    triggerD: Math.max(0, pass.along - VARIANT_DEFAULTS.leadDistance),
    offset: pass.offset,
  });
  searchResults.hidden = true;
  searchResults.innerHTML = '';
  nameSearch.value = '';
  setSearchStatus('');
  recompute();
  void (async () => {
    const added = allPlaces().find((p) => p.id === id);
    if (!added || (texts.get(id)?.text.length ?? 0) > 0) return;
    setStatus(`Fetching the text for ${added.name}…`);
    const got = await fetchPlaceText(added, narrationLang(), targetSeconds()).catch(() => null);
    if (got) texts.set(id, got);
    else setStatus(`No Wikipedia text found for ${added.name} — write one in the list.`);
    render();
  })();
}

const searchStatus = el<HTMLParagraphElement>('search-status');

function setSearchStatus(text: string): void {
  searchStatus.textContent = text;
  searchStatus.hidden = text.length === 0;
}

searchBtn.addEventListener('click', () => {
  const text = nameSearch.value.trim();
  if (!text) return;
  searchBtn.disabled = true;
  setSearchStatus('Searching…');
  toast('Searching…');
  void (async () => {
    try {
      const found = await searchPlacesByName(text, langInput.value.trim().toLowerCase());
      searchResults.innerHTML = '';
      searchResults.hidden = found.length === 0;
      setSearchStatus(
        found.length === 0
          ? `Nothing with coordinates found for “${text}”.`
          : `${found.length} found — pick one:`,
      );
      for (const c of found) {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.textContent = `${c.name} (${c.wikipedia?.lang ?? '?'})`;
        btn.addEventListener('click', () => addManualPlace(c));
        li.appendChild(btn);
        searchResults.appendChild(li);
      }
    } catch (err) {
      setSearchStatus(err instanceof Error ? err.message : String(err));
    } finally {
      searchBtn.disabled = false;
    }
  })();
});

nameSearch.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') searchBtn.click();
});

// --- Preview: a simulated runner (or real GPS) drives the trigger runtime.

const previewControls = el<HTMLDivElement>('preview-controls');
const paceInput = el<HTMLInputElement>('pace-input');
const defaultPace = (): string => {
  const s = VARIANT_DEFAULTS.paceSecPerKm;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
paceInput.value = defaultPace();
const previewFast = el<HTMLInputElement>('preview-fast');
previewFast.addEventListener('change', () => {
  preview?.setSpeed?.(previewFast.checked ? 10 : 1);
});
const previewGps = el<HTMLInputElement>('preview-gps');
const previewBtn = el<HTMLButtonElement>('preview-btn');
const previewPause = el<HTMLButtonElement>('preview-pause');
let previewPaused = false;
previewPause.addEventListener('click', () => {
  if (!preview) return;
  previewPaused = !previewPaused;
  preview.setPaused(previewPaused);
  previewPause.textContent = previewPaused ? 'Resume' : 'Pause';
});
const previewNote = el<HTMLParagraphElement>('preview-note');
const PREVIEW_LABEL = VARIANT === 'bus' ? 'Preview ride' : 'Preview run';
previewBtn.textContent = PREVIEW_LABEL;

let preview: PreviewHandle | null = null;
let runnerMarker: L.CircleMarker | null = null;

function parsePace(value: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return VARIANT_DEFAULTS.paceSecPerKm;
  return Number(m[1]) * 60 + Number(m[2]);
}

function previewPlaces(): PreviewPlace[] {
  return allPlaces().map((p) => ({
    id: p.id,
    name: p.name,
    triggerD: p.triggerD,
    text: texts.get(p.id)?.text ?? '',
  }));
}

function stopPreview(): void {
  preview?.stop();
  preview = null;
  runnerMarker?.remove();
  runnerMarker = null;
  previewBtn.textContent = PREVIEW_LABEL;
  previewNote.hidden = true;
  previewPause.hidden = true;
  previewPaused = false;
  previewPause.textContent = 'Pause';
}

previewBtn.addEventListener('click', () => {
  if (preview) {
    stopPreview();
    setStatus('Preview stopped.');
    return;
  }
  if (!course) return;
  const callbacks = {
    onPosition(lat: number, lon: number, d: number, offCourse: boolean) {
      if (!runnerMarker) {
        runnerMarker = L.circleMarker([lat, lon], {
          radius: 8,
          color: offCourse ? '#c0392b' : '#1d5c8f',
          fillOpacity: 0.9,
        }).addTo(map);
      } else {
        runnerMarker.setLatLng([lat, lon]);
        runnerMarker.setStyle({ color: offCourse ? '#c0392b' : '#1d5c8f' });
      }
      setStatus(`Preview at ${(d / 1000).toFixed(2)} km${offCourse ? ' — off course' : ''}`);
    },
    onSpeak(place: PreviewPlace) {
      setStatus(`▶ ${place.name}`);
      const at = runnerMarker?.getLatLng();
      if (at) panToVisible(map, sheet, at.lat, at.lng);
    },
    onInfo(text: string) {
      setStatus(text);
    },
    onDone() {
      stopPreview();
      setStatus('Preview finished.');
    },
  };
  preview = previewGps.checked
    ? startGpsPreview(course.lats, course.lons, previewPlaces(), narrationLang(), callbacks)
    : startSimulatedPreview(
        course.lats,
        course.lons,
        previewPlaces(),
        narrationLang(),
        parsePace(paceInput.value),
        previewFast.checked ? 10 : 1,
        callbacks,
      );
  previewBtn.textContent = 'Stop preview';
  previewNote.hidden = !previewGps.checked;
  previewPause.hidden = false;
});

// --- Course generation: start point + length + sliders → a loop over places.

const setStartBtn = el<HTMLButtonElement>('set-start');
const setFinishBtn = el<HTMLButtonElement>('set-finish');
const genLength = el<HTMLInputElement>('gen-length');
const genPlaces = el<HTMLInputElement>('gen-places');
const genPedestrian = el<HTMLInputElement>('gen-pedestrian');
const genCentre = el<HTMLInputElement>('gen-centre');
const genTwists = el<HTMLInputElement>('gen-twists');
const genRun = el<HTMLButtonElement>('gen-run');
const genStatus = el<HTMLParagraphElement>('gen-status');

let genStart: { lat: number; lon: number } | null = null;
let genEnd: { lat: number; lon: number } | null = null;
let genStartMarker: L.Marker | null = null;
let genEndMarker: L.Marker | null = null;
let setting: 'start' | 'finish' | null = null;
let generation: ReturnType<typeof generateCourse> | null = null;
/** Kept after a generation so a removed place can re-shape the course. */
let genContext: GenerationContext | null = null;
let refining = false;

function setGenStatus(text: string): void {
  genStatus.textContent = text;
  genStatus.hidden = text.length === 0;
}

const genPin = (kind: 'start' | 'finish'): L.DivIcon =>
  L.divIcon({ className: `gen-pin ${kind}`, iconSize: [18, 18], iconAnchor: [9, 9] });

function reflectGenButtons(): void {
  setStartBtn.textContent = setting === 'start' ? 'Tap the map…' : 'Set start';
  setFinishBtn.textContent =
    setting === 'finish' ? 'Tap the map…' : genEnd ? 'Remove finish' : 'Set finish';
  genRun.textContent = generation ? 'Cancel' : course ? 'Clear' : 'Generate';
  genRun.disabled = false;
  areaDownload.disabled = genStart === null;
}

/** Back to the bare map: course, places and texts go; downloads and vias stay. */
function clearCourse(): void {
  stopPreview();
  course = null;
  genContext = null;
  tourId = null;
  candidates = [];
  buildings = [];
  manual = [];
  places = [];
  removedIds.clear();
  texts.clear();
  openEditors.clear();
  courseLine?.remove();
  courseLine = null;
  stats.hidden = true;
  hint.hidden = false;
  placesRow.hidden = true;
  render();
  setStatus('');
  setGenStatus('');
  reflectGenButtons();
}

setStartBtn.addEventListener('click', () => {
  setting = setting === 'start' ? null : 'start';
  reflectGenButtons();
});

setFinishBtn.addEventListener('click', () => {
  if (setting !== 'finish' && genEnd) {
    // The button removes a placed finish; drag the marker to merely move it.
    removeFinish();
  } else {
    setting = setting === 'finish' ? null : 'finish';
    reflectGenButtons();
  }
});

function placeStart(latlng: L.LatLng): void {
  genStart = { lat: latlng.lat, lon: latlng.lng };
  if (!genStartMarker) {
    genStartMarker = L.marker(latlng, { draggable: true, icon: genPin('start') }).addTo(map);
    genStartMarker.on('dragend', () => {
      const at = genStartMarker!.getLatLng();
      genStart = { lat: at.lat, lon: at.lng };
    });
  } else {
    genStartMarker.setLatLng(latlng);
  }
  setGenStatus('Start set. Generate when ready.');
  reflectGenButtons();
}

function placeFinish(latlng: L.LatLng): void {
  genEnd = { lat: latlng.lat, lon: latlng.lng };
  if (!genEndMarker) {
    genEndMarker = L.marker(latlng, { draggable: true, icon: genPin('finish') }).addTo(map);
    genEndMarker.on('dragend', () => {
      const at = genEndMarker!.getLatLng();
      genEnd = { lat: at.lat, lon: at.lng };
    });
  } else {
    genEndMarker.setLatLng(latlng);
  }
  setGenStatus('Finish set — the course runs point to point.');
  reflectGenButtons();
}

function removeFinish(): void {
  genEnd = null;
  genEndMarker?.remove();
  genEndMarker = null;
  setGenStatus('Finish removed — the course is a loop again.');
  reflectGenButtons();
}

map.on('click', (e: L.LeafletMouseEvent) => {
  if (!setting) return;
  if (setting === 'start') placeStart(e.latlng);
  else placeFinish(e.latlng);
  setting = null;
  reflectGenButtons();
});

// Long press on a phone, right click with a mouse. Start/finish pins belong
// to the generator, which the bus build replaces with the line picker.
if (VARIANT === 'run') map.on('contextmenu', (e: L.LeafletMouseEvent) => {
  const box = document.createElement('div');
  box.className = 'map-menu';
  const startBtn = document.createElement('button');
  startBtn.textContent = genStart ? 'Move start here' : 'Start here';
  startBtn.addEventListener('click', () => {
    placeStart(e.latlng);
    map.closePopup();
  });
  const finishBtn = document.createElement('button');
  finishBtn.textContent = genEnd ? 'Move finish here' : 'Finish here';
  finishBtn.addEventListener('click', () => {
    placeFinish(e.latlng);
    map.closePopup();
  });
  box.append(startBtn, finishBtn);
  if (genEnd) {
    const rm = document.createElement('button');
    rm.textContent = 'Remove finish';
    rm.addEventListener('click', () => {
      removeFinish();
      map.closePopup();
    });
    box.append(rm);
  }
  L.popup({ closeButton: false }).setLatLng(e.latlng).setContent(box).openOn(map);
});

/** Dismissing the download prompt silences it for this start point only. */
let areaPromptDismissedFor: string | null = null;

genRun.addEventListener('click', () => {
  if (generation) {
    generation.cancel();
    return;
  }
  if (course) {
    clearCourse();
    toast('Course cleared.');
    return;
  }
  if (!genStart) {
    toast('First put a start on the map — long-press where you want to begin.');
    return;
  }
  void (async () => {
    // Like profile-course: Generate over a start no saved area covers offers
    // the download first, since public Overpass servers are unreliable.
    const { center, radiusM } = generationCircle(
      genStart!,
      genEnd,
      Number(genLength.value) * 1000,
    );
    const key = `${genStart!.lat.toFixed(4)},${genStart!.lon.toFixed(4)}`;
    const covered = await findCoveringArea(center, radiusM + 300).catch(() => null);
    if (
      covered ||
      localStorage.getItem('runtour.skipAreaPrompt') ||
      areaPromptDismissedFor === key
    ) {
      startGeneration();
      return;
    }
    openAreaPrompt(center, radiusM + 300, key);
  })();
});

function openAreaPrompt(
  center: { lat: number; lon: number },
  neededRadiusM: number,
  startKey: string,
): void {
  let handled = false;
  const box = document.createElement('div');
  const neededKm = Math.max(Math.ceil((neededRadiusM / 1000) * 2) / 2, Number(areaRadius.value));
  const text = document.createElement('p');
  text.className = 'hint';
  text.textContent =
    'No downloaded path network covers this course. The public Overpass servers are slow and ' +
    'sometimes down; downloading the area once makes generating here fast, reliable and offline. ' +
    'Closing this searches without downloading.';
  const row = document.createElement('div');
  row.className = 'row';
  const radiusLabel = document.createElement('label');
  radiusLabel.className = 'control len-control';
  radiusLabel.innerHTML = '<span>Area km</span>';
  const radiusInput = document.createElement('input');
  radiusInput.type = 'number';
  radiusInput.min = '1';
  radiusInput.max = '10';
  radiusInput.step = '0.5';
  radiusInput.value = String(Math.min(neededKm, 10));
  radiusInput.addEventListener('change', () => (areaRadius.value = radiusInput.value));
  radiusLabel.appendChild(radiusInput);
  const downloadBtn = document.createElement('button');
  downloadBtn.textContent = 'Download';
  downloadBtn.addEventListener('click', () => {
    downloadBtn.disabled = true;
    downloadBtn.textContent = 'Downloading…';
    void downloadArea(center, Number(radiusInput.value) * 1000, (t) => {
      text.textContent = t;
      setAreaStatus(t);
    })
      .then(() => {
        handled = true;
        closeDialog();
        startGeneration();
      })
      .catch((err: unknown) => {
        text.textContent = err instanceof Error ? err.message : String(err);
        downloadBtn.disabled = false;
        downloadBtn.textContent = 'Download';
      });
  });
  const never = document.createElement('button');
  never.textContent = "Don't show again";
  never.addEventListener('click', () => {
    localStorage.setItem('runtour.skipAreaPrompt', '1');
    handled = true;
    closeDialog();
    startGeneration();
  });
  row.append(radiusLabel, downloadBtn, never);
  box.append(text, row);
  openDialog('Download the path network?', box, () => {
    if (handled) return;
    // ✕, Esc or the backdrop: generation goes ahead, and this start point
    // stops asking.
    areaPromptDismissedFor = startKey;
    startGeneration();
  });
}

function startGeneration(): void {
  if (!genStart) return;
  generation = generateCourse(
    {
      start: genStart,
      end: genEnd,
      targetLengthM: Number(genLength.value) * 1000,
      localLang: langInput.value.trim().toLowerCase(),
      placesSlider: Number(genPlaces.value),
      pedestrianSlider: Number(genPedestrian.value),
      centreSlider: Number(genCentre.value),
      twistSlider: Number(genTwists.value),
      requireLang: nativeOnly() ? narrationLang() : null,
      vias: vias.map((v) => ({
        id: viaId(v),
        name: v.name,
        lat: v.lat,
        lon: v.lon,
        score: Math.max(interestScore(v), 30),
      })),
    },
    (text, fraction) => setGenStatus(`${text} ${(fraction * 100).toFixed(0)} %`),
  );
  generation.promise
    .then(async (generated) => {
      // The whole pipeline runs by itself: course → places → texts.
      const points: GpxPoint[] = generated.points.map(([lat, lon]) => ({ lat, lon, ele: null }));
      setCourse('Generated course', points);
      genContext = generated.context ?? null;
      // The must-pass places are on the course now; pin them so they stay in
      // the tour even if the corridor pipeline scores them out.
      for (const v of vias) addManualPlace(v);
      render();
      setGenStatus(
        `${(generated.lengthM / 1000).toFixed(2)} km touching ${generated.collected.length} places.`,
      );
      if (await runFindPlaces()) await runFetchTexts();
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (message !== 'cancelled') {
        setGenStatus(message);
        toast(message);
      }
      else setGenStatus('');
    })
    .finally(() => {
      generation = null;
      reflectGenButtons();
    });
  reflectGenButtons();
}

// --- Offline path network: download the area around the start once; getNetwork
// serves generation from a saved area without touching Overpass.

const areaRadius = el<HTMLInputElement>('area-radius');
const areaDownload = el<HTMLButtonElement>('area-download');
const areaStatus = el<HTMLParagraphElement>('area-status');
const areaList = el<HTMLUListElement>('area-list');

function setAreaStatus(text: string): void {
  areaStatus.textContent = text;
  areaStatus.hidden = text.length === 0;
}

async function renderAreas(): Promise<void> {
  const areas = await listAreas();
  areaList.hidden = areas.length === 0;
  areaList.replaceChildren(
    ...areas.map((a) => {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.textContent =
        `${(a.radiusMeters / 1000).toFixed(1)} km around ${a.lat.toFixed(3)}, ` +
        `${a.lon.toFixed(3)} — ${a.ways} ways`;
      const del = document.createElement('button');
      del.textContent = '✕';
      del.setAttribute('aria-label', 'Delete this area');
      del.addEventListener('click', () => {
        void deleteArea(a.id).then(() => renderAreas());
      });
      li.append(span, del);
      return li;
    }),
  );
}

/** Fetch and store the network and places of one circle, reporting as it goes. */
async function downloadArea(
  center: { lat: number; lon: number },
  radiusM: number,
  onStatus: (text: string) => void,
): Promise<void> {
  onStatus('Downloading the path network… this can take a while.');
  const response = await fetchNetwork(center, radiusM, { headerTimeoutMs: 120_000 });
  const area = await saveArea(center, radiusM, response);
  onStatus('Network saved. Fetching the places in the area…');
  try {
    const found = await fetchAreaCandidates(center, radiusM, langInput.value.trim().toLowerCase());
    await saveAreaPlaces(area.id, found);
    onStatus(`Area saved with ${found.length} places — courses here now generate offline.`);
    toast(`Area saved with ${found.length} places.`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onStatus(`Network saved, but the places fetch failed (${message}) — download again.`);
  }
  try {
    onStatus('Fetching the buildings for line of sight…');
    const footprints = await fetchAreaBuildings(center, radiusM, { headerTimeoutMs: 120_000 });
    await saveAreaBuildings(area.id, footprints);
    onStatus(`Area saved: buildings too (${footprints.length}).`);
  } catch {
    // Without footprints the area still works; line of sight just stays off.
    onStatus('Area saved; the buildings fetch failed, so line of sight is off here.');
  }
  await renderAreas();
}

areaDownload.addEventListener('click', () => {
  if (!genStart) return;
  areaDownload.disabled = true;
  void downloadArea({ ...genStart }, Number(areaRadius.value) * 1000, setAreaStatus)
    .catch((err: unknown) => setAreaStatus(err instanceof Error ? err.message : String(err)))
    .finally(() => reflectGenButtons());
});

void renderAreas();

if (VARIANT === 'bus') {
  initBusLines({
    map,
    sheet,
    onRoute: (name, points) => {
      setCourse(name, points);
      render();
      void (async () => {
        if (await runFindPlaces()) await runFetchTexts();
      })();
    },
    onClear: () => {
      clearCourse();
      toast('Route cleared.');
    },
  });
}

const runMode = initRunMode({
  map,
  sheet,
  controls: document.getElementById('controls')!,
  locate,
  onExit: () => shelf.refresh(),
});
const shelf = initShelf(el<HTMLDivElement>('shelf'), applyTour, setStatus, () => runMode.enter());
runMode.maybeResume();
const savePhoneBtn = el<HTMLButtonElement>('save-phone');
if (native) {
  savePhoneBtn.hidden = false;
  savePhoneBtn.addEventListener('click', () => {
    if (!course) return;
    try {
      const id = saveTourToPhone(JSON.stringify(buildTour()));
      setStatus(`Tour saved on the phone (${id}) — generating its audio…`);
      toast('Tour saved — generating audio…');
      shelf.refresh();
      shelf.generate(id);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  });
}
