import { buildGraph, snapToNode } from '@running/core/graph/build';
import { dijkstra } from '@running/core/graph/dijkstra';
import type { OverpassResponse } from '@running/core/net/overpass';
import { tourLoopSearch } from '@running/core/search/tourLoop';
import {
  improveTourCourse,
  snapPlacesToNodes,
  tourCoursePoints,
  type TourSearchPlace,
  type TourWeights,
} from '@running/core/search/tourScore';

export interface GenerateRequest {
  response: OverpassResponse;
  start: { lat: number; lon: number };
  /** A finish point makes the course point-to-point; null means a loop. */
  end: { lat: number; lon: number } | null;
  places: TourSearchPlace[];
  /** Null (with a finish set): aim for the shortest interesting course. */
  targetLengthM: number | null;
  weights: Partial<TourWeights>;
  /** An existing course's edges: skip the beam, just re-improve — used when a
      place was removed so detours to it can straighten. The graph is rebuilt
      deterministically from the same response, so the indices stay valid. */
  refineEdges?: number[];
  /** ± fraction the improved length may differ from the target. Refinement
      relaxes it: straightening a removed place's detour shortens the course,
      which the search tolerance would reject. */
  lengthToleranceFrac?: number;
}

export type GenerateReply =
  | { type: 'progress'; fraction: number }
  | {
      type: 'result';
      points: [number, number][];
      lengthM: number;
      score: number;
      edges: number[];
      collected: { id: string; name: string; d: number; score: number }[];
    }
  | { type: 'error'; message: string };

const post = (msg: GenerateReply): void => postMessage(msg);

onmessage = (e: MessageEvent<GenerateRequest>) => {
  try {
    const { response, start, end, places, targetLengthM, weights, refineEdges } = e.data;
    const lengthToleranceFrac = e.data.lengthToleranceFrac;
    const graph = buildGraph(response, { connectors: true });
    const startNode = snapToNode(graph, start.lat, start.lon, 150);
    if (startNode < 0) throw new Error('No runnable way within 150 m of the start point.');
    let endNode: number | undefined;
    if (end) {
      endNode = snapToNode(graph, end.lat, end.lon, 150);
      if (endNode < 0) throw new Error('No runnable way within 150 m of the finish point.');
    }
    const snapped = snapPlacesToNodes(graph, places);
    if (snapped.length === 0) {
      throw new Error('No interesting places near enough a runnable way here.');
    }
    const missingVia = places.find(
      (p) => p.required && !snapped.some((s) => s.required && s.id === p.id),
    );
    if (missingVia) {
      throw new Error(`No runnable way within 60 m of ${missingVia.name}.`);
    }
    // No length given: the shortest path start→finish becomes the target, so
    // lengthDiff charges exactly the extra metres a detour costs — interest
    // has to pay for them. The tolerance opens upward to give detours room.
    let target = targetLengthM;
    let tolerance = lengthToleranceFrac;
    if (target === null) {
      if (endNode === undefined) throw new Error('Without a length the course needs a finish.');
      const shortest = dijkstra(graph, [endNode]).dist[startNode]!;
      if (!Number.isFinite(shortest)) {
        throw new Error('No runnable way connects the start to the finish here.');
      }
      target = Math.max(shortest, 400);
      tolerance = Math.max(tolerance ?? 0, (0.5 * target + 1000) / target);
    }
    const options = {
      targetLengthM: target,
      weights,
      endNode,
      lengthToleranceFrac: tolerance,
      onProgress: (fraction: number) => post({ type: 'progress', fraction: fraction * 0.8 }),
    };
    const base = refineEdges
      ? { edges: refineEdges, dirs: [], lengthM: 0, score: 0, collected: [] }
      : tourLoopSearch(graph, startNode, snapped, options)[0];
    if (!base) {
      throw new Error('No course of that length found here — try another start or length.');
    }
    post({ type: 'progress', fraction: 0.85 });
    const improved = improveTourCourse(graph, base, startNode, snapped, {
      ...options,
      onProgress: (fraction) => post({ type: 'progress', fraction: 0.85 + fraction * 0.15 }),
    });
    post({
      type: 'result',
      points: tourCoursePoints(graph, improved, startNode),
      lengthM: improved.lengthM,
      score: improved.score,
      edges: improved.edges,
      collected: improved.collected,
    });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
