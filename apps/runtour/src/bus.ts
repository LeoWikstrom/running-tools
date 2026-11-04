import L from 'leaflet';
import type { GpxPoint } from '@running/core/gpx/parse';
import type { LatLon } from '@running/core/geo';
import {
  buildBusAreaQuery,
  buildBusSearchQuery,
  cropBetweenStops,
  parseBusLines,
  type BBox,
  type BusAreaElement,
  type BusLine,
  type BusLineData,
} from '@running/core/net/busRoutes';
import { gtfsLineToBusLineData, type GtfsFeedLines } from '@running/core/net/gtfsLines';
import { cacheGet, cacheSet } from '@running/core/net/cache';
import { fetchOverpass } from '@running/core/net/overpass';
import { fitVisible } from './ui/visibleMap';
import { toast } from './ui/toast';
import { PLACE_COLOR } from './variant';

// A deliberate button press can out-wait busy public mirrors, which often sit
// silent well past the default 25 s before answering.
const PATIENT = { headerTimeoutMs: 90_000 };
/** A bigger viewport than this would pull every line of half the city. */
const MAX_VIEW_DIAGONAL_M = 12_000;

const lineLabel = (line: BusLine): string => {
  const kind = line.kind === 'tram' ? 'Tram' : 'Bus';
  return line.ref ? `${kind} ${line.ref} → ${line.to ?? line.name}` : line.name;
};

/** Stored windows from the (reverted) tags-only experiment lack geometry;
    only full entries can be hotswapped into the picker. */
const fullLines = (stored: BusLineData[] | undefined): BusLineData[] =>
  (stored ?? []).filter((l) => Array.isArray(l.points) && l.points.length >= 2 && l.stops);

// Downloaded line areas persist, so revisiting a window costs nothing.
interface StoredBusArea {
  key: string;
  bbox: BBox;
  savedAt: number;
}

const AREAS_KEY = 'buslines:index:v1';

async function storedBusAreas(): Promise<StoredBusArea[]> {
  return (await cacheGet<StoredBusArea[]>(AREAS_KEY)) ?? [];
}

async function saveBusArea(key: string, bbox: BBox, lines: BusLineData[]): Promise<void> {
  await cacheSet(`buslines:${key}`, lines);
  const areas = (await storedBusAreas()).filter((a) => a.key !== key);
  areas.push({ key, bbox, savedAt: Date.now() });
  await cacheSet(AREAS_KEY, areas);
}

const areaKey = (bbox: BBox): string =>
  `${bbox.south.toFixed(3)},${bbox.west.toFixed(3)},` +
  `${bbox.north.toFixed(3)},${bbox.east.toFixed(3)}`;

/**
 * Prebuilt GTFS line files (scripts/build-gtfs-lines.ts, refreshed weekly by
 * CI): the whole operator's lines in one static JSON — instant and gapless
 * where a feed covers the view; Overpass remains the path everywhere else.
 * The relative URL serves whichever host the app is deployed on (github.io,
 * eq2.se/apps/); the absolute one covers the dev server and the APK.
 */
const GTFS_FEEDS = [
  {
    id: 'vt', // Västtrafik ≈ Västra Götaland
    bbox: { south: 56.8, west: 10.8, north: 59.5, east: 15.0 },
    urls: ['../gtfs/vt.json', 'https://leowikstrom.github.io/running-tools/gtfs/vt.json'],
  },
];
const FEED_MAX_AGE_MS = 7 * 24 * 3600_000;

/** The covering feed's lines, from the cache or the static file; null when no
    feed covers the view or the file is unreachable and nothing is cached. */
async function feedLines(view: BBox): Promise<BusLineData[] | null> {
  const feed = GTFS_FEEDS.find((f) => covers(f.bbox, view));
  if (!feed) return null;
  const key = `gtfslines:${feed.id}:v1`;
  const stored = await cacheGet<{ savedAt: number; data: GtfsFeedLines }>(key);
  let data = stored?.data ?? null;
  if (!stored || Date.now() - stored.savedAt > FEED_MAX_AGE_MS) {
    for (const url of feed.urls) {
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        data = (await res.json()) as GtfsFeedLines;
        await cacheSet(key, { savedAt: Date.now(), data });
        break;
      } catch {
        // Offline or not yet published — the stale copy (or Overpass) serves.
      }
    }
  }
  if (!data || data.lines.length === 0) return null;
  return data.lines.map(gtfsLineToBusLineData);
}

