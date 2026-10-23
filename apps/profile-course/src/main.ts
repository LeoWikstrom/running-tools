import { buildTargetProfile, SAMPLE_STEP_M, sliceProfile, type TargetProfile } from './gpx/profile';
import { parseGpx, type ParsedGpx } from './gpx/parse';
import { SURFACE_PRESETS } from './search/score';
import { haversineMeters } from './shared/geo';
import { loadSession, requestPersistentStorage, saveSession } from './session';
import type {
  AreaInfo,
  CourseResult,
  CourseSegment,
  MainToWorker,
  WorkerToMain,
} from './shared/messages';
import { createMap } from './ui/map';
import { renderInteractiveChart, type ChartHandle } from './ui/profileChart';
import { captureTops, playReorder, slideIn, slideOutRow } from './ui/animate';
import { hideResult, renderCourseTabs, renderResult, type ResultElements } from './ui/resultPanel';
import { initSheet } from './ui/sheet';
import { closeDialog, dialogOpen, openDialog } from './ui/dialog';
import { initDrawProfile } from './ui/drawProfile';
import { decodeLink, encodeLink, linkStateToParams } from './ui/linkCodec';
import { manualContent } from './ui/manual';
import { renderShortcuts, shortcutsContent } from './ui/shortcuts';
import { guardSlidersAgainstScroll } from './ui/sliderGuard';
import { initWeightControls } from './ui/weights';
import SearchWorker from './search/worker?worker';

const mapEl = document.getElementById('map') as HTMLElement;
const sheetEl = document.getElementById('sheet') as HTMLElement;

/** The sheet covers the window's bottom on a phone and its left on desktop. */
function sheetObscures(): { left: number; bottom: number } {
  const r = sheetEl.getBoundingClientRect();
  if (window.matchMedia('(min-width: 900px)').matches) return { left: r.right, bottom: 0 };
  return { left: 0, bottom: Math.max(0, window.innerHeight - r.top) };
}

const map = createMap('map', sheetObscures);
const worker = new SearchWorker();
// The tall sheet covers the spot the map icon buttons sit in, so CSS moves
// them up beside the zoom control while the sheet is at its top stop.
const sheet = initSheet(sheetEl, document.getElementById('sheet-handle') as HTMLElement, (level) =>
  document.body.classList.toggle('sheet-tall', level === 'tall'),
);

function send(msg: MainToWorker): void {
  worker.postMessage(msg);
}

const radiusSlider = document.getElementById('radius-slider') as HTMLInputElement;
const radiusValue = document.getElementById('radius-value') as HTMLOutputElement;
const findButton = document.getElementById('find-button') as HTMLButtonElement;
const cancelButton = document.getElementById('cancel-button') as HTMLButtonElement;
const startHint = document.getElementById('start-hint') as HTMLParagraphElement;
const gpxInput = document.getElementById('gpx-input') as HTMLInputElement;
const gpxStats = document.getElementById('gpx-stats') as HTMLParagraphElement;
const targetChart = document.getElementById('target-chart') as HTMLDivElement;
const algorithmSelect = document.getElementById('algorithm-select') as HTMLSelectElement;
const resultEls: ResultElements = {
  stats: document.getElementById('course-stats') as HTMLElement,
  advanced: document.getElementById('course-advanced') as HTMLDetailsElement,
  advancedBody: document.getElementById('course-advanced-body') as HTMLElement,
  mapButtons: document.getElementById('map-buttons') as HTMLElement,
  downloadButton: document.getElementById('download-gpx') as HTMLButtonElement,
};
const editBar = document.getElementById('edit-bar') as HTMLDivElement;
const editExitButton = document.getElementById('edit-exit') as HTMLButtonElement;
const editUndoButton = document.getElementById('edit-undo') as HTMLButtonElement;
const editNodesButton = document.getElementById('edit-nodes') as HTMLButtonElement;
const editDeleteButton = document.getElementById('edit-delete') as HTMLButtonElement;
const editStatus = document.getElementById('edit-status') as HTMLParagraphElement;
const rerouteWindow = document.getElementById('reroute-window') as HTMLInputElement;
const showEditWindow = document.getElementById('show-edit-window') as HTMLInputElement;
const seedInput = document.getElementById('seed-input') as HTMLInputElement;
const coordLat = document.getElementById('coord-lat') as HTMLInputElement;
const coordLon = document.getElementById('coord-lon') as HTMLInputElement;
const coordSet = document.getElementById('coord-set') as HTMLButtonElement;
const WEIGHT_FIELDS = [
  'localShape',
  'gainLoss',
  'turns',
  'surface',
  'penalty',
  'oscillation',
  'trafficLights',
];

function collectWeights(): Record<string, number> | null {
  const out: Record<string, number> = {};
  // Benchmarked on a 2 km Gothenburg graph where traces covered a fifth of the
  // edges: at 20 the courses lapped that fifth (out-and-back 42.8 → 50.8,
  // repeats 2.2 → 6.8) and the unrun fraction barely moved. Only the checkbox
  // decides whether any of it is charged.
  const untracked = Number(untrackedWeight.value);
  out['untracked'] = useTraces.checked && Number.isFinite(untracked) ? untracked : 0;
  for (const f of WEIGHT_FIELDS) {
    const el = document.getElementById(`w-${f}`) as HTMLInputElement;
    const v = Number(el.value);
    if (Number.isFinite(v)) out[f] = v;
  }
  // Dense turns and far repeats scale with their main sliders. Repeat tracks
  // oscillation at the default 30:80 ratio (laps were nearly free at 10).
  if (out['turns'] !== undefined) out['denseTurns'] = out['turns'];
  if (out['oscillation'] !== undefined) {
    out['repeat'] = (out['oscillation'] * 3) / 8;
    // Covering no ground is the same complaint as repeating yourself, so the
    // one slider governs both; 0 turns laps back into free distance.
    out['confinement'] = out['oscillation'] / 4;
  }
  return out;
}
const distanceInput = document.getElementById('distance-input') as HTMLInputElement;
const rangeControl = document.getElementById('range-control') as HTMLDivElement;
const rangeFrom = document.getElementById('range-from') as HTMLInputElement;
const rangeTo = document.getElementById('range-to') as HTMLInputElement;
const surfaceSelect = document.getElementById('surface-select') as HTMLSelectElement;
const returnToggle = document.getElementById('return-toggle') as HTMLInputElement;
const startAnywhereToggle = document.getElementById('start-anywhere') as HTMLInputElement;
const connectorsToggle = document.getElementById('connectors-toggle') as HTMLInputElement;
const areaRadius = document.getElementById('area-radius') as HTMLSelectElement;
const downloadAreaButton = document.getElementById('download-area') as HTMLButtonElement;
const areaProgress = document.getElementById('area-progress') as HTMLProgressElement;
const areasList = document.getElementById('areas-list') as HTMLUListElement;
const downloadTracesButton = document.getElementById('download-traces') as HTMLButtonElement;
const tracesList = document.getElementById('traces-list') as HTMLUListElement;
const useTraces = document.getElementById('use-traces') as HTMLInputElement;
const untrackedWeight = document.getElementById('w-untracked') as HTMLInputElement;
const rangeLabel = document.getElementById('range-label') as HTMLOutputElement;
const beamWidthInput = document.getElementById('beam-width') as HTMLInputElement;
const viaToleranceInput = document.getElementById('via-tolerance') as HTMLInputElement;

let fullProfile: TargetProfile | null = null;
let pendingGpx: ParsedGpx | null = null;
let seed = 1;
let searching = false;
let gpxLabel: string | null = null;
let lastResult: { course: CourseResult; profile: TargetProfile } | null = null;
/**
 * One slot per course the search is looking for, filled as each arrives;
 * `lastResult` is the shown one.
 */
let candidates: ({ course: CourseResult; profile: TargetProfile } | null)[] = [];
/** How far the search behind each unfilled slot has got, 0–1. */
let candidateProgress: number[] = [];
/** Each running search's best-so-far, drawn faded when its tab is watched. */
let candidatePreviews: ({ segments: CourseSegment[]; samples: Float32Array } | null)[] = [];
let shownCandidate = 0;
const courseTabs = document.getElementById('course-tabs') as HTMLElement;

/** The preview's chart, kept across ticks so only the line data moves. */
let previewChart: { handle: ChartHandle; index: number } | null = null;

/** A searching tab's live view: the best candidate so far, see-through. */
function showPreview(index: number): void {
  const profile = activeProfile();
  if (!profile) return;
  const preview = candidatePreviews[index];
  if (!preview) {
    // Nothing streamed yet: just the race profile, until the first best lands.
    previewChart = null;
    renderInteractiveChart(targetChart, profile.samples, null, () => {});
    return;
  }
  map.drawPreview(preview.segments);
  // Ticks arrive several times a second: update the existing chart's line
  // rather than rebuilding the SVG (which also killed a crosshair mid-scrub).
  if (previewChart?.index === index && previewChart.handle.updateCourse(preview.samples)) return;
  const handle = renderInteractiveChart(
    targetChart,
    profile.samples,
    preview.samples,
    () => {},
    null,
    undefined,
    undefined,
    { faded: true },
  );
  previewChart = { handle, index };
}

function drawCourseTabs(): void {
  renderCourseTabs(
    courseTabs,
    candidates.map((c, i) => ({
      score: c?.course.score ?? null,
      fraction: candidateProgress[i] ?? 0,
    })),
    shownCandidate,
    showCandidate,
  );
}

/**
 * Switch to one of the search's other courses. Edits belong to a course. A
 * tab whose search is still running can be watched: its best-so-far shows
 * faded, and the real course replaces it, solid, when the run finishes.
 */
function showCandidate(index: number): void {
  if (index === shownCandidate) return;
  const picked = candidates[index];
  const beingSearched =
    !picked && ((candidateProgress[index] ?? 0) > 0 || candidatePreviews[index]);
  if (!picked && !beingSearched) return;
  if (editingMode) exitEditing();
  shownCandidate = index;
  if (picked) {
    lastResult = picked;
    showResult(picked);
    drawCourseTabs();
    startHint.textContent = `Course ${index + 1} — mismatch ${picked.course.score.toFixed(1)}.`;
    persistSession();
    return;
  }
  // Not persisted: a preview is gone on reload, and the course may never land.
  hideResult(resultEls);
  map.clearCourse();
  showPreview(index);
  drawCourseTabs();
  startHint.textContent = `Course ${index + 1} is still being searched for…`;
}

