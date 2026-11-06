import { describe, expect, it } from 'vitest';
import { buildGraph, snapToNode } from '../src/graph/build';
import { otherNode } from '../src/graph/types';
import type { OverpassNode, OverpassResponse, OverpassWay } from '../src/net/overpass';
import { tourBeamSearch } from '../src/search/tourBeam';
import {
  improveTourCourse,
  scoreTourCourse,
  snapPlacesToNodes,
  tourCoursePoints,
  type TourSearchPlace,
} from '../src/search/tourScore';

/**
 * A synthetic city: a 13×13 street grid, 150 m spacing. Vertical streets are
 * pleasant (residential with sidewalks); horizontal streets in the southern
 * half are nasty (tertiary, no sidewalk, fast), so the search has something
 * to avoid. Interesting places sit on a ring of intersections.
 */
const SIZE = 13;
const SPACING_DEG_LAT = 150 / 111_195;
const LAT0 = 57.7;
const LON0 = 11.97;
const COS = Math.cos((LAT0 * Math.PI) / 180);
const SPACING_DEG_LON = SPACING_DEG_LAT / COS;

function gridResponse(): OverpassResponse {
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
  return { elements: [...ways, ...nodes] };
}

const graph = buildGraph(gridResponse());
const start = snapToNode(graph, LAT0 + 6 * SPACING_DEG_LAT, LON0 + 6 * SPACING_DEG_LON);

/** Twelve places on a ring about 2–4 grid steps out from the centre. */
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

describe('corridor repeat: the other sidewalk is the same ground', () => {
  // Two parallel 300 m paths 10 m apart, joined at both ends.
  function twinResponse(): OverpassResponse {
    const dLat = 10 / 111_195;
    const nodes: OverpassNode[] = [];
    for (let i = 0; i <= 6; i++) {
      nodes.push({ type: 'node', id: 10 + i, lat: LAT0, lon: LON0 + (i * 50) / 111_195 / COS });
      nodes.push({
        type: 'node',
        id: 20 + i,
        lat: LAT0 + dLat,
        lon: LON0 + (i * 50) / 111_195 / COS,
      });
    }
    const path = { highway: 'footway' };
    const ways: OverpassWay[] = [
      { type: 'way', id: 1, nodes: [10, 11, 12, 13, 14, 15, 16], tags: path },
      { type: 'way', id: 2, nodes: [20, 21, 22, 23, 24, 25, 26], tags: path },
      { type: 'way', id: 3, nodes: [10, 20], tags: path },
      { type: 'way', id: 4, nodes: [16, 26], tags: path },
    ];
    return { elements: [...ways, ...nodes] };
  }

  it('charges going out on one side and back on the other like a repeat', () => {
    const g = buildGraph(twinResponse());
    const s = snapToNode(g, LAT0, LON0);
    // Walk the full loop: out on the south path, over, back on the north path.
    const edges: number[] = [];
    let node = s;
    const visited = new Set<number>();
    for (;;) {
      visited.add(node);
      let next = -1;
      for (let k = g.adjOffset[node]!; k < g.adjOffset[node + 1]!; k++) {
        const e = g.edges[g.adjEdge[k]!]!;
        const v = otherNode(e, node);
        if (!visited.has(v)) {
          next = g.adjEdge[k]!;
          break;
        }
      }
      if (next < 0) break;
      edges.push(next);
      node = otherNode(g.edges[next]!, node);
    }
    // Close the loop back to the start.
    for (let k = g.adjOffset[node]!; k < g.adjOffset[node + 1]!; k++) {
      const e = g.edges[g.adjEdge[k]!]!;
      if (otherNode(e, node) === s && !edges.includes(g.adjEdge[k]!)) {
        edges.push(g.adjEdge[k]!);
        break;
      }
    }
    const target = 620;
    const base = { interest: 1, penalty: 0, lengthDiff: 0, crowding: 0, centroid: 0, turn: 0, crossing: 0 };
    const free = scoreTourCourse(g, edges, s, [], { ...base, repeat: 0 }, target);
    const charged = scoreTourCourse(g, edges, s, [], { ...base, repeat: 0.1 }, target);
    // The way back covers the way out's cells: ~300 m of repeat at 0.1/m.
    expect(free.score - charged.score).toBeGreaterThan(0.1 * 200);
  });
});

