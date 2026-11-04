import { beforeEach, describe, expect, it } from 'vitest';
import { cacheClearMemory } from '../src/net/cache';
import {
  fetchNetworkTiles,
  tileId,
  tilesCovering,
  TILE_LAT_STEP,
  TILE_LON_STEP,
} from '../src/net/networkTiles';
import {
  decodeOpl,
  keepWay,
  parseOplLine,
  wayTiles,
} from '../src/net/networkTilesBuild';

describe('tilesCovering', () => {
  it('covers the circle bounding box', () => {
    const center = { lat: 57.7, lon: 11.97 };
    const tiles = tilesCovering(center, 8000);
    const latPad = 8000 / 111_320;
    const lonPad = latPad / Math.cos((center.lat * Math.PI) / 180);
    for (const corner of [
      { lat: center.lat - latPad, lon: center.lon - lonPad },
      { lat: center.lat + latPad, lon: center.lon + lonPad },
    ]) {
      const x = Math.floor(corner.lon / TILE_LON_STEP);
      const y = Math.floor(corner.lat / TILE_LAT_STEP);
      expect(tiles.some((t) => t.x === x && t.y === y)).toBe(true);
    }
  });
});

describe('fetchNetworkTiles', () => {
  beforeEach(cacheClearMemory);
  const gothenburg = { lat: 57.7, lon: 11.97 };
  const manifest = (tiles: string[]) => ({
    version: 1,
    generated: '2026-11-04',
    latStep: TILE_LAT_STEP,
    lonStep: TILE_LON_STEP,
    tiles,
  });

  it('returns null outside the covered box', async () => {
    const fetchFn = (async () => {
      throw new Error('must not fetch');
    }) as unknown as typeof fetch;
    expect(await fetchNetworkTiles({ lat: 48.8, lon: 2.3 }, 5000, { fetchFn })).toBeNull();
  });

  it('assembles covering tiles, skipping sea tiles absent from the manifest', async () => {
    const wanted = tilesCovering(gothenburg, 3000);
    const presentIds = wanted.slice(0, 1).map((t) => tileId(t.x, t.y));
    const urls: string[] = [];
    const fetchFn = (async (url: unknown) => {
      urls.push(String(url));
      if (String(url).endsWith('index.json')) {
        return new Response(JSON.stringify(manifest(presentIds)));
      }
      return new Response(
        JSON.stringify({
          elements: [
            { type: 'way', id: 1, nodes: [10, 11] },
            { type: 'node', id: 10, lat: 57.7, lon: 11.97 },
            { type: 'node', id: 11, lat: 57.701, lon: 11.971 },
          ],
        }),
      );
    }) as typeof fetch;
    const response = await fetchNetworkTiles(gothenburg, 3000, { fetchFn });
    expect(response).not.toBeNull();
    expect(response!.elements.filter((e) => e.type === 'way')).toHaveLength(1);
    // Only manifest-listed tiles were requested.
    expect(urls.filter((u) => u.includes('net_'))).toHaveLength(presentIds.length);
  });

  it('returns null when a needed tile fails', async () => {
    const wanted = tilesCovering({ lat: 59.33, lon: 18.07 }, 3000);
    const fetchFn = (async (url: unknown) => {
      if (String(url).endsWith('index.json')) {
        return new Response(JSON.stringify(manifest(wanted.map((t) => tileId(t.x, t.y)))));
      }
      return new Response('gone', { status: 404 });
    }) as typeof fetch;
    expect(await fetchNetworkTiles({ lat: 59.33, lon: 18.07 }, 3000, { fetchFn })).toBeNull();
  });
});

describe('OPL parsing', () => {
  it('decodes %codepoint% escapes', () => {
    expect(decodeOpl('G%f6%teborg')).toBe('Göteborg');
    expect(decodeOpl('a%20%b')).toBe('a b');
    expect(decodeOpl('100%25%')).toBe('100%');
  });

  it('parses nodes and ways', () => {
    const n = parseOplLine('n123 v2 x11.971 y57.701 Tcrossing=traffic_signals');
    expect(n).toEqual({
      type: 'node',
      id: 123,
      lat: 57.701,
      lon: 11.971,
      tags: { crossing: 'traffic_signals' },
    });
    const w = parseOplLine('w9 v1 Thighway=footway,name=Guldhedsgatan Nn1,n2,n3');
    expect(w).toEqual({
      type: 'way',
      id: 9,
      nodes: [1, 2, 3],
      tags: { highway: 'footway', name: 'Guldhedsgatan' },
    });
    expect(parseOplLine('r77 v1 Ttype=route')).toBeNull();
  });
});

describe('keepWay — buildQuery clause parity', () => {
  it.each([
    [{ highway: 'footway' }, true],
    [{ highway: 'tertiary' }, true],
    [{ highway: 'motorway' }, false],
    [{ highway: 'footway', access: 'private' }, false],
    [{ highway: 'footway', access: 'no' }, false],
    [{ highway: 'footway', foot: 'no' }, false],
    [{ highway: 'footway', access: 'destination' }, true],
    // A barrier/rail/water way is a separator and passes regardless.
    [{ barrier: 'fence', access: 'private' }, true],
    [{ railway: 'tram' }, true],
    [{ railway: 'abandoned' }, false],
    [{ waterway: 'river' }, true],
    [{ waterway: 'drain' }, false],
    // The union: a private footway that is also a barrier stays (Overpass
    // would return it through the barrier clause).
    [{ highway: 'footway', access: 'private', barrier: 'gate' }, true],
    [{}, false],
  ])('%o → %s', (tags, expected) => {
    expect(keepWay(tags as Record<string, string>)).toBe(expected);
  });
});

describe('wayTiles', () => {
  it('duplicates a boundary way into every touched tile', () => {
    const pos = new Map([
      [1, { lat: 57.69, lon: 11.97 }], // south of the 57.8 boundary
      [2, { lat: 57.81, lon: 11.97 }], // north of it
    ]);
    const tiles = wayTiles([1, 2], (id) => pos.get(id));
    expect(tiles.size).toBe(2);
  });
});