renderShortcuts(document.getElementById('shortcuts-help') as HTMLElement);
initWeightControls();
// A drawn profile takes the uploaded GPX's place entirely: same stats line,
// range slider, chart and session persistence — the search cannot tell.
initDrawProfile((profile) => {
  gpxLabel = 'Drawn profile';
  gpxInput.value = '';
  setFullProfile(profile, true);
  startHint.textContent =
    map.getStart() === null
      ? 'Drawn profile loaded — tap the map to set a start point.'
      : 'Drawn profile loaded — press Find course.';
  persistSession();
});
guardSlidersAgainstScroll();
(document.getElementById('open-manual') as HTMLButtonElement).addEventListener('click', () =>
  openDialog('Manual', manualContent()),
);

// The GPS traces story is too long for the panel: a short hint sits there,
// and the ⓘ opens the full text (kept in the HTML, hidden) as a dialog.
{
  const full = document.getElementById('traces-info-text') as HTMLElement;
  const info = document.getElementById('traces-info') as HTMLButtonElement;
  info.title = (full.textContent ?? '').replace(/\s+/g, ' ').trim();
  info.addEventListener('click', () => {
    const p = full.cloneNode(true) as HTMLElement;
    p.hidden = false;
    p.removeAttribute('id');
    openDialog('GPS traces', p);
  });
}

/**
 * Enter means Find course, but only where nothing else already answers it: a
 * button, a summary, a link or a file input all do something of their own with
 * it, and stealing that would break the panel's own keyboard use.
 */
function enterIsFree(focus: Element | null): boolean {
  if (focus === null || focus === document.body) return true;
  if (focus instanceof HTMLInputElement) return focus.type === 'number' || focus.type === 'text';
  return false;
}

// Desktop: Esc backs out a step, Delete clears the marked nodes, the number
// keys switch course and the arrows walk the tab strip. The letters are in
// SHORTCUTS, which is also the list the ? overlay shows.
window.addEventListener('keydown', (e) => {
  const focus = document.activeElement;
  const typing =
    focus instanceof HTMLInputElement ||
    focus instanceof HTMLTextAreaElement ||
    focus instanceof HTMLSelectElement;
  // With a dialog up it is the only thing on screen: Esc and ? close it, and
  // nothing else gets to act on a course the user cannot see.
  if (dialogOpen()) {
    if (e.key === 'Escape' || e.key === '?') {
      closeDialog();
      e.preventDefault();
    }
    return;
  }
  // The one shortcut that keeps its modifier. A field has its own undo, and
  // outside editing mode there is no history to undo — it is dropped on exit.
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'z') {
    if (typing || !editingMode || editHistory.length === 0 || pendingEdit) return;
    undoEdit();
    e.preventDefault();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Escape') {
    // A pull in progress is the innermost thing to back out of: drop it and
    // stay in editing mode, with the course exactly as it was.
    if (map.cancelPull() || (editingMode && awaitingDestination)) {
      awaitingDestination = false;
      map.hideCoursePoint();
      map.hidePointLabel();
      map.hideEditWindow();
      if (lastResult && editingMode) armEditing(lastResult);
      setEditStatus('Edit cancelled.');
    } else if (!viaBar.hidden) {
      map.disarmViaPlacement();
      endViaPlacement();
      startHint.textContent = 'Via point not placed.';
    } else if (!editingMode) return;
    else if (markedNodes.size > 0) clearMarks();
    else if (nodeMode) {
      nodeMode = false;
      refreshEditBar();
      if (lastResult) armEditing(lastResult);
    } else exitEditing();
    e.preventDefault();
    return;
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && !typing && markedNodes.size > 0) {
    deleteMarkedNodes();
    e.preventDefault();
    return;
  }
  if (e.key === 'Enter' && enterIsFree(focus) && !findButton.disabled) {
    findButton.click();
    e.preventDefault();
    return;
  }
  if (!typing) {
    // Each letter stands in for the control that does the same thing, and is
    // ignored exactly when that control is unavailable.
    const key = e.key.toLowerCase();
    if (e.key === '?') {
      openDialog('Keyboard shortcuts', shortcutsContent());
      e.preventDefault();
      return;
    }
    if (key === 't' && !searching && lastResult) {
      tryAnother();
      e.preventDefault();
      return;
    }
    if (key === 'g' && !resultEls.downloadButton.hidden) {
      resultEls.downloadButton.click();
      e.preventDefault();
      return;
    }
    if (key === 'e' && lastResult) {
      toggleEditing(lastResult);
      e.preventDefault();
      return;
    }
    if (key === 'n' && editingMode) {
      editNodesButton.click();
      e.preventDefault();
      return;
    }
    if (key === 'v' && !addViaButton.disabled) {
      addViaButton.click();
      e.preventDefault();
      return;
    }
  }
  if (candidates.length < 2) return;
  const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
  // The arrows belong to the strip everywhere but over the map, where Leaflet
  // pans with them. Requiring a tab to hold the focus was the bug: selecting a
  // course rebuilds the strip, so the click or number key that chose one threw
  // away the focus the arrows then asked for.
  if (step !== 0 && !typing && !mapEl.contains(focus)) {
    // Tabs fill one at a time, and one still being searched for cannot be
    // shown, so the step carries on over it to the next course that has landed.
    let next = shownCandidate + step;
    while (next >= 0 && next < candidates.length && !candidates[next]) next += step;
    if (next >= 0 && next < candidates.length) {
      showCandidate(next);
      (courseTabs.children[next] as HTMLElement | undefined)?.focus();
    }
    e.preventDefault();
    return;
  }
  if (typing || e.key < '1' || e.key > '9') return;
  showCandidate(Number(e.key) - 1);
});

/** Replace the shown course, keeping its tab (an edit or improve landed). */
function replaceShownCandidate(result: { course: CourseResult; profile: TargetProfile }): void {
  lastResult = result;
  if (candidates.length === 0) {
    candidates = [result];
    candidateProgress = [1];
    shownCandidate = 0;
  } else {
    candidates[shownCandidate] = result;
  }
  drawCourseTabs();
}

function persistSession(): void {
  saveSession({
    profile: fullProfile,
    gpxLabel,
    settings: {
      start: map.getStart(),
      radiusKm: radiusSlider.value,
      distanceKm: distanceInput.value,
      rangeFromKm: rangeFrom.value,
      rangeToKm: rangeTo.value,
      surface: surfaceSelect.value,
      returnToStart: returnToggle.checked,
      startAnywhere: startAnywhereToggle.checked,
      useTraces: useTraces.checked,
      beamWidth: Number(beamWidthInput.value) || 200,
      viaPoints,
      seed,
    },
    // Courses arrive in tab order, so the filled slots are always a prefix and
    // dropping the empty ones leaves the shown index pointing at the same one.
    results: candidates.filter((c) => c !== null),
    shown: shownCandidate,
  });
}

/** Takes a distance picked on the chart while editing; null when not editing. */
let chartPick: ((km: number) => void) | null = null;
/** Halfway through the two-tap flow: a km is chosen, the destination is not. */
let awaitingDestination = false;

function showResult(
  result: { course: CourseResult; profile: TargetProfile },
  action?: { label: string; onAction: () => void },
): void {
  lastAction = action;
  map.drawCourse(result.course.segments);
  map.decorateCourse(result.course.exportPoints);
  const points = result.course.exportPoints;
  // The profile samples sit at exactly 25 m, the export points at 25–50 m, so
  // the marker has to be found by distance rather than by the same index.
  const cum = cumulativeM(points);
  // The combined chart replaces the target-only chart at the top of the sheet.
  previewChart = null;
  const chart = renderInteractiveChart(
    targetChart,
    result.profile.samples,
    result.course.samples,
    (i) => {
      if (i === null) {
        map.hideCoursePoint();
        return;
      }
      lastChartKm = (i * SAMPLE_STEP_M) / 1000;
      const m = lastChartKm * 1000;
      map.showCoursePoint(
        points[indexAtM(cum, m)]!,
        'hover',
        hoverReadout(points, cum, atM(cum, m)),
      );
    },
    // While editing, letting go of the chart picks that distance to edit at —
    // the only way to say which pass of a stretch the course covers twice.
    // The chart keeps the point up on every release because this callback
    // always exists, so outside editing the point is taken down here.
    (i) => {
      if (chartPick) chartPick((i * SAMPLE_STEP_M) / 1000);
      else map.hideCoursePoint();
    },
  );
  // Each hover answers the other: the chart already marks the map, and the map
  // now marks the chart, so a hill under the cursor can be found either way.
  map.armHoverReadout(points, (at) => {
    if (at === null) {
      chart.hideSample();
      return '';
    }
    const m = metresAt(cum, at);
    chart.showSample(Math.round(m / SAMPLE_STEP_M));
    return hoverReadout(points, cum, at);
  });
  renderResult(
    resultEls,
    result.course,
    action ?? { label: 'Try another', onAction: tryAnother },
    { editing: editingMode, toggle: () => toggleEditing(result) },
    courseName(),
  );
}

/** No seed is better than any other, so a fresh one is drawn, not the next. */
const randomSeed = (): number => 1 + Math.floor(Math.random() * 9999);

function tryAnother(): void {
  seed = randomSeed();
  seedInput.value = String(seed);
  startSearch();
}

/**
 * What to call the shown course: the race it was modelled on, plus which
 * course of the search it is, so a folder of downloads stays sortable.
 */
function courseName(): string {
  const base = (gpxLabel ?? 'Profile course').replace(/\.gpx$/i, '').trim() || 'Profile course';
  return shownCandidate === 0 ? `${base} model` : `${base} alt ${shownCandidate + 1}`;
}

/** Editing feedback also goes over the map, since the sheet may be collapsed. */
function setEditStatus(text: string): void {
  startHint.textContent = text;
  editStatus.textContent = text;
  editStatus.hidden = !editingMode;
}

/**
 * Exit, Undo and the node submode sit over the map, within thumb reach.
 * Showing the bar restarts its buttons' staggered slide-in (CSS): display
 * none → flex restarts child animations.
 */
