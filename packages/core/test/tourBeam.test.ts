import { describe, expect, it } from 'vitest';
import { buildGraph, snapToNode } from '../src/graph/build';
import type { OverpassNode, OverpassResponse, OverpassWay } from '../src/net/overpass';
import {
  improveTourCourse,
  scoreTourCourse,
  snapPlacesToNodes,
  tourBeamSearch,
  tourCoursePoints,
  type TourSearchPlace,
} from '../src/search/tourBeam';

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

  it('improvement never lowers the score and keeps the length legal', () => {
    const best = courses[0]!;
    const improved = improveTourCourse(graph, best, start, snapped, options);
    expect(improved.score).toBeGreaterThanOrEqual(best.score);
    expect(improved.lengthM).toBeGreaterThanOrEqual(3600 * 0.95);
    expect(improved.lengthM).toBeLessThanOrEqual(3600 * 1.05);
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
