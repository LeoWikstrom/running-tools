import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { parseGpx } from '@running/core/gpx/parse';
import { haversineMeters } from '@running/core/geo';
import { buildPlaces, firstPassProjection } from '@running/core/poi/pipeline';
import { interestScore } from '@running/core/poi/score';
import type { Place, PlaceCandidate } from '@running/core/poi/types';
import { fetchCandidates, searchPlacesByName } from './places';
import { initSheet } from './ui/sheet';

const sheet = document.getElementById('sheet')!;
const handle = document.getElementById('sheet-handle')!;
initSheet(sheet, handle);

const map = L.map('map', { zoomControl: true }).setView([57.7089, 11.9746], 13);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

const gpxInput = document.getElementById('gpx-input') as HTMLInputElement;
const stats = document.getElementById('course-stats') as HTMLParagraphElement;
const hint = document.getElementById('hint') as HTMLParagraphElement;
const placesRow = document.getElementById('places-row') as HTMLDivElement;
const langInput = document.getElementById('lang-input') as HTMLInputElement;
const findButton = document.getElementById('find-places') as HTMLButtonElement;
const status = document.getElementById('status') as HTMLParagraphElement;
const toggleRow = document.getElementById('toggle-row') as HTMLLabelElement;
const toggleMarkers = document.getElementById('toggle-markers') as HTMLInputElement;
const searchRow = document.getElementById('search-row') as HTMLDivElement;
const nameSearch = document.getElementById('name-search') as HTMLInputElement;
const searchBtn = document.getElementById('search-btn') as HTMLButtonElement;
const searchResults = document.getElementById('search-results') as HTMLUListElement;
const placeList = document.getElementById('place-list') as HTMLOListElement;

interface Course {
  name: string;
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
const markerLayer = L.layerGroup().addTo(map);

/** A manually added place is pinned to the course with a very wide corridor. */
const MANUAL_CORRIDOR_M = 1000;

function setStatus(text: string): void {
  status.textContent = text;
  status.hidden = text.length === 0;
}

function allPlaces(): Place[] {
  return [...places, ...manual.filter((m) => !removedIds.has(m.id))].sort((a, b) => a.d - b.d);
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
  const el = document.createElement('div');
  el.innerHTML =
    `<strong>${p.name}</strong><br>` +
    `score ${p.score} · at ${(p.d / 1000).toFixed(2)} km, ${Math.round(p.offset)} m off<br>` +
    `${links}<br>`;
  const remove = document.createElement('button');
  remove.textContent = 'Remove';
  remove.addEventListener('click', () => {
    removedIds.add(p.id);
    recompute();
  });
  el.appendChild(remove);
  marker.bindPopup(el);
  return marker;
}

function render(): void {
  markerLayer.clearLayers();
  const manualIds = new Set(manual.map((m) => m.id));
  for (const p of allPlaces()) markerFor(p, manualIds.has(p.id)).addTo(markerLayer);

  placeList.innerHTML = '';
  for (const p of allPlaces()) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = `${(p.d / 1000).toFixed(2)} km — ${p.name} `;
    const score = document.createElement('small');
    score.textContent = `(${p.score})`;
    const remove = document.createElement('button');
    remove.textContent = '✕';
    remove.title = 'Remove this place';
    remove.className = 'remove-place';
    remove.addEventListener('click', () => {
      removedIds.add(p.id);
      recompute();
    });
    li.append(label, score, remove);
    li.addEventListener('click', (e) => {
      if (e.target === remove) return;
      map.panTo([p.lat, p.lon]);
    });
    placeList.appendChild(li);
  }
  const n = allPlaces().length;
  toggleRow.hidden = n === 0 && candidates.length === 0;
  searchRow.hidden = course === null;
}

function recompute(): void {
  if (!course) return;
  places = buildPlaces(course.lats, course.lons, candidates, {}, removedIds);
  render();
  if (candidates.length > 0) {
    setStatus(`${allPlaces().length} places along the course.`);
  }
}

toggleMarkers.addEventListener('change', () => {
  if (toggleMarkers.checked) markerLayer.addTo(map);
  else markerLayer.remove();
});

gpxInput.addEventListener('change', () => {
  const file = gpxInput.files?.[0];
  if (!file) return;
  void (async () => {
    try {
      const gpx = parseGpx(await file.text());
      if (gpx.points.length < 2) throw new Error('No track points found in the file.');
      const lats = gpx.points.map((p) => p.lat);
      const lons = gpx.points.map((p) => p.lon);
      let distance = 0;
      for (let i = 1; i < gpx.points.length; i++) {
        distance += haversineMeters(lats[i - 1]!, lons[i - 1]!, lats[i]!, lons[i]!);
      }
      course = { name: gpx.name ?? file.name, lats, lons, distance };
      candidates = [];
      manual = [];
      places = [];
      removedIds.clear();
      courseLine?.remove();
      courseLine = L.polyline(
        lats.map((lat, i) => [lat, lons[i]!] as [number, number]),
        { color: '#2d7a4f', weight: 4 },
      ).addTo(map);
      map.fitBounds(courseLine.getBounds(), { padding: [24, 24] });
      stats.textContent = `${course.name} — ${(distance / 1000).toFixed(1)} km, ${lats.length} points`;
      stats.hidden = false;
      hint.hidden = true;
      placesRow.hidden = false;
      setStatus('');
      render();
    } catch (err) {
      stats.textContent = err instanceof Error ? err.message : String(err);
      stats.hidden = false;
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
