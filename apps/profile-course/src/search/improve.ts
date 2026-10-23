import type { TargetProfile } from '../gpx/profile';
import type { Graph } from '../graph/types';
import { kShortestPaths, pathNodes } from '../graph/ksp';
import {
  assembleCourse,
  scoreCourse,
  DEFAULT_WEIGHTS,
  MIX_ROAD,
  type CoursePath,
  type SurfaceMix,
  type Weights,
} from './score';
import type { WalkCandidate } from './randomWalk';

export interface ImproveOptions {
  k?: number;
  passes?: number;
  windowStepM?: number;
  windowLengthM?: number;
  maxCandidates?: number;
  desiredMix?: SurfaceMix | null;
  weights?: Weights;
  /** Reject window replacements that break constraints (e.g. via points). */
  validatePath?: (path: CoursePath) => boolean;
  shouldCancel?: () => boolean;
  /** Overall progress 0..1, with the candidate currently being polished. */
  onProgress?: (fraction: number, current: WalkCandidate) => void;
}

/** Above this share of shared edges, two courses are the same run out. */
const SAME_COURSE_OVERLAP = 0.8;

function edgeOverlap(a: Set<number>, b: Set<number>): number {
  let shared = 0;
  for (const edge of a) if (b.has(edge)) shared++;
  return shared / Math.min(a.size, b.size);
}

/**
 * Whether a course covers mostly the ground of one already being offered.
 * Each alternative gets a search of its own that is steered away from the
 * courses before it; this only catches the times that steering fails.
 */
export function sameRunAs(
  candidate: WalkCandidate,
  others: WalkCandidate[],
  maxOverlap = SAME_COURSE_OVERLAP,
): boolean {
  const edges = new Set(candidate.path.edges);
  return others.some((o) => edgeOverlap(edges, new Set(o.path.edges)) > maxOverlap);
}

function spliceWindow(
  path: CoursePath,
  from: number,
  to: number,
  replacement: { edges: number[]; dirs: number[] },
): CoursePath {
  return {
    edges: [...path.edges.slice(0, from), ...replacement.edges, ...path.edges.slice(to)],
    dirs: [...path.dirs.slice(0, from), ...replacement.dirs, ...path.dirs.slice(to)],
  };
}

export async function improveCandidates(
  graph: Graph,
  startNode: number,
  candidates: WalkCandidate[],
  target: TargetProfile,
  targetLengthM: number,
  options: ImproveOptions = {},
): Promise<WalkCandidate[]> {
  const {
    k = 5,
    passes = 4,
    windowStepM = 400,
    windowLengthM = 800,
    maxCandidates = 5,
    desiredMix = MIX_ROAD,
    weights = DEFAULT_WEIGHTS,
    validatePath,
    shouldCancel,
    onProgress,
  } = options;

  const minLen = targetLengthM * 0.97;
  const maxLen = targetLengthM * 1.03;
  const improved: WalkCandidate[] = candidates.map((c) => ({ ...c }));

  // With multi-start searches a candidate's root is not necessarily the
  // marker node; derive it from the first edge.
  const rootOf = (c: WalkCandidate): number => {
    if (c.path.edges.length === 0) return startNode;
    const e = graph.edges[c.path.edges[0]!]!;
    return c.path.dirs[0] === 1 ? e.a : e.b;
  };

  const cumOf = (path: CoursePath): number[] => {
    const cum: number[] = [0];
    for (const ei of path.edges) cum.push(cum[cum.length - 1]! + graph.edges[ei]!.lengthM);
    return cum;
  };

  // Yen's answers depend only on the (static) graph, and the later passes
  // rescan mostly unchanged windows — so repeats are answered from a cache
  // instead of running the k-shortest-paths search again.
  const altsCache = new Map<string, ReturnType<typeof kShortestPaths>>();
  const altsFor = (
    from: number,
    to: number,
    windowLen: number,
  ): ReturnType<typeof kShortestPaths> => {
    const key = `${from},${to},${Math.round(windowLen)}`;
    let alts = altsCache.get(key);
    if (!alts) {
      alts = kShortestPaths(graph, from, to, k, windowLen * 1.6);
      altsCache.set(key, alts);
    }
    return alts;
  };

  async function scanOnce(
    start: WalkCandidate,
    onWindow?: (fraction: number, current: WalkCandidate) => void,
  ): Promise<WalkCandidate | null> {
    let current = start;
    let anyChange = false;
    // The course only changes when a window is replaced; recomputing its
    // nodes and cumulative lengths per window made every scan quadratic.
    let nodes = pathNodes(graph, current.path, rootOf(current));
    let cum = cumOf(current.path);

    for (let windowStart = 0, wi = 0; ; windowStart += windowStepM, wi++) {
      if (shouldCancel?.()) break;
      const totalLen = cum[cum.length - 1]!;
      if (windowStart >= totalLen - 300) break;
      onWindow?.(windowStart / Math.max(1, totalLen), current);
      // Let a cancel message reach the worker mid-scan — but not every
      // window, or the timer clamp (4 ms past five chained timeouts) would
      // cost more than it buys.
      if ((wi & 7) === 7) await new Promise((resolve) => setTimeout(resolve, 0));

      let fromIdx = 0;
      while (fromIdx < nodes.length - 2 && cum[fromIdx]! < windowStart) fromIdx++;
      let toIdx = fromIdx + 1;
      while (toIdx < nodes.length - 1 && cum[toIdx]! - cum[fromIdx]! < windowLengthM) toIdx++;
      const windowLen = cum[toIdx]! - cum[fromIdx]!;
      if (windowLen < 300 || windowLen > 1500 || nodes[fromIdx] === nodes[toIdx]) continue;

      const alts = altsFor(nodes[fromIdx]!, nodes[toIdx]!, windowLen);
      for (const alt of alts) {
        const newLen = current.course.lengthM - windowLen + alt.lengthM;
        if (newLen < minLen || newLen > maxLen) continue;
        const newPath = spliceWindow(current.path, fromIdx, toIdx, alt);
        if (validatePath && !validatePath(newPath)) continue;
        const course = assembleCourse(graph, newPath);
        const score = scoreCourse(course, target, desiredMix, weights);
        if (score < current.score) {
          current = { path: newPath, course, score };
          anyChange = true;
          nodes = pathNodes(graph, current.path, rootOf(current));
          cum = cumOf(current.path);
          break;
        }
      }
    }
    return anyChange ? current : null;
  }

  const n = Math.min(improved.length, maxCandidates);
  for (let ci = 0; ci < n; ci++) {
    for (let pass = 0; pass < passes; pass++) {
      if (shouldCancel?.()) break;
      const better = await scanOnce(improved[ci]!, (f, current) =>
        onProgress?.((ci + (pass + f) / passes) / n, current),
      );
      if (!better) break;
      improved[ci] = better;
    }
  }
  return improved.sort((a, b) => a.score - b.score);
}
