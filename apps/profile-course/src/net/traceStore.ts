import type { LatLon } from '../shared/messages';
import { cacheGet, cacheSet, cacheSetOrThrow } from './cache';
import type { TraceGrid, TraceYield } from './traces';

export interface StoredTraces {
  id: string;
  lat: number;
  lon: number;
  radiusMeters: number;
  savedAt: number;
  /** Everything the API returned, for the "how much of this was usable" line. */
  points: number;
  timed: number;
  kept: number;
  cells: number;
}

const INDEX_KEY = 'traces:index';

export async function listTraces(): Promise<StoredTraces[]> {
  return (await cacheGet<StoredTraces[]>(INDEX_KEY)) ?? [];
}

export async function saveTraces(
  center: LatLon,
  radiusMeters: number,
  found: TraceYield,
): Promise<StoredTraces> {
  const entry: StoredTraces = {
    id: `${center.lat.toFixed(4)},${center.lon.toFixed(4)},${Math.round(radiusMeters)}`,
    lat: center.lat,
    lon: center.lon,
    radiusMeters,
    savedAt: Date.now(),
    points: found.points,
    timed: found.timed,
    kept: found.kept,
    cells: found.grid.cells.length,
  };
  // Write payload first; a quota error here surfaces before the index is touched.
  await cacheSetOrThrow(`trace:${entry.id}`, found.grid);
  const all = (await listTraces()).filter((t) => t.id !== entry.id);
  all.push(entry);
  await cacheSet(INDEX_KEY, all);
  return entry;
}

export async function deleteTraces(id: string): Promise<StoredTraces[]> {
  const all = (await listTraces()).filter((t) => t.id !== id);
  await cacheSet(INDEX_KEY, all);
  await cacheSet(`trace:${id}`, undefined);
  return all;
}

/**
 * Every stored area's counts in one grid. They are merged rather than picked
 * per search because a cell says where people run regardless of which download
 * saw it, and ground no download covered must read as untrodden either way.
 */
export async function loadTraceCounts(): Promise<Map<number, number>> {
  const merged = new Map<number, number>();
  for (const entry of await listTraces()) {
    const grid = await cacheGet<TraceGrid>(`trace:${entry.id}`);
    if (!grid) continue;
    for (let i = 0; i < grid.cells.length; i++) {
      const id = grid.cells[i]!;
      // Max, not sum: overlapping downloads fetched the same public traces,
      // so a sum counted the same points twice wherever the circles overlap.
      merged.set(id, Math.max(merged.get(id) ?? 0, grid.counts[i]!));
    }
  }
  return merged;
}