let editBarLeaving = false;
function refreshEditBar(): void {
  if (editingMode) {
    editBarLeaving = false;
    editBar.hidden = false;
  } else if (!editBar.hidden && !editBarLeaving) {
    // Leaving plays the entrance stagger in reverse; the bar is only really
    // hidden once the last button is out.
    editBarLeaving = true;
    const buttons = [...editBar.children].filter(
      (b): b is HTMLElement => b instanceof HTMLElement && !b.hidden,
    );
    slideOutRow(buttons, () => {
      editBarLeaving = false;
      if (!editingMode) editBar.hidden = true;
    });
  }
  editUndoButton.disabled = editHistory.length === 0 || pendingEdit;
  editNodesButton.setAttribute('aria-pressed', String(nodeMode));
  editDeleteButton.hidden = markedNodes.size === 0;
  editDeleteButton.textContent = markedNodes.size > 1 ? `Delete ${markedNodes.size}` : 'Delete';
}

/**
 * The course's junctions: each segment is one network edge, so the segment
 * boundaries are exactly the nodes an edit can move or delete.
 */
function courseNodes(course: CourseResult): { lat: number; lon: number; km: number }[] {
  const out: { lat: number; lon: number; km: number }[] = [];
  let runM = 0;
  for (const seg of course.segments) {
    if (out.length === 0) out.push({ lat: seg.lats[0]!, lon: seg.lons[0]!, km: 0 });
    for (let i = 1; i < seg.lats.length; i++) {
      runM += haversineMeters(seg.lats[i - 1]!, seg.lons[i - 1]!, seg.lats[i]!, seg.lons[i]!);
    }
    const last = seg.lats.length - 1;
    out.push({ lat: seg.lats[last]!, lon: seg.lons[last]!, km: runM / 1000 });
  }
  return out;
}

/**
 * Distance along the course at each point. Course points are not spaced at
 * exactly 25 m — each edge spreads its own samples — so index × 25 m drifts.
 */
function cumulativeM(points: { lat: number; lon: number }[]): number[] {
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    cum.push(cum[i - 1]! + haversineMeters(a.lat, a.lon, b.lat, b.lon));
  }
  return cum;
}

/** The export point nearest a distance along the course. */
function indexAtM(cum: number[], m: number): number {
  let i = 0;
  while (i + 1 < cum.length && cum[i + 1]! <= m) i++;
  return i;
}

/** Fractional point index at a distance along the course — metresAt inverted. */
function atM(cum: number[], m: number): number {
  const i = indexAtM(cum, m);
  const j = Math.min(i + 1, cum.length - 1);
  const span = cum[j]! - cum[i]!;
  return span > 0 ? i + Math.min(1, Math.max(0, (m - cum[i]!) / span)) : i;
}

/** Distance along the course at a fractional point index. */
function metresAt(cum: number[], at: number): number {
  const i = Math.floor(at);
  const j = Math.min(i + 1, cum.length - 1);
  return cum[i]! + (cum[j]! - cum[i]!) * (at - i);
}

/**
 * What the cursor is standing on, for the readout that follows the course:
 * distance, height above sea level and gradient. The gradient is taken over
 * ±50 m rather than between neighbouring points, which sit 25–50 m apart on a
 * DEM with a ~30 m grid, so a single step is as much noise as slope.
 */
function hoverReadout(
  points: { lat: number; lon: number; ele: number }[],
  cum: number[],
  at: number,
): string {
  const i = Math.floor(at);
  const j = Math.min(i + 1, points.length - 1);
  const f = at - i;
  const m = metresAt(cum, at);
  const ele = points[i]!.ele + (points[j]!.ele - points[i]!.ele) * f;
  const lo = indexAtM(cum, Math.max(0, m - 50));
  const hi = indexAtM(cum, m + 50);
  const run = cum[hi]! - cum[lo]!;
  const grade = run > 1 ? ((points[hi]!.ele - points[lo]!.ele) / run) * 100 : 0;
  const sign = grade > 0 ? '+' : '';
  return `${(m / 1000).toFixed(2)} km · ${Math.round(ele)} m · ${sign}${grade.toFixed(1)} %`;
}

/** Midpoint km of the course leg whose geometry passes nearest `p`. */
function nearestLegKm(course: CourseResult, p: { lat: number; lon: number }): number {
  const lonScale = Math.cos((p.lat * Math.PI) / 180);
  let runM = 0;
  let bestD = Infinity;
  let bestKm = 0;
  for (const seg of course.segments) {
    const startM = runM;
    let segD = Infinity;
    for (let i = 0; i < seg.lats.length; i++) {
      const dLat = seg.lats[i]! - p.lat;
      const dLon = (seg.lons[i]! - p.lon) * lonScale;
      segD = Math.min(segD, dLat * dLat + dLon * dLon);
      if (i > 0) {
        runM += haversineMeters(seg.lats[i - 1]!, seg.lons[i - 1]!, seg.lats[i]!, seg.lons[i]!);
      }
    }
    if (segD < bestD) {
      bestD = segD;
      bestKm = (startM + runM) / 2000;
    }
  }
  return bestKm;
}

function rerouteWindowM(): number {
  return Math.max(100, Number(rerouteWindow.value) || 600);
}

/** Resizes the window in round steps, within what the number input allows. */
function setRerouteWindowM(meters: number): number {
  const stepped = Math.round(meters / 50) * 50;
  const clamped = Math.min(3000, Math.max(100, stepped));
  rerouteWindow.value = String(clamped);
  return clamped;
}

/** The stretch an edit at `atKm` may rewrite, as course points. */
function editWindowPoints(
  points: { lat: number; lon: number }[],
  cum: number[],
  atKm: number,
): { lat: number; lon: number }[] {
  const at = atKm * 1000;
  const half = rerouteWindowM();
  const mid = indexAtM(cum, at);
  const anchor = points[mid]!;
  // The same rule the reroute uses: half a window along the course, and no
  // further than that from the drag, so a lap coming back by stays outside it.
  const near = (i: number) =>
    haversineMeters(anchor.lat, anchor.lon, points[i]!.lat, points[i]!.lon) <= half;
  let from = mid;
  while (from > 0 && cum[from - 1]! >= at - half && near(from - 1)) from--;
  let to = mid;
  while (to < points.length - 1 && cum[to + 1]! <= at + half && near(to + 1)) to++;
  return points.slice(from, to + 1);
}

function previewEditWindow(
  points: { lat: number; lon: number }[],
  cum: number[],
  atKm: number,
): void {
  // A node edit reaches to its neighbours, which the drag preview already draws.
  if (showEditWindow.checked && !nodeMode) map.showEditWindow(editWindowPoints(points, cum, atKm));
}

/**
 * Persistent editing mode: pull the course somewhere else, or tap a course
 * point then tap its destination. Either way the mode stays armed, and each
 * reroute builds on the previous one, until Exit editing.
 */
let editingMode = false;
/** Advanced submode: edits act on single course points instead of stretches. */
let nodeMode = false;
/**
 * Course nodes held down in node mode, by index into `courseNodes`. They go
 * together on Delete: deleting them one by one would route each reconnection
 * through the next node about to be deleted.
 */
const markedNodes = new Set<number>();
let lastAction: { label: string; onAction: () => void } | undefined;
/** Courses replaced by an edit, newest last, for Undo. */
const editHistory: { course: CourseResult; profile: TargetProfile }[] = [];
/** Where edits have landed, drawn on the map while editing; null for node edits. */
let editedPoints: ({ lat: number; lon: number } | null)[] = [];

/** Node edits need no marker: the node dots already show where they landed. */
function drawEditMarkers(): void {
  map.setEditMarkers(editedPoints.filter((p): p is { lat: number; lon: number } => p !== null));
}

function toggleEditing(result: { course: CourseResult; profile: TargetProfile }): void {
  if (editingMode) {
    exitEditing();
    return;
  }
  editingMode = true;
  if (lastResult) showResult(lastResult, lastAction); // refresh button label
  armEditing(result);
  refreshEditBar();
}

function exitEditing(): void {
  editingMode = false;
  nodeMode = false;
  chartPick = null;
  awaitingDestination = false;
  map.cancelPull();
  map.hidePointLabel();
  map.disarmViaPlacement();
  map.disarmCourseDrag();
  map.hideCoursePoint();
  map.hideEditWindow();
  map.setEditMarkers([]);
  map.setNodeMarkers([]);
  markedNodes.clear();
  editedPoints = [];
  editHistory.length = 0;
  startHint.textContent = 'Editing finished.';
  editStatus.hidden = true;
  if (lastResult) showResult(lastResult, lastAction);
  refreshEditBar();
}

editExitButton.addEventListener('click', exitEditing);
editUndoButton.addEventListener('click', () => undoEdit());
editNodesButton.addEventListener('click', () => {
  nodeMode = !nodeMode;
  // Arming first, because leaving the submode drops any marks it held.
  if (lastResult) armEditing(lastResult);
  refreshEditBar();
});
editDeleteButton.addEventListener('click', () => deleteMarkedNodes());

/** Marks belong to the course they were made on, so redraw them with it. */
function drawNodeMarkers(): void {
  if (lastResult && nodeMode) map.setNodeMarkers(courseNodes(lastResult.course), markedNodes);
}

function clearMarks(): void {
  if (markedNodes.size === 0) return;
  markedNodes.clear();
  drawNodeMarkers();
  refreshEditBar();
  setEditStatus('Marks cleared.');
}

/** Drop every marked node in one edit, reconnecting the survivors around them. */
function deleteMarkedNodes(): void {
  if (!lastResult || markedNodes.size === 0) return;
  const nodes = courseNodes(lastResult.course);
  const kms = [...markedNodes]
    .map((i) => nodes[i]?.km)
    .filter((km): km is number => km !== undefined)
    .sort((a, b) => a - b);
  if (kms.length === 0) return;
  const count = kms.length;
  markedNodes.clear();
  drawNodeMarkers();
  sendNodeEdit(lastResult, 'delete', kms[0]!, null, kms);
  if (count > 1) setEditStatus(`Removing ${count} points…`);
}

/** Record the course an edit is about to replace, so Undo can bring it back. */
function beginEdit(
  result: { course: CourseResult; profile: TargetProfile },
  marker: { lat: number; lon: number } | null,
): void {
  editHistory.push(result);
  editedPoints.push(marker);
  pendingEdit = true;
  awaitingDestination = false;
  drawEditMarkers();
  map.hideCoursePoint();
  map.hidePointLabel();
  map.hideEditWindow();
  // The history entry above is speculative until the worker replies: an Undo
  // now would pop it and still be overwritten by the arriving edit, losing
  // the pre-edit course for good — so Undo waits.
  refreshEditBar();
}

