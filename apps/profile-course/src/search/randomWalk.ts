import type { TargetProfile } from '../gpx/profile';
import { dijkstra } from '../graph/dijkstra';
import { otherNode, type Graph } from '../graph/types';
import {
  assembleCourse,
  scoreCourse,
  DEFAULT_WEIGHTS,
  MIX_ROAD,
  type AssembledCourse,
  type CoursePath,
  type SurfaceMix,
  type Weights,
} from './score';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface WalkCandidate {
  path: CoursePath;
  course: AssembledCourse;
  score: number;
}

export interface RandomWalkOptions {
  seed: number;
  walks?: number;
  keepBest?: number;
  lengthTolerance?: number;
  desiredMix?: SurfaceMix | null;
  weights?: Weights;
  /** Courses must end back at the start node. */
  returnToStart?: boolean;
  /** 1 = node is a valid course end; see BeamOptions.validEnd. */
  validEnd?: Uint8Array | null;
  /** Additional allowed start nodes; each walk picks one at random. */
  startNodes?: number[] | null;
  onProgress?: (done: number, total: number, best: WalkCandidate | null) => void;
  shouldCancel?: () => boolean;
}

function targetElevationAt(target: TargetProfile, distM: number): number {
  const idx = distM / 25;
  const i0 = Math.min(Math.floor(idx), target.samples.length - 1);
  const i1 = Math.min(i0 + 1, target.samples.length - 1);
  const t = idx - i0;
  return target.samples[i0]! * (1 - t) + target.samples[i1]! * t;
}

export async function randomWalkSearch(
  graph: Graph,
  startNode: number,
  target: TargetProfile,
  targetLengthM: number,
  options: RandomWalkOptions,
): Promise<WalkCandidate[]> {
  const {
    seed,
    walks = 2000,
    keepBest = 20,
    lengthTolerance = 0.03,
    desiredMix = MIX_ROAD,
    weights = DEFAULT_WEIGHTS,
    returnToStart = false,
    validEnd = null,
    startNodes = null,
    onProgress,
    shouldCancel,
  } = options;
  const roots = returnToStart || !startNodes || startNodes.length === 0 ? [startNode] : startNodes;

  const rng = mulberry32(seed);
  const minLen = targetLengthM * (1 - lengthTolerance);
  const maxLen = targetLengthM * (1 + lengthTolerance);

  let endMask: Uint8Array | null = null;
  if (returnToStart) {
    endMask = new Uint8Array(graph.nodeLat.length);
    endMask[startNode] = 1;
  } else if (validEnd) {
    endMask = validEnd;
  }
  const endSources: number[] = [];
  if (endMask) {
    for (let i = 0; i < endMask.length; i++) if (endMask[i]) endSources.push(i);
  }
  const distBack = endMask ? dijkstra(graph, endSources).dist : null;
  const best: WalkCandidate[] = [];

  const edgeIdx: number[] = [];
  const edgeWeight: number[] = [];

  for (let walk = 0; walk < walks; walk++) {
    if (shouldCancel?.()) break;

    const path: CoursePath = { edges: [], dirs: [] };
    const used = new Map<number, number>();
    let node = roots.length === 1 ? roots[0]! : roots[Math.floor(rng() * roots.length)]!;
    let dist = 0;
    let prevEdge = -1;
    let failed = false;

    while (dist < minLen || (endMask !== null && !endMask[node])) {
      if (dist >= maxLen) {
        failed = true;
        break;
      }
      edgeIdx.length = 0;
      edgeWeight.length = 0;
      const targetDeltaBase = targetElevationAt(target, dist);
      for (let k = graph.adjOffset[node]!; k < graph.adjOffset[node + 1]!; k++) {
        const ei = graph.adjEdge[k]!;
        if (ei === prevEdge) continue; // no immediate in-and-back
        const e = graph.edges[ei]!;
        if (dist + e.lengthM > maxLen) continue;
        if (distBack && dist + e.lengthM + distBack[otherNode(e, node)]! > maxLen) continue;
        const elev = e.elev!;
        const forward = e.a === node;
        const edgeDelta = forward
          ? elev[elev.length - 1]! - elev[0]!
          : elev[0]! - elev[elev.length - 1]!;
        const wantDelta = targetElevationAt(target, dist + e.lengthM) - targetDeltaBase;
        let w = Math.exp(-Math.abs(edgeDelta - wantDelta) / 8);
        w *= Math.exp(-2 * e.penalty);
        const uses = used.get(ei) ?? 0;
        if (uses > 0) w *= 0.3 ** uses;
        edgeIdx.push(ei);
        edgeWeight.push(w);
      }

      if (edgeIdx.length === 0) {
        failed = true;
        break;
      }

      let total = 0;
      for (const w of edgeWeight) total += w;
      let r = rng() * total;
      let pick = edgeIdx.length - 1;
      for (let i = 0; i < edgeIdx.length; i++) {
        r -= edgeWeight[i]!;
        if (r <= 0) {
          pick = i;
          break;
        }
      }

      const ei = edgeIdx[pick]!;
      const e = graph.edges[ei]!;
      path.edges.push(ei);
      path.dirs.push(e.a === node ? 1 : 0);
      used.set(ei, (used.get(ei) ?? 0) + 1);
      node = otherNode(e, node);
      dist += e.lengthM;
      prevEdge = ei;
    }

    if (
      !failed &&
      dist >= minLen &&
      dist <= maxLen &&
      path.edges.length > 0 &&
      (!endMask || endMask[node])
    ) {
      const course = assembleCourse(graph, path);
      const score = scoreCourse(course, target, desiredMix, weights);
      if (best.length < keepBest || score < best[best.length - 1]!.score) {
        best.push({ path, course, score });
        best.sort((x, y) => x.score - y.score);
        if (best.length > keepBest) best.length = keepBest;
      }
    }

    if (walk % 100 === 99) {
      onProgress?.(walk + 1, walks, best[0] ?? null);
      // Yield so cancel messages can be processed in the worker.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  onProgress?.(walks, walks, best[0] ?? null);
  return best;
}
