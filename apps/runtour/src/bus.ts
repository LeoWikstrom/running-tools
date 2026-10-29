import L from 'leaflet';
import type { GpxPoint } from '@running/core/gpx/parse';
import type { LatLon } from '@running/core/geo';
import {
  buildBusAreaQuery,
  cropBetweenStops,
  parseBusLines,
  type BusAreaElement,
  type BusLineData,
} from '@running/core/net/busRoutes';
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

export interface BusLinesOptions {
  map: L.Map;
  sheet: HTMLElement;
  onRoute: (name: string, points: GpxPoint[]) => void;
  onClear: () => void;
}

export function initBusLines({ map, sheet, onRoute, onClear }: BusLinesOptions): void {
  const find = document.getElementById('bus-find') as HTMLButtonElement;
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

  function renderList(): void {
    list.replaceChildren(
      ...lines.map((line) => {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.textContent = lineLabel(line);
        btn.addEventListener('click', () => select(line));
        li.appendChild(btn);
        return li;
      }),
    );
    list.hidden = lines.length === 0;
  }

  find.addEventListener('click', () => {
    const bounds = map.getBounds();
    const diagonal = bounds.getNorthWest().distanceTo(bounds.getSouthEast());
    if (diagonal > MAX_VIEW_DIAGONAL_M) {
      setBusStatus('Zoom in a little — every line crossing this much map would be a heavy download.');
      return;
    }
    const bbox = {
      south: bounds.getSouth(),
      west: bounds.getWest(),
      north: bounds.getNorth(),
      east: bounds.getEast(),
    };
    const key =
      `busarea:v1:${bbox.south.toFixed(3)},${bbox.west.toFixed(3)},` +
      `${bbox.north.toFixed(3)},${bbox.east.toFixed(3)}`;
    find.disabled = true;
    clearPreview();
    setBusStatus('Looking for bus and tram lines… the public Overpass servers can take a minute.');
    void (async () => {
      try {
        const response = await fetchOverpass(buildBusAreaQuery(bbox), key, PATIENT);
        lines = parseBusLines(response.elements as unknown as BusAreaElement[]);
        renderList();
        setBusStatus(
          lines.length === 0
            ? 'No bus or tram lines found here — pan or zoom and try again.'
            : `${lines.length} lines — tap one to see it on the map (one entry per direction):`,
        );
      } catch (err) {
        setBusStatus(err instanceof Error ? err.message : String(err));
      } finally {
        find.disabled = false;
      }
    })();
  });

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