function editPayload(result: { course: CourseResult; profile: TargetProfile }) {
  // The 'matched' reply must be paired with what it was scored against.
  matchedProfile = result.profile;
  return {
    path: result.course.path,
    ...coursePointArrays(result.course),
    target: targetTransfer(result.profile),
    desiredMix: SURFACE_PRESETS[surfaceSelect.value] ?? SURFACE_PRESETS['road']!,
    weights: collectWeights(),
    viaPoints,
  };
}

function sendEdit(
  result: { course: CourseResult; profile: TargetProfile },
  atKm: number,
  to: { lat: number; lon: number },
): void {
  beginEdit(result, to);
  setEditStatus('Rerouting…');
  send({ type: 'editCourse', atKm, to, ...editPayload(result), rerouteWindowM: rerouteWindowM() });
  refreshEditBar();
}

/** Node editing: move, delete or add the course point near `atKm`. */
function sendNodeEdit(
  result: { course: CourseResult; profile: TargetProfile },
  op: 'move' | 'delete' | 'add',
  atKm: number,
  to: { lat: number; lon: number } | null,
  atKms?: number[],
): void {
  beginEdit(result, null);
  const what =
    op === 'move'
      ? `Moving the point at km ${atKm.toFixed(1)}…`
      : op === 'delete'
        ? `Removing the point at km ${atKm.toFixed(1)}…`
        : `Adding a point near km ${atKm.toFixed(1)}…`;
  setEditStatus(what);
  send({ type: 'nodeEdit', op, atKm, ...(atKms ? { atKms } : {}), to, ...editPayload(result) });
  refreshEditBar();
}

/** An edit is in flight: its history entry and marker are still speculative. */
let pendingEdit = false;

function undoEdit(): void {
  const previous = editHistory.pop();
  if (!previous) return;
  editedPoints.pop();
  drawEditMarkers();
  replaceShownCandidate(previous);
  showResult(previous, lastAction);
  startHint.textContent = `Edit undone — mismatch back to ${previous.course.score.toFixed(1)}.`;
  persistSession();
  armEditing(previous);
  refreshEditBar();
}

function armEditing(result: { course: CourseResult; profile: TargetProfile }): void {
  const points = result.course.exportPoints;
  // In node mode a grab or tap must land on a junction, so the course's nodes
  // are both drawn and used as the grabbable points.
  const nodes = nodeMode ? courseNodes(result.course) : null;
  const grabPoints = nodes ?? points;
  const cum = cumulativeM(points);
  const kmAt = (index: number) => nodes?.[index]?.km ?? cum[index]! / 1000;
  setEditStatus(
    nodeMode
      ? 'Nodes: pull a dot to move it, tap one to delete it, hold to mark several.'
      : 'Editing: pull the course where you want it, or pick a point on it — on the map or on the chart.',
  );
  /** The leg of the course a distance falls on, as an index into `nodes`. */
  const legAt = (km: number): number => {
    let leg = 0;
    for (let i = 0; nodes && i < nodes.length - 1; i++) if (nodes[i]!.km <= km) leg = i;
    return leg;
  };
  drawEditMarkers();
  awaitingDestination = false;
  map.hidePointLabel();
  // An edit rewrites the node list, so marks made against the old one are gone.
  markedNodes.clear();
  map.setNodeMarkers(nodes ?? [], markedNodes);
  map.hideEditWindow();

  /** First half of the two-tap flow: the km to edit at is settled, the destination is not. */
  const selectOrigin = (atKm: number, marker: { lat: number; lon: number }) => {
    awaitingDestination = true;
    map.showCoursePoint(marker);
    previewEditWindow(points, cum, atKm);
    // While waiting for the destination, a tap near the course must not be
    // swallowed as a new pull.
    map.disarmCourseDrag();
    setEditStatus(
      nodeMode
        ? `Moving the point near km ${atKm.toFixed(2)} — tap where it should go…`
        : `Editing near km ${atKm.toFixed(2)} — tap where the course should go…`,
    );
    map.armViaPlacement((to) => {
      awaitingDestination = false;
      if (nodeMode) sendNodeEdit(result, 'move', atKm, to);
      else sendEdit(result, atKm, to);
    });
  };
  const selectDestination = (index: number) => selectOrigin(kmAt(index), grabPoints[index]!);
  // The chart is the other way in: scrub to a distance, let go, then tap the map.
  chartPick = (km) => selectOrigin(km, points[indexAtM(cum, km * 1000)]!);

  map.armCourseDrag(grabPoints, {
    onPull: (index, to, dragged) => {
      const atKm = kmAt(index);
      if (nodeMode) {
        if (dragged) sendNodeEdit(result, 'move', atKm, to);
        // A tap takes the dot, except on a marked one, which it releases.
        else if (markedNodes.delete(index)) {
          drawNodeMarkers();
          refreshEditBar();
          setEditStatus(
            markedNodes.size === 0
              ? 'Mark released.'
              : `Mark released — ${markedNodes.size} still marked.`,
          );
        } else sendNodeEdit(result, 'delete', atKm, null);
      } else if (dragged) sendEdit(result, atKm, to);
      else selectDestination(index);
    },
    onGrab: (index) => previewEditWindow(points, cum, kmAt(index)),
    // The wheel mid-pull resizes the window the edit may rewrite, so the reach
    // can be judged against the map instead of guessed from a number in the
    // panel. The box is shown for the length of the gesture whether or not it
    // is switched on, since it is the thing being changed. A node edit has no
    // window — it reaches to its two neighbours and no further.
    ...(nodeMode
      ? {}
      : {
          onWheel: (notches: number, index: number) => {
            const next = setRerouteWindowM(rerouteWindowM() * (notches > 0 ? 1.25 : 0.8));
            map.showEditWindow(editWindowPoints(points, cum, kmAt(index)));
            return `± ${next} m`;
          },
        }),
    // Which pass is on offer belongs over the point itself, not in the pill at
    // the side: the point is what the eye is on while the passes take turns.
    onCycle: (index, pass, passes) => {
      const atKm = kmAt(index);
      previewEditWindow(points, cum, atKm);
      map.showCoursePoint(grabPoints[index]!);
      map.showPointLabel(grabPoints[index]!, `km ${atKm.toFixed(2)} · pass ${pass + 1}/${passes}`);
    },
    ...(nodes
      ? {
          onLongPress: (index: number) => {
            markedNodes.add(index);
            drawNodeMarkers();
            refreshEditBar();
            setEditStatus(
              `${markedNodes.size} point${markedNodes.size === 1 ? '' : 's'} marked — Delete removes them together.`,
            );
          },
        }
      : {}),
    anchors: (index) => {
      // The course either side of these two points is untouched by the edit:
      // the neighbouring junctions in node mode, the window ends otherwise.
      if (nodes) {
        return [nodes[index - 1] ?? nodes[index]!, nodes[index + 1] ?? nodes[index]!] as const;
      }
      const stretch = editWindowPoints(points, cum, kmAt(index));
      const first = stretch[0];
      const last = stretch[stretch.length - 1];
      return first && last ? ([first, last] as const) : null;
    },
    // In node mode the course between two dots behaves like a node waiting to
    // be born: pull it out and it becomes one, on that leg.
    ...(nodes
      ? {
          line: {
            points,
            onPull: (index: number, to: { lat: number; lon: number }, dragged: boolean) => {
              if (!dragged) {
                setEditStatus('Pull the course out to add a point, or tap a dot to delete it.');
                return;
              }
              const leg = legAt(cum[index]! / 1000);
              sendNodeEdit(result, 'add', (nodes[leg]!.km + nodes[leg + 1]!.km) / 2, to);
            },
            anchors: (index: number) => {
              const leg = legAt(cum[index]! / 1000);
              return [nodes[leg]!, nodes[leg + 1]!] as const;
            },
          },
        }
      : {}),
  });
  const onTap = (p: { lat: number; lon: number }): void => {
    // Away from any dot, a tap in node mode adds a point on the nearest leg.
    if (nodeMode) {
      sendNodeEdit(result, 'add', nearestLegKm(result.course, p), p);
      // Taps keep adding while the reroute is in flight, instead of falling
      // through to placing a new start.
      map.armViaPlacement(onTap);
      return;
    }
    // A tap away from the course still picks the nearest course point.
    let bestI = 0;
    let bestD = Infinity;
    for (let i = 0; i < points.length; i++) {
      const dLat = points[i]!.lat - p.lat;
      const dLon = points[i]!.lon - p.lon;
      const d = dLat * dLat + dLon * dLon;
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    }
    selectDestination(bestI);
  };
  map.armViaPlacement(onTap);
}

/** The profile actually searched for: the race window, rebased. */
function activeProfile(): TargetProfile | null {
  if (!fullProfile) return null;
  const fromM = Math.max(0, Number(rangeFrom.value) * 1000 || 0);
  const toM = Math.min(
    fullProfile.totalDistance,
    Number(rangeTo.value) * 1000 || fullProfile.totalDistance,
  );
  if (fromM <= 0 && toM >= fullProfile.totalDistance) return fullProfile;
  if (toM - fromM < 500) return fullProfile;
  return sliceProfile(fullProfile, fromM, toM);
}

/**
 * A shared link always carries the start, and is then complete: every setting
 * it leaves out is at its default, so the hash stays short without losing the
 * guarantee that it decides the whole result. A hand-written fragment without
 * `lat` still applies whatever it names and resets nothing.
 */
