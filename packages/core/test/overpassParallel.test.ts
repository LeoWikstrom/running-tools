import { describe, expect, it } from 'vitest';
import {
  buildQuery,
  buildQueryBBox,
  fetchNetworkParallel,
  mergeOverpassResponses,
  quadrantBoxes,
  type OverpassResponse,
} from '../src/net/overpass';

const CENTER = { lat: 57.7, lon: 11.97 };

describe('quadrantBoxes', () => {
  it('tiles the circle bounding box exactly, split at the center', () => {
    const boxes = quadrantBoxes(CENTER, 5000);
    expect(boxes).toHaveLength(4);
    const latPad = 5000 / 111_320;
    for (const b of boxes) {
      expect(b.north - b.south).toBeCloseTo(latPad, 10);
      expect(b.north === CENTER.lat || b.south === CENTER.lat).toBe(true);
      expect(b.east === CENTER.lon || b.west === CENTER.lon).toBe(true);
    }
    // Union spans the full bbox.
    expect(Math.min(...boxes.map((b) => b.south))).toBeCloseTo(CENTER.lat - latPad, 10);
    expect(Math.max(...boxes.map((b) => b.north))).toBeCloseTo(CENTER.lat + latPad, 10);
  });
});

describe('buildQueryBBox', () => {
  it('keeps every clause and filter of the circle query', () => {
    const circle = buildQuery(CENTER, 5000);
    const bbox = buildQueryBBox({ south: 57.6, west: 11.9, north: 57.8, east: 12.1 });
    for (const fragment of [
      'way[highway~',
      '[access!~"private|no"][foot!=no]',
      'way[barrier]',
      'way[railway~"^(rail|tram|light_rail)$"]',
      'way[waterway~"^(river|stream|canal|ditch)$"]',
      ');out body;>;out body qt;',
    ]) {
      expect(circle).toContain(fragment);
      expect(bbox).toContain(fragment);
    }
    expect(bbox).toContain('(57.600000,11.900000,57.800000,12.100000)');
  });
});

describe('mergeOverpassResponses', () => {
  it('dedupes by type and id, first occurrence wins', () => {
    const a: OverpassResponse = {
      elements: [
        { type: 'way', id: 1, nodes: [10, 11] },
        { type: 'node', id: 10, lat: 1, lon: 1 },
        { type: 'node', id: 11, lat: 2, lon: 2 },
      ],
    };
    const b: OverpassResponse = {
      elements: [
        { type: 'way', id: 1, nodes: [10, 11] }, // boundary way, second copy
        { type: 'way', id: 2, nodes: [11, 12] },
        { type: 'node', id: 11, lat: 2, lon: 2 },
        { type: 'node', id: 12, lat: 3, lon: 3 },
      ],
    };
    const merged = mergeOverpassResponses([a, b]);
    expect(merged.elements.map((e) => `${e.type}:${e.id}`)).toEqual([
      'way:1',
      'node:10',
      'node:11',
      'way:2',
      'node:12',
    ]);
  });
});

describe('fetchNetworkParallel', () => {
  it('fetches four quadrants on four distinct mirrors and merges them', async () => {
    const calls: { url: string; body: string }[] = [];
    const node = (id: number, lat: number, lon: number) => ({ type: 'node', id, lat, lon });
    const fetchFn = (async (url: unknown, init?: RequestInit) => {
      const body = String(init?.body ?? '');
      calls.push({ url: String(url), body });
      // Every quadrant returns one unique way near the center (inside the
      // radius) plus the shared boundary node.
      const q = calls.length;
      const json: OverpassResponse = {
        elements: [
          { type: 'way', id: q, nodes: [100, 200 + q] },
          node(100, 57.7, 11.97),
          node(200 + q, 57.701, 11.971),
        ],
      };
      return new Response(JSON.stringify(json), { status: 200 });
    }) as typeof fetch;

    const merged = await fetchNetworkParallel({ lat: 57.7, lon: 11.97 }, 3000, { fetchFn });
    expect(calls).toHaveLength(4);
    // One mirror per quadrant, all four distinct.
    expect(new Set(calls.map((c) => c.url)).size).toBe(4);
    // Four distinct bbox queries.
    expect(new Set(calls.map((c) => c.body)).size).toBe(4);
    const ways = merged.elements.filter((e) => e.type === 'way');
    expect(ways).toHaveLength(4);
    // The shared node survives exactly once.
    expect(merged.elements.filter((e) => e.type === 'node' && e.id === 100)).toHaveLength(1);
  });

  it('fails the whole download when one quadrant cannot be fetched anywhere', async () => {
    let n = 0;
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      n++;
      // The south-west quadrant (south edge below the center) fails on every
      // mirror; the others answer.
      if (String(init?.body ?? '').includes('49.9')) return new Response('busy', { status: 504 });
      return new Response(
        JSON.stringify({ elements: [{ type: 'node', id: n, lat: 50.0, lon: 11.97 }] }),
        { status: 200 },
      );
    }) as typeof fetch;
    await expect(
      fetchNetworkParallel({ lat: 50.0, lon: 11.97 }, 3000, { fetchFn, rounds: 1 }),
    ).rejects.toThrow();
  });
});
