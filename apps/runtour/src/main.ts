import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { parseGpx, type GpxPoint } from '@running/core/gpx/parse';
import { haversineMeters } from '@running/core/geo';
import { findPointSpurs } from '@running/core/geo/spurs';
import { searchLangs } from '@running/core/poi/langs';
import { buildPlaces, firstPassProjection } from '@running/core/poi/pipeline';
import { interestScore } from '@running/core/poi/score';
import type { Place, PlaceCandidate } from '@running/core/poi/types';
import { countWords, WORDS_PER_SECOND } from '@running/core/text/trim';
import {
  DEFAULT_TOUR_SETTINGS,
  tourToGpx,
  validateTour,
  type Tour,
  type TourPlaceImage,
} from '@running/core/tour/types';
import { fetchHistoricalImage } from './images';
import {
  deleteArea,
  findCoveringArea,
  listAreas,
  saveArea,
  saveAreaBuildings,
  saveAreaPlaces,
} from '@running/core/net/areaStore';
import { buildBuildingIndex, type BuildingIndex, type BuildingPoly } from '@running/core/geo/los';
import { fetchAreaBuildings, fetchBuildings } from '@running/core/poi/buildings';
import { fetchNetworkParallel } from '@running/core/net/overpass';
import { fetchNetworkTiles } from '@running/core/net/networkTiles';
import { BUILDINGS_CORRIDOR_M, fetchCandidates, searchPlacesByName } from './places';
import {
  fetchAreaCandidates,
  generateCourse,
  generationCircle,
  refineCourse,
  regenerateCourse,
  type GenerationContext,
} from './generate';
import { startSimulatedPreview, type PreviewHandle, type PreviewPlace } from './preview';
import {
  downloadDoneNotice,
  downloadNotice,
  listTours,
  native,
  saveTourToPhone,
  getTourJson,
} from './native';
import { loadSession, saveSession } from './session';
import { translatorAvailable } from './translate';
import { initRunMode } from './run';
import { initShelf } from './shelf';
import { fetchPlaceText, placeDisplayName, type PlaceText } from './texts';
import { closeDialog, openDialog } from './ui/dialog';
import { APP_NAME, PLACE_COLOR, THEME_COLOR, VARIANT, VARIANT_DEFAULTS } from './variant';
import { initBusLines, type BusLinesHandle } from './bus';
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

/** Editions for place fetches: narration first, English and the local wiki after. */
const fetchLangs = (nativeOnlySearch = false): string[] =>
  searchLangs(narrationLang(), langInput.value.trim().toLowerCase(), nativeOnlySearch);

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
const markersBtn = el<HTMLButtonElement>('markers-btn');
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
/** Historical photos by place id; they travel in tour.json. */
const images = new Map<string, TourPlaceImage>();
let busUi: BusLinesHandle | null = null;
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

/** By the place you want ~this much of its clip already told — you see a
    place coming up, not shrinking behind you. */
const CLIP_HEAD_FRACTION = 0.5;
/** Sightline checks for the trigger walk the course at this step, metres. */
const TRIGGER_SIGHT_STEP_M = 20;

let losIndex: BuildingIndex | null = null;
let courseCum: Float64Array | null = null;

function courseDistances(): Float64Array {
  if (courseCum) return courseCum;
  const c = course!;
  courseCum = new Float64Array(c.lats.length);
  for (let i = 1; i < c.lats.length; i++) {
    courseCum[i] =
      courseCum[i - 1]! + haversineMeters(c.lats[i - 1]!, c.lons[i - 1]!, c.lats[i]!, c.lons[i]!);
  }
  return courseCum;
}

function coursePointAt(d: number): { lat: number; lon: number } {
  const cum = courseDistances();
  const c = course!;
  let lo = 0;
  let hi = cum.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid]! <= d) lo = mid;
    else hi = mid;
  }
  const segLen = cum[hi]! - cum[lo]!;
  const f = segLen === 0 ? 0 : (d - cum[lo]!) / segLen;
  return {
    lat: c.lats[lo]! + f * (c.lats[hi]! - c.lats[lo]!),
    lon: c.lons[lo]! + f * (c.lons[hi]! - c.lons[lo]!),
  };
}

/**
 * The pipeline's trigger knows only the lead distance; once the text exists
 * the clip's own length pulls the start earlier, so a 40 s story does not
 * mostly play after the place has passed. But never earlier than the first
 * point the place can actually be seen from — a story should not start
 * behind the corner that still hides its subject.
 */