function readUrlState(): void {
  let params = new URLSearchParams(location.hash.slice(1));
  // A packed link (#c=…) unfolds into the plain params, so there is a single
  // parsing path whichever form the link arrived in.
  const packed = params.get('c');
  if (packed) {
    const state = decodeLink(packed);
    if (!state) return;
    params = new URLSearchParams(linkStateToParams(state));
  }
  const complete = params.has('lat');
  const get = (key: string, def: string): string | null =>
    params.get(key) ?? (complete ? def : null);

  const lat = Number(params.get('lat'));
  const lon = Number(params.get('lon'));
  if (complete && Number.isFinite(lat) && Number.isFinite(lon)) {
    map.setStart({ lat, lon });
  }
  const r = get('r', radiusSlider.defaultValue);
  if (r !== null) radiusSlider.value = r;
  if (params.has('d')) distanceInput.value = params.get('d')!;
  if (params.has('from')) rangeFrom.value = params.get('from')!;
  if (params.has('to')) rangeTo.value = params.get('to')!;
  const mix = get('mix', 'road');
  if (mix !== null) surfaceSelect.value = mix;
  const sd = get('seed', '1');
  if (sd !== null) {
    seed = Number(sd) || 1;
    // Find course re-reads the box, so the box must agree with the link.
    seedInput.value = String(seed);
  }
  const flag = (key: string, el: HTMLInputElement): void => {
    const v = get(key, '0');
    if (v !== null) el.checked = v === '1';
  };
  flag('rts', returnToggle);
  flag('sa', startAnywhereToggle);
  flag('conn', connectorsToggle);
  flag('tr', useTraces);
  reflectUseTraces();
  const alg = get('alg', 'beam');
  if (alg !== null) algorithmSelect.value = alg === 'walk' ? 'walk' : 'beam';
  const b = get('b', beamWidthInput.defaultValue);
  if (b !== null && Number(b) > 0) beamWidthInput.value = b;
  const vt = get('vt', viaToleranceInput.defaultValue);
  if (vt !== null && Number(vt) > 0) viaToleranceInput.value = vt;
  const w = get('w', '');
  if (w !== null) {
    const given = new Map<string, string>();
    for (const pair of w.split(',')) {
      const [name, val] = pair.split(':');
      if (name && val && Number.isFinite(Number(val))) given.set(name, val);
    }
    for (const f of [...WEIGHT_FIELDS, 'untracked']) {
      const box = document.getElementById(`w-${f}`) as HTMLInputElement;
      const v = given.get(f) ?? box.defaultValue;
      box.value = v;
      (document.getElementById(`ws-${f}`) as HTMLInputElement).value = v;
    }
  }
  const via = get('via', '');
  if (via !== null) {
    viaPoints = [];
    for (const part of via.split(';')) {
      const [latS, lonS, kmS] = part.split(',');
      const vLat = Number(latS);
      const vLon = Number(lonS);
      if (!part || !Number.isFinite(vLat) || !Number.isFinite(vLon)) continue;
      // An unpinned via travels as an empty km, which Number() would read as 0.
      const km = kmS ? Number(kmS) : NaN;
      viaPoints.push({ lat: vLat, lon: vLon, km: Number.isFinite(km) ? km : null });
    }
  }
  radiusSlider.dispatchEvent(new Event('input'));
}

function writeUrlState(): void {
  const start = map.getStart();
  if (!start) return;
  // Everything that decides the result is represented: what differs from its
  // default is written, and readUrlState reads absence as the default — the
  // receiver's own stored settings may differ, and a shared link promises the
  // same course given the same GPX and map data (see the manual). The hash is
  // joined by hand because URLSearchParams.toString would percent-escape the
  // , : ; in the via and weight lists, which a fragment allows as they are.
  const parts = [`lat=${start.lat.toFixed(5)}`, `lon=${start.lon.toFixed(5)}`];
  const put = (key: string, value: string, def: string): void => {
    if (value !== def) parts.push(`${key}=${value}`);
  };
  put('r', radiusSlider.value, radiusSlider.defaultValue);
  if (distanceInput.value) parts.push(`d=${distanceInput.value}`);
  if (Number(rangeFrom.value) > 0) parts.push(`from=${rangeFrom.value}`);
  if (rangeTo.value) parts.push(`to=${rangeTo.value}`);
  put('mix', surfaceSelect.value, 'road');
  put('seed', String(seed), '1');
  put('b', String(Number(beamWidthInput.value) || 200), beamWidthInput.defaultValue);
  put('rts', returnToggle.checked ? '1' : '0', '0');
  put('sa', startAnywhereToggle.checked ? '1' : '0', '0');
  put('conn', connectorsToggle.checked ? '1' : '0', '0');
  put('tr', useTraces.checked ? '1' : '0', '0');
  put('alg', algorithmSelect.value === 'walk' ? 'walk' : 'beam', 'beam');
  put('vt', String(Number(viaToleranceInput.value) || 0.3), viaToleranceInput.defaultValue);
  const weightDiffs = [...WEIGHT_FIELDS, 'untracked'].flatMap((f) => {
    const box = document.getElementById(`w-${f}`) as HTMLInputElement;
    const v = Number(box.value);
    // v, not box.value: an emptied box scores as 0 and must travel as 0.
    return Number.isFinite(v) && v !== Number(box.defaultValue) ? [{ name: f, value: v }] : [];
  });
  if (weightDiffs.length > 0) {
    parts.push(`w=${weightDiffs.map((w) => `${w.name}:${w.value}`).join(',')}`);
  }
  if (viaPoints.length > 0) {
    const via = viaPoints.map((v) => `${v.lat.toFixed(5)},${v.lon.toFixed(5)},${v.km ?? ''}`);
    parts.push(`via=${via.join(';')}`);
  }
  // A plain hash reads at a glance, but edited weights and via points sprawl,
  // so a long one is packed instead (#c=…). The threshold keeps an everyday
  // link readable: packing would shave ~10 chars off even a minimal hash, and
  // that is not worth the gibberish.
  const plain = parts.join('&');
  const packed = `c=${encodeLink({
    lat: start.lat,
    lon: start.lon,
    radiusKm: Number(radiusSlider.value),
    distanceKm: distanceInput.value ? Number(distanceInput.value) : null,
    fromKm: Math.max(0, Number(rangeFrom.value) || 0),
    toKm: rangeTo.value ? Number(rangeTo.value) : null,
    mix: (SURFACE_PRESETS[surfaceSelect.value] ? surfaceSelect.value : 'road') as
      | 'road'
      | 'gravel'
      | 'trail'
      | 'any',
    algorithm: algorithmSelect.value === 'walk' ? 'walk' : 'beam',
    returnToStart: returnToggle.checked,
    startAnywhere: startAnywhereToggle.checked,
    connectors: connectorsToggle.checked,
    useTraces: useTraces.checked,
    seed,
    beamWidth: Number(beamWidthInput.value) || 200,
    viaToleranceKm: Number(viaToleranceInput.value) || 0.3,
    weights: weightDiffs,
    vias: viaPoints,
  })}`;
  const usePlain = plain.length <= 100 || plain.length <= packed.length;
  history.replaceState(null, '', `#${usePlain ? plain : packed}`);
}

function startSearch(): void {
  const start = map.getStart();
  const profile = activeProfile();
  if (!start || !profile) return;
  if (editingMode) exitEditing();
  searching = true;
  searchGeneration += 1;
  searchProfile = profile;
  hideResult(resultEls);
  map.clearCourse();
  map.hideCoursePoint();
  refreshTargetChart(); // back to the target-only chart while searching
  findButton.disabled = true;
  findButton.textContent = 'Working…';
  cancelButton.hidden = false;
  cancelButton.style.marginTop = '8px';
  writeUrlState();
  const targetLength = Number(distanceInput.value) * 1000 || profile.totalDistance;
  send({
    type: 'search',
    generation: searchGeneration,
    start,
    radiusMeters: Number(radiusSlider.value) * 1000,
    target: {
      totalDistance: profile.totalDistance,
      samples: profile.samples,
      totalGain: profile.totalGain,
      totalLoss: profile.totalLoss,
      gradientHistogram: profile.gradientHistogram,
      turnsPerKm: profile.turnsPerKm,
    },
    targetLengthMeters: targetLength,
    seed,
    algorithm: algorithmSelect.value === 'walk' ? 'walk' : 'beam',
    desiredMix: SURFACE_PRESETS[surfaceSelect.value] ?? SURFACE_PRESETS['road']!,
    returnToStart: returnToggle.checked,
    startAtPoint: !startAnywhereToggle.checked || returnToggle.checked,
    weights: collectWeights(),
    connectors: connectorsToggle.checked,
    beamWidth: Number(beamWidthInput.value) || 200,
    viaPoints,
    viaToleranceKm: Number(viaToleranceInput.value) || 0.3,
  });
}

function searchDone(): void {
  searching = false;
  findButton.textContent = 'Find course';
  cancelButton.hidden = true;
  updateFindEnabled();
}

cancelButton.addEventListener('click', () => {
  send({ type: 'cancel' });
  // The search posts until the worker yields; a new generation mutes it.
  if (!downloadingTraces) searchGeneration += 1;
  startHint.textContent = downloadingTraces ? 'Trace download cancelled.' : 'Search cancelled.';
  if (downloadingTraces) downloadTracesButton.textContent = 'Stopping…';
  if (!downloadingTraces) {
    // The runs fill the tabs in order, so everything past the last course that
    // landed is a spinner with no search behind it any more.
    const ready = candidates.filter((c) => c !== null).length;
    candidates.length = ready;
    candidateProgress.length = ready;
    candidatePreviews.length = ready;
    // A cancelled run's preview tab has nothing behind it any more either.
    if (!candidates[shownCandidate] && candidates[0]) {
      shownCandidate = 0;
      lastResult = candidates[0];
      showResult(lastResult);
    }
    drawCourseTabs();
  }
  searchDone();
});

function renderAreas(areas: import('./shared/messages').AreaInfo[]): void {
  areasList.textContent = '';
  for (const a of areas) {
    const li = document.createElement('li');
    const date = new Date(a.savedAt).toISOString().slice(0, 10);
    li.textContent = `${(a.radiusMeters / 1000).toFixed(0)} km @ ${a.lat.toFixed(3)}, ${a.lon.toFixed(3)} (${a.ways} ways, ${date}) `;
    const del = document.createElement('button');
    del.textContent = 'Remove';
    del.style.width = 'auto';
    del.style.minHeight = '28px';
    del.addEventListener('click', () => send({ type: 'deleteArea', id: a.id }));
    li.appendChild(del);
    areasList.appendChild(li);
  }
}

function renderTraces(traces: import('./shared/messages').TraceInfo[]): void {
  tracesList.textContent = '';
  for (const t of traces) {
    const li = document.createElement('li');
    const date = new Date(t.savedAt).toISOString().slice(0, 10);
    li.textContent =
      `${(t.radiusMeters / 1000).toFixed(0)} km @ ${t.lat.toFixed(3)}, ${t.lon.toFixed(3)}: ` +
      `${t.kept.toLocaleString()} run points of ${t.points.toLocaleString()} (${date}) `;
    const del = document.createElement('button');
    del.textContent = 'Remove';
    del.style.width = 'auto';
    del.style.minHeight = '28px';
    del.addEventListener('click', () => send({ type: 'deleteTraces', id: t.id }));
    li.appendChild(del);
    tracesList.appendChild(li);
  }
  if (traces.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'Nothing downloaded yet.';
    tracesList.appendChild(li);
  }
}

