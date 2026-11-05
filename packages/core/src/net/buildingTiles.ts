import type { LatLon } from '../geo';
import { haversineMeters } from '../geo';
import type { BuildingPoly } from '../geo/los';
import { cacheGetFresh, cacheSetStamped } from './cache';
import { decodePolyline } from './gtfsLines';
import { SWEDEN_BBOX, tileId, tilesCovering } from './networkTiles';

/**
 * Pre-baked Swedish building footprints, the sibling of the network tiles:
 * the same CI job exports buildings via osmium (geometry inline, no node
 * joining) and scripts/build-building-tiles.ts packs each footprint as a
 * polyline-encoded ring — no tags, ~6 bytes a vertex — into the same grid on
 * the same network-tiles branch, under its own manifest. Buildings are OSM's
 * heaviest layer; the live quadrant fetch stays as the fallback.
 */

export interface BuildingTile {
  version: 1;
  /** [id, encoded ring] pairs; ring closed, precision 1e-5. */
  buildings: [number, string][];
}

export interface BuildingManifest {
  version: 1;
  generated: string;
  latStep: number;
  lonStep: number;
  tiles: string[];
}

const RAW_BASE = 'https://raw.githubusercontent.com/LeoWikstrom/running-tools/network-tiles';
const MANIFEST_MAX_AGE_MS = 24 * 3600_000;
const TILE_MAX_AGE_MS = 45 * 24 * 3600_000;

export interface FetchBuildingTilesOptions {
  fetchFn?: typeof fetch;
}

async function cachedJson<T>(
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
 * Footprints with any vertex inside the circle, from pre-baked tiles; null
 * when the circle leaves the covered box or a tile cannot be had — the
 * caller falls back to the live Overpass fetch.
 */
export async function fetchBuildingTiles(
  center: LatLon,
  radiusMeters: number,
  options: FetchBuildingTilesOptions = {},
): Promise<BuildingPoly[] | null> {
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
  let manifest: BuildingManifest | null;
  try {
    manifest = await cachedJson<BuildingManifest>(
      `${RAW_BASE}/index-bld.json`,
      'bldtile:manifest:v1',
      MANIFEST_MAX_AGE_MS,
      fetchFn,
    );
  } catch {
    return null;
  }
  if (!manifest || manifest.version !== 1) return null;
  const present = new Set(manifest.tiles);
  const wanted = tilesCovering(center, radiusMeters).filter((t) => present.has(tileId(t.x, t.y)));
  if (wanted.length === 0) return null;

  const seen = new Set<number>();
  const out: BuildingPoly[] = [];
  for (const t of wanted) {
    const id = tileId(t.x, t.y);
    let tile: BuildingTile | null;
    try {
      tile = await cachedJson<BuildingTile>(
        `${RAW_BASE}/bld_${id}.json`,
        `bldtile:v1:${id}`,
        TILE_MAX_AGE_MS,
        fetchFn,
      );
    } catch {
      return null;
    }
    if (!tile || tile.version !== 1) return null;
    for (const [bid, encoded] of tile.buildings) {
      if (seen.has(bid)) continue;
      const ring = decodePolyline(encoded);
      if (ring.length < 3) continue;
      if (!ring.some((p) => haversineMeters(center.lat, center.lon, p.lat, p.lon) <= radiusMeters)) {
        continue;
      }
      seen.add(bid);
      out.push({ id: bid, lats: ring.map((p) => p.lat), lons: ring.map((p) => p.lon) });
    }
  }
  return out;
}