function effectiveTriggerD(p: Place): number {
  const text = texts.get(p.id)?.text ?? '';
  const clipSeconds = countWords(text) / WORDS_PER_SECOND;
  const metresPerSecond = 1000 / VARIANT_DEFAULTS.paceSecPerKm;
  const head = clipSeconds * metresPerSecond * CLIP_HEAD_FRACTION;
  const desired = Math.max(0, p.d - VARIANT_DEFAULTS.leadDistance - head);
  if (!losIndex || !course) return desired;
  const total = courseDistances()[courseDistances().length - 1]!;
  for (let d = desired; d <= Math.min(p.d + 150, total); d += TRIGGER_SIGHT_STEP_M) {
    const at = coursePointAt(d);
    if (!losIndex.blocked(at.lat, at.lon, p.lat, p.lon)) return d;
  }
  return desired;
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
  courseCum = null;
  candidates = [];
  buildings = [];
  losIndex = null;
  manual = [];
  places = [];
  removedIds.clear();
  texts.clear();
  images.clear();
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
  genPruneBtn.hidden = false;
  pruneUndo = [];
  pruneRedo = [];
  setPruneMode(false);
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
  courseCum = null;
  courseLine?.remove();
  courseLine = L.polyline(
    lats.map((lat, i) => [lat, lons[i]!] as [number, number]),
    { color: PLACE_COLOR, weight: 4 },
  ).addTo(map);
  stats.textContent = `${course.name} — ${(distance / 1000).toFixed(1)} km, ${points.length} points`;
}

/**
 * Manual spur pruning: red dots mark every out-and-back tip; tapping one
 * splices that spur out of the course. The automatic pruner (tourBeam)
 * respects the asked length, so some filler always survives — this mode is
 * for the runner who would rather run short than run silly.
 */
const genPruneBtn = el<HTMLButtonElement>('gen-prune');
const pruneBar = el<HTMLDivElement>('prune-bar');
const pruneUndoBtn = el<HTMLButtonElement>('prune-undo');
const pruneRedoBtn = el<HTMLButtonElement>('prune-redo');
const pruneDoneBtn = el<HTMLButtonElement>('prune-done');
const pruneLayer = L.layerGroup().addTo(map);
let pruneMode = false;
let pruneUndo: GpxPoint[][] = [];
let pruneRedo: GpxPoint[][] = [];

function reflectPruneHistory(): void {
  pruneUndoBtn.disabled = pruneUndo.length === 0;
  pruneRedoBtn.disabled = pruneRedo.length === 0;
}

function applyPrunePoints(points: GpxPoint[]): void {
  // The spliced course no longer matches the generated edge path.
  genContext = null;
  updateCourseGeometry(points.map((p) => [p.lat, p.lon] as [number, number]));
  if (candidates.length > 0) recompute();
  renderPruneMarkers();
  reflectPruneHistory();
}

function renderPruneMarkers(): void {
  pruneLayer.clearLayers();
  if (!pruneMode || !course) return;
  const spurs = findPointSpurs(course.lats, course.lons);
  for (const spur of spurs) {
    L.circleMarker([course.lats[spur.tip]!, course.lons[spur.tip]!], {
      radius: 9,
      color: '#c62828',
      fillColor: '#ffffff',
      fillOpacity: 0.9,
      weight: 3,
    })
      .bindTooltip(`Remove this ${(spur.lengthM / 1000).toFixed(2)} km out-and-back`)
      .on('click', () => {
        if (!course) return;
        pruneUndo.push(course.points);
        pruneRedo = [];
        applyPrunePoints(course.points.filter((_, i) => i <= spur.from || i > spur.to));
        toast(`Spur removed — ${(course!.distance / 1000).toFixed(2)} km now.`);
      })
      .addTo(pruneLayer);
  }
  setStatus(
    spurs.length === 0
      ? 'No out-and-back spurs found on this course.'
      : `${spurs.length} out-and-back${spurs.length > 1 ? 's' : ''} marked — tap a red dot to remove it.`,
  );
}

pruneUndoBtn.addEventListener('click', () => {
  const prev = pruneUndo.pop();
  if (!prev || !course) return;
  pruneRedo.push(course.points);
  applyPrunePoints(prev);
});

