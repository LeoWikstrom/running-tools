import { bearingDeg, haversineMeters } from '../geo';
import { dijkstra, reconstructPath } from '../graph/dijkstra';
import { otherNode, type Graph } from '../graph/types';
import {
  DEFAULT_TOUR_WEIGHTS,
  scoreTourCourse,
  tourCoursePoints,
  unsanctionedSpurCount,
  type SnappedPlace,
  type TourCourse,
  type TourSearchOptions,
  type TourWeights,
} from './tourScore';

/**
 * Loop-first course construction. The beam it replaces decided topology by
 * survivor dynamics and padded length with out-and-back spurs; here topology
 * is structural: pick waypoints spread around the start (preferring
 * interesting places), route shortest-path legs between them — a shortest
 * path never visits a node twice, so a leg cannot contain a spur — and make
 * the closing legs pay 4× to reuse earlier legs' edges, so the course comes
 * home a different way. Candidates that still show an out-and-back that no
 * visited place excuses are rejected outright; the survivors compete on the
 * unchanged tour score, so the sliders choose among clean loops instead of
 * steering one search.
 */

/** Penalty (safety weight per metre) → routing-cost multiplier. */
const COST_PENALTY = 8;
/** Centroid distance (km, at full slider) → routing-cost multiplier. */
const COST_CENTROID = 1.5;
/** Routing discount per interest point for streets through a place's node. */
const DISCOUNT_PER_POINT = 0.004;
const MIN_DISCOUNT = 0.6;
/** Cost multiplier for re-walking an edge an earlier leg used. */
const REUSE_FACTOR = 4;
// Small rounds, many of them: each round recalibrates the band and the
// estimate ratio from what routing actually produced, and a city's street
// factor is learnt within a couple of rounds.
const MAX_SETS_PER_ROUND = 16;
const ROUNDS = 6;
const CONSTRUCT_TIME_MS = 2500;
/** With no clean candidate inside the asked tolerance, the best clean course
    within this wider band still beats returning a spur-padded one. */
const FALLBACK_TOLERANCE = 0.15;
/** Geometric fallback waypoints: one per this many degrees of bearing. */
const FALLBACK_SECTORS = 16;
const ENOUGH_CLEAN = 8;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Best interest at each node that IS a place's snapped node. Only incident
    edges get the routing discount: a cheap path then actually passes through
    the node and collects the place, instead of grazing the block beside it. */
function placeNodeScores(graph: Graph, places: SnappedPlace[]): Float64Array {
  const score = new Float64Array(graph.nodeLat.length);
  for (const p of places) {
    if (score[p.node]! < p.score) score[p.node] = p.score;
  }
  return score;
}

/** The loop-invariant routing cost of each edge, in pseudo-metres. */
function buildBaseCost(graph: Graph, w: TourWeights, places: SnappedPlace[]): Float64Array {
  let centroidLat = 0;
  let centroidLon = 0;
  for (const p of places) {
    centroidLat += p.lat / places.length;
    centroidLon += p.lon / places.length;
  }
  const near = placeNodeScores(graph, places);
  const cost = new Float64Array(graph.edges.length);
  for (let ei = 0; ei < graph.edges.length; ei++) {
    const e = graph.edges[ei]!;
    let factor = 1 + COST_PENALTY * w.penalty * Math.max(0, e.penalty);
    if (w.centroid > 0 && places.length > 0) {
      const mid = e.lats.length >> 1;
      const km = haversineMeters(e.lats[mid]!, e.lons[mid]!, centroidLat, centroidLon) / 1000;
      factor += COST_CENTROID * w.centroid * km;
    }
    const best = Math.max(near[e.a]!, near[e.b]!);
    const discount = Math.max(MIN_DISCOUNT, 1 - DISCOUNT_PER_POINT * best);
    cost[ei] = e.lengthM * factor * discount;
  }
  return cost;
}

interface Waypoint {
  node: number;
  interest: number;
  bearing: number;
  dM: number;
}

