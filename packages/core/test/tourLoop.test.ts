import { describe, expect, it } from 'vitest';
import { buildGraph, snapToNode } from '../src/graph/build';
import type { Graph } from '../src/graph/types';
import type { OverpassNode, OverpassResponse, OverpassWay } from '../src/net/overpass';
import { tourLoopSearch } from '../src/search/tourLoop';
import {
  improveTourCourse,
  snapPlacesToNodes,
  tourCoursePoints,
  unsanctionedSpurCount,
  type SnappedPlace,
  type TourCourse,
  type TourSearchPlace,
} from '../src/search/tourScore';

/**
 * The same synthetic city as tourBeam.test.ts: a 13×13 street grid, 150 m
 * spacing, nasty horizontal streets in the southern half, places on a ring —
 * plus an optional dead-end stub holding a place, to prove that the only
 * out-and-backs a generated course ever contains are the ones that reach a
 * place.
 */
const SIZE = 13;
const SPACING_DEG_LAT = 150 / 111_195;
const LAT0 = 57.7;
const LON0 = 11.97;
const COS = Math.cos((LAT0 * Math.PI) / 180);
const SPACING_DEG_LON = SPACING_DEG_LAT / COS;
const STUB_NODE_ID = 9000;
const STUB_LON = LON0 + 12 * SPACING_DEG_LON + 200 / 111_195 / COS;

function gridResponse(withStub = false): OverpassResponse {
  const nodes: OverpassNode[] = [];
  const ways: OverpassWay[] = [];
  const id = (r: number, c: number): number => 1000 + r * SIZE + c;
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      nodes.push({
        type: 'node',
        id: id(r, c),
        lat: LAT0 + r * SPACING_DEG_LAT,
        lon: LON0 + c * SPACING_DEG_LON,
      });
    }
  }
  let wayId = 1;
  for (let r = 0; r < SIZE; r++) {
    const nasty = r < SIZE / 2;
    ways.push({
      type: 'way',
      id: wayId++,
      nodes: Array.from({ length: SIZE }, (_, c) => id(r, c)),
      tags: nasty
        ? { highway: 'tertiary', maxspeed: '70' }
        : { highway: 'residential', sidewalk: 'both' },
    });
  }
  for (let c = 0; c < SIZE; c++) {
    ways.push({
      type: 'way',
      id: wayId++,
      nodes: Array.from({ length: SIZE }, (_, r) => id(r, c)),
      tags: { highway: 'residential', sidewalk: 'both' },
    });
  }
  if (withStub) {
    // A 200 m dead-end east of the grid with something worth seeing at its tip.
    nodes.push({ type: 'node', id: STUB_NODE_ID, lat: LAT0 + 6 * SPACING_DEG_LAT, lon: STUB_LON });
    ways.push({
      type: 'way',
      id: wayId,
      nodes: [id(6, 12), STUB_NODE_ID],
      tags: { highway: 'footway' },
    });
  }
  return { elements: [...ways, ...nodes] };
}

const graph = buildGraph(gridResponse());
const start = snapToNode(graph, LAT0 + 6 * SPACING_DEG_LAT, LON0 + 6 * SPACING_DEG_LON);

function ringPlaces(): TourSearchPlace[] {
  const spots: [number, number, number][] = [
    [6, 9, 80],
    [8, 9, 70],
    [9, 7, 60],
    [9, 5, 65],
    [8, 3, 75],
    [6, 3, 55],
    [4, 3, 50],
    [3, 5, 45],
    [3, 7, 52],
    [4, 9, 58],
    [9, 9, 40],
    [3, 3, 35],
  ];
  return spots.map(([r, c, score], i) => ({
    id: `P${i}`,
    name: `Place ${i}`,
    lat: LAT0 + r * SPACING_DEG_LAT,
    lon: LON0 + c * SPACING_DEG_LON,
    score,
  }));
}

/** Spurs in the course that neither a collected place nor a via excuses. */
function unsanctioned(
  g: Graph,
  course: TourCourse,
  startNode: number,
  snapped: SnappedPlace[],
): number {
  const ids = new Set(course.collected.map((c) => c.id));
  const sanction = snapped
    .filter((p) => p.required || ids.has(p.id))
    .map((p) => ({ lat: g.nodeLat[p.node]!, lon: g.nodeLon[p.node]! }));
  return unsanctionedSpurCount(tourCoursePoints(g, course, startNode), sanction);
}

