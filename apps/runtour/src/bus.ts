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
  type BusLineData,
} from '@running/core/net/busRoutes';
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

const lineLabel = (line: BusLineData): string => {
  const kind = line.kind === 'tram' ? 'Tram' : 'Bus';
  return line.ref ? `${kind} ${line.ref} → ${line.to ?? line.name}` : line.name;
};

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

function matchesText(line: BusLineData, text: string): boolean {
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

export function initBusLines({ map, sheet, onRoute, onClear }: BusLinesOptions): void {
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

  async function fetchArea(bbox: BBox): Promise<void> {
    const key =
      `${bbox.south.toFixed(3)},${bbox.west.toFixed(3)},` +
      `${bbox.north.toFixed(3)},${bbox.east.toFixed(3)}`;
    setBusStatus('Looking for bus and tram lines… the public Overpass servers can take a minute.');
    const response = await fetchOverpass(buildBusAreaQuery(bbox), `busarea:v1:${key}`, PATIENT);
    lines = parseBusLines(response.elements as unknown as BusAreaElement[]);
    await saveBusArea(key, bbox, lines);
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
          // Already-loaded lines answer instantly; Overpass only for strangers.
          const local = lines.filter((l) => matchesText(l, text));
          if (local.length > 0) {
            renderList(local);
            setBusStatus(`${local.length} lines matching “${text}”:`);
          } else {
            await fetchSearch(text);
          }
          return;
        }
        const view = viewBBox();
        const bounds = map.getBounds();
        if (bounds.getNorthWest().distanceTo(bounds.getSouthEast()) > MAX_VIEW_DIAGONAL_M) {
          setBusStatus(
            'Zoom in a little — every line crossing this much map would be a heavy download.',
          );
          return;
        }
        // A window fetched once serves from the store forever.
        const area = (await storedBusAreas()).find((a) => covers(a.bbox, view));
        const stored = area ? await cacheGet<BusLineData[]>(`buslines:${area.key}`) : undefined;
        if (stored && stored.length > 0) {
          lines = stored;
          renderList();
          setBusStatus(`${lines.length} lines (already downloaded) — tap one to preview:`);
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

  // Last session's lines greet the next one; Find refreshes or widens.
  void (async () => {
    const areas = await storedBusAreas();
    const latest = areas.sort((a, b) => b.savedAt - a.savedAt)[0];
    if (!latest || selected) return;
    const stored = await cacheGet<BusLineData[]>(`buslines:${latest.key}`);
    if (stored && stored.length > 0 && lines.length === 0) {
      lines = stored;
      renderList();
      setBusStatus(`${lines.length} lines from last time — Find lines here refreshes.`);
    }
  })();

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
    fromSel.value = '0';
    toSel.value = String(line.stops.length - 1);
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
    clear.hidden = false;
    onRoute(name, points);
  });

  clear.addEventListener('click', () => {
    clear.hidden = true;
    clearPreview();
    list.hidden = lines.length === 0;
    setBusStatus('');
    onClear();
  });
}
