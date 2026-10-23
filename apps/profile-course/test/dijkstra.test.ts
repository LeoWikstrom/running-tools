import { describe, expect, it } from 'vitest';
import { dijkstra, reconstructPath } from '../src/graph/dijkstra';
import { kShortestPaths, pathNodes } from '../src/graph/ksp';
import { pruneDeadEnds } from '../src/graph/build';
import type { Graph, GraphEdge } from '../src/graph/types';

/**
 * Synthetic diamond graph with a dead-end stub:
 *
 *        1
 *      /   \        0-1: 100   1-3: 100
 *    0       3 - 4  0-2: 150   2-3: 150
 *      \   /        3-4: 50 (stub)
 *        2
 */
function makeGraph(): Graph {
  const mk = (a: number, b: number, lengthM: number): GraphEdge => ({
    a,
    b,
    lengthM,
    surface: 0,
    penalty: 0,
    lats: new Float64Array([0, 0]),
    lons: new Float64Array([0, 0]),
    elev: new Float32Array([0, 0]),
    levelled: false,
    eleTag: null,
    signals: 0,
    cellIds: null,
    cellHead: null,
    traced: 1,
    turnOffsets: new Float64Array(0),
    headOutA: Number.NaN,
    headInB: Number.NaN,
  });
  const edges = [mk(0, 1, 100), mk(1, 3, 100), mk(0, 2, 150), mk(2, 3, 150), mk(3, 4, 50)];
  const n = 5;
  const degree = new Int32Array(n);
  for (const e of edges) {
    degree[e.a]!++;
    degree[e.b]!++;
  }
  const adjOffset = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) adjOffset[i + 1] = adjOffset[i]! + degree[i]!;
  const adjEdge = new Int32Array(edges.length * 2);
  const fill = Int32Array.from(adjOffset.subarray(0, n));
  edges.forEach((e, ei) => {
    adjEdge[fill[e.a]!++] = ei;
    adjEdge[fill[e.b]!++] = ei;
  });
  return {
    nodeLat: new Float64Array(n),
    nodeLon: new Float64Array(n),
    edges,
    adjOffset,
    adjEdge,
  };
}

describe('dijkstra', () => {
  const graph = makeGraph();

  it('finds shortest distances from a single source', () => {
    const { dist } = dijkstra(graph, [0]);
    expect(Array.from(dist)).toEqual([0, 100, 150, 200, 250]);
  });

  it('supports multiple sources', () => {
    const { dist } = dijkstra(graph, [1, 2]);
    expect(dist[0]).toBe(100);
    expect(dist[3]).toBe(100);
  });

  it('respects maxDist', () => {
    const { dist } = dijkstra(graph, [0], { maxDist: 120 });
    expect(dist[3]).toBe(Infinity);
  });

  it('reconstructs the path', () => {
    const result = dijkstra(graph, [0], { target: 3 });
    const path = reconstructPath(graph, result, 0, 3);
    expect(path?.lengthM).toBe(200);
    expect(path?.edges).toEqual([0, 1]);
    expect(pathNodes(graph, path!, 0)).toEqual([0, 1, 3]);
  });
});

describe('kShortestPaths', () => {
  it('returns both diamond paths in length order', () => {
    const graph = makeGraph();
    const paths = kShortestPaths(graph, 0, 3, 3, 1000);
    expect(paths.length).toBe(2);
    expect(paths[0]!.lengthM).toBe(200);
    expect(paths[1]!.lengthM).toBe(300);
  });
});

describe('pruneDeadEnds', () => {
  it('removes the stub but keeps the diamond', () => {
    const graph = makeGraph();
    const { graph: pruned, keepNode } = pruneDeadEnds(graph, 0);
    expect(pruned.edges.length).toBe(4);
    expect(pruned.nodeLat.length).toBe(4);
    expect(keepNode).toBeGreaterThanOrEqual(0);
  });

  it('keeps a stub containing the start node', () => {
    const graph = makeGraph();
    const { graph: pruned } = pruneDeadEnds(graph, 4);
    expect(pruned.edges.length).toBe(5);
  });
});