/** Set while a trace download is out, so its arrival can tick the checkbox. */
let downloadingTraces = false;

/**
 * The latest search's generation. The worker echoes it in every search-related
 * reply; anything carrying an older one is the ghost of a cancelled search —
 * it keeps posting until the worker yields — and is dropped on arrival.
 */
let searchGeneration = 0;
/**
 * The profile the running search was asked to match, captured at send time:
 * activeProfile() may have moved (range sliders, a new GPX) before results land.
 */
let searchProfile: TargetProfile | null = null;
/** Likewise for what a 'matched' reply (upload/edit/improve) was scored against. */
let matchedProfile: TargetProfile | null = null;

function tracesDone(): void {
  downloadingTraces = false;
  downloadTracesButton.textContent = 'Download GPS traces around start';
  downloadTracesButton.disabled = map.getStart() === null;
  cancelButton.hidden = !searching;
}

worker.onmessage = (event: MessageEvent<WorkerToMain>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'pong':
      console.log('worker alive');
      break;
    case 'areas': {
      savedAreas = msg.areas;
      renderAreas(msg.areas);
      downloadAreaButton.textContent = 'Download area around start';
      downloadAreaButton.disabled = map.getStart() === null;
      areaProgress.hidden = true;
      // A download the area prompt started: the list arriving means it saved.
      if (areaPromptDownload) {
        const done = areaPromptDownload.done;
        areaPromptDownload = null;
        done();
      }
      break;
    }
    case 'traces': {
      savedTraces = msg.traces;
      renderTraces(msg.traces);
      // Downloading them is asking for them: the checkbox is only unticked by
      // default because there is nothing to use until one has been done.
      if (downloadingTraces && msg.traces.length > 0) {
        useTraces.checked = true;
        reflectUseTraces();
        persistSession();
      }
      tracesDone();
      break;
    }
    case 'elevated': {
      if (!pendingGpx) break;
      const points = pendingGpx.points.map((p, i) => ({ ...p, ele: msg.elevations[i]! }));
      pendingGpx = null;
      setFullProfile(buildTargetProfile(points), true);
      break;
    }
    case 'prepared':
      console.log(
        `graph ready: ${msg.nodeCount} nodes, ${msg.edgeCount} edges; ` +
          `start node at ${msg.startNode.lat.toFixed(5)}, ${msg.startNode.lon.toFixed(5)}, ` +
          `elevation ${msg.startElevation.toFixed(1)} m`,
      );
      break;
    case 'progress':
      if (msg.stage.startsWith('GPS traces')) {
        downloadTracesButton.textContent = msg.stage;
        areaProgress.hidden = false;
        areaProgress.value = msg.fraction;
        break;
      }
      if (msg.stage.startsWith('downloading area')) {
        downloadAreaButton.textContent = msg.stage;
        areaProgress.hidden = false;
        areaProgress.value = msg.fraction;
        if (areaPromptDownload) areaPromptDownload.progress.value = msg.fraction;
        break;
      }
      // The hint rather than the button: sharing a row with the GPX chooser
      // left the button too small for "beam search 45 % (best 52.3)".
      startHint.textContent =
        msg.bestScore !== null
          ? `${msg.stage} ${Math.round(msg.fraction * 100)} % (best ${msg.bestScore.toFixed(1)})`
          : `${msg.stage} ${Math.round(msg.fraction * 100)} %`;
      break;
    case 'bestSoFar':
      if (msg.gen !== searchGeneration) break; // a cancelled search's ghost
      candidatePreviews[msg.index] = { segments: msg.segments, samples: msg.samples };
      // Only painted when that tab is what's on screen and still unfilled.
      if (msg.index === shownCandidate && !candidates[msg.index]) showPreview(msg.index);
      break;
    case 'courses':
      if (msg.gen !== searchGeneration) break;
      candidates = Array.from({ length: msg.total }, () => null);
      candidateProgress = candidates.map(() => 0);
      candidatePreviews = candidates.map(() => null);
      previewChart = null;
      shownCandidate = 0;
      drawCourseTabs();
      break;
    case 'courseProgress':
      if (msg.gen !== searchGeneration) break;
      candidateProgress[msg.index] = msg.fraction;
      drawCourseTabs();
      break;
    case 'course': {
      if (msg.gen !== searchGeneration) break;
      // The profile this search was sent with, not whatever is active now.
      const profile = searchProfile;
      if (profile) {
        candidates[msg.index] = { course: msg.course, profile };
        candidateProgress[msg.index] = 1;
        candidatePreviews[msg.index] = null;
        // The first course to land is shown straight away; the rest wait in
        // their tabs so an arriving alternative cannot pull the map away.
        if (msg.index === shownCandidate) {
          lastResult = candidates[msg.index]!;
          showResult(lastResult);
        }
        drawCourseTabs();
        persistSession();
      }
      break;
    }
    case 'coursesDone': {
      if (msg.gen !== searchGeneration) break; // the cancelled search bowing out
      // Close the tabs no course could be found for.
      candidates.length = Math.max(msg.ready, 1);
      candidateProgress.length = candidates.length;
      candidatePreviews.length = candidates.length;
      // Watching a preview whose run never delivered: fall back to course 1.
      const shown = candidates[shownCandidate];
      if (!shown && candidates[0]) {
        shownCandidate = 0;
        lastResult = candidates[0];
        showResult(lastResult);
      }
      drawCourseTabs();
      if (msg.ready > 1) {
        startHint.textContent = `${msg.ready} courses found — switch with the tabs at the top, or press 1–${msg.ready}.`;
      }
      searchDone();
      break;
    }
    case 'matched': {
      // Stale once a search has started since: drawing it would clobber the
      // search's own preview, and searchDone() would re-enable Find mid-run.
      if (searching) {
        pendingEdit = false;
        break;
      }
      const profile = matchedProfile;
      pendingEdit = false;
      if (profile) {
        replaceShownCandidate({ course: msg.course, profile });
        showResult(lastResult!, { label: 'Improve this course', onAction: sendImproveMatched });
        const summary =
          msg.snappedFraction < 0.9
            ? `Matched ${Math.round(msg.snappedFraction * 100)} % of the course to the path network.`
            : `Course updated — mismatch ${msg.course.score.toFixed(1)}.`;
        startHint.textContent = summary;
        persistSession();
        // Stay in editing mode: re-arm on the updated course.
        if (editingMode) {
          armEditing(lastResult!);
          setEditStatus(summary);
          refreshEditBar();
        }
      }
      searchDone();
      break;
    }
    case 'noCourse':
      if (msg.gen !== searchGeneration) break;
      clearResult();
      startHint.textContent = msg.message;
      searchDone();
      break;
    case 'error':
      console.warn('worker:', msg.message);
      // A failed area download must not leave the prompt modal stuck on a
      // disabled "Downloading…" button — Overpass failures are common.
      if (areaPromptDownload) {
        areaPromptDownload = null;
        if (dialogOpen()) closeDialog();
      }
      if (pendingEdit) {
        // The reroute failed, so the course is unchanged: drop the entry and
        // marker that were added in anticipation.
        pendingEdit = false;
        editHistory.pop();
        editedPoints.pop();
        drawEditMarkers();
        refreshEditBar();
        if (editingMode && lastResult) armEditing(lastResult);
      }
      // After the re-arm, which would otherwise talk over the reason with its
      // own invitation — leaving a refused edit looking like nothing happened.
      if (editingMode) setEditStatus(msg.message);
      else startHint.textContent = msg.message;
      downloadAreaButton.textContent = 'Download area around start';
      downloadAreaButton.disabled = map.getStart() === null;
      areaProgress.hidden = true;
      searchDone();
      tracesDone();
      break;
  }
};
send({ type: 'ping' });
send({ type: 'listAreas' });
send({ type: 'listTraces' });

downloadAreaButton.addEventListener('click', () => {
  const start = map.getStart();
  if (!start) return;
  downloadAreaButton.disabled = true;
  downloadAreaButton.textContent = 'Downloading…';
  send({ type: 'downloadArea', center: start, radiusMeters: Number(areaRadius.value) * 1000 });
});

function startTracesDownload(): void {
  const start = map.getStart();
  if (!start) return;
  downloadingTraces = true;
  downloadTracesButton.disabled = true;
  downloadTracesButton.textContent = 'GPS traces: 0 %';
  // The search's Cancel stops this too — it is the same worker-side flag, and
  // a download measured in minutes needs a way out.
  cancelButton.hidden = false;
  send({ type: 'downloadTraces', center: start, radiusMeters: Number(areaRadius.value) * 1000 });
}
downloadTracesButton.addEventListener('click', startTracesDownload);

/** The weight only counts while the box is ticked, so its controls grey with it. */
function reflectUseTraces(): void {
  untrackedWeight.disabled = !useTraces.checked;
  (document.getElementById('ws-untracked') as HTMLInputElement).disabled = !useTraces.checked;
}
reflectUseTraces();
useTraces.addEventListener('change', () => {
  reflectUseTraces();
  persistSession();
  if (useTraces.checked && !localStorage.getItem(TRACES_PROMPT_SKIP_KEY)) {
    const start = map.getStart();
    if (start ? !tracesCover(start) : savedTraces.length === 0) promptTracesDownload();
  }
});

/**
 * `fresh` is a race the user just loaded (or drew): course distance and the
 * match-race-section window reset to the new race's own, since values tuned
 * for the previous race mean nothing against this one. A session restore is
 * not fresh — it must keep what was saved.
 */