describe('snapPlacesToNodes', () => {
  it('snaps to the nearest node within 60 m and drops the rest', () => {
    const places = snapPlacesToNodes(graph, [
      { id: 'near', name: 'near', lat: LAT0 + 20 / 111_195, lon: LON0, score: 50 },
      { id: 'far', name: 'far', lat: LAT0 + 75 / 111_195, lon: LON0, score: 50 },
    ]);
    expect(places.map((p) => p.id)).toEqual(['near']);
    expect(places[0]!.node).toBe(snapToNode(graph, LAT0, LON0));
  });
});

describe('tourBeamSearch on the synthetic grid', () => {
  const snapped = snapPlacesToNodes(graph, ringPlaces());
  const options = { targetLengthM: 3600 };
  const courses = tourBeamSearch(graph, start, snapped, options);

  it('returns loops of the right length back to the start', () => {
    expect(courses.length).toBeGreaterThan(0);
    for (const c of courses) {
      expect(c.lengthM).toBeGreaterThanOrEqual(3600 * 0.95);
      expect(c.lengthM).toBeLessThanOrEqual(3600 * 1.05);
      // A loop: edge count parity aside, the geometry closes on the start.
      const pts = tourCoursePoints(graph, c, start);
      expect(pts[0]).toEqual(pts[pts.length - 1]);
    }
  });

  it('collects a good handful of the interesting places', () => {
    const best = courses[0]!;
    expect(best.collected.length).toBeGreaterThanOrEqual(6);
    // Collected in course order.
    for (let i = 1; i < best.collected.length; i++) {
      expect(best.collected[i]!.d).toBeGreaterThanOrEqual(best.collected[i - 1]!.d);
    }
  });

  it('prefers streets with sidewalks over the nasty half of the grid', () => {
    const best = courses[0]!;
    let nastyLen = 0;
    for (let i = 0; i < best.edges.length; i++) {
      const e = graph.edges[best.edges[i]!]!;
      if (e.penalty > 0) nastyLen += e.lengthM;
    }
    // The ring passes through the southern half, but the course should keep
    // the share of unpleasant ground well under half.
    expect(nastyLen / best.lengthM).toBeLessThan(0.35);
  });

  it('the turn weight buys a rounder course: fewer junction direction changes', () => {
    const countTurns = (c: (typeof courses)[number]): number => {
      let turns = 0;
      for (let i = 1; i < c.edges.length; i++) {
        const a = graph.edges[c.edges[i - 1]!]!;
        const b = graph.edges[c.edges[i]!]!;
        // On the grid every edge is axis-aligned: a turn is a change of axis.
        const aNS = a.lats[0] !== a.lats[a.lats.length - 1];
        const bNS = b.lats[0] !== b.lats[b.lats.length - 1];
        if (aNS !== bNS) turns++;
      }
      return turns;
    };
    const round = tourBeamSearch(graph, start, snapped, { ...options, weights: { turn: 6 } });
    expect(round.length).toBeGreaterThan(0);
    expect(countTurns(round[0]!)).toBeLessThan(countTurns(courses[0]!));
  });

  it('the crossing weight stops little loops: no node is visited twice', () => {
    const smooth = tourBeamSearch(graph, start, snapped, {
      ...options,
      weights: { turn: 6, crossing: 25 },
    });
    expect(smooth.length).toBeGreaterThan(0);
    const seen = new Set<number>([start]);
    let node = start;
    const edges = smooth[0]!.edges;
    for (let i = 0; i < edges.length - 1; i++) {
      node = otherNode(graph.edges[edges[i]!]!, node);
      expect(seen.has(node)).toBe(false);
      seen.add(node);
    }
  });

  it('a required place is collected whatever it scores, and improvement keeps it', () => {
    // A dull corner place far from the interesting ring: skipped when free.
    const dull: TourSearchPlace = {
      id: 'VIA',
      name: 'Via',
      lat: LAT0 + 11 * SPACING_DEG_LAT,
      lon: LON0 + 11 * SPACING_DEG_LON,
      score: 5,
    };
    const free = tourBeamSearch(graph, start, snapPlacesToNodes(graph, [...ringPlaces(), dull]), options);
    expect(free[0]!.collected.some((c) => c.id === 'VIA')).toBe(false);

    const snappedVia = snapPlacesToNodes(graph, [...ringPlaces(), { ...dull, required: true }]);
    const must = tourBeamSearch(graph, start, snappedVia, options);
    expect(must.length).toBeGreaterThan(0);
    expect(must[0]!.collected.some((c) => c.id === 'VIA')).toBe(true);
    const improved = improveTourCourse(graph, must[0]!, start, snappedVia, options);
    expect(improved.collected.some((c) => c.id === 'VIA')).toBe(true);
    expect(improved.lengthM).toBeGreaterThanOrEqual(3600 * 0.95);
    expect(improved.lengthM).toBeLessThanOrEqual(3600 * 1.05);
  });

  it('a finish node makes the course point-to-point', () => {
    const end = snapToNode(graph, LAT0 + 9 * SPACING_DEG_LAT, LON0 + 9 * SPACING_DEG_LON);
    const p2p = tourBeamSearch(graph, start, snapped, { ...options, endNode: end });
    expect(p2p.length).toBeGreaterThan(0);
    for (const c of p2p) {
      expect(c.lengthM).toBeGreaterThanOrEqual(3600 * 0.95);
      expect(c.lengthM).toBeLessThanOrEqual(3600 * 1.05);
      const pts = tourCoursePoints(graph, c, start);
      expect(pts[0]).toEqual([LAT0 + 6 * SPACING_DEG_LAT, LON0 + 6 * SPACING_DEG_LON]);
      expect(pts[pts.length - 1]).toEqual([LAT0 + 9 * SPACING_DEG_LAT, LON0 + 9 * SPACING_DEG_LON]);
    }
    // Improvement keeps both endpoints where they are.
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

  it('re-improving after a place is dropped keeps the course legal', () => {
    const best = courses[0]!;
    const droppedId = best.collected[0]!.id;
    const remaining = snapped.filter((p) => p.id !== droppedId);
    const improved = improveTourCourse(graph, best, start, remaining, options);
    expect(improved.lengthM).toBeGreaterThanOrEqual(3600 * 0.95);
    expect(improved.lengthM).toBeLessThanOrEqual(3600 * 1.05);
    expect(improved.collected.some((c) => c.id === droppedId)).toBe(false);
  });

  it('a repeated edge costs: an out-and-back scores below the loop', () => {
    const best = courses[0]!;
    // Walking the first half out and back (same edges twice).
    const half = best.edges.slice(0, Math.floor(best.edges.length / 2));
    const outAndBack = [...half, ...[...half].reverse()];
    const loop = scoreTourCourse(
      graph, best.edges, start, snapped, {
        interest: 1, repeat: 0.08, penalty: 0.05, lengthDiff: 0.05, crowding: 0.5, centroid: 0,
      }, 3600,
    );
    const doubled = scoreTourCourse(
      graph, outAndBack, start, snapped, {
        interest: 1, repeat: 0.08, penalty: 0.05, lengthDiff: 0.05, crowding: 0.5, centroid: 0,
      }, 3600,
    );
    expect(doubled.score).toBeLessThan(loop.score);
  });

  it('crowding: two adjacent places pay, spread ones do not', () => {
    const spread = snapPlacesToNodes(graph, [
      { id: 'a', name: 'a', lat: LAT0 + 6 * SPACING_DEG_LAT, lon: LON0 + 7 * SPACING_DEG_LON, score: 50 },
      { id: 'b', name: 'b', lat: LAT0 + 6 * SPACING_DEG_LAT, lon: LON0 + 9 * SPACING_DEG_LON, score: 50 },
    ]);
    const crowdedPair = snapPlacesToNodes(graph, [
      { id: 'a', name: 'a', lat: LAT0 + 6 * SPACING_DEG_LAT, lon: LON0 + 7 * SPACING_DEG_LON, score: 50 },
      { id: 'b', name: 'b', lat: LAT0 + 6 * SPACING_DEG_LAT, lon: LON0 + 8 * SPACING_DEG_LON, score: 50 },
    ]);
    // One straight line of edges east from the centre, 3 steps.
    const edges: number[] = [];
    let node = start;
    for (let step = 0; step < 3; step++) {
      for (let k = graph.adjOffset[node]!; k < graph.adjOffset[node + 1]!; k++) {
        const ei = graph.adjEdge[k]!;
        const e = graph.edges[ei]!;
        const v = e.a === node ? e.b : e.a;
        if (graph.nodeLon[v]! > graph.nodeLon[node]! && graph.nodeLat[v] === graph.nodeLat[node]) {
          edges.push(ei);
          node = v;
          break;
        }
      }
    }
    const w = { interest: 1, repeat: 0, penalty: 0, lengthDiff: 0, crowding: 0.5, centroid: 0 };
    const spreadScore = scoreTourCourse(graph, edges, start, spread, w, 450).score;
    const crowdedScore = scoreTourCourse(graph, edges, start, crowdedPair, w, 450).score;
    expect(crowdedScore).toBeLessThan(spreadScore);
  });
});
