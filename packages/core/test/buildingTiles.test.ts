import { beforeEach, describe, expect, it } from 'vitest';
import { cacheClearMemory } from '../src/net/cache';
import { fetchBuildingTiles } from '../src/net/buildingTiles';
import { encodePolyline } from '../src/net/gtfsLines';
import { tileId, tilesCovering, TILE_LAT_STEP, TILE_LON_STEP } from '../src/net/networkTiles';

const center = { lat: 57.7, lon: 11.97 };

const ring = (lat: number, lon: number): string =>
  encodePolyline([
    { lat, lon },
    { lat: lat + 0.0002, lon },
    { lat: lat + 0.0002, lon: lon + 0.0002 },
    { lat, lon },
  ]);

describe('fetchBuildingTiles', () => {
  beforeEach(cacheClearMemory);

  const manifest = (tiles: string[]) => ({
    version: 1,
    generated: '2026-11-05',
    latStep: TILE_LAT_STEP,
    lonStep: TILE_LON_STEP,
    tiles,
  });

  it('returns null outside the covered box', async () => {
    const fetchFn = (async () => {
      throw new Error('must not fetch');
    }) as unknown as typeof fetch;
    expect(await fetchBuildingTiles({ lat: 48.8, lon: 2.3 }, 5000, { fetchFn })).toBeNull();
  });

  it('decodes footprints, filters to the circle and dedupes boundary copies', async () => {
    const ids = tilesCovering(center, 3000).map((t) => tileId(t.x, t.y));
    const fetchFn = (async (url: unknown) => {
      if (String(url).endsWith('index-bld.json')) {
        return new Response(JSON.stringify(manifest(ids)));
      }
      return new Response(
        JSON.stringify({
          version: 1,
          buildings: [
            [7, ring(57.7, 11.97)], // inside, duplicated in every tile
            [8, ring(58.5, 13.0)], // far outside the circle
          ],
        }),
      );
    }) as typeof fetch;
    const out = await fetchBuildingTiles(center, 3000, { fetchFn });
    expect(out).not.toBeNull();
    expect(out!.map((b) => b.id)).toEqual([7]);
    expect(out![0]!.lats).toHaveLength(4);
    expect(out![0]!.lats[1]).toBeCloseTo(57.7002, 5);
  });

  it('returns null when a listed tile cannot be fetched', async () => {
    const ids = tilesCovering(center, 3000).map((t) => tileId(t.x, t.y));
    const fetchFn = (async (url: unknown) =>
      String(url).endsWith('index-bld.json')
        ? new Response(JSON.stringify(manifest(ids)))
        : new Response('gone', { status: 404 })) as typeof fetch;
    expect(await fetchBuildingTiles(center, 3000, { fetchFn })).toBeNull();
  });
});
