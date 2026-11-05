import { describe, expect, it } from 'vitest';
import { fetchAreaBuildings } from '../src/poi/buildings';

describe('fetchAreaBuildings', () => {
  it('fetches four quadrants on four distinct mirrors and dedupes footprints', async () => {
    const calls: { url: string; body: string }[] = [];
    const square = (lat: number, lon: number) => [
      { lat, lon },
      { lat: lat + 0.0001, lon },
      { lat: lat + 0.0001, lon: lon + 0.0001 },
      { lat, lon },
    ];
    const fetchFn = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? '') });
      const q = calls.length;
      return new Response(
        JSON.stringify({
          elements: [
            // One shared boundary building plus one unique per quadrant.
            { type: 'way', id: 1, geometry: square(57.7, 11.97) },
            { type: 'way', id: 10 + q, geometry: square(57.71, 11.98) },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    // Outside the baked-tiles box, so the quadrant fallback runs directly.
    const footprints = await fetchAreaBuildings({ lat: 48.85, lon: 2.35 }, 4000, { fetchFn });
    expect(calls).toHaveLength(4);
    expect(new Set(calls.map((c) => c.url)).size).toBe(4);
    expect(calls.every((c) => c.body.includes('way%5Bbuilding%5D'))).toBe(true);
    // 1 shared + 4 unique.
    expect(footprints).toHaveLength(5);
    expect(footprints.filter((f) => f.id === 1)).toHaveLength(1);
  });
});
