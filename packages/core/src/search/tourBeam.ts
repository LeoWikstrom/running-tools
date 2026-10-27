import { angleDiffDeg, bearingDeg, haversineMeters } from '../geo';
import { cellAndNeighbours, cellIdAt } from '../graph/cells';
import { dijkstra } from '../graph/dijkstra';
import { kShortestPaths, pathNodes } from '../graph/ksp';
import { otherNode, type Graph } from '../graph/types';

/**
 * "N km that passes the most interesting places": the same beam structure as
 * the profile matcher — (node, distance bucket) states, Dijkstra pruning on
 * reachability, k-shortest-paths window improvement — but the score collects
 * place interest instead of matching a profile, so each state also carries a
 * bitset of the places collected (at most 64 candidates, the best by score).
 */

export interface TourSearchPlace {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** Interest 0–100 from core/poi. */
  score: number;
  /** A via: the course must collect this place, whatever it scores. */
  required?: boolean;
}

export interface TourWeights {
  /** Multiplier on collected interest. */
  interest: number;
  /** Cost per metre of ground walked more than once. In the final scorer the
      same ~14 m corridor grid as profile-course decides "same ground", so
      going back down the other sidewalk of the same street also pays. */
  repeat: number;
  /** Multiplier on the edge safety penalty (per metre). */
  penalty: number;
  /** Cost per metre of |L − Ltarget| at completion. */
  lengthDiff: number;
  /** Cost per crowded pair: this × the lower of the two interests. */
  crowding: number;
  /** Cost per metre per km the edge lies from the centroid of the places. */
  centroid: number;
  /** Cost per junction direction change: this × (1 − cos θ), so a U-turn pays double a right angle. */
  turn: number;
  /** Flat cost each time the course re-visits a node (the start exempt) — a
      detour looping round a block comes back to the node it left from. */
  crossing: number;
}

export const DEFAULT_TOUR_WEIGHTS: TourWeights = {
  interest: 1,
  repeat: 0.08,
  penalty: 0.05,
  lengthDiff: 0.05,
  crowding: 0.5,
  centroid: 0,
  turn: 0,
  crossing: 0,
};

export interface TourSearchOptions {
  targetLengthM: number;
  weights?: Partial<TourWeights>;
  /** Collected places closer than this along the course crowd each other. */
  minSpacingM?: number;
  bucketM?: number;
  beamWidth?: number;
  /** ± fraction of the target length a finished loop may differ. */
  lengthToleranceFrac?: number;
  /** Wall-clock cap on improveTourCourse; dense city graphs need one. */
  improveTimeMs?: number;
  /** Finish node for a point-to-point course; the start itself when absent (a loop). */
  endNode?: number;
  onProgress?: (fraction: number) => void;
}

export interface CollectedPlace {
  id: string;
  name: string;
  /** Where along the course it is collected, metres. */
  d: number;
  score: number;
}

export interface TourCourse {
  edges: number[];
  dirs: number[];
  lengthM: number;
  score: number;
  collected: CollectedPlace[];
}

const MAX_PLACES = 64;

export interface SnappedPlace extends TourSearchPlace {
  node: number;
}

/** Snap places to the nearest graph node within maxDistM; drop the rest. */
export function snapPlacesToNodes(
  graph: Graph,
  places: TourSearchPlace[],
  maxDistM = 60,
): SnappedPlace[] {
  // Required places first, so the 64-place cap can never push one out.
  const byScore = [...places].sort(
    (a, b) => Number(b.required ?? false) - Number(a.required ?? false) || b.score - a.score,
  );
  const out: SnappedPlace[] = [];
  const n = graph.nodeLat.length;
  for (const p of byScore) {
    if (out.length >= MAX_PLACES) break;
    let best = -1;
    let bestD = maxDistM;
    // Cheap bounding box first; the graphs here are tens of thousands of nodes.
    const latPad = maxDistM / 111_195;
    const lonPad = latPad / Math.cos((p.lat * Math.PI) / 180);
    for (let i = 0; i < n; i++) {
      if (Math.abs(graph.nodeLat[i]! - p.lat) > latPad) continue;
      if (Math.abs(graph.nodeLon[i]! - p.lon) > lonPad) continue;
      const d = haversineMeters(p.lat, p.lon, graph.nodeLat[i]!, graph.nodeLon[i]!);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) out.push({ ...p, node: best });
  }
  return out;
}

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