describe('tourLoopSearch on the synthetic grid', () => {
  const snapped = snapPlacesToNodes(graph, ringPlaces());
  const options = { targetLengthM: 3600 };
  const courses = tourLoopSearch(graph, start, snapped, options);

  it('returns loops of the right length back to the start', () => {
    expect(courses.length).toBeGreaterThan(0);
    for (const c of courses) {
      expect(c.lengthM).toBeGreaterThanOrEqual(3600 * 0.95);
      expect(c.lengthM).toBeLessThanOrEqual(3600 * 1.05);
      const pts = tourCoursePoints(graph, c, start);
      expect(pts[0]).toEqual(pts[pts.length - 1]);
    }
  });

  it('collects interesting places, in course order', () => {
    const best = courses[0]!;
    expect(best.collected.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < best.collected.length; i++) {
      expect(best.collected[i]!.d).toBeGreaterThanOrEqual(best.collected[i - 1]!.d);
    }
  });

  it('prefers streets with sidewalks over the nasty half of the grid', () => {
    const best = courses[0]!;
    let nastyLen = 0;
    for (const ei of best.edges) {
      const e = graph.edges[ei]!;
      if (e.penalty > 0) nastyLen += e.lengthM;
    }
    expect(nastyLen / best.lengthM).toBeLessThan(0.35);
  });

  it('never pads length with out-and-back spurs, at any length, improve included', () => {
    for (const target of [2400, 3600, 4800]) {
      const found = tourLoopSearch(graph, start, snapped, { targetLengthM: target });
      expect(found.length).toBeGreaterThan(0);
      for (const c of found) {
        // Off-target within the fallback band beats a spur-padded course.
        expect(c.lengthM).toBeGreaterThanOrEqual(target * 0.85);
        expect(c.lengthM).toBeLessThanOrEqual(target * 1.15);
        expect(unsanctioned(graph, c, start, snapped)).toBe(0);
      }
      const improved = improveTourCourse(graph, found[0]!, start, snapped, {
        targetLengthM: target,
      });
      expect(unsanctioned(graph, improved, start, snapped)).toBe(0);
    }
  });

  it('a required place is collected whatever it scores, and improvement keeps it', () => {
    const dull: TourSearchPlace = {
      id: 'VIA',
      name: 'Via',
      lat: LAT0 + 11 * SPACING_DEG_LAT,
      lon: LON0 + 11 * SPACING_DEG_LON,
      score: 5,
      required: true,
    };
    const snappedVia = snapPlacesToNodes(graph, [...ringPlaces(), dull]);
    const must = tourLoopSearch(graph, start, snappedVia, options);
    expect(must.length).toBeGreaterThan(0);
    expect(must[0]!.collected.some((c) => c.id === 'VIA')).toBe(true);
    const improved = improveTourCourse(graph, must[0]!, start, snappedVia, options);
    expect(improved.collected.some((c) => c.id === 'VIA')).toBe(true);
    expect(unsanctioned(graph, improved, start, snappedVia)).toBe(0);
  });

  it('a finish node makes the course point-to-point, still spur-free', () => {
    const end = snapToNode(graph, LAT0 + 9 * SPACING_DEG_LAT, LON0 + 9 * SPACING_DEG_LON);
    const p2p = tourLoopSearch(graph, start, snapped, { ...options, endNode: end });
    expect(p2p.length).toBeGreaterThan(0);
    for (const c of p2p) {
      const pts = tourCoursePoints(graph, c, start);
      expect(pts[0]).toEqual([LAT0 + 6 * SPACING_DEG_LAT, LON0 + 6 * SPACING_DEG_LON]);
      expect(pts[pts.length - 1]).toEqual([LAT0 + 9 * SPACING_DEG_LAT, LON0 + 9 * SPACING_DEG_LON]);
      expect(unsanctioned(graph, c, start, snapped)).toBe(0);
    }
    const improved = improveTourCourse(graph, p2p[0]!, start, snapped, {
      ...options,
      endNode: end,
    });
    const pts = tourCoursePoints(graph, improved, start);
    expect(pts[pts.length - 1]).toEqual([LAT0 + 9 * SPACING_DEG_LAT, LON0 + 9 * SPACING_DEG_LON]);
    expect(improved.score).toBeGreaterThanOrEqual(p2p[0]!.score);
  });

  it('improvement never lowers the score and keeps the length legal', () => {
    const best = courses[0]!;
    const improved = improveTourCourse(graph, best, start, snapped, options);
    expect(improved.score).toBeGreaterThanOrEqual(best.score);
    expect(improved.lengthM).toBeGreaterThanOrEqual(3600 * 0.95);
    expect(improved.lengthM).toBeLessThanOrEqual(3600 * 1.05);
  });
});

describe('a place down a dead end', () => {
  const stubGraph = buildGraph(gridResponse(true));
  const stubStart = snapToNode(stubGraph, LAT0 + 6 * SPACING_DEG_LAT, LON0 + 6 * SPACING_DEG_LON);
  const tip: TourSearchPlace = {
    id: 'TIP',
    name: 'Tip',
    lat: LAT0 + 6 * SPACING_DEG_LAT,
    lon: STUB_LON,
    score: 90,
    required: true,
  };

  it('a via as the only place still yields a clean course (geometric waypoints)', () => {
    const snapped = snapPlacesToNodes(stubGraph, [tip]);
    const courses = tourLoopSearch(stubGraph, stubStart, snapped, { targetLengthM: 3600 });
    expect(courses.length).toBeGreaterThan(0);
    for (const c of courses) {
      expect(c.collected.some((p) => p.id === 'TIP')).toBe(true);
      expect(c.lengthM).toBeGreaterThanOrEqual(3600 * 0.85);
      expect(c.lengthM).toBeLessThanOrEqual(3600 * 1.15);
      expect(unsanctioned(stubGraph, c, stubStart, snapped)).toBe(0);
    }
  });

  it('is reached by a sanctioned spur — and the course has no other spur', () => {
    const snapped = snapPlacesToNodes(stubGraph, [...ringPlaces(), tip]);
    const courses = tourLoopSearch(stubGraph, stubStart, snapped, { targetLengthM: 3600 });
    expect(courses.length).toBeGreaterThan(0);
    const best = courses[0]!;
    expect(best.collected.some((c) => c.id === 'TIP')).toBe(true);
    // The stub is the only way in: the raw detector sees an out-and-back…
    const pts = tourCoursePoints(stubGraph, best, stubStart);
    expect(unsanctionedSpurCount(pts, [])).toBeGreaterThan(0);
    // …but the place at its tip sanctions it, and nothing else spurs.
    expect(unsanctioned(stubGraph, best, stubStart, snapped)).toBe(0);
  });
});