const covers = (outer: BBox, inner: BBox): boolean =>
  outer.south <= inner.south &&
  outer.west <= inner.west &&
  outer.north >= inner.north &&
  outer.east >= inner.east;

/** "Tram 3", "spårvagn 3", "bus 16" → kind + line number; else a free term.
    OSM refs/names rarely contain the word "tram", but the app's labels do —
    this is what someone types after reading the list. */
function parseLineQuery(text: string): { kind?: 'bus' | 'tram'; term: string } {
  const t = text.trim().toLowerCase();
  const m = /^(tram|spårvagn|bus|buss)\s+(.+)$/.exec(t);
  if (!m) return { term: t };
  return { kind: m[1] === 'tram' || m[1] === 'spårvagn' ? 'tram' : 'bus', term: m[2]! };
}

const pointInBBox = (lat: number, lon: number, b: BBox): boolean =>
  lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east;

/** Whether the line actually crosses the view — a stored area can be much
    bigger than the window the user is looking at. */
function lineInView(line: BusLineData, view: BBox): boolean {
  const pts = line.points;
  const stride = Math.max(1, Math.floor(pts.length / 200));
  for (let i = 0; i < pts.length; i += stride) {
    if (pointInBBox(pts[i]!.lat, pts[i]!.lon, view)) return true;
  }
  const last = pts[pts.length - 1]!;
  return pointInBBox(last.lat, last.lon, view);
}

function matchesText(line: BusLine, text: string): boolean {
  const { kind, term } = parseLineQuery(text);
  if (kind && line.kind !== kind) return false;
  return (
    line.ref.toLowerCase() === term ||
    line.name.toLowerCase().includes(term) ||
    lineLabel(line).toLowerCase().includes(text.trim().toLowerCase())
  );
}

export interface BusLinesOptions {
  map: L.Map;
  sheet: HTMLElement;
  onRoute: (name: string, points: GpxPoint[]) => void;
  onClear: () => void;
}

export interface BusLinesHandle {
  /** Keeps "Clear route" in step with the editor — tours arrive from the
      session restore, tour.json and the shelf too, not only the picker. */
  reflectCourse(hasCourse: boolean): void;
}