function setFullProfile(profile: TargetProfile, fresh = false): void {
  fullProfile = profile;
  gpxStats.hidden = false;
  const label = gpxLabel ? `${gpxLabel}: ` : '';
  gpxStats.textContent = `${label}${(profile.totalDistance / 1000).toFixed(1)} km, +${Math.round(profile.totalGain)} m / \u2212${Math.round(profile.totalLoss)} m`;
  rangeControl.hidden = false;
  const totalKm = profile.totalDistance / 1000;
  rangeTo.max = totalKm.toFixed(1);
  rangeFrom.max = rangeTo.max;
  if (fresh) {
    rangeFrom.value = '0';
    rangeTo.value = totalKm.toFixed(1);
    distanceInput.value = totalKm.toFixed(1);
  } else {
    if (!rangeFrom.value) rangeFrom.value = '0';
    if (!rangeTo.value || Number(rangeTo.value) > totalKm) rangeTo.value = totalKm.toFixed(1);
    if (!distanceInput.value) distanceInput.value = totalKm.toFixed(1);
  }
  updateRangeLabel();
  clearResult(); // a new race invalidates whatever course was on screen
  refreshTargetChart();
  updateFindEnabled();
  persistSession();
}

/** Drop the proposed course: no stats, no advanced stats, no course buttons. */
function clearResult(): void {
  if (editingMode) exitEditing();
  // Invalidating the result invalidates any search still producing one.
  if (searching) {
    send({ type: 'cancel' });
    searchGeneration += 1;
    searchDone();
  }
  lastResult = null;
  candidates = [];
  candidateProgress = [];
  candidatePreviews = [];
  previewChart = null;
  shownCandidate = 0;
  drawCourseTabs();
  lastAction = undefined;
  editHistory.length = 0;
  hideResult(resultEls);
  map.clearCourse();
  map.hideCoursePoint();
  map.setEditMarkers([]);
}

function updateRangeLabel(): void {
  rangeLabel.textContent = `${Number(rangeFrom.value).toFixed(1)} – ${Number(rangeTo.value).toFixed(1)} km`;
}

/** Km last touched on the chart, so a pick can be committed on release. */
let lastChartKm: number | null = null;

function refreshTargetChart(): void {
  const profile = activeProfile();
  if (!profile) return;
  // Scrubbable even without a course, to read off height/grade/distance.
  renderInteractiveChart(targetChart, profile.samples, null, (i) => {
    lastChartKm = i === null ? lastChartKm : (i * SAMPLE_STEP_M) / 1000;
  });
  if (profile !== fullProfile) {
    distanceInput.value = (profile.totalDistance / 1000).toFixed(1);
  }
}

// Dual-handle slider: keep the handles at least 0.5 km apart.
rangeFrom.addEventListener('input', () => {
  if (Number(rangeFrom.value) > Number(rangeTo.value) - 0.5) {
    rangeFrom.value = String(Math.max(0, Number(rangeTo.value) - 0.5));
  }
  updateRangeLabel();
  refreshTargetChart();
});
rangeTo.addEventListener('input', () => {
  if (Number(rangeTo.value) < Number(rangeFrom.value) + 0.5) {
    rangeTo.value = String(Math.min(Number(rangeTo.max), Number(rangeFrom.value) + 0.5));
  }
  updateRangeLabel();
  refreshTargetChart();
});

const compareInput = document.getElementById('compare-input') as HTMLInputElement;
const viaList = document.getElementById('via-list') as HTMLUListElement;
const addViaButton = document.getElementById('add-via') as HTMLButtonElement;
const viaBar = document.getElementById('via-bar') as HTMLDivElement;
const viaCancelButton = document.getElementById('via-cancel') as HTMLButtonElement;

let viaPoints: { lat: number; lon: number; km: number | null }[] = [];

/** Row element per via, by identity, so reordering can be animated. */
let viaRows = new Map<object, HTMLElement>();

/**
 * Disarm a pending pick-on-chart. The capture listeners otherwise stay armed
 * forever, and the next chart release — however much later — would silently
 * set the via's km from wherever the finger happened to be.
 */
let cancelViaPick: (() => void) | null = null;

/**
 * The course visits the vias in list order. One with a km is pinned near that
 * km, so the km-bearing vias must stand in km order among themselves; one
 * without a km just falls somewhere between its neighbours — it keeps its
 * place in the list and is moved with its ↑/↓ buttons instead.
 */
function sortVias(): void {
  const timed = viaPoints.filter((v) => v.km !== null).sort((a, b) => a.km! - b.km!);
  let ti = 0;
  viaPoints = viaPoints.map((v) => (v.km === null ? v : timed[ti++]!));
}

/** Rebuild the via list; the view stays put and the rows slide to their places. */
function renderVias(): void {
  sortVias();
  map.setViaMarkers(viaPoints, (i, p) => {
    viaPoints[i] = { ...viaPoints[i]!, lat: p.lat, lon: p.lon };
    renderVias();
    persistSession();
  });
  const wasAt = captureTops(viaRows);
  viaRows = new Map();
  viaList.textContent = '';
  viaPoints.forEach((v, i) => {
    const li = document.createElement('li');
    // The number matches the marker on the map; coordinates would say less.
    const n = document.createElement('span');
    n.className = 'via-n';
    n.textContent = `${i + 1}:`;
    li.append(n, 'at km ');
    const km = document.createElement('input');
    km.type = 'number';
    km.min = '0';
    km.step = '0.1';
    km.placeholder = 'any';
    km.style.width = '70px';
    if (v.km !== null) km.value = String(v.km);
    km.addEventListener('change', () => {
      v.km = km.value === '' ? null : Math.max(0, Number(km.value));
      renderVias();
      persistSession();
    });
    li.appendChild(km);
    const pick = document.createElement('button');
    pick.textContent = 'pick on chart';
    pick.style.width = 'auto';
    pick.style.minHeight = '28px';
    pick.addEventListener('click', () => {
      if (!activeProfile()) return;
      cancelViaPick?.();
      // Bring the chart into view, then let the finger slide and commit on release.
      sheet.restore();
      targetChart.scrollIntoView({ behavior: 'smooth', block: 'center' });
      startHint.textContent = 'Slide along the elevation chart and let go at the right km…';
      const commit = () => {
        cleanup();
        if (lastChartKm === null) return;
        v.km = Math.round(lastChartKm * 10) / 10;
        startHint.textContent = `Via point set to km ${v.km}`;
        renderVias();
        persistSession();
      };
      const timer = setTimeout(() => cancelViaPick?.(), 30_000);
      const cleanup = () => {
        clearTimeout(timer);
        targetChart.removeEventListener('pointerup', commit, true);
        targetChart.removeEventListener('pointercancel', commit, true);
        cancelViaPick = null;
      };
      cancelViaPick = cleanup;
      targetChart.addEventListener('pointerup', commit, true);
      targetChart.addEventListener('pointercancel', commit, true);
    });
    li.appendChild(pick);
    if (v.km === null) {
      // No km means "between its neighbours" — these say which neighbours.
      const move = (delta: number, glyph: string, label: string): void => {
        const b = document.createElement('button');
        b.textContent = glyph;
        b.style.width = 'auto';
        b.style.minHeight = '28px';
        b.style.padding = '0 12px';
        b.title = label;
        b.setAttribute('aria-label', label);
        b.disabled = i + delta < 0 || i + delta >= viaPoints.length;
        b.addEventListener('click', () => {
          const j = i + delta;
          [viaPoints[i], viaPoints[j]] = [viaPoints[j]!, viaPoints[i]!];
          renderVias();
          persistSession();
        });
        li.appendChild(b);
      };
      move(-1, '↑', 'Visit this via point earlier');
      move(1, '↓', 'Visit this via point later');
    }
    const del = document.createElement('button');
    del.textContent = '×';
    del.style.width = 'auto';
    del.style.minHeight = '28px';
    del.addEventListener('click', () => {
      viaPoints.splice(i, 1);
      renderVias();
      persistSession();
    });
    li.appendChild(del);
    viaList.appendChild(li);
    viaRows.set(v, li);
  });
  playReorder(wasAt, viaRows);
  addViaButton.disabled = false;
}

/** Leave via placement, whether a point was placed or the ✕ was tapped. */
function endViaPlacement(): void {
  addViaButton.textContent = 'Add via point';
  viaBar.hidden = true;
  sheet.restore();
}

addViaButton.addEventListener('click', () => {
  addViaButton.textContent = 'Tap the map to place the via point…';
  startHint.textContent = 'Tap the map to place the via point…';
  sheet.collapse(); // get the menu out of the way of the map
  // The sheet is out of the way, so the only way back is over the map.
  viaBar.hidden = false;
  slideIn(viaBar);
  map.armViaPlacement((p) => {
    viaPoints.push({ lat: p.lat, lon: p.lon, km: null });
    endViaPlacement();
    renderVias();
    persistSession();
  });
});

viaCancelButton.addEventListener('click', () => {
  map.disarmViaPlacement();
  endViaPlacement();
  startHint.textContent = 'Via point not placed.';
});

function targetTransfer(profile: TargetProfile) {
  return {
    totalDistance: profile.totalDistance,
    samples: profile.samples,
    totalGain: profile.totalGain,
    totalLoss: profile.totalLoss,
    gradientHistogram: profile.gradientHistogram,
    turnsPerKm: profile.turnsPerKm,
  };
}

function coursePointArrays(course: CourseResult): { lats: Float64Array; lons: Float64Array } {
  return {
    lats: new Float64Array(course.exportPoints.map((p) => p.lat)),
    lons: new Float64Array(course.exportPoints.map((p) => p.lon)),
  };
}

function sendImproveMatched(): void {
  const profile = activeProfile();
  if (!profile || !lastResult) return;
  matchedProfile = profile;
  findButton.disabled = true;
  findButton.textContent = 'Improving…';
  send({
    type: 'improveCourse',
    path: lastResult.course.path,
    ...coursePointArrays(lastResult.course),
    target: targetTransfer(profile),
    desiredMix: SURFACE_PRESETS[surfaceSelect.value] ?? SURFACE_PRESETS['road']!,
    weights: collectWeights(),
  });
}

/** Loads someone's own course — exported from anywhere — to score and edit. */
async function importCourseGpx(file: File | undefined): Promise<void> {
  const profile = activeProfile();
  if (!file) return;
  if (!profile) {
    startHint.textContent = 'Load the race GPX first, then the comparison course.';
    return;
  }
  try {
    const gpx = parseGpx(await file.text());
    matchedProfile = profile;
    findButton.disabled = true;
    findButton.textContent = 'Matching course…';
    send({
      type: 'matchCourse',
      lats: new Float64Array(gpx.points.map((p) => p.lat)),
      lons: new Float64Array(gpx.points.map((p) => p.lon)),
      target: targetTransfer(profile),
      desiredMix: SURFACE_PRESETS[surfaceSelect.value] ?? SURFACE_PRESETS['road']!,
      weights: collectWeights(),
    });
  } catch (err) {
    startHint.textContent = err instanceof Error ? err.message : String(err);
  }
}

