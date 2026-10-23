import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildGraph,
  filterToComponent,
  pruneDeadEnds,
  sampleEdgeElevations,
  snapToNode,
} from '../src/graph/build';
import { matchTrackToGraph } from '../src/graph/match';
import { otherNode, type Graph } from '../src/graph/types';
import type { OverpassResponse } from '../src/net/overpass';
import { assembleCourse } from '../src/search/score';
import { FixtureSampler } from './helpers/fixtureSampler';

let graph: Graph;
let startNode: number;

beforeAll(async () => {
  const response = JSON.parse(
    readFileSync('test/fixtures/overpass_skatas_250m.json', 'utf8'),
  ) as OverpassResponse;
  const full = buildGraph(response);
  const snapped = snapToNode(full, 57.7046, 12.0381);
  const filtered = filterToComponent(full, snapped);
  const pruned = pruneDeadEnds(filtered.graph, filtered.startNode);
  graph = pruned.graph;
  startNode = pruned.keepNode;
  await sampleEdgeElevations(graph, new FixtureSampler());
});

describe('matchTrackToGraph', () => {
  it('recovers a walk along real edges', () => {
    // Build a ~600 m track by walking edges from the start node.
    const lats: number[] = [];
    const lons: number[] = [];
    let node = startNode;
    let prevEdge = -1;
    let dist = 0;
    const edgesWalked: number[] = [];
    while (dist < 600) {
      let picked = -1;
      for (let k = graph.adjOffset[node]!; k < graph.adjOffset[node + 1]!; k++) {
        const ei = graph.adjEdge[k]!;
        if (ei !== prevEdge) {
          picked = ei;
          break;
        }
      }
      if (picked < 0) break;
      const e = graph.edges[picked]!;
      const forward = e.a === node;
      for (let i = 0; i < e.lats.length; i++) {
        const idx = forward ? i : e.lats.length - 1 - i;
        lats.push(e.lats[idx]!);
        lons.push(e.lons[idx]!);
      }
      edgesWalked.push(picked);
      dist += e.lengthM;
      node = otherNode(e, node);
      prevEdge = picked;
    }
    expect(dist).toBeGreaterThan(400);

    const { path, snappedFraction } = matchTrackToGraph(graph, lats, lons);
    expect(snappedFraction).toBeGreaterThan(0.9);
    const course = assembleCourse(graph, path);
    expect(course.lengthM).toBeGreaterThan(dist * 0.7);
    expect(course.lengthM).toBeLessThan(dist * 1.3);
  });

  it('throws for a track far outside the graph', () => {
    const lats = [58.5, 58.501, 58.502];
    const lons = [13.0, 13.0, 13.0];
    expect(() => matchTrackToGraph(graph, lats, lons)).toThrow(/match/i);
  });
});
