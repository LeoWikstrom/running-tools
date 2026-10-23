import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { bearingDeg } from '../shared/geo';
import type { CourseSegment, LatLon } from '../shared/messages';

const SURFACE_COLORS = ['#2563eb', '#d97706', '#16a34a', '#6b7280'];
const KM_SAMPLE_STRIDE = 40; // 1000 m / 25 m
const ARROW_SAMPLE_STRIDE = 20; // every ~500 m
/** Above markerPane (600), so edit markers never hide behind km labels. */
const EDIT_PANE = 'editPane';
const GRAB_RADIUS_PX = 28;
const DRAG_THRESHOLD_PX = 12;
const LONG_PRESS_MS = 450;
/** How near the course the cursor must be for the readout to follow it. */
const HOVER_RADIUS_PX = 18;
/** How long each pass of a doubled stretch is offered before the next. */
const CYCLE_MS = 2000;
/** Grab points closer than this along the course are one pass, not two. */
const PASS_GAP = 8;

/** The start pin, in the accent — Leaflet's default marker is blue. */
const START_PIN = L.divIcon({
  className: 'start-pin',
  iconSize: [30, 42],
  iconAnchor: [15, 41],
  html:
    '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="42" viewBox="0 0 30 42">' +
    '<defs><linearGradient id="start-pin-g" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0" stop-color="#e06ba6"/><stop offset="1" stop-color="#a62d68"/>' +
    '</linearGradient></defs>' +
    '<path d="M15 1C7.3 1 1 7.4 1 15.3 1 26 15 41 15 41S29 26 29 15.3C29 7.4 22.7 1 15 1Z" ' +
    'fill="url(#start-pin-g)" stroke="#a62d68" stroke-width="1.5"/>' +
    '<circle cx="15" cy="15.5" r="5.5" fill="#fff"/></svg>',
});

export interface MapController {
  getStart(): LatLon | null;
  setStart(start: LatLon): void;
  setRadius(meters: number): void;
  onStartChange(cb: (start: LatLon) => void): void;
  /** The next map tap calls cb instead of placing the start marker. */
  armViaPlacement(cb: (p: LatLon) => void): void;
  /** Cancel a pending armViaPlacement callback. */
  disarmViaPlacement(): void;
  /** Redraws numbered, draggable via markers. */
  setViaMarkers(vias: LatLon[], onMove: (index: number, p: LatLon) => void): void;
  /** Dots showing where the course has already been edited. */
  setEditMarkers(points: LatLon[]): void;
  /** Dots on every junction of the course, for node editing; `marked` stand out. */
  setNodeMarkers(points: LatLon[], marked?: ReadonlySet<number>): void;
  /**
   * Press on the course and pull it somewhere else. `dragged` is false when the
   * press was really a tap, so the caller can fall back to a two-tap flow.
   */
  armCourseDrag(
    points: LatLon[],
    handlers: {
      onPull: (index: number, to: LatLon, dragged: boolean) => void;
      onGrab?: (index: number) => void;
      /** Held still on a point long enough to mean "mark", not "pull". */
      onLongPress?: (index: number) => void;
      /**
       * Where the course passes the same spot more than once, holding offers
       * each pass in turn; the pull or tap then means the one last offered.
       */
      onCycle?: (index: number, pass: number, passes: number) => void;
      /**
       * Wheel notches while the point is still held, positive away from the
       * user. Whatever text it returns goes in a pill at the held point, so the
       * caller can say what the wheel changed; the map zoom is left alone for
       * the length of the pull.
       */
      onWheel?: (notches: number, index: number) => string | void;
      /** The fixed points the pulled stretch stays attached to, for the drag preview. */
      anchors?: (index: number) => readonly [LatLon, LatLon] | null;
      /** A pull may also start between the grab points, anywhere along this line. */
      line?: {
        points: LatLon[];
        onPull: (index: number, to: LatLon, dragged: boolean) => void;
        anchors?: (index: number) => readonly [LatLon, LatLon] | null;
      };
    },
  ): void;
  disarmCourseDrag(): void;
  /** Translucent box over the stretch an edit may rewrite. */
  showEditWindow(points: LatLon[]): void;
  hideEditWindow(): void;
  drawCourse(segments: CourseSegment[], options?: { faded?: boolean }): void;
  /**
   * The live search preview: one translucent line, mutated in place — a tick
   * arrives several times a second and must not rebuild the course layer.
   * drawCourse and clearCourse take it down.
   */
  drawPreview(segments: CourseSegment[]): void;
  /** Km labels and running-direction arrows along ~25 m-spaced course points. */
  decorateCourse(points: { lat: number; lon: number }[]): void;
  clearCourse(): void;
  /**
   * `hover` draws it like the hover readout's point; default is the red pick.
   * `label`, if given, goes in the same pill the hover readout shows.
   */
  showCoursePoint(point: LatLon, look?: 'pick' | 'hover', label?: string): void;
  hideCoursePoint(): void;
  /** A pill above a point on the map, for what the gesture is about to do. */
  showPointLabel(point: LatLon, text: string): void;
  hidePointLabel(): void;
  /**
   * A translucent point that follows the cursor along the course, with
   * `describe`'s text in a pill above it. `at` is a fractional index into
   * `points`, so the readout slides between them instead of hopping; it is
   * null when the cursor leaves the course, so the caller can take its own
   * readout down (the chart's crosshair follows this one).
   */
  armHoverReadout(points: LatLon[], describe: (at: number | null) => string): void;
  disarmHoverReadout(): void;
  /** Abandon a pull in progress without committing it; true if there was one. */
  cancelPull(): boolean;
}

