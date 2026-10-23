import { buildGraph, snapToNode } from '@running/core/graph/build';
import type { OverpassResponse } from '@running/core/net/overpass';
import {
  improveTourCourse,
  snapPlacesToNodes,
  tourBeamSearch,
  tourCoursePoints,
  type TourSearchPlace,
  type TourWeights,
} from '@running/core/search/tourBeam';

export interface GenerateRequest {
  response: OverpassResponse;
  start: { lat: number; lon: number };
  places: TourSearchPlace[];
  targetLengthM: number;
  weights: Partial<TourWeights>;
}

export type GenerateReply =
  | { type: 'progress'; fraction: number }
  | {
      type: 'result';
      points: [number, number][];
      lengthM: number;
      score: number;
      collected: { id: string; name: string; d: number; score: number }[];
    }
  | { type: 'error'; message: string };

const post = (msg: GenerateReply): void => postMessage(msg);

onmessage = (e: MessageEvent<GenerateRequest>) => {
  try {
    const { response, start, places, targetLengthM, weights } = e.data;
    const graph = buildGraph(response, { connectors: true });
    const startNode = snapToNode(graph, start.lat, start.lon, 150);
    if (startNode < 0) throw new Error('No runnable way within 150 m of the start point.');
    const snapped = snapPlacesToNodes(graph, places);
    if (snapped.length === 0) {
      throw new Error('No interesting places near enough a runnable way here.');
    }
    const options = {
      targetLengthM,
      weights,
      onProgress: (fraction: number) => post({ type: 'progress', fraction: fraction * 0.8 }),
    };
    const courses = tourBeamSearch(graph, startNode, snapped, options);
    if (courses.length === 0) {
      throw new Error('No loop of that length found here — try another start or length.');
    }
    post({ type: 'progress', fraction: 0.85 });
    const improved = improveTourCourse(graph, courses[0]!, startNode, snapped, options);
    post({
      type: 'result',
      points: tourCoursePoints(graph, improved, startNode),
      lengthM: improved.lengthM,
      score: improved.score,
      collected: improved.collected,
    });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