/** Cost factor (0..2) for turning from edge `a` into edge `b` at `node`. */
function turnFactor(graph: Graph, a: number, b: number, node: number): number {
  const out = (edgeIdx: number): number => {
    const e = graph.edges[edgeIdx]!;
    const n = e.lats.length;
    return e.a === node
      ? bearingDeg(e.lats[0]!, e.lons[0]!, e.lats[1]!, e.lons[1]!)
      : bearingDeg(e.lats[n - 1]!, e.lons[n - 1]!, e.lats[n - 2]!, e.lons[n - 2]!);
  };
  // Arriving along `a` means walking against `out(a)`; straight on is 180° from it.
  const dev = 180 - Math.abs(angleDiffDeg(out(a), out(b)));
  return 1 - Math.cos((dev * Math.PI) / 180);
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

/** ~12 m samples along an edge's geometry, for the corridor-cell grid. */
function eachCellSample(
  e: Graph['edges'][number],
  fn: (lat: number, lon: number) => void,
): void {
  const n = e.lats.length;
  fn(e.lats[0]!, e.lons[0]!);
  for (let i = 1; i < n; i++) {
    const la0 = e.lats[i - 1]!;
    const lo0 = e.lons[i - 1]!;
    const la1 = e.lats[i]!;
    const lo1 = e.lons[i]!;
    const steps = Math.max(1, Math.ceil(haversineMeters(la0, lo0, la1, lo1) / 12));
    for (let s = 1; s <= steps; s++) {
      fn(la0 + ((la1 - la0) * s) / steps, lo0 + ((lo1 - lo0) * s) / steps);
    }
  }
}

/** Score a complete loop from scratch — the improver's single source of truth. */
export function scoreTourCourse(
  graph: Graph,
  edges: number[],
  startNode: number,
  places: SnappedPlace[],
  weights: TourWeights,
  targetLengthM: number,
  minSpacingM = 200,
): { score: number; lengthM: number; collected: CollectedPlace[] } {
  const placesAtNode = new Map<number, number[]>();
  places.forEach((p, i) => {
    const list = placesAtNode.get(p.node);
    if (list) list.push(i);
    else placesAtNode.set(p.node, [i]);
  });
  let centroidLat = 0;
  let centroidLon = 0;
  for (const p of places) {
    centroidLat += p.lat / places.length;
    centroidLon += p.lon / places.length;
  }

  const seenEdges = new Set<number>();
  const collectedIdx = new Set<number>();
  const collected: CollectedPlace[] = [];
  let score = 0;
  let length = 0;
  let lastCollectD = -Infinity;
  let lastCollectScore = 0;
  let node = startNode;

  const collect = (at: number): void => {
    const here = placesAtNode.get(at);
    if (!here) return;
    for (const i of here) {
      if (collectedIdx.has(i)) continue;
      collectedIdx.add(i);
      const p = places[i]!;
      let gain = weights.interest * p.score;
      if (length - lastCollectD < minSpacingM && lastCollectScore > 0) {
        gain -= weights.crowding * Math.min(p.score, lastCollectScore);
      }
      score += gain;
      lastCollectD = length;
      lastCollectScore = p.score;
      collected.push({ id: p.id, name: p.name, d: length, score: p.score });
    }
  };

  collect(startNode);
  let prevEdge = -1;
  const visited = new Set<number>([startNode]);
  const visitedCells = weights.repeat > 0 ? new Set<number>() : null;
  const neigh: number[] = [];
  for (let i = 0; i < edges.length; i++) {
    const ei = edges[i]!;
    const e = graph.edges[ei]!;
    length += e.lengthM;
    score -= weights.penalty * Math.max(0, e.penalty) * e.lengthM;
    if (weights.turn > 0 && prevEdge >= 0) {
      score -= weights.turn * turnFactor(graph, prevEdge, ei, node);
    }
    prevEdge = ei;
    if (weights.centroid > 0 && places.length > 0) {
      const mid = e.lats.length >> 1;
      const km = haversineMeters(e.lats[mid]!, e.lons[mid]!, centroidLat, centroidLon) / 1000;
      score -= weights.centroid * km * e.lengthM;
    }
    if (seenEdges.has(ei)) {
      score -= weights.repeat * e.lengthM;
    } else if (visitedCells) {
      // Ground covered before on *another* edge — the other sidewalk of the
      // same street, a twin path — is a repeat too, by the ~14 m cell grid.
      let overlap = 0;
      let total = 0;
      eachCellSample(e, (la, lo) => {
        total++;
        if (visitedCells.has(cellIdAt(la, lo))) overlap++;
      });
      // One touching sample is just a junction corner, not covered ground.
      if (overlap > 1) score -= weights.repeat * (overlap / total) * e.lengthM;
    }
    if (visitedCells) {
      eachCellSample(e, (la, lo) => {
        cellAndNeighbours(cellIdAt(la, lo), neigh);
        for (const c of neigh) visitedCells.add(c);
      });
    }
    seenEdges.add(ei);
    node = otherNode(e, node);
    // The course crossing itself costs; the arrival that ends it does not.
    if (weights.crossing > 0 && i < edges.length - 1 && visited.has(node)) {
      score -= weights.crossing;
    }
    visited.add(node);
    collect(node);
  }
  score -= weights.lengthDiff * Math.abs(length - targetLengthM);
  return { score, lengthM: length, collected };
}

const IMPROVE_WINDOW_MIN_M = 300;
const IMPROVE_WINDOW_MAX_M = 1500;
const IMPROVE_K = 4;

/**
 * The profile matcher's window replacement with the tour score: slide
 * 300–1500 m windows over the loop, try k shortest alternatives, keep an
 * improvement that stays inside the length tolerance. Scans resume where
 * the last improvement landed, and a wall-clock deadline bounds the whole
 * thing — a dense city graph has thousands of windows per pass.
 */
export function improveTourCourse(
  graph: Graph,
  course: TourCourse,
  startNode: number,
  places: SnappedPlace[],
  options: TourSearchOptions,
): TourCourse {
  const w: TourWeights = { ...DEFAULT_TOUR_WEIGHTS, ...options.weights };
  const target = options.targetLengthM;
  const tolerance = options.lengthToleranceFrac ?? 0.05;
  const minSpacing = options.minSpacingM ?? 200;
  const timeMs = options.improveTimeMs ?? 10_000;
  const deadline = Date.now() + timeMs;

  let edges = [...course.edges];
  let best = scoreTourCourse(graph, edges, startNode, places, w, target, minSpacing);
  let budget = 40; // the score rises strictly, so this is belt and braces
  let startI = 0;
  const requiredIds = places.filter((p) => p.required).map((p) => p.id);
  const keepsRequired = (collected: CollectedPlace[]): boolean =>
    requiredIds.every((id) => collected.some((c) => c.id === id));

  outer: while (budget > 0) {
    const nodes = pathNodes(graph, { edges, dirs: [] }, startNode);
    const cum: number[] = [0];
    for (const ei of edges) cum.push(cum[cum.length - 1]! + graph.edges[ei]!.lengthM);
    let improved = false;

    for (let i = startI; i < nodes.length - 1; i++) {
      if ((i & 15) === 0) {
        const now = Date.now();
        if (now > deadline) break outer;
        options.onProgress?.(Math.min(1, 1 - (deadline - now) / timeMs));
      }
      for (let j = i + 2; j < nodes.length; j++) {
        const windowLen = cum[j]! - cum[i]!;
        if (windowLen < IMPROVE_WINDOW_MIN_M) continue;
        if (windowLen > IMPROVE_WINDOW_MAX_M) break;
        const from = nodes[i]!;
        const to = nodes[j]!;
        if (from === to) continue;
        if (Date.now() > deadline) break outer;
        const alternatives = kShortestPaths(graph, from, to, IMPROVE_K, windowLen * 1.8);
        for (const alt of alternatives) {
          const candidate = [...edges.slice(0, i), ...alt.edges, ...edges.slice(j)];
          const scored = scoreTourCourse(graph, candidate, startNode, places, w, target, minSpacing);
          if (
            scored.score > best.score &&
            scored.lengthM >= target * (1 - tolerance) &&
            scored.lengthM <= target * (1 + tolerance) &&
            keepsRequired(scored.collected)
          ) {
            edges = candidate;
            best = scored;
            improved = true;
            break;
          }
        }
        if (improved) break;
      }
      if (improved) {
        // The path changed from i on; rebuild and resume at the same spot.
        budget--;
        startI = i;
        continue outer;
      }
    }
    if (!improved) {
      if (startI === 0) break;
      startI = 0; // one last pass over the windows skipped before the resume point
    }
  }
  options.onProgress?.(1);

  // Rebuild dirs by walking the final edge list.
  const dirs: number[] = [];
  let node = startNode;
  for (const ei of edges) {
    const e = graph.edges[ei]!;
    dirs.push(e.a === node ? 1 : 0);
    node = otherNode(e, node);
  }
  return { edges, dirs, lengthM: best.lengthM, score: best.score, collected: best.collected };
}

/** The loop's geometry as [lat, lon] points, start to start. */
export function tourCoursePoints(
  graph: Graph,
  course: TourCourse,
  startNode: number,
): [number, number][] {
  const points: [number, number][] = [[graph.nodeLat[startNode]!, graph.nodeLon[startNode]!]];
  let node = startNode;
  for (const ei of course.edges) {
    const e = graph.edges[ei]!;
    const forward = e.a === node;
    const len = e.lats.length;
    for (let i = 1; i < len; i++) {
      const idx = forward ? i : len - 1 - i;
      points.push([e.lats[idx]!, e.lons[idx]!]);
    }
    node = otherNode(e, node);
  }
  return points;
}