export function createMap(
  container: string,
  /** How much of the window other UI hides from the map, in px. */
  obscured?: () => { left: number; bottom: number },
): MapController {
  const map = L.map(container, { zoomControl: false }).setView([57.7089, 11.9746], 12);
  L.control.zoom({ position: 'topright' }).addTo(map);
  map.createPane(EDIT_PANE).style.zIndex = '680';

  // GoKartor as a second layer was tried and blocked (licensing protection);
  // ask Gokartor AB for permission before re-adding.
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  let marker: L.Marker | null = null;
  let circle: L.Circle | null = null;
  let radiusMeters = 5000;
  let changeCb: ((start: LatLon) => void) | null = null;

  function notify(): void {
    if (marker && changeCb) {
      const { lat, lng } = marker.getLatLng();
      changeCb({ lat, lon: lng });
    }
  }

  function placeStart(latlng: L.LatLng): void {
    if (!marker) {
      marker = L.marker(latlng, { draggable: true, icon: START_PIN }).addTo(map);
      circle = L.circle(latlng, {
        radius: radiusMeters,
        color: '#c63d80',
        weight: 2,
        fillOpacity: 0.05,
      }).addTo(map);
      marker.on('move', () => {
        circle?.setLatLng(marker!.getLatLng());
      });
      marker.on('moveend', notify);
    } else {
      marker.setLatLng(latlng);
      circle?.setLatLng(latlng);
    }
    notify();
  }

  let viaTapCb: ((p: LatLon) => void) | null = null;
  let lastDragEnd = 0;
  map.on('click', (e: L.LeafletMouseEvent) => {
    // A pulled course emits a trailing click on touch; don't treat it as a tap.
    if (Date.now() - lastDragEnd < 400) return;
    if (viaTapCb) {
      const cb = viaTapCb;
      viaTapCb = null;
      cb({ lat: e.latlng.lat, lon: e.latlng.lng });
      return;
    }
    placeStart(e.latlng);
  });

  let courseLayer: L.LayerGroup | null = null;
  let previewLine: L.Polyline | null = null;
  let pointMarker: L.Marker | null = null;
  let pointMarkerClass = '';
  let pointPill: L.Tooltip | null = null;
  let pointLabel: L.Tooltip | null = null;
  let viaMarkers: L.Marker[] = [];
  let editMarkers: L.Marker[] = [];
  let nodeLayer: L.LayerGroup | null = null;

  let pullCb: ((index: number, to: LatLon, dragged: boolean) => void) | null = null;
  let grabCb: ((index: number) => void) | null = null;
  let longPressCb: ((index: number) => void) | null = null;
  let cycleCb: ((index: number, pass: number, passes: number) => void) | null = null;
  let wheelCb: ((notches: number, index: number) => string | void) | null = null;
  let anchorsCb: ((index: number) => readonly [LatLon, LatLon] | null) | null = null;
  let lineGrab: {
    points: LatLon[];
    onPull: (index: number, to: LatLon, dragged: boolean) => void;
    anchors?: (index: number) => readonly [LatLon, LatLon] | null;
  } | null = null;
  let windowBox: L.Rectangle | null = null;
  let pullPoints: LatLon[] = [];
  let pullIndex = -1;
  /** The pull started between the grab points, on the course line itself. */
  let pullOnLine = false;
  let pullStart: { x: number; y: number } | null = null;
  let pullAnchors: readonly [LatLon, LatLon] | null = null;
  /** Where the pulled point is now, so the wheel can redraw without a move. */
  let pullLatLng: L.LatLng | null = null;
  let rubber: L.Polyline | null = null;
  let rubberPoint: L.Marker | null = null;
  /** The hold has already been taken as a long press; the pull is off. */
  let pullHeld = false;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  /** One index per pass under the press, and which of them is being offered. */
  let cyclePasses: number[] = [];
  let cyclePass = 0;
  let cycleTimer: ReturnType<typeof setInterval> | null = null;

  function clearHoldTimer(): void {
    if (holdTimer === null) return;
    clearTimeout(holdTimer);
    holdTimer = null;
  }

  function clearCycleTimer(): void {
    cyclePasses = [];
    if (cycleTimer === null) return;
    clearInterval(cycleTimer);
    cycleTimer = null;
  }

  function hidePointLabel(): void {
    pointLabel?.remove();
    pointLabel = null;
  }

  function showPointLabel(point: LatLon, text: string): void {
    if (!pointLabel) {
      pointLabel = L.tooltip({
        permanent: true,
        direction: 'top',
        offset: [0, -12],
        className: 'point-pill',
        interactive: false,
      }).setLatLng([point.lat, point.lon]);
      pointLabel.addTo(map);
    } else {
      pointLabel.setLatLng([point.lat, point.lon]);
    }
    pointLabel.setContent(text);
  }

  let hoverPoints: LatLon[] = [];
  let hoverDescribe: ((at: number | null) => string) | null = null;
  let hoverMarker: L.Marker | null = null;
  let hoverLabel: L.Tooltip | null = null;

  function hideHover(): void {
    const wasShown = hoverMarker !== null;
    hoverMarker?.remove();
    hoverMarker = null;
    hoverLabel?.remove();
    hoverLabel = null;
    if (wasShown) hoverDescribe?.(null);
  }

  function clearRubber(): void {
    rubber?.remove();
    rubber = null;
    rubberPoint?.remove();
    rubberPoint = null;
  }

  function nearestCoursePoint(e: PointerEvent, points: LatLon[]): number {
    const p = map.mouseEventToContainerPoint(e);
    let best = -1;
    let bestD = GRAB_RADIUS_PX;
    for (let i = 0; i < points.length; i++) {
      const q = map.latLngToContainerPoint([points[i]!.lat, points[i]!.lon]);
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /**
   * One grab point per distinct pass of the course under the press, nearest
   * first within each pass, in course order. Neighbouring points are the same
   * pass — a hairpin included; a second pass is a cluster that is close on
   * screen but far away along the course.
   */
  function passesAt(e: PointerEvent, points: LatLon[]): number[] {
    const p = map.mouseEventToContainerPoint(e);
    const near: { i: number; d: number }[] = [];
    for (let i = 0; i < points.length; i++) {
      const q = map.latLngToContainerPoint([points[i]!.lat, points[i]!.lon]);
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < GRAB_RADIUS_PX) near.push({ i, d });
    }
    near.sort((a, b) => a.d - b.d);
    const reps: number[] = [];
    for (const { i } of near) {
      if (!reps.some((r) => Math.abs(r - i) < PASS_GAP)) reps.push(i);
    }
    return reps.sort((a, b) => a - b);
  }

  /**
   * Where the cursor is along the course, as a fractional index, or -1 when it
   * is not near it. The nearest *leg* rather than the nearest point, because
   * the points sit 25–50 m apart and a readout that hops between them does not
   * read as following the course.
   */
  function alongCourse(e: PointerEvent, points: LatLon[]): number {
    if (points.length < 2) return -1;
    const p = map.mouseEventToContainerPoint(e);
    let bestD = HOVER_RADIUS_PX * HOVER_RADIUS_PX;
    let bestAt = -1;
    let a = map.latLngToContainerPoint([points[0]!.lat, points[0]!.lon]);
    for (let i = 1; i < points.length; i++) {
      const b = map.latLngToContainerPoint([points[i]!.lat, points[i]!.lon]);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      const u =
        len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
      const ex = a.x + u * dx - p.x;
      const ey = a.y + u * dy - p.y;
      const d = ex * ex + ey * ey;
      if (d < bestD) {
        bestD = d;
        bestAt = i - 1 + u;
      }
      a = b;
    }
    return bestAt;
  }

  /** The point at a fractional index, interpolated along its leg. */
  function pointAt(points: LatLon[], at: number): L.LatLng {
    const i = Math.floor(at);
    const a = points[i]!;
    const b = points[Math.min(i + 1, points.length - 1)]!;
    const f = at - i;
    return L.latLng(a.lat + (b.lat - a.lat) * f, a.lon + (b.lon - a.lon) * f);
  }

  const mapEl = map.getContainer();

  /** Straight legs from the two points the pulled stretch stays attached to. */
  function drawRubber(): void {
    if (!pullLatLng) return;
    const from = (pullOnLine ? lineGrab!.points : pullPoints)[pullIndex]!;
    const ends = pullAnchors ?? ([from, from] as const);
    const line: L.LatLngExpression[] = [
      [ends[0].lat, ends[0].lon],
      pullLatLng,
      [ends[1].lat, ends[1].lon],
    ];
    if (rubber) rubber.setLatLngs(line);
    else {
      rubber = L.polyline(line, {
        pane: EDIT_PANE,
        color: '#7c3aed',
        weight: 4,
        opacity: 0.55,
        dashArray: '6 5',
        interactive: false,
      }).addTo(map);
    }
    if (rubberPoint) rubberPoint.setLatLng(pullLatLng);
    else {
      rubberPoint = L.marker(pullLatLng, {
        pane: EDIT_PANE,
        interactive: false,
        icon: L.divIcon({ className: 'dragged-point', iconSize: [14, 14] }),
      }).addTo(map);
    }
  }

  mapEl.addEventListener('pointerdown', (e) => {
    if (!pullCb || pullStart) return;
    // A via marker often sits on the course; its own drag comes first.
    if ((e.target as Element | null)?.closest?.('.leaflet-marker-icon.leaflet-interactive')) return;
    let i = nearestCoursePoint(e, pullPoints);
    // Between the grab points, the course line itself can be pulled out.
    pullOnLine = i < 0 && lineGrab !== null;
    if (pullOnLine) i = nearestCoursePoint(e, lineGrab!.points);
    if (i < 0) return; // away from the course: let the map pan as usual
    // The gesture owns the pointer from here: no selection started under it,
    // and nothing already marked dragged along with it.
    e.preventDefault();
    window.getSelection()?.removeAllRanges();
    pullIndex = i;
    pullStart = { x: e.clientX, y: e.clientY };
    pullAnchors = (pullOnLine ? lineGrab!.anchors?.(i) : anchorsCb?.(i)) ?? null;
    pullHeld = false;
    pullLatLng = null;
    hideHover();
    map.dragging.disable();
    // The wheel belongs to the gesture while a point is held, not to the zoom.
    if (wheelCb) map.scrollWheelZoom.disable();
    mapEl.setPointerCapture(e.pointerId);
    if (!pullOnLine) grabCb?.(i);
    // A press where the course passes twice is ambiguous, and pixels cannot
    // settle it: hold still and the passes take turns until one is pulled or
    // released. Holding to mark is out while that is going on.
    const passes = cycleCb && !pullOnLine ? passesAt(e, pullPoints) : [];
    if (passes.length > 1) {
      cyclePasses = passes;
      cyclePass = Math.max(0, passes.indexOf(i));
      cycleCb?.(i, cyclePass, passes.length);
      cycleTimer = setInterval(() => {
        cyclePass = (cyclePass + 1) % cyclePasses.length;
        pullIndex = cyclePasses[cyclePass]!;
        pullAnchors = anchorsCb?.(pullIndex) ?? null;
        navigator.vibrate?.(30);
        cycleCb?.(pullIndex, cyclePass, cyclePasses.length);
      }, CYCLE_MS);
    }
    // Holding a point still is a different gesture from pulling it: the pull
    // is abandoned and the caller gets to mark the point instead.
    if (longPressCb && !pullOnLine && passes.length <= 1) {
      const held = i;
      holdTimer = setTimeout(() => {
        holdTimer = null;
        pullHeld = true;
        clearRubber();
        longPressCb?.(held);
      }, LONG_PRESS_MS);
    }
  });

  mapEl.addEventListener('pointermove', (e) => {
    if (!pullStart) return;
    // Moving off the point means a pull, not a hold: the pass being offered
    // when the drag began is the one that gets pulled.
    if (Math.hypot(e.clientX - pullStart.x, e.clientY - pullStart.y) >= DRAG_THRESHOLD_PX) {
      clearHoldTimer();
      clearCycleTimer();
    }
    if (pullHeld) return;
    pullLatLng = map.mouseEventToLatLng(e);
    drawRubber();
  });

  mapEl.addEventListener(
    'wheel',
    (e) => {
      if (!pullStart || pullHeld || !wheelCb) return;
      // Away from the user reads as "more", which is what the panel's arrows do.
      const notches = -Math.sign(e.deltaY);
      if (notches === 0) return;
      e.preventDefault();
      const said = wheelCb(notches, pullIndex);
      // The stretch the edit may rewrite has just changed, and with it the two
      // points the band hangs from.
      pullAnchors = (pullOnLine ? lineGrab!.anchors?.(pullIndex) : anchorsCb?.(pullIndex)) ?? null;
      drawRubber();
      if (said && pullLatLng) showPointLabel({ lat: pullLatLng.lat, lon: pullLatLng.lng }, said);
    },
    { passive: false },
  );

  // Mouse only: a finger has no hover, and on touch the course is for pulling.
  mapEl.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || !hoverDescribe || pullStart) return;
    const at = alongCourse(e, hoverPoints);
    if (at < 0) {
      hideHover();
      return;
    }
    const ll = pointAt(hoverPoints, at);
    if (hoverMarker) hoverMarker.setLatLng(ll);
    else {
      hoverMarker = L.marker(ll, {
        pane: EDIT_PANE,
        interactive: false,
        icon: L.divIcon({ className: 'hover-point', iconSize: [16, 16] }),
      }).addTo(map);
    }
    if (hoverLabel) hoverLabel.setLatLng(ll);
    else {
      hoverLabel = L.tooltip({
        permanent: true,
        direction: 'top',
        offset: [0, -14],
        className: 'hover-pill',
        interactive: false,
      }).setLatLng(ll);
      hoverLabel.addTo(map);
    }
    hoverLabel.setContent(hoverDescribe(at));
  });
  mapEl.addEventListener('pointerleave', hideHover);

  const endPull = (e: PointerEvent, commit: boolean) => {
    if (!pullStart) return;
    clearHoldTimer();
    clearCycleTimer();
    const moved = Math.hypot(e.clientX - pullStart.x, e.clientY - pullStart.y);
    const index = pullIndex;
    const onLine = pullOnLine;
    const held = pullHeld;
    pullStart = null;
    pullIndex = -1;
    pullOnLine = false;
    pullAnchors = null;
    pullLatLng = null;
    pullHeld = false;
    clearRubber();
    // The pass pill belongs to the gesture; the status pill carries the km on.
    hidePointLabel();
    map.dragging.enable();
    map.scrollWheelZoom.enable();
    // The long press already acted; swallow the release and its trailing click.
    if (held) {
      lastDragEnd = Date.now();
      return;
    }
    if (!commit) return;
    lastDragEnd = Date.now();
    const to = map.mouseEventToLatLng(e);
    const dragged = moved >= DRAG_THRESHOLD_PX;
    if (onLine) lineGrab?.onPull(index, { lat: to.lat, lon: to.lng }, dragged);
    else pullCb?.(index, { lat: to.lat, lon: to.lng }, dragged);
  };
  mapEl.addEventListener('pointerup', (e) => endPull(e, true));
  mapEl.addEventListener('pointercancel', (e) => endPull(e, false));
  // A native drag would take the pointer away mid-pull and the edit would be
  // dropped on a pointercancel, looking exactly like a refusal.
  mapEl.addEventListener('dragstart', (e) => {
    if (pullStart) e.preventDefault();
  });

  return {
    armViaPlacement(cb) {
      viaTapCb = cb;
    },
    disarmViaPlacement() {
      viaTapCb = null;
    },
    setViaMarkers(vias, onMove) {
      for (const m of viaMarkers) m.remove();
      viaMarkers = vias.map((v, i) => {
        const m = L.marker([v.lat, v.lon], {
          draggable: true,
          icon: L.divIcon({ className: 'via-marker', html: String(i + 1), iconSize: [22, 22] }),
        }).addTo(map);
        m.on('moveend', () => {
          const { lat, lng } = m.getLatLng();
          onMove(i, { lat, lon: lng });
        });
        return m;
      });
    },
    setEditMarkers(points) {
      for (const m of editMarkers) m.remove();
      editMarkers = points.map((p) =>
        L.marker([p.lat, p.lon], {
          pane: EDIT_PANE,
          interactive: false,
          icon: L.divIcon({ className: 'edited-point', iconSize: [12, 12] }),
        }).addTo(map),
      );
    },
    setNodeMarkers(points, marked) {
      nodeLayer?.remove();
      nodeLayer = null;
      if (points.length === 0) return;
      nodeLayer = L.layerGroup();
      points.forEach((p, i) => {
        const on = marked?.has(i) === true;
        L.marker([p.lat, p.lon], {
          pane: EDIT_PANE,
          interactive: false,
          icon: L.divIcon({
            className: on ? 'node-point marked' : 'node-point',
            iconSize: on ? [16, 16] : [10, 10],
          }),
        }).addTo(nodeLayer!);
      });
      nodeLayer.addTo(map);
    },
    armCourseDrag(points, handlers) {
      pullPoints = points;
      pullCb = handlers.onPull;
      grabCb = handlers.onGrab ?? null;
      longPressCb = handlers.onLongPress ?? null;
      cycleCb = handlers.onCycle ?? null;
      wheelCb = handlers.onWheel ?? null;
      anchorsCb = handlers.anchors ?? null;
      lineGrab = handlers.line ?? null;
    },
    disarmCourseDrag() {
      pullCb = null;
      grabCb = null;
      longPressCb = null;
      cycleCb = null;
      wheelCb = null;
      anchorsCb = null;
      lineGrab = null;
      pullPoints = [];
      clearHoldTimer();
      clearCycleTimer();
    },
    showEditWindow(points) {
      if (points.length === 0) return;
      let minLat = Infinity;
      let maxLat = -Infinity;
      let minLon = Infinity;
      let maxLon = -Infinity;
      for (const p of points) {
        minLat = Math.min(minLat, p.lat);
        maxLat = Math.max(maxLat, p.lat);
        minLon = Math.min(minLon, p.lon);
        maxLon = Math.max(maxLon, p.lon);
      }
      const bounds: L.LatLngBoundsLiteral = [
        [minLat, minLon],
        [maxLat, maxLon],
      ];
      if (windowBox) {
        windowBox.setBounds(bounds);
        return;
      }
      windowBox = L.rectangle(bounds, {
        pane: EDIT_PANE,
        interactive: false,
        color: '#7c3aed',
        weight: 1,
        dashArray: '4 4',
        fillOpacity: 0.12,
        className: 'edit-window',
      }).addTo(map);
    },
    hideEditWindow() {
      windowBox?.remove();
      windowBox = null;
    },
    drawPreview(segments) {
      const latlngs: [number, number][] = [];
      for (const seg of segments) {
        for (let i = 0; i < seg.lats.length; i++) latlngs.push([seg.lats[i]!, seg.lons[i]!]);
      }
      if (previewLine) {
        previewLine.setLatLngs(latlngs);
        return;
      }
      previewLine = L.polyline(latlngs, {
        color: '#c63d80',
        weight: 4,
        opacity: 0.45,
        interactive: false,
      }).addTo(map);
    },
    drawCourse(segments, options) {
      previewLine?.remove();
      previewLine = null;
      courseLayer?.remove();
      courseLayer = L.layerGroup();
      const opacity = options?.faded ? 0.45 : 0.9;
      for (const seg of segments) {
        const latlngs: [number, number][] = [];
        for (let i = 0; i < seg.lats.length; i++) latlngs.push([seg.lats[i]!, seg.lons[i]!]);
        L.polyline(latlngs, {
          color: SURFACE_COLORS[seg.surface] ?? SURFACE_COLORS[3]!,
          weight: 4,
          opacity,
        }).addTo(courseLayer);
      }
      const last = segments[segments.length - 1];
      if (last && !options?.faded) {
        const i = last.lats.length - 1;
        L.circleMarker([last.lats[i]!, last.lons[i]!], {
          radius: 6,
          color: '#111',
          fillColor: '#fff',
          fillOpacity: 1,
        }).addTo(courseLayer);
      }
      courseLayer.addTo(map);
    },
    decorateCourse(points) {
      if (!courseLayer) return;
      for (let i = KM_SAMPLE_STRIDE; i < points.length; i += KM_SAMPLE_STRIDE) {
        const km = i / KM_SAMPLE_STRIDE;
        L.marker([points[i]!.lat, points[i]!.lon], {
          interactive: false,
          icon: L.divIcon({ className: 'km-marker', html: String(km), iconSize: [20, 20] }),
        }).addTo(courseLayer);
      }
      for (let i = ARROW_SAMPLE_STRIDE; i < points.length - 1; i += ARROW_SAMPLE_STRIDE) {
        if (i % KM_SAMPLE_STRIDE === 0) continue; // don't stack on km labels
        const p = points[i]!;
        const q = points[i + 1]!;
        const bearing = bearingDeg(p.lat, p.lon, q.lat, q.lon);
        L.marker([p.lat, p.lon], {
          interactive: false,
          icon: L.divIcon({
            className: 'dir-arrow',
            html: `<span style="transform: rotate(${(bearing - 90).toFixed(0)}deg)">➤</span>`,
            iconSize: [16, 16],
          }),
        }).addTo(courseLayer);
      }
    },
    clearCourse() {
      previewLine?.remove();
      previewLine = null;
      courseLayer?.remove();
      courseLayer = null;
      windowBox?.remove();
      windowBox = null;
      nodeLayer?.remove();
      nodeLayer = null;
      pointMarker?.remove();
      pointMarker = null;
      pointPill?.remove();
      pointPill = null;
      hoverPoints = [];
      hoverDescribe = null;
      hideHover();
    },
    showCoursePoint(point, look = 'pick', label) {
      const className = look === 'hover' ? 'hover-point' : 'course-point';
      if (pointMarker && pointMarkerClass !== className) {
        pointMarker.remove();
        pointMarker = null;
      }
      pointMarkerClass = className;
      if (!pointMarker) {
        pointMarker = L.marker([point.lat, point.lon], {
          pane: EDIT_PANE,
          interactive: false,
          icon: L.divIcon({ className, iconSize: [16, 16] }),
        }).addTo(map);
      } else {
        pointMarker.setLatLng([point.lat, point.lon]);
      }
      if (!label) {
        pointPill?.remove();
        pointPill = null;
        return;
      }
      if (!pointPill) {
        pointPill = L.tooltip({
          permanent: true,
          direction: 'top',
          offset: [0, -14],
          className: 'hover-pill',
          interactive: false,
        }).setLatLng([point.lat, point.lon]);
        pointPill.addTo(map);
      } else {
        pointPill.setLatLng([point.lat, point.lon]);
      }
      pointPill.setContent(label);
    },
    hideCoursePoint() {
      pointMarker?.remove();
      pointMarker = null;
      pointPill?.remove();
      pointPill = null;
    },
    showPointLabel,
    hidePointLabel,
    armHoverReadout(points, describe) {
      hoverPoints = points;
      hoverDescribe = describe;
    },
    disarmHoverReadout() {
      hoverPoints = [];
      hoverDescribe = null;
      hideHover();
    },
    cancelPull() {
      if (!pullStart) return false;
      clearHoldTimer();
      clearCycleTimer();
      clearRubber();
      hidePointLabel();
      pullStart = null;
      pullIndex = -1;
      pullOnLine = false;
      pullAnchors = null;
      pullLatLng = null;
      pullHeld = false;
      map.dragging.enable();
      map.scrollWheelZoom.enable();
      // The release still to come must not be read as a tap on the course.
      lastDragEnd = Date.now();
      return true;
    },
    getStart() {
      if (!marker) return null;
      const { lat, lng } = marker.getLatLng();
      return { lat, lon: lng };
    },
    setStart(start) {
      placeStart(L.latLng(start.lat, start.lon));
      map.setView([start.lat, start.lon], Math.max(map.getZoom(), 13), { animate: false });
      // Centred in the window is under the sheet when the sheet is up: shift
      // the view so the marker sits in the middle of the map that can be seen.
      const hid = obscured?.();
      if (hid) map.panBy([-hid.left / 2, hid.bottom / 2], { animate: false });
    },
    setRadius(meters: number) {
      radiusMeters = meters;
      circle?.setRadius(meters);
    },
    onStartChange(cb) {
      changeCb = cb;
    },
  };
}