export function tourLoopSearch(
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
  const fallbackMin = Math.min(minLen, target * (1 - FALLBACK_TOLERANCE));
  const fallbackMax = Math.max(maxLen, target * (1 + FALLBACK_TOLERANCE));
  const minSpacing = options.minSpacingM ?? 200;
  const endNode = options.endNode ?? startNode;
  const isLoop = endNode === startNode;
  const deadline = Date.now() + CONSTRUCT_TIME_MS;
  const rand = mulberry32(1);

  const baseCost = buildBaseCost(graph, w, places);
  // True-metre distances decide which nodes sit in the waypoint band.
  const distM = dijkstra(graph, [startNode]).dist;
  const distEndM = isLoop ? distM : dijkstra(graph, [endNode]).dist;
  const startLat = graph.nodeLat[startNode]!;
  const startLon = graph.nodeLon[startNode]!;
  const bearingOf = (node: number): number =>
    bearingDeg(startLat, startLon, graph.nodeLat[node]!, graph.nodeLon[node]!);

  const vias: Waypoint[] = [];
  const viaNodes = new Set<number>();
  for (const p of places) {
    if (!p.required || viaNodes.has(p.node) || p.node === startNode || p.node === endNode) continue;
    if (!Number.isFinite(distM[p.node]!) || !Number.isFinite(distEndM[p.node]!)) continue;
    viaNodes.add(p.node);
    vias.push({ node: p.node, interest: p.score, bearing: bearingOf(p.node), dM: distM[p.node]! });
  }

  const sanctionAll = places.map((p) => ({
    node: p.node,
    lat: graph.nodeLat[p.node]!,
    lon: graph.nodeLon[p.node]!,
    id: p.id,
  }));

  const poolFor = (bandLo: number, bandHi: number): Waypoint[] => {
    const pool: Waypoint[] = [];
    const seen = new Set<number>(viaNodes);
    for (const p of places) {
      if (seen.has(p.node) || p.node === startNode || p.node === endNode) continue;
      const d = distM[p.node]!;
      if (d < bandLo || d > bandHi || !Number.isFinite(distEndM[p.node]!)) continue;
      seen.add(p.node);
      pool.push({ node: p.node, interest: p.score, bearing: bearingOf(p.node), dM: d });
    }
    // Geometric fallbacks: the course should exist in place-poor areas too.
    // Three radius tiers per sector give the sampler length diversity even
    // when the pool is otherwise empty (or pinned down by a far-off via).
    const tiers = [0.25, 0.5, 0.8].map((f) => bandLo + f * (bandHi - bandLo));
    const best = new Int32Array(FALLBACK_SECTORS * tiers.length).fill(-1);
    const bestErr = new Float64Array(FALLBACK_SECTORS * tiers.length).fill(Infinity);
    for (let i = 0; i < graph.nodeLat.length; i++) {
      const d = distM[i]!;
      if (d < bandLo || d > bandHi || !Number.isFinite(distEndM[i]!)) continue;
      const sector = Math.floor((((bearingOf(i) % 360) + 360) % 360) / (360 / FALLBACK_SECTORS));
      for (let t = 0; t < tiers.length; t++) {
        const err = Math.abs(d - tiers[t]!);
        const slot = sector * tiers.length + t;
        if (err < bestErr[slot]!) {
          bestErr[slot] = err;
          best[slot] = i;
        }
      }
    }
    for (const node of best) {
      if (node >= 0 && !seen.has(node)) {
        seen.add(node);
        pool.push({ node, interest: 0, bearing: bearingOf(node), dM: distM[node]! });
      }
    }
    return pool;
  };

  // Routed legs come out longer than the estimate (streets wind, the reuse
  // penalty forces the closing legs onto detours); the measured ratio feeds
  // back so later rounds aim their estimates correctly.
  let estRatio = 1.15;

  const sampleSets = (pool: Waypoint[], k: number): { members: Waypoint[]; est: number }[] => {
    const sets: Waypoint[][] = [];
    const estimates: number[] = [];
    const seen = new Set<string>();
    const minBearingGap = 360 / (k + 2);
    // First and last hop are known road distances; middle hops are
    // straight lines padded for streets not being straight.
    const estimate = (members: Waypoint[]): number => {
      const seq = orderSet(members);
      if (seq.length === 0) return distEndM[startNode]!;
      let m = distM[seq[0]!.node]!;
      for (let i = 1; i < seq.length; i++) {
        m +=
          1.3 *
          haversineMeters(
            graph.nodeLat[seq[i - 1]!.node]!,
            graph.nodeLon[seq[i - 1]!.node]!,
            graph.nodeLat[seq[i]!.node]!,
            graph.nodeLon[seq[i]!.node]!,
          );
      }
      m += distEndM[seq[seq.length - 1]!.node]!;
      return m;
    };
    for (let attempt = 0; attempt < 400 && sets.length < MAX_SETS_PER_ROUND; attempt++) {
      const members = [...vias];
      const totalWeight = (cands: Waypoint[]): number =>
        cands.reduce((sum, c) => sum + c.interest + 10, 0);
      while (members.length < k) {
        const ok = pool.filter(
          (c) =>
            !members.some((m) => {
              if (m.node === c.node) return true;
              const angDist = Math.abs(((m.bearing - c.bearing + 540) % 360) - 180);
              return angDist < minBearingGap;
            }),
        );
        if (ok.length === 0) break;
        let pick = rand() * totalWeight(ok);
        let chosen = ok[ok.length - 1]!;
        for (const c of ok) {
          pick -= c.interest + 10;
          if (pick <= 0) {
            chosen = c;
            break;
          }
        }
        members.push(chosen);
      }
      if (members.length === 0 && isLoop) continue;
      const key = members
        .map((m) => m.node)
        .sort((a, b) => a - b)
        .join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      const est = estimate(members) * estRatio;
      // Loose on purpose: routing and the length bands do the real
      // filtering, the estimate only orders the attempts.
      if (est < 0.6 * target || est > 1.5 * target) continue;
      sets.push(members);
      estimates.push(est);
    }
    // The point-to-point course may already be best with no detour at all.
    if (!isLoop && !seen.has('')) {
      sets.push([]);
      estimates.push(estimate([]) * estRatio);
    }
    // Try length-plausible sets first, the most interesting ones of each
    // 500 m closeness bucket before the duller ones.
    const bucket = (i: number): number => Math.floor(Math.abs(estimates[i]! - target) / 500);
    const interestOf = (s: Waypoint[]): number => s.reduce((sum, m) => sum + m.interest, 0);
    const order = sets.map((_, i) => i).sort((a, b) => {
      return bucket(a) - bucket(b) || interestOf(sets[b]!) - interestOf(sets[a]!);
    });
    return order.map((i) => ({ members: sets[i]!, est: estimates[i]! }));
  };

  // Loops visit waypoints in bearing order (no self-crossing); point-to-point
  // courses visit them in distance order from the start.
  const orderSet = (members: Waypoint[]): Waypoint[] =>
    isLoop
      ? [...members].sort((a, b) => a.bearing - b.bearing)
      : [...members].sort((a, b) => a.dM - b.dM);

  const routeSet = (members: Waypoint[]): { edges: number[]; lengthM: number } | null => {
    const used = new Set<number>();
    const edgeCost = (ei: number): number => baseCost[ei]! * (used.has(ei) ? REUSE_FACTOR : 1);
    const edges: number[] = [];
    let lengthM = 0;
    let cur = startNode;
    const seq = [...orderSet(members).map((m) => m.node), endNode];
    for (const wp of seq) {
      if (wp === cur) continue;
      const res = dijkstra(graph, [cur], { target: wp, maxDist: 6 * target, edgeCost });
      const path = reconstructPath(graph, res, cur, wp);
      if (!path) return null;
      for (const ei of path.edges) {
        edges.push(ei);
        used.add(ei);
      }
      lengthM += path.lengthM;
      cur = wp;
    }
    if (edges.length === 0) return null;
    return { edges, lengthM };
  };

  const toCourse = (edges: number[], lengthM: number): TourCourse | null => {
    const scored = scoreTourCourse(graph, edges, startNode, places, w, target, minSpacing);
    const collectedIds = new Set(scored.collected.map((c) => c.id));
    const sanction = sanctionAll.filter(
      (s) => collectedIds.has(s.id) || viaNodes.has(s.node),
    );
    const points = tourCoursePoints(graph, { edges, dirs: [], lengthM, score: 0, collected: [] }, startNode);
    if (unsanctionedSpurCount(points, sanction) > 0) return null;
    const dirs: number[] = [];
    let node = startNode;
    for (const ei of edges) {
      const e = graph.edges[ei]!;
      dirs.push(e.a === node ? 1 : 0);
      node = otherNode(e, node);
    }
    return { edges, dirs, lengthM, score: scored.score, collected: scored.collected };
  };

  // More waypoints collect more places but cost a Dijkstra per leg each set;
  // past ~5 the construction deadline starts eating the length-control rounds.
  let k = Math.min(Math.max(Math.round(target / 2000), isLoop ? 2 : 1), 5);
  if (vias.length > k) k = vias.length;
  let bandScale = 1;
  const cleanInTol: TourCourse[] = [];
  const cleanFallback: TourCourse[] = [];
  // Rounds resample from overlapping pools; never route the same set twice.
  const routedKeys = new Set<string>();
  const keyOf = (members: Waypoint[]): string =>
    members
      .map((m) => m.node)
      .sort((a, b) => a - b)
      .join(',');

  outer: for (let round = 0; round < ROUNDS; round++) {
    const bandLo = Math.max(100, 0.15 * target * bandScale);
    const bandHi = 0.45 * target * bandScale;
    const pool = poolFor(bandLo, bandHi);
    const sets = sampleSets(pool, k);
    const achieved: number[] = [];
    const ratios: number[] = [];
    for (let si = 0; si < sets.length; si++) {
      if (Date.now() > deadline) break outer;
      options.onProgress?.((round + si / Math.max(1, sets.length)) / ROUNDS);
      const { members, est } = sets[si]!;
      const key = keyOf(members);
      if (routedKeys.has(key)) continue;
      routedKeys.add(key);
      const routed = routeSet(members);
      if (!routed) continue;
      achieved.push(routed.lengthM);
      ratios.push(routed.lengthM / Math.max(1, est));
      if (routed.lengthM < fallbackMin || routed.lengthM > fallbackMax) continue;
      const course = toCourse(routed.edges, routed.lengthM);
      if (!course) continue;
      if (course.lengthM >= minLen && course.lengthM <= maxLen) {
        cleanInTol.push(course);
        if (cleanInTol.length >= ENOUGH_CLEAN) break outer;
      } else {
        cleanFallback.push(course);
      }
    }
    if (cleanInTol.length >= ENOUGH_CLEAN) break;
    // Recalibrate: the estimate ratio from what routing measured, the band
    // toward the lengths actually achieved.
    if (ratios.length > 0) {
      ratios.sort((a, b) => a - b);
      estRatio *= Math.min(1.5, Math.max(0.7, ratios[ratios.length >> 1]!));
    }
    if (achieved.length > 0) {
      achieved.sort((a, b) => a - b);
      const median = achieved[achieved.length >> 1]!;
      bandScale *= Math.min(2, Math.max(0.5, target / median));
      if (median < 0.85 * target) k = Math.min(k + 1, 6);
      else if (median > 1.15 * target) k = Math.max(k - 1, Math.max(isLoop ? 1 : 0, vias.length));
    } else {
      bandScale *= 0.7; // nothing routed: pull the waypoints in and retry
    }
  }
  options.onProgress?.(1);

  const ranked = (cleanInTol.length > 0 ? cleanInTol : cleanFallback).sort(
    (a, b) => b.score - a.score,
  );
  return ranked.slice(0, 5);
}
