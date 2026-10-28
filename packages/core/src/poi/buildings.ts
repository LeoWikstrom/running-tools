import { haversineMeters } from '../geo';
import type { BuildingPoly } from '../geo/los';
import { fetchOverpass, type FetchNetworkOptions } from '../net/overpass';

/** Overpass way from an `out geom` query: coordinates inline. */
interface GeomWayElement {
  type: string;
  id: number;
  geometry?: { lat: number; lon: number }[];
}

/**
 * Building footprints within `widthMeters` of the course, for line-of-sight
 * filtering. Same linestring `around` and thinning as buildPlacesQuery.
 */
export function buildBuildingsQuery(
  lats: ArrayLike<number>,
  lons: ArrayLike<number>,
  widthMeters: number,
): string {
  const coords: string[] = [];
  const n = lats.length;
  let lastLat = Infinity;
  let lastLon = Infinity;
  for (let i = 0; i < n; i++) {
    if (i > 0 && i < n - 1 && haversineMeters(lastLat, lastLon, lats[i]!, lons[i]!) < 100) {
      continue;
    }
    lastLat = lats[i]!;
    lastLon = lons[i]!;
    coords.push(lats[i]!.toFixed(5), lons[i]!.toFixed(5));
  }
  const around = `(around:${Math.round(widthMeters)},${coords.join(',')})`;
  return `[out:json][timeout:60];way[building]${around};out geom;`;
}

export function elementsToBuildings(elements: GeomWayElement[]): BuildingPoly[] {
  const out: BuildingPoly[] = [];
  for (const el of elements) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 3) continue;
    out.push({
      id: el.id,
      lats: el.geometry.map((g) => g.lat),
      lons: el.geometry.map((g) => g.lon),
    });
  }
  return out;
}

/** Footprints of a whole circle, for storing beside a downloaded area. */
export async function fetchAreaBuildings(
  center: { lat: number; lon: number },
  radiusMeters: number,
  options: FetchNetworkOptions = {},
): Promise<BuildingPoly[]> {
  const around = `(around:${Math.round(radiusMeters)},${center.lat.toFixed(6)},${center.lon.toFixed(6)})`;
  const query = `[out:json][timeout:120];way[building]${around};out geom;`;
  const key = `buildings:v1:area:${center.lat.toFixed(4)},${center.lon.toFixed(4)},${Math.round(radiusMeters)}`;
  const response = await fetchOverpass(query, key, options);
  return elementsToBuildings(response.elements as unknown as GeomWayElement[]);
}

export async function fetchBuildings(
  lats: ArrayLike<number>,
  lons: ArrayLike<number>,
  widthMeters: number,
  options: FetchNetworkOptions = {},
): Promise<BuildingPoly[]> {
  const mid = Math.floor(lats.length / 2);
  const key = `buildings:v1:${lats[0]?.toFixed(4)},${lons[0]?.toFixed(4)}:${lats[mid]?.toFixed(4)},${lons[mid]?.toFixed(4)}:${lats.length}:${Math.round(widthMeters)}`;
  const response = await fetchOverpass(buildBuildingsQuery(lats, lons, widthMeters), key, options);
  return elementsToBuildings(response.elements as unknown as GeomWayElement[]);
}
