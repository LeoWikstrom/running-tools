import { haversineMeters } from '../geo';
import { dijkstra } from '../graph/dijkstra';
import { otherNode, type Graph } from '../graph/types';
import {
  DEFAULT_TOUR_WEIGHTS,
  scoreTourCourse,
  turnFactor,
  type SnappedPlace,
  type TourCourse,
  type TourSearchOptions,
  type TourWeights,
} from './tourScore';

/**
 * "N km that passes the most interesting places": the same beam structure as
 * the profile matcher — (node, distance bucket) states, Dijkstra pruning on
 * reachability, k-shortest-paths window improvement — but the score collects
 * place interest instead of matching a profile, so each state also carries a
 * bitset of the places collected (at most 64 candidates, the best by score).
 */

interface State {
  node: number;
  dist: number;
  /** Bitset of collected place indices, split into two 32-bit halves. */
  bitsLo: number;
  bitsHi: number;
  /** Net running score: interest − per-edge costs − crowding so far. */
  score: number;
  lastCollectD: number;
  lastCollectScore: number;
  parent: State | null;
  viaEdge: number;
}

function hasBit(s: { bitsLo: number; bitsHi: number }, i: number): boolean {
  return i < 32 ? (s.bitsLo & (1 << i)) !== 0 : (s.bitsHi & (1 << (i - 32))) !== 0;
}

function edgeUsed(state: State, edge: number): boolean {
  for (let s: State | null = state; s; s = s.parent) {
    if (s.viaEdge === edge) return true;
  }
  return false;
}

function nodeUsed(state: State, node: number): boolean {
  for (let s: State | null = state; s; s = s.parent) {
    if (s.node === node) return true;
  }
  return false;
}