export function initBusLines({ map, sheet, onRoute, onClear }: BusLinesOptions): BusLinesHandle {
  const find = document.getElementById('bus-find') as HTMLButtonElement;
  const search = document.getElementById('bus-search') as HTMLInputElement;
  const clear = document.getElementById('bus-clear') as HTMLButtonElement;
  const status = document.getElementById('bus-status') as HTMLParagraphElement;
  const list = document.getElementById('bus-list') as HTMLUListElement;
  const pick = document.getElementById('bus-pick') as HTMLDivElement;
  const pickName = document.getElementById('bus-pick-name') as HTMLParagraphElement;
  const fromSel = document.getElementById('bus-from') as HTMLSelectElement;
  const toSel = document.getElementById('bus-to') as HTMLSelectElement;
  const use = document.getElementById('bus-use') as HTMLButtonElement;
  const back = document.getElementById('bus-back') as HTMLButtonElement;

  let lines: BusLineData[] = [];
  let selected: BusLineData | null = null;
  let cropped: LatLon[] = [];
  const previewLayer = L.layerGroup().addTo(map);

  const setBusStatus = (text: string): void => {
    status.textContent = text;
    status.hidden = text.length === 0;
  };

  document.getElementById('bus-info')!.addEventListener('click', () => {
    toast(
      'Pan the map to where you ride, or search by line number. Picking a line previews it ' +
        'on the map; choose the stops to ride between and create the tour — the places along ' +
        'the way and their texts follow by themselves.',
      8000,
    );
  });

  function clearPreview(): void {
    previewLayer.clearLayers();
    selected = null;
    cropped = [];
    pick.hidden = true;
  }

  function renderList(shown: BusLineData[] = lines): void {
    list.replaceChildren(
      ...shown.map((line) => {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.textContent = lineLabel(line);
        btn.addEventListener('click', () => select(line));
        li.appendChild(btn);
        return li;
      }),
    );
    list.hidden = shown.length === 0;
  }

  const viewBBox = (): BBox => {
    const bounds = map.getBounds();
    return {
      south: bounds.getSouth(),
      west: bounds.getWest(),
      north: bounds.getNorth(),
      east: bounds.getEast(),
    };
  };

  /** Fetch every line crossing the view, full geometry and stops. A `refresh`
      call is the revalidate half of stale-while-revalidate: it goes to the
      network past the cache, and leaves the UI alone if the user moved on.
      The interactive call streams: the query outputs relations, then stop
      nodes, then way geometry, so the list shows almost immediately and each
      line becomes tappable the moment its last member way arrives. */
  async function fetchArea(bbox: BBox, refresh = false): Promise<void> {
    const key = areaKey(bbox);
    if (!refresh) {
      setBusStatus('Looking for bus and tram lines… the public servers can take a minute.');
    }

    let streamed: BusAreaElement[] = [];
    const wayIds = new Set<number>();
    let relCount = 0;
    let readyCount = 0;
    let bytes = 0;
    let lastPaint = 0;
    const statusLine = (): string =>
      `Receiving lines… ${readyCount} of ${relCount} ready · ${(bytes / 1e6).toFixed(1)} MB`;
    const relationReady = (r: { members?: { type: string; ref: number; role: string }[] }): boolean =>
      (r.members ?? []).every(
        (m) => m.type !== 'way' || /stop|platform/.test(m.role) || wayIds.has(m.ref),
      );
    const paintPartial = (): void => {
      if (!pick.hidden) return; // the user is picking stops on a line
      const relations = streamed.filter((el) => el.type === 'relation');
      relCount = relations.length;
      const ready = relations.filter(relationReady);
      if (ready.length === readyCount) {
        setBusStatus(statusLine());
        return;
      }
      const now = Date.now();
      if (now - lastPaint < 400) return;
      lastPaint = now;
      const parsed = parseBusLines([...streamed.filter((el) => el.type !== 'relation'), ...ready]);
      readyCount = ready.length;
      lines = parsed;
      renderList();
      setBusStatus(statusLine());
    };

    const response = await fetchOverpass(buildBusAreaQuery(bbox), `busarea:v1:${key}`, {
      ...PATIENT,
      skipCacheRead: refresh,
      ...(refresh ? { rounds: 1 } : {}),
      ...(refresh
        ? {}
        : {
            onBytes: (b: number) => {
              bytes = b;
              setBusStatus(statusLine());
            },
            onElement: (el: Record<string, unknown>) => {
              streamed.push(el as unknown as BusAreaElement);
              if (el.type === 'way') wayIds.add(el.id as number);
              if (el.type === 'way' || el.type === 'relation') paintPartial();
            },
            onStreamRestart: () => {
              streamed = [];
              wayIds.clear();
              relCount = 0;
              readyCount = 0;
            },
          }),
    });
    const found = parseBusLines(response.elements as unknown as BusAreaElement[]);
    await saveBusArea(key, bbox, found);
    lines = found;
    if (!pick.hidden) {
      // The user is already picking stops on a line; don't yank the list up.
      return;
    }
    renderList();
    setBusStatus(
      lines.length === 0
        ? 'No bus or tram lines found here — pan or zoom and try again.'
        : `${lines.length} lines — tap one to see it on the map (one entry per direction):`,
    );
  }

  /** A targeted ref/name search over a widened box, for lines not yet loaded. */
  async function fetchSearch(text: string): Promise<void> {
    const v = viewBBox();
    const padLat = (v.north - v.south) * 1.5;
    const padLon = (v.east - v.west) * 1.5;
    const bbox: BBox = {
      south: v.south - padLat,
      west: v.west - padLon,
      north: v.north + padLat,
      east: v.east + padLon,
    };
    const { kind, term } = parseLineQuery(text);
    setBusStatus(`Searching for “${text}”… the public Overpass servers can take a minute.`);
    const key = `bussearch:v2:${kind ?? 'any'}:${term}:${bbox.south.toFixed(2)},${bbox.west.toFixed(2)}`;
    const response = await fetchOverpass(buildBusSearchQuery(bbox, term, kind), key, PATIENT);
    const found = parseBusLines(response.elements as unknown as BusAreaElement[]);
    // Found lines join the pool so previews and later filters stay instant.
    const known = new Set(lines.map((l) => l.id));
    lines = [...lines, ...found.filter((l) => !known.has(l.id))];
    renderList(found);
    setBusStatus(
      found.length === 0
        ? `Nothing named or numbered “${text}” around here.`
        : `${found.length} lines matching “${text}”:`,
    );
  }

  find.addEventListener('click', () => {
    const text = search.value.trim();
    find.disabled = true;
    clearPreview();
    void (async () => {
      try {
        if (text.length > 0) {
          // Already-loaded lines answer instantly; then the feed; Overpass
          // only for strangers.
          const local = lines.filter((l) => matchesText(l, text));
          if (local.length > 0) {
            renderList(local);
            setBusStatus(`${local.length} lines matching “${text}”:`);
            return;
          }
          const feed = await feedLines(viewBBox());
          const inFeed = feed?.filter((l) => matchesText(l, text)) ?? [];
          if (inFeed.length > 0) {
            const known = new Set(lines.map((l) => l.id));
            lines = [...lines, ...inFeed.filter((l) => !known.has(l.id))];
            renderList(inFeed);
            setBusStatus(`${inFeed.length} lines matching “${text}”:`);
            return;
          }
          await fetchSearch(text);
          return;
        }
        const view = viewBBox();
        // A covering GTFS feed answers instantly, whole and gapless — no
        // Overpass, no zoom limit (the data is already here).
        const fromFeed = await feedLines(view);
        if (fromFeed) {
          lines = fromFeed;
          const visible = lines.filter((l) => lineInView(l, view));
          renderList(visible);
          setBusStatus(
            visible.length === 0
              ? 'No bus or tram lines cross this view — pan or zoom and try again.'
              : `${visible.length} lines through this view (timetable data) — tap one:`,
          );
          return;
        }
        const bounds = map.getBounds();
        if (bounds.getNorthWest().distanceTo(bounds.getSouthEast()) > MAX_VIEW_DIAGONAL_M) {
          setBusStatus(
            'Zoom in a little — every line crossing this much map would be a heavy download.',
          );
          return;
        }
        // Stale-while-revalidate: a window fetched before answers instantly
        // from the store, and a background refresh keeps it honest.
        const area = (await storedBusAreas()).find((a) => covers(a.bbox, view));
        const stored = fullLines(
          area ? await cacheGet<BusLineData[]>(`buslines:${area.key}`) : undefined,
        );
        if (stored.length > 0) {
          lines = stored;
          const visible = lines.filter((l) => lineInView(l, view));
          renderList(visible);
          setBusStatus(
            visible.length === 0
              ? 'No bus or tram lines cross this view — pan or zoom and try again.'
              : `${visible.length} lines through this view (saved) — tap one:`,
          );
          try {
            await fetchArea(view, true);
          } catch {
            // The saved list is already up; a failed refresh changes nothing.
          }
          return;
        }
        await fetchArea(view);
      } catch (err) {
        setBusStatus(err instanceof Error ? err.message : String(err));
      } finally {
        find.disabled = false;
      }
    })();
  });

  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') find.click();
  });

  // Last session's lines greet the next one, when any cross the start view.
  void (async () => {
    const areas = await storedBusAreas();
    const latest = areas.sort((a, b) => b.savedAt - a.savedAt)[0];
    if (!latest || selected) return;
    const stored = fullLines(await cacheGet<BusLineData[]>(`buslines:${latest.key}`));
    if (stored.length === 0 || lines.length > 0) return;
    const view = viewBBox();
    const intersects =
      latest.bbox.south <= view.north &&
      latest.bbox.north >= view.south &&
      latest.bbox.west <= view.east &&
      latest.bbox.east >= view.west;
    if (!intersects) return;
    lines = stored;
    const visible = lines.filter((l) => lineInView(l, view));
    if (visible.length === 0) return;
    renderList(visible);
    setBusStatus(`${visible.length} lines from last time — Find lines refreshes.`);
  })();

  // Prewarm: fetch the start view's lines once the session restore has
  // settled the map, so the first Find lines answers instantly from the
  // store. Best-effort guest behaviour — one round, silence on failure.
  setTimeout(() => {
    void (async () => {
      try {
        const view = viewBBox();
        // A covering feed makes Overpass unnecessary; warm its cache instead.
        if (GTFS_FEEDS.some((f) => covers(f.bbox, view))) {
          await feedLines(view);
          return;
        }
        const bounds = map.getBounds();
        if (bounds.getNorthWest().distanceTo(bounds.getSouthEast()) > MAX_VIEW_DIAGONAL_M) return;
        if ((await storedBusAreas()).some((a) => covers(a.bbox, view))) return;
        const response = await fetchOverpass(buildBusAreaQuery(view), `busarea:v1:${areaKey(view)}`, {
          ...PATIENT,
          rounds: 1,
        });
        const found = parseBusLines(response.elements as unknown as BusAreaElement[]);
        await saveBusArea(areaKey(view), view, found);
      } catch {
        // Prewarming is a favour, not a promise.
      }
    })();
  }, 3000);

  function fillStops(select: HTMLSelectElement, stops: BusLineData['stops']): void {
    select.replaceChildren(
      ...stops.map((s, i) => {
        const option = document.createElement('option');
        option.value = String(i);
        option.textContent = s.name;
        return option;
      }),
    );
  }

  function updateCrop(): void {
    if (!selected) return;
    const line = selected;
    cropped =
      line.stops.length >= 2
        ? cropBetweenStops(line.points, line.stops[Number(fromSel.value)]!, line.stops[Number(toSel.value)]!)
        : line.points;
    previewLayer.clearLayers();
    // The whole line faintly underneath; the chosen stretch full strength.
    const all = line.points.map((p) => [p.lat, p.lon] as [number, number]);
    L.polyline(all, { color: PLACE_COLOR, weight: 3, opacity: 0.35 }).addTo(previewLayer);
    const strong = L.polyline(
      cropped.map((p) => [p.lat, p.lon] as [number, number]),
      { color: PLACE_COLOR, weight: 5 },
    ).addTo(previewLayer);
    for (const s of line.stops) {
      L.circleMarker([s.lat, s.lon], {
        radius: 4,
        color: PLACE_COLOR,
        fillColor: '#ffffff',
        fillOpacity: 1,
        weight: 2,
      })
        .bindTooltip(s.name)
        .addTo(previewLayer);
    }
    fitVisible(map, sheet, strong.getBounds());
  }

  function select(line: BusLineData): void {
    selected = line;
    pickName.textContent = lineLabel(line);
    const noStops = line.stops.length < 2;
    fillStops(fromSel, line.stops);
    fillStops(toSel, line.stops);
    // A long line defaults to the stretch inside the window being looked at —
    // picking a line over Kålltorp should not propose Kungsbacka–Kungälv.
    const view = viewBBox();
    const within = line.stops
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => pointInBBox(s.lat, s.lon, view));
    fromSel.value = String(within.length >= 2 ? within[0]!.i : 0);
    toSel.value = String(within.length >= 2 ? within[within.length - 1]!.i : line.stops.length - 1);
    fromSel.disabled = noStops;
    toSel.disabled = noStops;
    list.hidden = true;
    pick.hidden = false;
    setBusStatus(noStops ? 'This line has no stops mapped — the tour takes the whole route.' : '');
    if (line.gaps > 0) {
      toast(`The OSM route has ${line.gaps} gap${line.gaps > 1 ? 's' : ''} — check the drawn line.`, 6000);
    }
    updateCrop();
  }

  fromSel.addEventListener('change', updateCrop);
  toSel.addEventListener('change', updateCrop);

  back.addEventListener('click', () => {
    clearPreview();
    list.hidden = lines.length === 0;
    setBusStatus('');
  });

  use.addEventListener('click', () => {
    if (!selected || cropped.length < 2) return;
    const line = selected;
    const stops = line.stops;
    const name =
      stops.length >= 2
        ? `${lineLabel(line)}: ${stops[Number(fromSel.value)]!.name} → ${stops[Number(toSel.value)]!.name}`
        : lineLabel(line);
    const points = cropped.map((p) => ({ lat: p.lat, lon: p.lon, ele: null }));
    clearPreview();
    list.hidden = true;
    setBusStatus('');
    onRoute(name, points);
  });

  clear.addEventListener('click', () => {
    clearPreview();
    list.hidden = lines.length === 0;
    setBusStatus('');
    onClear();
  });

  return {
    reflectCourse(hasCourse: boolean): void {
      clear.hidden = !hasCourse;
    },
  };
}
