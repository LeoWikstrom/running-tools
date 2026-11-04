import { describe, expect, it } from 'vitest';
import { haversineMeters } from '../src/geo';
import {
  assembleRoutePolyline,
  buildBusAreaQuery,
  buildBusSearchQuery,
  cropBetweenStops,
  parseBusLines,
  type BusAreaElement,
  type BusStop,
  type OverpassGeomWay,
  type OverpassRelation,
} from '../src/net/busRoutes';

// ~0.001° lon ≈ 111 m at the equator, where these fixtures live.
const way = (id: number, coords: [number, number][]): OverpassGeomWay => ({
  type: 'way',
  id,
  geometry: coords.map(([lat, lon]) => ({ lat, lon })),
});

const relation = (
  wayIds: number[],
  roles: Record<number, string> = {},
): OverpassRelation => ({
  type: 'relation',
  id: 1,
  members: wayIds.map((ref) => ({ type: 'way', ref, role: roles[ref] ?? '' })),
});

const wayMap = (...ways: OverpassGeomWay[]): Map<number, OverpassGeomWay> =>
  new Map(ways.map((w) => [w.id, w]));

/** Largest jump between consecutive points, metres. */
function maxJump(points: { lat: number; lon: number }[]): number {
  let max = 0;
  for (let i = 1; i < points.length; i++) {
    max = Math.max(
      max,
      haversineMeters(points[i - 1]!.lat, points[i - 1]!.lon, points[i]!.lat, points[i]!.lon),
    );
  }
  return max;
}

describe('assembleRoutePolyline', () => {
  const w1 = way(10, [[0, 0], [0, 0.001]]);
  const w2 = way(11, [[0, 0.001], [0, 0.002]]);
  const w3 = way(12, [[0, 0.002], [0, 0.003]]);

  it('chains ways in order without duplicating the joints', () => {
    const { points, gaps } = assembleRoutePolyline(relation([10, 11, 12]), wayMap(w1, w2, w3));
    expect(gaps).toBe(0);
    expect(points).toHaveLength(4);
    expect(points[3]).toEqual({ lat: 0, lon: 0.003 });
    expect(maxJump(points)).toBeLessThan(120);
  });

  it('reverses ways drawn against the direction of travel', () => {
    const w2r = way(11, [[0, 0.002], [0, 0.001]]);
    const { points, gaps } = assembleRoutePolyline(relation([10, 11, 12]), wayMap(w1, w2r, w3));
    expect(gaps).toBe(0);
    expect(points.map((p) => p.lon)).toEqual([0, 0.001, 0.002, 0.003]);
  });

  it('flips the first way when it faces away from the second', () => {
    const w1r = way(10, [[0, 0.001], [0, 0]]);
    const { points, gaps } = assembleRoutePolyline(relation([10, 11]), wayMap(w1r, w2));
    expect(gaps).toBe(0);
    expect(points.map((p) => p.lon)).toEqual([0, 0.001, 0.002]);
  });

  it('skips stop and platform members', () => {
    const stop = way(20, [[0.005, 0.005], [0.005, 0.006]]);
    const { points, gaps } = assembleRoutePolyline(
      relation([10, 20, 11], { 20: 'platform' }),
      wayMap(w1, stop, w2),
    );
    expect(gaps).toBe(0);
    expect(points).toHaveLength(3);
  });

  it('counts joints further apart than 30 m as gaps and carries on', () => {
    const far = way(21, [[0, 0.0015], [0, 0.0025]]);
    const { points, gaps } = assembleRoutePolyline(relation([10, 21]), wayMap(w1, far));
    expect(gaps).toBe(1);
    expect(points).toHaveLength(4);
  });

  it('walks a roundabout from entry to exit, the short way around', () => {
    const ring = way(30, [
      [0, 0.001],
      [0.0001, 0.0011],
      [0, 0.0012],
      [-0.0001, 0.0011],
      [0, 0.001],
    ]);
    const after = way(31, [[0, 0.0012], [0, 0.002]]);
    const { points, gaps } = assembleRoutePolyline(relation([10, 30, 31]), wayMap(w1, ring, after));
    expect(gaps).toBe(0);
    expect(maxJump(points)).toBeLessThan(120);
    expect(points[points.length - 1]).toEqual({ lat: 0, lon: 0.002 });
    // Exactly one side of the ring is walked, not the full circle.
    const onRing = points.filter((p) => p.lat !== 0);
    expect(onRing).toHaveLength(1);
  });

  it('aims the roundabout exit at the ring, not at the entry point', () => {
    // The exit street bends back behind the roundabout, so its far end lies
    // nearer the ENTRY point than the exit node does. Picking the exit target
    // by distance to the entry chose that far end and drove the street
    // backwards; the target must be the next way's end nearer the ring.
    const entry = way(40, [[0, 0.0005], [0, 0.0015]]);
    const ring8 = way(41, [
      [0, 0.0025],
      [0.00035, 0.00235],
      [0.0005, 0.002],
      [0.00035, 0.00165],
      [0, 0.0015],
      [-0.00035, 0.00165],
      [-0.0005, 0.002],
      [-0.00035, 0.00235],
      [0, 0.0025],
    ]);
    const exit = way(42, [
      [0.0005, 0.002],
      [0.0001, 0.00115],
    ]);
    const { points, gaps } = assembleRoutePolyline(
      relation([40, 41, 42]),
      wayMap(entry, ring8, exit),
    );
    expect(gaps).toBe(0);
    // Ring walked entry → exit node, then the street driven forwards.
    expect(points[points.length - 2]).toEqual({ lat: 0.0005, lon: 0.002 });
    expect(points[points.length - 1]).toEqual({ lat: 0.0001, lon: 0.00115 });
  });

  it('returns empty for a relation with no usable ways', () => {
    const { points } = assembleRoutePolyline(relation([99]), wayMap());
    expect(points).toHaveLength(0);
  });
});