pruneRedoBtn.addEventListener('click', () => {
  const next = pruneRedo.pop();
  if (!next || !course) return;
  pruneUndo.push(course.points);
  applyPrunePoints(next);
});

function setPruneMode(on: boolean): void {
  pruneMode = on;
  genPruneBtn.setAttribute('aria-pressed', String(on));
  genPruneBtn.textContent = on ? 'Done pruning' : 'Prune spurs by hand';
  pruneBar.hidden = !on;
  if (!on) setStatus('');
  reflectPruneHistory();
  renderPruneMarkers();
}

genPruneBtn.addEventListener('click', () => setPruneMode(!pruneMode));
pruneDoneBtn.addEventListener('click', () => setPruneMode(false));

/** A removed place may have been the sole reason for a detour; re-improve the
    generated course without it so the detour can straighten. */
function refineGeneratedCourse(removed: Place): void {
  if (!genContext || refining) return;
  // Match by id (OSM-only places have no wikidataId) and keep the haversine
  // fallback: ids in genContext.places use a name: form that may not equal
  // the removed place's osm: id.
  genContext.places = genContext.places.filter(
    (p) =>
      p.id !== removed.id &&
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

/**
 * An anchor only when the URL is https; plain text otherwise. These URLs come
 * from OSM/Wikipedia data and imported tour.json files — a javascript: href
 * from a crafted tour must render inert.
 */
function safeLink(url: string | undefined, text: string): HTMLElement {
  if (url?.startsWith('https://')) {
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = text;
    return a;
  }
  const span = document.createElement('span');
  span.textContent = text;
  return span;
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
  const box = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = placeDisplayName(p, narrationLang());
  box.append(
    title,
    document.createElement('br'),
    `score ${p.score} · at ${(p.d / 1000).toFixed(2)} km`,
    document.createElement('br'),
  );
  p.sources.forEach((s, i) => {
    const url =
      s.kind === 'wikipedia' && narrationWiki
        ? `https://${narrationWiki.lang}.wikipedia.org/wiki/` +
          encodeURIComponent(narrationWiki.title.replaceAll(' ', '_'))
        : s.url;
    if (i > 0) box.append(' · ');
    box.append(safeLink(url, s.kind));
  });
  box.append(document.createElement('br'));
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
    // The fetch overwrites the entry on return; typing meanwhile would be
    // silently lost, so the box is read-only for the round-trip.
    area.disabled = true;
    void (async () => {
      const got = await fetchPlaceText(p, narrationLang(), targetSeconds()).catch(() => null);
      if (got) texts.set(p.id, got);
      else setStatus(`No Wikipedia text found for ${p.name}.`);
      refetch.disabled = false;
      area.disabled = false;
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
    src.append('Source: ', safeLink(entry.sourceUrl, 'Wikipedia'), ' (CC BY-SA)');
  }
  body.append(area, counts, row, src);

  const image = images.get(p.id);
  if (image) {
    const fig = document.createElement('figure');
    fig.className = 'place-image';
    const img = document.createElement('img');
    img.src = image.url;
    img.alt = `${p.name}${image.year ? `, ${image.year}` : ''}`;
    img.loading = 'lazy';
    const cap = document.createElement('figcaption');
    cap.className = 'hint';
    cap.append(`${image.year ?? 'Historical'} · `, safeLink(image.pageUrl, image.attribution));
    fig.append(img, cap);
    body.appendChild(fig);
  }
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
  // The markers are about to be removed; a pending highlight timer would
  // restore a marker that is no longer on the map.
  clearTimeout(highlightTimer);
  highlighted = null;
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
  markersBtn.hidden = !any && candidates.length === 0;
  textControls.hidden = !any;
  previewControls.hidden = !any || !showPreviewBox.checked;
  el<HTMLDivElement>('list-lang-row').hidden = !any;
  busUi?.reflectCourse(course !== null);
  // Every state change passes through here; the tour survives the tab being
  // discarded or the WebView reloading after a trip to the browser.
  saveSession(course ? buildTour() : null);
}

function recompute(): void {
  if (!course) return;
  if (candidates.length > 0) {
    const pool = nativeOnly() ? candidates.filter(hasNarrationPage) : candidates;
    places = buildPlaces(
      course.lats,
      course.lons,
      pool,
      {
        leadDistance: VARIANT_DEFAULTS.leadDistance,
        minSpacing: VARIANT_DEFAULTS.minSpacing,
        corridorWidth: VARIANT_DEFAULTS.corridorWidth,
        excludeStreets: !includeStreetsBox.checked,
        excludeSquares: !includeSquaresBox.checked,
        excludeEvents: !includeEventsBox.checked,
      },
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
  // A new GPX/tour mid-flight clears `texts`; keep the stale loop from
  // writing the old course's entries into the new one.
  const courseAtStart = course;
  let done = 0;
  for (const p of list) {
    const got = await fetchPlaceText(p, lang, targetSeconds()).catch(() => null);
    if (course !== courseAtStart) {
      relanging = false;
      return;
    }
    if (got) texts.set(p.id, got);
    done++;
    setStatus(`Switching texts to ${lang} ${done}/${list.length}…`);
  }
  relanging = false;
  if (course !== courseAtStart) return;
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

let markersShown = true;
markersBtn.addEventListener('click', () => {
  markersShown = !markersShown;
  if (markersShown) markerLayer.addTo(map);
  else markerLayer.remove();
  markersBtn.setAttribute('aria-pressed', String(markersShown));
  markersBtn.classList.toggle('active', markersShown);
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
  // `image` stays out of the spread: Place inherits PlaceCandidate's string
  // `image` (a Wikidata photo URL); the historical photo lives in `images`.
  places = tour.places.map(({ image: _image, ...p }) => ({
    ...p,
    types: [],
    offset: 0,
    sources: p.sources,
  }));
  for (const p of tour.places) {
    if (p.image) images.set(p.id, p.image);
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
    const report = await fetchCandidates(course.lats, course.lons, fetchLangs(), setStatus);
    candidates = report.candidates;
    buildings = report.buildings;
    losIndex = buildings.length > 0 ? buildBuildingIndex(buildings) : null;
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
    if (await runFindPlaces()) {
      await runFetchTexts();
      await runFetchImages();
    }
  })(),
);

const showPreviewBox = el<HTMLInputElement>('show-preview');
showPreviewBox.checked = localStorage.getItem('runtour.hidePreviewBar') !== '1';
showPreviewBox.addEventListener('change', () => {
  localStorage.setItem('runtour.hidePreviewBar', showPreviewBox.checked ? '0' : '1');
  // Hiding the bar mid-preview would strand a voice with no stop button.
  if (!showPreviewBox.checked) stopPreview();
  render();
});

// Streets and squares as narration subjects are a taste; both persisted.
// Include-style options, all default off: streets, squares and events stay
// out of tours unless asked for (London showed what street-places do to a
// course). The old skip-* localStorage keys are deliberately abandoned.
const includeStreetsBox = el<HTMLInputElement>('include-streets');
const includeSquaresBox = el<HTMLInputElement>('include-squares');
const includeEventsBox = el<HTMLInputElement>('include-events');
includeStreetsBox.checked = localStorage.getItem('runtour.includeStreets') === '1';
includeSquaresBox.checked = localStorage.getItem('runtour.includeSquares') === '1';
includeEventsBox.checked = localStorage.getItem('runtour.includeEvents') === '1';
for (const [box, key] of [
  [includeStreetsBox, 'runtour.includeStreets'],
  [includeSquaresBox, 'runtour.includeSquares'],
  [includeEventsBox, 'runtour.includeEvents'],
] as const) {
  box.addEventListener('change', () => {
    localStorage.setItem(key, box.checked ? '1' : '0');
    if (candidates.length > 0) recompute();
  });
}

const historicImagesBox = el<HTMLInputElement>('historic-images');
// A rider looks at the screen; a runner mostly cannot, so only bus opts in by
// default. The box lives in both builds.
const storedHistoricImages = localStorage.getItem('runtour.historicImages');
historicImagesBox.checked =
  storedHistoricImages !== null ? storedHistoricImages === '1' : VARIANT === 'bus';
historicImagesBox.addEventListener('change', () => {
  localStorage.setItem('runtour.historicImages', historicImagesBox.checked ? '1' : '0');
});

async function runFetchImages(): Promise<void> {
  if (!historicImagesBox.checked) return;
  const list = allPlaces().filter((p) => !images.has(p.id));
  if (list.length === 0) return;
  let done = 0;
  let found = 0;
  for (const p of list) {
    const got = await fetchHistoricalImage(p.lat, p.lon).catch(() => null);
    if (got) {
      images.set(p.id, got);
      found++;
    }
    done++;
    setStatus(`Looking for historical pictures ${done}/${list.length}…`);
  }
  render();
  setStatus(
    found === 0
      ? 'No historical pictures found on Wikimedia Commons for these places.'
      : `Historical pictures found for ${found} of ${list.length} places.`,
  );
}

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

/** crypto.randomUUID needs a secure context, and phone testing runs the dev
    server over plain LAN http — getRandomValues works everywhere. */
function freshUUID(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function buildTour(): Tour {
  const c = course!;
  tourId ??= freshUUID();
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
        triggerD: effectiveTriggerD(p),
        score: p.score,
        sources: p.sources,
        text: t?.text ?? '',
        needsReview: t ? t.needsReview && !t.reviewed : true,
        image: images.get(p.id),
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
  const strong = document.createElement('strong');
  strong.textContent = c.name;
  box.append(strong, document.createElement('br'), 'must-pass place', document.createElement('br'));
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
      const found = await searchPlacesByName(text, fetchLangs(nativeOnly()));
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
        const shown =
          [c.wikipedia, ...(c.wikipedias ?? [])].find((w) => w?.lang === narrationLang()) ??
          c.wikipedia;
        btn.textContent = `${shown?.title ?? c.name} (${shown?.lang ?? '?'})`;
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
const previewBtn = el<HTMLButtonElement>('preview-btn');
const previewPause = el<HTMLButtonElement>('preview-pause');
let previewPaused = false;
previewPause.addEventListener('click', () => {
  if (!preview) return;
  previewPaused = !previewPaused;
  preview.setPaused(previewPaused);
  previewPause.textContent = previewPaused ? 'Resume' : 'Pause';
});

let preview: PreviewHandle | null = null;
let runnerMarker: L.CircleMarker | null = null;

/** The floating photo over the map while a clip plays in the preview. */
let imageCard: HTMLDivElement | null = null;
function showImageCard(placeId: string, name: string): void {
  const image = images.get(placeId);
  if (!image) {
    hideImageCard();
    return;
  }
  if (!imageCard) {
    imageCard = document.createElement('div');
    imageCard.id = 'image-card';
    imageCard.addEventListener('click', hideImageCard);
    document.body.appendChild(imageCard);
  }
  imageCard.innerHTML = '';
  const img = document.createElement('img');
  img.src = image.url;
  img.alt = name;
  const cap = document.createElement('p');
  cap.className = 'hint';
  cap.textContent = `${name}${image.year ? `, ${image.year}` : ''} · ${image.attribution}`;
  imageCard.append(img, cap);
  imageCard.hidden = false;
}
function hideImageCard(): void {
  if (imageCard) imageCard.hidden = true;
}

function parsePace(value: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return VARIANT_DEFAULTS.paceSecPerKm;
  return Number(m[1]) * 60 + Number(m[2]);
}

function previewPlaces(): PreviewPlace[] {
  return allPlaces().map((p) => ({
    id: p.id,
    name: p.name,
    triggerD: effectiveTriggerD(p),
    text: texts.get(p.id)?.text ?? '',
  }));
}

function stopPreview(): void {
  preview?.stop();
  preview = null;
  hideImageCard();
  runnerMarker?.remove();
  runnerMarker = null;
  previewBtn.textContent = 'Preview';
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
      showImageCard(place.id, place.name);
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
  preview = startSimulatedPreview(
    course.lats,
    course.lons,
    previewPlaces(),
    narrationLang(),
    parsePace(paceInput.value),
    previewFast.checked ? 10 : 1,
    callbacks,
  );
  previewBtn.textContent = 'Stop';
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

// Every slider gets a ↺ back to its default, RaceTwin's weights pattern.
for (const slider of document.querySelectorAll<HTMLInputElement>('input[type="range"]')) {
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'slider-reset';
  reset.textContent = '↺';
  reset.title = `Reset to default (${slider.defaultValue})`;
  reset.setAttribute('aria-label', `Reset to default, ${slider.defaultValue}`);
  reset.addEventListener('click', (e) => {
    // Inside a label the click would also activate the slider.
    e.preventDefault();
    slider.value = slider.defaultValue;
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
  });
  slider.insertAdjacentElement('afterend', reset);
}

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

/** Empty with a finish set: as short as the interesting places allow. */
function targetLength(): number | null {
  const raw = genLength.value.trim();
  return raw === '' ? null : Number(raw) * 1000;
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
  pruneUndo = [];
  pruneRedo = [];
  setPruneMode(false);
  genPruneBtn.hidden = true;
  tourId = null;
  courseCum = null;
  candidates = [];
  buildings = [];
  losIndex = null;
  manual = [];
  places = [];
  removedIds.clear();
  texts.clear();
  images.clear();
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

el<HTMLButtonElement>('gen-info').addEventListener('click', () => {
  toast(
    'Drag the markers to move them. Without a finish the course is a loop; with one it runs ' +
      'point to point, and an empty length means as short as the interesting places allow.',
    8000,
  );
});

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
  const hadEnd = genEnd !== null;
  genEnd = { lat: latlng.lat, lon: latlng.lng };
  // A finish defaults the length to "shortest"; a typed length means moving
  // the finish marker should not wipe it again.
  if (!hadEnd) genLength.value = '';
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
  // A loop cannot be "shortest" — give the length back its default.
  if (genLength.value.trim() === '') genLength.value = '8';
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

/** Places already narrated by tours saved on the phone — the generator makes
    them expensive so new tours find new ground, without forbidding them. */
function visitedPlaces(): { lat: number; lon: number; id?: string }[] {
  const out: { lat: number; lon: number; id?: string }[] = [];
  for (const info of listTours()) {
    try {
      const tour = validateTour(JSON.parse(getTourJson(info.id)));
      for (const p of tour.places) out.push({ lat: p.lat, lon: p.lon, id: p.id });
    } catch {
      // An unreadable stored tour just contributes nothing.
    }
  }
  return out;
}

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
  const lengthM = targetLength();
  if (lengthM === null && !genEnd) {
    toast('Without a length the course needs a finish — set one or give a length.');
    return;
  }
  if (lengthM !== null && !(lengthM > 0)) {
    toast('The length needs to be a number of kilometres — or empty with a finish set.');
    return;
  }
  void (async () => {
    // Like profile-course: Generate over a start no saved area covers offers
    // the download first, since public Overpass servers are unreliable.
    const { center, radiusM } = generationCircle(genStart!, genEnd, lengthM);
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
  // Dismissing the dialog mid-download starts the generation; the download's
  // .then() must not start a second one over it (the orphan's .finally()
  // nulled `generation` and broke Cancel).
  let started = false;
  const startOnce = (): void => {
    if (started) return;
    started = true;
    startGeneration();
  };
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
    // A download decides the question; "Don't show again" would only confuse.
    never.remove();
    void downloadArea(center, Number(radiusInput.value) * 1000, (t) => {
      text.textContent = t;
      setAreaStatus(t);
    })
      .then(() => {
        handled = true;
        closeDialog();
        startOnce();
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
    startOnce();
  });
  row.append(radiusLabel, downloadBtn, never);
  box.append(text, row);
  openDialog('Download the path network?', box, () => {
    if (handled) return;
    // ✕, Esc or the backdrop: generation goes ahead, and this start point
    // stops asking.
    areaPromptDismissedFor = startKey;
    startOnce();
  });
}

function startGeneration(): void {
  if (!genStart) return;
  generation = generateCourse(
    {
      start: genStart,
      end: genEnd,
      targetLengthM: targetLength(),
      searchLangs: fetchLangs(),
      placesSlider: Number(genPlaces.value),
      pedestrianSlider: Number(genPedestrian.value),
      centreSlider: Number(genCentre.value),
      twistSlider: Number(genTwists.value),
      requireLang: nativeOnly() ? narrationLang() : null,
      excludeStreets: !includeStreetsBox.checked,
      excludeSquares: !includeSquaresBox.checked,
      excludeEvents: !includeEventsBox.checked,
      visited: visitedPlaces(),
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
        // Collected counts the beam's deliberate high-interest targets; the
        // full place list (every tellable thing in the corridor) comes from
        // the places step and is usually longer.
        `${(generated.lengthM / 1000).toFixed(2)} km, routed via ${generated.collected.length} ` +
          `high-interest place${generated.collected.length === 1 ? '' : 's'} — finding everything else along it…`,
      );
      if (await runFindPlaces()) {
        await runFetchTexts();
        await runFetchImages();
      }
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
  reportStatus: (text: string) => void,
): Promise<void> {
  // The APK shows the status as a foreground-service notification, which
  // keeps the download alive while the app is minimised.
  let last = '';
  const onStatus = (text: string): void => {
    last = text;
    reportStatus(text);
    downloadNotice(text);
  };
  try {
    await downloadAreaInner(center, radiusM, onStatus);
  } catch (err) {
    last = `Download failed: ${err instanceof Error ? err.message : String(err)}`;
    throw err;
  } finally {
    downloadNotice('');
    downloadDoneNotice(last);
  }
}

async function downloadAreaInner(
  center: { lat: number; lon: number },
  radiusM: number,
  onStatus: (text: string) => void,
): Promise<void> {
  onStatus('Downloading the network, places and buildings…');
  // The downloads are independent and run concurrently: the wall time is the
  // slowest of them, not the sum. Places and buildings failures stay
  // tolerable; only the network is make-or-break for the area.
  const placesPromise = fetchAreaCandidates(center, radiusM, fetchLangs());
  placesPromise.catch(() => undefined);
  // Pre-baked tiles first (CDN-fast inside Sweden); otherwise Overpass with
  // four quadrants on four mirrors — four queue tickets, all useful.
  const tiled = await fetchNetworkTiles(center, radiusM, {
    onTile: (done, total) => onStatus(`Downloading the path network… tile ${done}/${total}.`),
  }).catch(() => null);
  // Outside the tiles, network and buildings are both quadrant-parallel
  // Overpass work — eight concurrent queries on four mirrors only throttle
  // each other (central London taught this), so there buildings wait their
  // turn. On tiles, both are CDN fetches and overlap freely.
  const buildingsPromise = tiled
    ? fetchAreaBuildings(center, radiusM, { headerTimeoutMs: 120_000 })
    : null;
  buildingsPromise?.catch(() => undefined);
  const response =
    tiled ?? (await fetchNetworkParallel(center, radiusM, { headerTimeoutMs: 120_000 }));
  const startedBuildings =
    buildingsPromise ?? fetchAreaBuildings(center, radiusM, { headerTimeoutMs: 120_000 });
  startedBuildings.catch(() => undefined);
  const area = await saveArea(center, radiusM, response);
  onStatus('Network saved. Waiting for the places…');
  try {
    const { candidates: found, failures } = await placesPromise;
    await saveAreaPlaces(area.id, found);
    const warn = failures.length > 0 ? ` (${failures.join(', ')} failed — ranking may suffer)` : '';
    onStatus(`Area saved with ${found.length} places${warn} — courses here now generate offline.`);
    toast(`Area saved with ${found.length} places${warn}.`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onStatus(`Network saved, but the places fetch failed (${message}) — download again.`);
  }
  try {
    onStatus('Waiting for the buildings (line of sight)…');
    const footprints = await startedBuildings;
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
  busUi = initBusLines({
    map,
    sheet,
    onRoute: (name, points) => {
      setCourse(name, points);
      render();
      void (async () => {
        if (await runFindPlaces()) {
          await runFetchTexts();
          await runFetchImages();
        }
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

// A tour in flight survives the app being reloaded (browser visits, tab
// discards): the last editor state comes back from IndexedDB.
void (async () => {
  if (course) return;
  const saved = await loadSession();
  if (!saved || course) return;
  try {
    applyTour(validateTour(saved));
    setStatus(`Tour “${saved.name}” restored from the last session.`);
    // The session carries no footprints; without them a re-export would lose
    // the sight-gated triggers. Usually instant — the fetch is idb-cached.
    void fetchBuildings(course!.lats, course!.lons, BUILDINGS_CORRIDOR_M)
      .then((got) => {
        if (!course) return;
        buildings = got;
        losIndex = got.length > 0 ? buildBuildingIndex(got) : null;
      })
      .catch(() => {});
    // setCourse fitted the map against the still-settling sheet. Fit again —
    // into the upper half of the screen (the sheet owns the lower), without
    // animation so nothing in flight can override it, and once more later in
    // case startup layout work landed after the first.
    const fitRestoredCourse = (): void => {
      if (!courseLine) return;
      map.fitBounds(courseLine.getBounds(), {
        paddingTopLeft: L.point(32, 32),
        paddingBottomRight: L.point(32, Math.round(window.innerHeight / 2)),
        animate: false,
      });
    };
    window.setTimeout(fitRestoredCourse, 400);
    window.setTimeout(fitRestoredCourse, 1400);
  } catch {
    // A stale or half-written session is silently dropped.
  }
})();
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
