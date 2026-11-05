import { haversineMeters } from '../geo';
import type { BuildingPoly } from '../geo/los';
import { fetchBuildingTiles } from '../net/buildingTiles';
import { fetchOverpass, quadrantBoxes, type FetchNetworkOptions } from '../net/overpass';

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

/**
 * Footprints of a whole circle, for storing beside a downloaded area.
 * Buildings are the heaviest single layer in OSM, so like the network this
 * fetches four bbox quadrants concurrently, each on its own mirror rotation;
 * the corner overshoot beyond the circle is harmless for line of sight.
 * Deduped by way id — a boundary building arrives whole in both quadrants.
 */
export async function fetchAreaBuildings(
  center: { lat: number; lon: number },
  radiusMeters: number,
  options: FetchNetworkOptions = {},
): Promise<BuildingPoly[]> {
  // Pre-baked footprint tiles answer first (CDN-fast inside Sweden).
  const tiled = await fetchBuildingTiles(center, radiusMeters, {
    fetchFn: options.fetchFn,
  }).catch(() => null);
  if (tiled) return tiled;
  const keyBase = `buildings:v2:area:${center.lat.toFixed(4)},${center.lon.toFixed(4)},${Math.round(radiusMeters)}`;
  const responses = await Promise.all(
    quadrantBoxes(center, radiusMeters).map((b, q) => {
      const box = `(${b.south.toFixed(6)},${b.west.toFixed(6)},${b.north.toFixed(6)},${b.east.toFixed(6)})`;
      return fetchOverpass(
        `[out:json][timeout:120];way[building]${box};out geom;`,
        `${keyBase}:q${q}`,
        { ...options, endpoints: [0, 1, 2, 3].map((i) => (q + i) % 4), race: 1 },
      );
    }),
  );
  const seen = new Set<number>();
  const elements: GeomWayElement[] = [];
  for (const r of responses as unknown as { elements: GeomWayElement[] }[]) {
    for (const el of r.elements) {
      if (seen.has(el.id)) continue;
      seen.add(el.id);
      elements.push(el);
    }
  }
  return elementsToBuildings(elements);
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
