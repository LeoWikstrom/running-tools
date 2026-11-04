import type { LatLon } from '../geo';
import { cacheGetFresh, cacheSetStamped } from './cache';
import {
  filterByRadius,
  mergeOverpassResponses,
  type OverpassResponse,
} from './overpass';

/**
 * Pre-baked Sweden path-network tiles: a monthly CI job
 * (.github/workflows/network-tiles.yml + scripts/build-network-tiles.ts)
 * filters the Geofabrik Sweden extract to exactly what buildQuery asks
 * Overpass for and splits it into fixed-grid JSON tiles on the orphan
 * `network-tiles` branch. raw.githubusercontent.com serves them with
 * CORS * and transparent gzip (verified; GitHub release assets send no
 * CORS headers at all, which is why the branch hosts them). Inside the
 * covered box the network download is a CDN fetch; anywhere else — or on
 * any miss — the caller falls back to Overpass.
 */

/** ~22 km squares at Swedish latitudes. */
export const TILE_LAT_STEP = 0.2;
export const TILE_LON_STEP = 0.4;

export const SWEDEN_BBOX = { south: 55.0, west: 10.5, north: 69.2, east: 24.2 };

const RAW_BASE = 'https://raw.githubusercontent.com/LeoWikstrom/running-tools/network-tiles';

export interface TileManifest {
  version: 1;
  generated: string;
  latStep: number;
  lonStep: number;
  /** Present tile ids ("x_y"); a covering tile missing here is empty sea. */
  tiles: string[];
}

export const tileId = (x: number, y: number): string => `${x}_${y}`;

/** Grid indices are global: x = floor(lon/step), y = floor(lat/step). */
export function tilesCovering(center: LatLon, radiusMeters: number): { x: number; y: number }[] {
  const latPad = radiusMeters / 111_320;
  const lonPad = latPad / Math.cos((center.lat * Math.PI) / 180);
  const x0 = Math.floor((center.lon - lonPad) / TILE_LON_STEP);
  const x1 = Math.floor((center.lon + lonPad) / TILE_LON_STEP);
  const y0 = Math.floor((center.lat - latPad) / TILE_LAT_STEP);
  const y1 = Math.floor((center.lat + latPad) / TILE_LAT_STEP);
  const out: { x: number; y: number }[] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push({ x, y });
  return out;
}

export interface FetchTilesOptions {
  fetchFn?: typeof fetch;
  /** Called after each tile lands (fetched or from cache). */
  onTile?: (done: number, total: number) => void;
}

const MANIFEST_MAX_AGE_MS = 24 * 3600_000;
const TILE_MAX_AGE_MS = 45 * 24 * 3600_000;

async function cachedFetchJson<T>(
  url: string,
  cacheKey: string,
  maxAgeMs: number,
  fetchFn: typeof fetch,
): Promise<T | null> {
  const cached = await cacheGetFresh<T>(cacheKey, maxAgeMs);
  if (cached !== undefined) return cached;
  const res = await fetchFn(url);
  if (!res.ok) return null;
  const json = (await res.json()) as T;
  await cacheSetStamped(cacheKey, json);
  return json;
}

/**
 * The network for a circle, assembled from pre-baked tiles; null when the
 * circle leaves the covered box or any needed tile cannot be had — the
 * caller then falls back to Overpass.
 */
export async function fetchNetworkTiles(
  center: LatLon,
  radiusMeters: number,
  options: FetchTilesOptions = {},
): Promise<OverpassResponse | null> {
  const fetchFn = options.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const latPad = radiusMeters / 111_320;
  const lonPad = latPad / Math.cos((center.lat * Math.PI) / 180);
  if (
    center.lat - latPad < SWEDEN_BBOX.south ||
    center.lat + latPad > SWEDEN_BBOX.north ||
    center.lon - lonPad < SWEDEN_BBOX.west ||
    center.lon + lonPad > SWEDEN_BBOX.east
  ) {
    return null;
  }
  let manifest: TileManifest | null;
  try {
    manifest = await cachedFetchJson<TileManifest>(
      `${RAW_BASE}/index.json`,
      'nettile:manifest:v1',
      MANIFEST_MAX_AGE_MS,
      fetchFn,
    );
  } catch {
    return null;
  }
  if (!manifest || manifest.version !== 1) return null;
  const present = new Set(manifest.tiles);
  const wanted = tilesCovering(center, radiusMeters).filter((t) => present.has(tileId(t.x, t.y)));
  // A tile absent from the manifest is empty sea — but a circle touching NO
  // present tile is likelier outside the baked data than on open water;
  // let Overpass answer rather than inventing an empty network.
  if (wanted.length === 0) return null;
  const responses: OverpassResponse[] = [];
  let done = 0;
  for (const t of wanted) {
    const id = tileId(t.x, t.y);
    let tile: OverpassResponse | null;
    try {
      tile = await cachedFetchJson<OverpassResponse>(
        `${RAW_BASE}/net_${id}.json`,
        `nettile:v1:${id}`,
        TILE_MAX_AGE_MS,
        fetchFn,
      );
    } catch {
      return null;
    }
    if (!tile || !Array.isArray(tile.elements)) return null;
    responses.push(tile);
    options.onTile?.(++done, wanted.length);
  }
  return filterByRadius(mergeOverpassResponses(responses), center, radiusMeters);
}
