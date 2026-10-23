import { haversineMeters } from '../shared/geo';
import type { LatLon } from '../shared/messages';
import { cacheGet, cacheSet, cacheSetOrThrow } from './cache';
import type { OverpassResponse } from './overpass';

// Must match the version embedded in overpass.ts's cacheKey (`overpass:v4:`).
const AREA_SCHEMA_VERSION = 4;

export interface StoredArea {
  id: string;
  lat: number;
  lon: number;
  radiusMeters: number;
  savedAt: number;
  ways: number;
  nodes: number;
  /** Schema version; absent on older entries, treated as a version mismatch. */
  v?: number;
}

const INDEX_KEY = 'areas:index';

export async function listAreas(): Promise<StoredArea[]> {
  return (await cacheGet<StoredArea[]>(INDEX_KEY)) ?? [];
}

export async function saveArea(
  center: LatLon,
  radiusMeters: number,
  response: OverpassResponse,
): Promise<StoredArea> {
  const area: StoredArea = {
    id: `${center.lat.toFixed(4)},${center.lon.toFixed(4)},${Math.round(radiusMeters)}`,
    lat: center.lat,
    lon: center.lon,
    radiusMeters,
    savedAt: Date.now(),
    ways: response.elements.filter((e) => e.type === 'way').length,
    nodes: response.elements.filter((e) => e.type === 'node').length,
    v: AREA_SCHEMA_VERSION,
  };
  // Write payload first; a quota error here surfaces before the index is touched.
  await cacheSetOrThrow(`area:${area.id}`, response);
  const areas = (await listAreas()).filter((a) => a.id !== area.id);
  areas.push(area);
  await cacheSet(INDEX_KEY, areas);
  return area;
}

export async function deleteArea(id: string): Promise<StoredArea[]> {
  const areas = (await listAreas()).filter((a) => a.id !== id);
  await cacheSet(INDEX_KEY, areas);
  await cacheSet(`area:${id}`, undefined);
  return areas;
}

/** Smallest stored area whose circle fully covers the requested one. */
export async function findCoveringArea(
  center: LatLon,
  radiusMeters: number,
): Promise<StoredArea | null> {
  const areas = await listAreas();
  let best: StoredArea | null = null;
  for (const a of areas) {
    // Stale-schema entries are treated as absent so they get refetched.
    // Entries from before versioning were all saved under the v4 query, so
    // they are grandfathered rather than thrown away.
    if ((a.v ?? 4) !== AREA_SCHEMA_VERSION) continue;
    const d = haversineMeters(center.lat, center.lon, a.lat, a.lon);
    if (d + radiusMeters <= a.radiusMeters && (!best || a.radiusMeters < best.radiusMeters)) {
      best = a;
    }
  }
  return best;
}

export async function loadArea(id: string): Promise<OverpassResponse | undefined> {
  return cacheGet<OverpassResponse>(`area:${id}`);
}
