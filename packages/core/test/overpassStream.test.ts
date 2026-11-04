import { describe, expect, it } from 'vitest';
import { createElementScanner } from '../src/net/overpassStream';

const RESPONSE = JSON.stringify({
  version: 0.6,
  generator: 'Overpass API',
  osm3s: { timestamp_osm_base: '2026-11-04T00:00:00Z', copyright: 'odbl' },
  elements: [
    { type: 'relation', id: 1, tags: { name: 'Bus 16 → "Centrum" {east}', ref: '16' } },
    { type: 'node', id: 2, lat: 57.7, lon: 11.95, tags: { name: 'Brace } in name' } },
    { type: 'way', id: 3, geometry: [{ lat: 57.7, lon: 11.95 }, { lat: 57.71, lon: 11.97 }] },
  ],
});

function feed(chunkSize: number): Record<string, unknown>[] {
  const got: Record<string, unknown>[] = [];
  const scanner = createElementScanner((el) => got.push(el));
  for (let i = 0; i < RESPONSE.length; i += chunkSize) {
    scanner.push(RESPONSE.slice(i, i + chunkSize));
  }
  return got;
}

describe('createElementScanner', () => {
  it('emits every element whole, matching JSON.parse', () => {
    const got = feed(RESPONSE.length);
    expect(got).toEqual(JSON.parse(RESPONSE).elements);
  });

  it.each([1, 2, 3, 7, 16])('survives arbitrary chunk splits (size %i)', (size) => {
    expect(feed(size)).toEqual(JSON.parse(RESPONSE).elements);
  });

  it('is not fooled by braces, brackets and escapes inside strings', () => {
    const got = feed(5);
    expect(got[0]!.tags).toEqual({ name: 'Bus 16 → "Centrum" {east}', ref: '16' });
    expect((got[1]!.tags as Record<string, string>).name).toBe('Brace } in name');
  });

  it('stops at the end of the elements array', () => {
    const got: Record<string, unknown>[] = [];
    const scanner = createElementScanner((el) => got.push(el));
    scanner.push(RESPONSE);
    scanner.push('{"type":"way","id":99}'); // trailing garbage must not emit
    expect(got).toHaveLength(3);
  });

  it('emits elements as soon as they close, before the array ends', () => {
    const got: Record<string, unknown>[] = [];
    const scanner = createElementScanner((el) => got.push(el));
    const cut = RESPONSE.indexOf('{ "type": "node"'.replace(/ /g, '')) - 1;
    const first = RESPONSE.indexOf('"elements"');
    scanner.push(RESPONSE.slice(0, RESPONSE.indexOf(',{"type":"node"')));
    expect(first).toBeGreaterThan(0);
    expect(cut).toBeLessThan(RESPONSE.length);
    expect(got).toHaveLength(1);
    expect(got[0]!.type).toBe('relation');
  });
});
