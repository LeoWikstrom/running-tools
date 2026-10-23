import { describe, expect, it } from 'vitest';
import { decodeLink, encodeLink, linkStateToParams, type LinkState } from '../src/ui/linkCodec';

const base: LinkState = {
  lat: 57.70887,
  lon: 11.97456,
  radiusKm: 5,
  distanceKm: 21.1,
  fromKm: 0,
  toKm: 21.1,
  mix: 'road',
  algorithm: 'beam',
  returnToStart: false,
  startAnywhere: false,
  connectors: false,
  useTraces: false,
  seed: 1,
  beamWidth: 200,
  viaToleranceKm: 0.3,
  weights: [],
  vias: [],
};

describe('link codec', () => {
  it('round-trips a plain search', () => {
    expect(decodeLink(encodeLink(base))).toEqual(base);
  });

  it('round-trips every field at once', () => {
    const state: LinkState = {
      lat: -33.86882,
      lon: 151.2093,
      radiusKm: 7.5,
      distanceKm: 42.2,
      fromKm: 5.5,
      toKm: 30,
      mix: 'trail',
      algorithm: 'walk',
      returnToStart: true,
      startAnywhere: true,
      connectors: true,
      useTraces: true,
      seed: 98765,
      beamWidth: 650,
      viaToleranceKm: 1.2,
      weights: [
        { name: 'localShape', value: 0 },
        { name: 'penalty', value: 40 },
        { name: 'untracked', value: 7.5 },
      ],
      vias: [
        { lat: -33.87001, lon: 151.21002, km: 5.2 },
        { lat: -33.86543, lon: 151.19876, km: null },
      ],
    };
    expect(decodeLink(encodeLink(state))).toEqual(state);
  });

  it('keeps null distance and race window distinct from zero', () => {
    const state = { ...base, distanceKm: null, toKm: null };
    const out = decodeLink(encodeLink(state))!;
    expect(out.distanceKm).toBeNull();
    expect(out.toKm).toBeNull();
  });

  it('rejects garbage, truncation and unknown versions', () => {
    expect(decodeLink('not base64!!')).toBeNull();
    expect(decodeLink('')).toBeNull();
    expect(decodeLink(encodeLink(base).slice(0, 10))).toBeNull();
    const bytes = Uint8Array.from(atob(encodeLink(base).replaceAll('-', '+')), (c) =>
      c.charCodeAt(0),
    );
    bytes[0] = 99;
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    expect(decodeLink(btoa(bin))).toBeNull();
  });

  it('unfolds to plain params that carry the same state', () => {
    const state: LinkState = {
      ...base,
      returnToStart: true,
      weights: [{ name: 'turns', value: 0 }],
      vias: [{ lat: 57.7, lon: 11.97, km: null }],
    };
    const params = new URLSearchParams(linkStateToParams(state));
    expect(params.get('lat')).toBe('57.70887');
    expect(params.get('rts')).toBe('1');
    expect(params.get('seed')).toBe('1');
    expect(params.get('w')).toBe('turns:0');
    expect(params.get('via')).toBe('57.70000,11.97000,');
    expect(params.get('from')).toBeNull();
    expect(params.get('d')).toBe('21.1');
  });
});
