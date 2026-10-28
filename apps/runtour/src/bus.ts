import type L from 'leaflet';
import type { GpxPoint } from '@running/core/gpx/parse';
import {
  assembleRoutePolyline,
  buildBusRouteGeomQuery,
  buildBusRoutesListQuery,
  relationsToBusLines,
  type BusLine,
  type OverpassGeomWay,
  type OverpassRelation,
} from '@running/core/net/busRoutes';
import { fetchOverpass } from '@running/core/net/overpass';
import { toast } from './ui/toast';

/** OSM maps most lines as one relation per direction; both get listed. */
const lineLabel = (line: BusLine): string =>
  line.ref && line.to ? `${line.ref} → ${line.to}` : line.name;

// A deliberate button press can out-wait busy public mirrors, which often sit
// silent well past the default 25 s before answering.
const PATIENT = { headerTimeoutMs: 90_000 };

async function fetchBusLines(center: L.LatLng, radiusM: number): Promise<BusLine[]> {
  const key = `busroutes:v2:${center.lat.toFixed(3)},${center.lng.toFixed(3)},${Math.round(radiusM / 100)}`;
  const query = buildBusRoutesListQuery({ lat: center.lat, lon: center.lng }, radiusM);
  const response = await fetchOverpass(query, key, PATIENT);
  return relationsToBusLines(response.elements as unknown as OverpassRelation[]);
}

async function fetchBusLinePolyline(id: number): Promise<{ points: GpxPoint[]; gaps: number }> {
  const response = await fetchOverpass(buildBusRouteGeomQuery(id), `busroute:v1:${id}`, PATIENT);
  const elements = response.elements as unknown as (OverpassRelation | OverpassGeomWay)[];
  const relation = elements.find((e) => e.type === 'relation' && e.id === id) as
    | OverpassRelation
    | undefined;
  if (!relation) throw new Error('The bus route relation came back empty.');
  const ways = new Map<number, OverpassGeomWay>();
  for (const e of elements) if (e.type === 'way') ways.set(e.id, e);
  const { points, gaps } = assembleRoutePolyline(relation, ways);
  if (points.length < 2) throw new Error('The bus route has no usable geometry.');
  return { points: points.map((p) => ({ lat: p.lat, lon: p.lon, ele: null })), gaps };
}

export interface BusLinesOptions {
  map: L.Map;
  onRoute: (name: string, points: GpxPoint[]) => void;
  onClear: () => void;
}

export function initBusLines({ map, onRoute, onClear }: BusLinesOptions): void {
  const find = document.getElementById('bus-find') as HTMLButtonElement;
  const clear = document.getElementById('bus-clear') as HTMLButtonElement;
  const status = document.getElementById('bus-status') as HTMLParagraphElement;
  const list = document.getElementById('bus-list') as HTMLUListElement;

  const setBusStatus = (text: string): void => {
    status.textContent = text;
    status.hidden = text.length === 0;
  };

  find.addEventListener('click', () => {
    // The viewport sets the search circle: zoomed out finds a whole city.
    const bounds = map.getBounds();
    const radiusM = Math.min(
      Math.max(bounds.getNorthWest().distanceTo(bounds.getSouthEast()) / 2, 800),
      5000,
    );
    find.disabled = true;
    setBusStatus('Looking for bus lines… the public Overpass servers can take a minute.');
    void (async () => {
      try {
        const lines = await fetchBusLines(map.getCenter(), radiusM);
        list.replaceChildren(
          ...lines.map((line) => {
            const li = document.createElement('li');
            const btn = document.createElement('button');
            btn.textContent = lineLabel(line);
            btn.addEventListener('click', () => pick(line));
            li.appendChild(btn);
            return li;
          }),
        );
        list.hidden = lines.length === 0;
        setBusStatus(
          lines.length === 0
            ? 'No bus lines found here — pan or zoom out and try again.'
            : `${lines.length} lines — pick one (most run as one entry per direction):`,
        );
      } catch (err) {
        setBusStatus(err instanceof Error ? err.message : String(err));
      } finally {
        find.disabled = false;
      }
    })();
  });

  function pick(line: BusLine): void {
    setBusStatus(`Fetching the route of ${lineLabel(line)}…`);
    void (async () => {
      try {
        const { points, gaps } = await fetchBusLinePolyline(line.id);
        if (gaps > 0) {
          toast(`The OSM route has ${gaps} gap${gaps > 1 ? 's' : ''} — check the drawn line.`, 6000);
        }
        list.hidden = true;
        list.replaceChildren();
        setBusStatus('');
        clear.hidden = false;
        onRoute(lineLabel(line), points);
      } catch (err) {
        setBusStatus(err instanceof Error ? err.message : String(err));
      }
    })();
  }

  clear.addEventListener('click', () => {
    clear.hidden = true;
    setBusStatus('');
    onClear();
  });
}