compareInput.addEventListener('change', () => void importCourseGpx(compareInput.files?.[0]));

gpxInput.addEventListener('change', async () => {
  const file = gpxInput.files?.[0];
  if (!file) return;
  try {
    const gpx = parseGpx(await file.text());
    gpxLabel = gpx.name ?? file.name;
    clearResult();
    if (gpx.hasElevation) {
      setFullProfile(buildTargetProfile(gpx.points), true);
    } else {
      gpxStats.hidden = false;
      gpxStats.textContent = 'No elevation in GPX; fetching from terrain model…';
      pendingGpx = gpx;
      const lats = new Float64Array(gpx.points.map((p) => p.lat));
      const lons = new Float64Array(gpx.points.map((p) => p.lon));
      send({ type: 'elevate', lats, lons });
    }
  } catch (err) {
    gpxStats.hidden = false;
    gpxStats.textContent = err instanceof Error ? err.message : String(err);
    fullProfile = null;
    updateFindEnabled();
  }
});

radiusSlider.addEventListener('input', () => {
  const km = Number(radiusSlider.value);
  radiusValue.textContent = km.toFixed(1);
  map.setRadius(km * 1000);
});

map.onStartChange((start) => {
  startHint.textContent = `Start: ${start.lat.toFixed(5)}, ${start.lon.toFixed(5)} (drag to adjust)`;
  coordLat.value = start.lat.toFixed(5);
  coordLon.value = start.lon.toFixed(5);
  downloadAreaButton.disabled = false;
  if (!downloadingTraces) downloadTracesButton.disabled = false;
  updateFindEnabled();
  persistSession();
});

for (const el of [
  surfaceSelect,
  returnToggle,
  startAnywhereToggle,
  distanceInput,
  rangeFrom,
  rangeTo,
  radiusSlider,
]) {
  el.addEventListener('change', persistSession);
}

function updateFindEnabled(): void {
  if (searching) return;
  findButton.disabled = !(fullProfile !== null && map.getStart() !== null);
}

/** "Don't show again" for the download-area prompt — global, all areas. */
const AREA_PROMPT_SKIP_KEY = 'profile-course.skipAreaPrompt';
let savedAreas: AreaInfo[] = [];
/** ✕ on the prompt: not again for this start point (but a new point asks). */
let areaPromptDismissedFor = '';
/** Set while the prompt's own download runs, cleared when the areas list lands. */
let areaPromptDownload: { progress: HTMLProgressElement; done: () => void } | null = null;

function areaCovers(start: { lat: number; lon: number }): boolean {
  return savedAreas.some(
    (a) => haversineMeters(start.lat, start.lon, a.lat, a.lon) <= a.radiusMeters,
  );
}

/** "Don't show again" for the download-traces prompt — global, like the area's. */
const TRACES_PROMPT_SKIP_KEY = 'profile-course.skipTracesPrompt';
let savedTraces: import('./shared/messages').TraceInfo[] = [];

function tracesCover(start: { lat: number; lon: number }): boolean {
  return savedTraces.some(
    (t) => haversineMeters(start.lat, start.lon, t.lat, t.lon) <= t.radiusMeters,
  );
}

/**
 * Ticking "unrun ground" without a trace download does nothing useful — every
 * path counts as unrun — so the tick offers the download, like the Find button
 * offers the path network. ✕/Esc just closes: the tick stays, the user may be
 * about to download somewhere else.
 */
function promptTracesDownload(): void {
  const start = map.getStart();
  const wrap = document.createElement('div');
  const info = document.createElement('p');
  info.textContent =
    'No downloaded GPS traces cover this start point, so every path here counts as ' +
    'unrun and the weight has nothing to prefer. Download the traces around the start ' +
    'once and the search can favour paths people actually run. The download takes ' +
    'several minutes — the public API hands out 5 000 points at a time.';
  const label = document.createElement('label');
  label.className = 'control';
  const span = document.createElement('span');
  span.textContent = 'Radius (km)';
  const select = areaRadius.cloneNode(true) as HTMLSelectElement;
  select.removeAttribute('id');
  select.value = areaRadius.value;
  label.append(span, select);
  const download = document.createElement('button');
  download.textContent = start ? 'Download GPS traces' : 'Set a start point first';
  download.disabled = !start || downloadingTraces;
  download.style.marginTop = '10px';
  const skip = document.createElement('button');
  skip.textContent = "Don't show again";
  skip.style.marginTop = '8px';
  wrap.append(info, label, download, skip);

  openDialog('Download GPS traces first?', wrap);

  download.addEventListener('click', () => {
    // The subsection's button carries the progress, so closing loses nothing.
    areaRadius.value = select.value;
    closeDialog();
    startTracesDownload();
  });
  skip.addEventListener('click', () => {
    localStorage.setItem(TRACES_PROMPT_SKIP_KEY, '1');
    closeDialog();
  });
}

/**
 * Searching off any downloaded area means asking the public Overpass servers
 * every time — slow and flaky — so the Find button offers the download first.
 * Download = fetch here in the dialog, then search; Don't show again = never
 * ask anywhere; ✕/Esc = not for this start point, and the search goes ahead
 * (a ✕ during the download leaves it running, visible under Path network).
 */
function promptAreaDownload(startKey: string): void {
  const start = map.getStart();
  if (!start) return;
  let settled = false;
  let downloading = false;

  const wrap = document.createElement('div');
  const info = document.createElement('p');
  info.textContent =
    'No downloaded path network covers this start point, so every search here must ask ' +
    'the public Overpass servers — slow, and often unreliable. Download the area once ' +
    'and searches run from your device instead, offline included.';
  const label = document.createElement('label');
  label.className = 'control';
  const span = document.createElement('span');
  span.textContent = 'Area radius (km)';
  const select = areaRadius.cloneNode(true) as HTMLSelectElement;
  select.removeAttribute('id');
  select.value = areaRadius.value;
  label.append(span, select);
  const progress = document.createElement('progress');
  progress.max = 1;
  progress.value = 0;
  progress.hidden = true;
  const download = document.createElement('button');
  download.textContent = 'Download area';
  download.style.marginTop = '10px';
  const skip = document.createElement('button');
  skip.textContent = "Don't show again";
  skip.style.marginTop = '8px';
  wrap.append(info, label, download, skip, progress);

  openDialog('Download this area first?', wrap, () => {
    if (settled) return;
    if (downloading) return; // the download keeps going; Path network shows it
    areaPromptDismissedFor = startKey;
    startSearch();
  });

  download.addEventListener('click', () => {
    downloading = true;
    skip.remove();
    download.disabled = true;
    download.textContent = 'Downloading…';
    progress.hidden = false;
    // The subsection mirrors the dialog, so a ✕ loses nothing.
    areaRadius.value = select.value;
    downloadAreaButton.disabled = true;
    downloadAreaButton.textContent = 'Downloading…';
    send({ type: 'downloadArea', center: start, radiusMeters: Number(select.value) * 1000 });
    areaPromptDownload = {
      progress,
      done: () => {
        settled = true;
        if (dialogOpen()) {
          closeDialog();
          startSearch();
        }
      },
    };
  });

  skip.addEventListener('click', () => {
    settled = true;
    localStorage.setItem(AREA_PROMPT_SKIP_KEY, '1');
    closeDialog();
    startSearch();
  });
}

findButton.addEventListener('click', () => {
  seed = Math.max(1, Math.round(Number(seedInput.value)) || 1);
  const start = map.getStart();
  if (start && !areaCovers(start) && !localStorage.getItem(AREA_PROMPT_SKIP_KEY)) {
    const key = `${start.lat.toFixed(4)},${start.lon.toFixed(4)}`;
    if (key !== areaPromptDismissedFor) {
      promptAreaDownload(key);
      return;
    }
  }
  startSearch();
});

beamWidthInput.addEventListener('change', persistSession);

const seedRandom = document.getElementById('seed-random') as HTMLButtonElement;
seedRandom.addEventListener('click', () => {
  seed = randomSeed();
  seedInput.value = String(seed);
  persistSession();
});

coordSet.addEventListener('click', () => {
  const lat = Number(coordLat.value);
  const lon = Number(coordLon.value);
  if (Number.isFinite(lat) && Number.isFinite(lon) && lat !== 0 && lon !== 0) {
    map.setStart({ lat, lon });
  }
});

async function boot(): Promise<void> {
  const session = await loadSession();
  if (session) {
    gpxLabel = session.gpxLabel;
    seed = session.settings.seed || 1;
    // Find course re-reads the box, which would otherwise undo the restore.
    seedInput.value = String(seed);
    if (session.settings.radiusKm) radiusSlider.value = session.settings.radiusKm;
    if (session.settings.distanceKm) distanceInput.value = session.settings.distanceKm;
    if (session.settings.rangeFromKm) rangeFrom.value = session.settings.rangeFromKm;
    if (session.settings.rangeToKm) rangeTo.value = session.settings.rangeToKm;
    if (session.settings.surface) surfaceSelect.value = session.settings.surface;
    returnToggle.checked = session.settings.returnToStart;
    startAnywhereToggle.checked = session.settings.startAnywhere ?? false;
    useTraces.checked = session.settings.useTraces ?? false;
    reflectUseTraces();
    if (session.settings.beamWidth) beamWidthInput.value = String(session.settings.beamWidth);
    viaPoints = session.settings.viaPoints ?? [];
    renderVias();
    if (session.profile) setFullProfile(session.profile);
    if (session.settings.start) map.setStart(session.settings.start);
    radiusSlider.dispatchEvent(new Event('input'));
    const results = session.results ?? [];
    if (results.length > 0) {
      candidates = results;
      candidateProgress = results.map(() => 1);
      shownCandidate = Math.min(session.shown ?? 0, results.length - 1);
      lastResult = candidates[shownCandidate]!;
      showResult(lastResult);
      drawCourseTabs();
    }
  }
  // Explicit URL parameters win over the restored session.
  readUrlState();
  renderVias();

  const storageInfo = document.getElementById('storage-info') as HTMLParagraphElement;
  storageInfo.textContent = await requestPersistentStorage();
}

void boot();

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('sw:', err));
}