describe('parseBusLines', () => {
  const node = (id: number, lat: number, lon: number, name?: string): BusAreaElement => ({
    type: 'node',
    id,
    lat,
    lon,
    tags: name ? { name } : undefined,
  });

  const elements: BusAreaElement[] = [
    way(10, [[0, 0], [0, 0.001]]),
    way(11, [[0, 0.001], [0, 0.002]]),
    node(100, 0, 0, 'Första'),
    node(101, 0, 0.002, 'Sista'),
    {
      type: 'relation',
      id: 3,
      tags: { type: 'route', route: 'bus', ref: '16', name: 'Bus 16', to: 'Eketrägatan' },
      members: [
        { type: 'node', ref: 100, role: 'stop' },
        { type: 'way', ref: 10, role: '' },
        { type: 'way', ref: 11, role: '' },
        { type: 'node', ref: 101, role: 'stop' },
      ],
    },
    {
      type: 'relation',
      id: 1,
      tags: { type: 'route', route: 'tram', ref: '2', name: 'Tram 2' },
      members: [{ type: 'way', ref: 10, role: '' }],
    },
    // Untagged and geometry-less relations fall out.
    { type: 'relation', id: 4 },
    { type: 'relation', id: 5, tags: { route: 'bus', name: 'Ghost' }, members: [] },
  ];

  it('builds lines with geometry, kind and ordered stops, sorted by ref', () => {
    const lines = parseBusLines(elements);
    expect(lines.map((l) => l.ref)).toEqual(['2', '16']);
    expect(lines[0]!.kind).toBe('tram');
    const sixteen = lines[1]!;
    expect(sixteen.kind).toBe('bus');
    expect(sixteen.points).toHaveLength(3);
    expect(sixteen.stops.map((s) => s.name)).toEqual(['Första', 'Sista']);
  });
});

describe('buildBusAreaQuery', () => {
  it('outputs relations, member geometry and stop nodes via the named set', () => {
    const q = buildBusAreaQuery({ south: 57.6, west: 11.9, north: 57.8, east: 12.1 });
    expect(q).toContain('.rt out body');
    expect(q).toContain('way(r.rt);out geom');
    expect(q).toContain('node(r.rt);out body');
  });
});

describe('buildBusSearchQuery', () => {
  const bbox = { south: 57.6, west: 11.9, north: 57.8, east: 12.1 };

  it('outputs full line data via the named set', () => {
    const q = buildBusSearchQuery(bbox, '16');
    expect(q).toContain('way(r.rt);out geom');
    expect(q).toContain('node(r.rt);out body');
  });

  it('narrows the route filter when a kind is given', () => {
    expect(buildBusSearchQuery(bbox, '3', 'tram')).toContain('route~"^tram$"');
    expect(buildBusSearchQuery(bbox, '3')).toContain('route~"^(bus|tram)$"');
  });

  it('escapes quotes and regex specials in the term', () => {
    const q = buildBusSearchQuery(bbox, 'St. "X" (east)');
    expect(q).toContain('"ref"="St. \\"X\\" (east)"');
    // Regex value: regex-escaped first, then QL-string-escaped on top, so the
    // regex engine receives St\. \"X\" \(east\) after the string layer parses.
    expect(q).toContain('St\\\\. \\"X\\" \\\\(east\\\\)');
  });

  it('leaves no unescaped ] that could close a tag filter early', () => {
    const q = buildBusSearchQuery(bbox, '12]abc(');
    // Every ] in the built query is either a filter bracket following a
    // quote/letter or an escaped \] inside a value — never a bare one
    // straight after value text.
    expect(q).toContain('"ref"="12\\]abc("');
    // Regex value: regex-escaped first (\] \(), then QL-string-escaped on top.
    expect(q).toContain('12\\\\\\]abc\\\\(');
  });
});

describe('cropBetweenStops', () => {
  const points = [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 0.001 },
    { lat: 0, lon: 0.002 },
    { lat: 0, lon: 0.003 },
  ];
  const stop = (id: number, lon: number): BusStop => ({ id, name: `S${id}`, lat: 0.0001, lon });

  it('keeps the stretch between the stops, endpoints interpolated', () => {
    const out = cropBetweenStops(points, stop(1, 0.0005), stop(2, 0.0025));
    expect(out[0]!.lon).toBeCloseTo(0.0005, 6);
    expect(out[out.length - 1]!.lon).toBeCloseTo(0.0025, 6);
    expect(out.map((p) => p.lon)).toEqual([0.0005, 0.001, 0.002, 0.0025]);
  });

  it('always runs in travel direction, even picked backwards', () => {
    const out = cropBetweenStops(points, stop(2, 0.0025), stop(1, 0.0005));
    expect(out[0]!.lon).toBeCloseTo(0.0005, 6);
    expect(out[out.length - 1]!.lon).toBeCloseTo(0.0025, 6);
  });
});
