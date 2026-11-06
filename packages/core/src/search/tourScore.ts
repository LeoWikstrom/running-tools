import { angleDiffDeg, bearingDeg, haversineMeters } from '../geo';
import { findPointSpurs } from '../geo/spurs';
import { cellAndNeighbours, cellIdAt } from '../graph/cells';
import { kShortestPaths, pathNodes } from '../graph/ksp';
import { otherNode, type Graph } from '../graph/types';

/**
 * The tour score and its improver: shared between the course generator and
 * anything that re-scores or locally optimises an existing course. A course
 * collects place interest and pays per-metre costs; scoreTourCourse is the
 * single source of truth for what a finished course is worth.
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
  /** Total one-way length of outer spurs (pokes into fresh ground that no
      place excuses) the course may contain, as a fraction of its length.
      0 (the default) forbids them; the twisty end of the circular slider
      buys a budget. Internal double-backs are forbidden regardless. */
  outerSpurBudgetFrac?: number;
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

/** Cost factor (0..2) for turning from edge `a` into edge `b` at `node`. */
export function turnFactor(graph: Graph, a: number, b: number, node: number): number {
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

/** A spur whose tip is this close to a sanction point is deliberate: the
    course went up a dead end to reach a place, which is allowed. */
const SPUR_SANCTION_M = 30;
/** Spur legs farther apart than this are different ground, not a retrace. */
const SPUR_TOL_M = 15;
/** Detect out-and-backs up to this out+back path length. */
const SPUR_MAX_PATH_M = 4000;
/** A spur tip this close to the course outside the spur itself means the
    spur retraces the course's own ground — an internal double-back. */
const SPUR_INTERNAL_M = 20;

export interface CourseSpurs {
  /** Double-backs along the course's own ground (a segment walked three
      times) — invisible on the map, prohibited whatever the sliders say. */
  internal: number;
  /** Pokes into otherwise-unvisited ground that no place excuses. */
  outer: number;
  /** One-way length of those outer pokes, metres. */
  outerLenM: number;
}

/**
 * Out-and-back spurs in a course that no visited place excuses, split into
 * the always-forbidden internal double-backs and the outer pokes a twisty
 * slider may buy a budget for.
 */
export function classifyCourseSpurs(
  points: [number, number][],
  sanction: { lat: number; lon: number }[],
): CourseSpurs {
  const lats = new Float64Array(points.length);
  const lons = new Float64Array(points.length);
  for (let i = 0; i < points.length; i++) {
    lats[i] = points[i]![0];
    lons[i] = points[i]![1];
  }
  const spurs = findPointSpurs(lats, lons, SPUR_TOL_M, 20, SPUR_MAX_PATH_M);
  const out: CourseSpurs = { internal: 0, outer: 0, outerLenM: 0 };
  for (const s of spurs) {
    const sanctioned = sanction.some(
      (c) => haversineMeters(lats[s.tip]!, lons[s.tip]!, c.lat, c.lon) <= SPUR_SANCTION_M,
    );
    if (sanctioned) continue;
    let internal = false;
    for (let j = 0; j < points.length; j++) {
      // The span itself and its immediate neighbours do not count as "the
      // course passes here anyway" — anything further out does.
      if (j >= s.from - 1 && j <= s.to + 2) continue;
      if (haversineMeters(lats[j]!, lons[j]!, lats[s.tip]!, lons[s.tip]!) <= SPUR_INTERNAL_M) {
        internal = true;
        break;
      }
    }
    if (internal) out.internal++;
    else {
      out.outer++;
      out.outerLenM += s.lengthM;
    }
  }
  return out;
}

/** Every unsanctioned spur, whatever its kind — the strict zero-budget bar. */
export function unsanctionedSpurCount(
  points: [number, number][],
  sanction: { lat: number; lon: number }[],
): number {
  const spurs = classifyCourseSpurs(points, sanction);
  return spurs.internal + spurs.outer;
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
  // A swap may not add an out-and-back that no visited place excuses; a
  // local window improvement must never undo the generator's clean topology.
  // Internal double-backs stay at zero (or whatever the incoming course
  // already had); outer pokes may fill the twisty slider's budget.
  const spurBudget = options.outerSpurBudgetFrac ?? 0;
  const spursOf = (es: number[], collected: CollectedPlace[]): CourseSpurs => {
    const ids = new Set(collected.map((c) => c.id));
    const sanction = places
      .filter((p) => p.required || ids.has(p.id))
      .map((p) => ({ lat: graph.nodeLat[p.node]!, lon: graph.nodeLon[p.node]! }));
    const points = tourCoursePoints(
      graph,
      { edges: es, dirs: [], lengthM: 0, score: 0, collected: [] },
      startNode,
    );
    return classifyCourseSpurs(points, sanction);
  };
  let bestSpurs = spursOf(edges, best.collected);

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
            const spurs = spursOf(candidate, scored.collected);
            if (spurs.internal > bestSpurs.internal) continue;
            if (spurs.outerLenM > Math.max(spurBudget * scored.lengthM, bestSpurs.outerLenM)) {
              continue;
            }
            edges = candidate;
            best = scored;
            bestSpurs = spurs;
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
