import { describe, expect, it } from 'vitest';
import { haversineMeters } from '../src/geo';
import {
  assembleRoutePolyline,
  relationsToBusLines,
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

  it('returns empty for a relation with no usable ways', () => {
    const { points } = assembleRoutePolyline(relation([99]), wayMap());
    expect(points).toHaveLength(0);
  });
});

describe('relationsToBusLines', () => {
  it('reads tags and sorts numerically by ref', () => {
    const lines = relationsToBusLines([
      { type: 'relation', id: 3, tags: { ref: '16', name: 'Bus 16', to: 'Eketrägatan' } },
      { type: 'relation', id: 1, tags: { ref: '2', name: 'Bus 2' } },
      { type: 'relation', id: 2, tags: { ref: '10', name: 'Bus 10' } },
      { type: 'relation', id: 4 },
    ]);
    expect(lines.map((l) => l.ref)).toEqual(['2', '10', '16']);
    expect(lines[2]!.to).toBe('Eketrägatan');
  });
});