export function tourBeamSearch(
  graph: Graph,
  startNode: number,
  places: SnappedPlace[],
  options: TourSearchOptions,
): TourCourse[] {
  const w: TourWeights = { ...DEFAULT_TOUR_WEIGHTS, ...options.weights };
  const target = options.targetLengthM;
  const tolerance = options.lengthToleranceFrac ?? 0.05;
  const minLen = target * (1 - tolerance);
  const maxLen = target * (1 + tolerance);
  const bucketM = options.bucketM ?? 100;
  const beamWidth = options.beamWidth ?? 200;
  const minSpacing = options.minSpacingM ?? 200;
  const endNode = options.endNode ?? startNode;

  // Places per node (several statues can share a square's corner node).
  const placesAtNode = new Map<number, number[]>();
  places.forEach((p, i) => {
    const list = placesAtNode.get(p.node);
    if (list) list.push(i);
    else placesAtNode.set(p.node, [i]);
  });

  // Centroid of the candidate places, for the "historic centre" slider.
  let centroidLat = 0;
  let centroidLon = 0;
  for (const p of places) {
    centroidLat += p.lat / places.length;
    centroidLon += p.lon / places.length;
  }
  const centroidCost = (edgeIdx: number): number => {
    if (w.centroid === 0 || places.length === 0) return 0;
    const e = graph.edges[edgeIdx]!;
    const mid = e.lats.length >> 1;
    const km = haversineMeters(e.lats[mid]!, e.lons[mid]!, centroidLat, centroidLon) / 1000;
    return w.centroid * km * e.lengthM;
  };

  // Reachability: a state that cannot reach the finish within maxLen is dead.
  const home = dijkstra(graph, [endNode]).dist;

  // Required places: a course only finishes with all of them collected, and a
  // state that can no longer reach a missing one and still get home is dead.
  let reqLo = 0;
  let reqHi = 0;
  const reqChecks: { idx: number; distTo: Float64Array; toEnd: number }[] = [];
  places.forEach((p, i) => {
    if (!p.required) return;
    if (i < 32) reqLo |= 1 << i;
    else reqHi |= 1 << (i - 32);
    const distTo = dijkstra(graph, [p.node]).dist;
    reqChecks.push({ idx: i, distTo, toEnd: distTo[endNode]! });
  });

  const nBuckets = Math.ceil(maxLen / bucketM) + 1;
  const buckets: State[][] = Array.from({ length: nBuckets }, () => []);

  const collectAt = (
    state: Omit<State, 'parent' | 'viaEdge'> & { parent: State | null; viaEdge: number },
    node: number,
  ): void => {
    const here = placesAtNode.get(node);
    if (!here) return;
    for (const i of here) {
      if (hasBit(state, i)) continue;
      if (i < 32) state.bitsLo |= 1 << i;
      else state.bitsHi |= 1 << (i - 32);
      const p = places[i]!;
      let gain = w.interest * p.score;
      if (state.dist - state.lastCollectD < minSpacing && state.lastCollectScore > 0) {
        gain -= w.crowding * Math.min(p.score, state.lastCollectScore);
      }
      state.score += gain;
      state.lastCollectD = state.dist;
      state.lastCollectScore = p.score;
    }
  };

  const root: State = {
    node: startNode,
    dist: 0,
    bitsLo: 0,
    bitsHi: 0,
    score: 0,
    lastCollectD: -Infinity,
    lastCollectScore: 0,
    parent: null,
    viaEdge: -1,
  };
  collectAt(root, startNode);
  buckets[0]!.push(root);

  const finished: State[] = [];

  for (let b = 0; b < nBuckets; b++) {
    const bucket = buckets[b]!;
    options.onProgress?.(b / nBuckets);
    // Dedupe and rank: one state per (node, bitset), best beamWidth survive.
    const byKey = new Map<string, State>();
    for (const s of bucket) {
      const key = `${s.node},${s.bitsLo},${s.bitsHi}`;
      const seen = byKey.get(key);
      if (!seen || s.score > seen.score) byKey.set(key, s);
    }
    const survivors = [...byKey.values()].sort((a, b2) => b2.score - a.score).slice(0, beamWidth);
    // Same-bucket queue: short edges land in the bucket being processed.
    for (let qi = 0; qi < survivors.length; qi++) {
      const s = survivors[qi]!;
      for (let k = graph.adjOffset[s.node]!; k < graph.adjOffset[s.node + 1]!; k++) {
        const ei = graph.adjEdge[k]!;
        const e = graph.edges[ei]!;
        const v = otherNode(e, s.node);
        const dist = s.dist + e.lengthM;
        if (dist + home[v]! > maxLen) continue;
        if (reqChecks.length > 0) {
          let dead = false;
          for (const r of reqChecks) {
            if (hasBit(s, r.idx)) continue;
            if (dist + r.distTo[v]! + r.toEnd > maxLen) {
              dead = true;
              break;
            }
          }
          if (dead) continue;
        }
        const finishes = v === endNode && dist >= minLen && dist <= maxLen;
        let score = s.score - w.penalty * Math.max(0, e.penalty) * e.lengthM - centroidCost(ei);
        if (edgeUsed(s, ei)) score -= w.repeat * e.lengthM;
        if (w.turn > 0 && s.viaEdge >= 0) {
          score -= w.turn * turnFactor(graph, s.viaEdge, ei, s.node);
        }
        if (w.crossing > 0 && !finishes && nodeUsed(s, v)) score -= w.crossing;
        const next: State = {
          node: v,
          dist,
          bitsLo: s.bitsLo,
          bitsHi: s.bitsHi,
          score,
          lastCollectD: s.lastCollectD,
          lastCollectScore: s.lastCollectScore,
          parent: s,
          viaEdge: ei,
        };
        collectAt(next, v);
        if (finishes && (next.bitsLo & reqLo) === reqLo && (next.bitsHi & reqHi) === reqHi) {
          finished.push(next);
          continue;
        }
        const nb = Math.floor(dist / bucketM);
        if (nb === b) {
          // Keep expanding inside this bucket, capped by the beam width.
          if (survivors.length < beamWidth * 2) survivors.push(next);
          else buckets[Math.min(nb + 1, nBuckets - 1)]!.push(next);
        } else if (nb < nBuckets) {
          buckets[nb]!.push(next);
        }
      }
    }
    buckets[b] = [];
  }
  options.onProgress?.(1);

  finished.sort((a, b2) => finalScore(a) - finalScore(b2)).reverse();
  const out: TourCourse[] = [];
  for (const s of finished.slice(0, 5)) {
    out.push(toCourse(s));
  }
  return out;

  function finalScore(s: State): number {
    return s.score - w.lengthDiff * Math.abs(s.dist - target);
  }

  function toCourse(s: State): TourCourse {
    const edges: number[] = [];
    const dirs: number[] = [];
    for (let cur: State | null = s; cur && cur.parent; cur = cur.parent) {
      edges.push(cur.viaEdge);
      const e = graph.edges[cur.viaEdge]!;
      dirs.push(e.b === cur.node ? 1 : 0);
    }
    edges.reverse();
    dirs.reverse();
    const scored = scoreTourCourse(graph, edges, startNode, places, w, target, minSpacing);
    return { edges, dirs, lengthM: s.dist, score: scored.score, collected: scored.collected };
  }
}
