import type { TargetProfile } from '../gpx/profile';
import { dijkstra } from '../graph/dijkstra';
import { otherNode, type Graph } from '../graph/types';
import { TURN_ANGLE_DEG, angleDiffDeg } from '../shared/geo';
import {
  assembleCourse,
  confinementFraction,
  entryHeading,
  exitHeading,
  scoreCourse,
  DEFAULT_WEIGHTS,
  MIX_ROAD,
  OSCILLATION_WINDOW_M,
  type CoursePath,
  type SurfaceMix,
  type Weights,
} from './score';
import { mulberry32, type WalkCandidate } from './randomWalk';

export interface BeamOptions {
  /** Perturbs beam tie-breaking so "Try another" explores different courses. */
  seed?: number;
  /** States kept per bucket; a floor, since multi-start widens it (STATES_PER_ROOT). */
  beamWidth?: number;
  bucketSizeM?: number;
  lengthTolerance?: number;
  keepBest?: number;
  desiredMix?: SurfaceMix | null;
  weights?: Weights;
  /** Courses must end back at the start node. */
  returnToStart?: boolean;
  /**
   * 1 = node is a valid course end (e.g. inside the start/finish radius).
   * The course itself may go arbitrarily far away; states are pruned when
   * they can no longer reach a valid end within the length budget.
   */
  validEnd?: Uint8Array | null;
  /** Additional allowed start nodes (e.g. everything inside the zone). */
  startNodes?: number[] | null;
  /**
   * Edges already spoken for by a course this search has offered. They are
   * costed like unpleasant ground so the next course goes elsewhere, without
   * being forbidden — a park with one entrance still has to be enterable.
   */
  avoidEdges?: Set<number> | null;
  /**
   * Must-pass constraints, in order. nodes = graph nodes counting as "at the
   * via"; dist = multi-source Dijkstra distances to them; kmM = optional
   * course distance (metres) near which the via must be reached.
   */
  vias?: { nodes: Set<number>; edges?: Set<number>; dist: Float64Array; kmM: number | null }[];
  /** Half-width of the km window around each via's km, metres. */
  viaSlackM?: number;
  /** `leader` is the top-ranked *partial* path, for a live search preview. */
  onProgress?: (
    bucket: number,
    totalBuckets: number,
    best: WalkCandidate | null,
    leader?: CoursePath | null,
  ) => void;
  shouldCancel?: () => boolean;
}

/**
 * Every expanded state lives here until the search ends — reachable through
 * parent pointers for path reconstruction — so this is exactly the thing that
 * grows into the hundreds of thousands on a long search. Flat typed arrays
 * with capacity slack: integer fields at 4 (or 1) bytes instead of 8, nothing
 * for the GC to scan, and the hot loop indexes them like the plain arrays
 * they replaced. `n` is the live count; growStore doubles the capacity.
 */
interface StateStore {
  n: number;
  node: Int32Array;
  dist: Float64Array;
  sq: Float64Array;
  /** Sum of (course − target) diffs, for offset-corrected partial RMSE. */
  diffSum: Float64Array;
  sampleCount: Int32Array;
  gain: Float64Array;
  loss: Float64Array;
  penaltyLen: Float64Array;
  /** Metres run along ground no downloaded GPS trace covers (see `traced`). */
  untracedLen: Float64Array;
  repeatLen: Float64Array;
  /** Farthest the path has been from its own root, metres (see confinement). */
  reach: Float64Array;
  /** The start node this path grew from; roots differ when starting anywhere. */
  root: Int32Array;
  /** Bitmask of via points visited so far, in order. */
  viaMask: Int32Array;
  /**
   * Length-weighted sum of squared per-edge offset-corrected shape error;
   * sqrt(shapeSq / dist) is the beam's proxy for the final localShape RMS.
   */
  shapeSq: Float64Array;
  turns: Float64Array;
  exitHead: Float64Array;
  parent: Int32Array;
  edge: Int32Array;
  dir: Int8Array;
}

function newStateStore(capacity: number): StateStore {
  return {
    n: 0,
    node: new Int32Array(capacity),
    dist: new Float64Array(capacity),
    sq: new Float64Array(capacity),
    diffSum: new Float64Array(capacity),
    sampleCount: new Int32Array(capacity),
    gain: new Float64Array(capacity),
    loss: new Float64Array(capacity),
    penaltyLen: new Float64Array(capacity),
    untracedLen: new Float64Array(capacity),
    repeatLen: new Float64Array(capacity),
    reach: new Float64Array(capacity),
    root: new Int32Array(capacity),
    viaMask: new Int32Array(capacity),
    shapeSq: new Float64Array(capacity),
    turns: new Float64Array(capacity),
    exitHead: new Float64Array(capacity),
    parent: new Int32Array(capacity),
    edge: new Int32Array(capacity),
    dir: new Int8Array(capacity),
  };
}

function growStore(s: StateStore): void {
  const cap = s.node.length * 2;
  const grow = <T extends Int8Array | Int32Array | Float64Array>(a: T): T => {
    const next = new (a.constructor as new (n: number) => T)(cap);
    next.set(a);
    return next;
  };
  s.node = grow(s.node);
  s.dist = grow(s.dist);
  s.sq = grow(s.sq);
  s.diffSum = grow(s.diffSum);
  s.sampleCount = grow(s.sampleCount);
  s.gain = grow(s.gain);
  s.loss = grow(s.loss);
  s.penaltyLen = grow(s.penaltyLen);
  s.untracedLen = grow(s.untracedLen);
  s.repeatLen = grow(s.repeatLen);
  s.reach = grow(s.reach);
  s.root = grow(s.root);
  s.viaMask = grow(s.viaMask);
  s.shapeSq = grow(s.shapeSq);
  s.turns = grow(s.turns);
  s.exitHead = grow(s.exitHead);
  s.parent = grow(s.parent);
  s.edge = grow(s.edge);
  s.dir = grow(s.dir);
}

interface TargetPrefix {
  /** Cumulative target gain/loss per 25 m sample index. */
  cumGain: Float32Array;
  cumLoss: Float32Array;
  denom: number;
  turnsPerKm: number;
  /**
   * Guidance toward the target's highest feature: distance from every node to
   * the nearest "peak-capable" terrain (elevation ≈ start + peak value).
   * Without it the beam is myopic — a big climb at km 5 cannot influence
   * which flat prefixes survive at km 2, so features like a high bridge are
   * never reached (the Älvsborgsbron case).
   */
  peakDist: Float64Array | null;
  peakAtM: number;
}

const MAX_ROOTS = 120;

/**
 * States each start node keeps when the course may begin anywhere. One beam
 * shared across every root left a lineage with barely a state to its name, so
 * each start settled for whatever faked the profile in its own corner instead
 * of searching; the beam now widens with the number of roots.
 */
const STATES_PER_ROOT = 16;

/**
 * Per metre of an avoided edge, in the same units as an edge's own penalty —
 * about as off-putting as a busy road, which steers the course away without
 * ruling out the one bridge or underpass that makes an area reachable.
 */
const AVOID_PENALTY = 0.5;

function rootCell(graph: Graph, node: number): number {
  const cy = Math.round((graph.nodeLat[node]! * 111320) / 250);
  const cx = Math.round((graph.nodeLon[node]! * 58000) / 250);
  return cy * 1_000_003 + cx;
}

const PEAK_MIN_HEIGHT_M = 15;
// Generous: elev0 carries DEM bias (7 m observed at Slottsskogsvallen), and
// the RMSE is offset-corrected anyway — guidance just needs to include all
// plausibly peak-capable terrain.
const PEAK_ELEV_TOLERANCE_M = 15;
const PEAK_MISS_WEIGHT_PER_KM = 10;

function targetPrefix(target: TargetProfile, graph: Graph, elev0: number): TargetPrefix {
  const samples = target.samples;
  const cumGain = new Float32Array(samples.length);
  const cumLoss = new Float32Array(samples.length);
  for (let i = 1; i < samples.length; i++) {
    const d = samples[i]! - samples[i - 1]!;
    cumGain[i] = cumGain[i - 1]! + (d > 0 ? d : 0);
    cumLoss[i] = cumLoss[i - 1]! + (d < 0 ? -d : 0);
  }

  let peakDist: Float64Array | null = null;
  let peakAtM = 0;
  let peakIdx = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i]! > samples[peakIdx]!) peakIdx = i;
  }
  const peakValue = samples[peakIdx]!;
  if (peakValue >= PEAK_MIN_HEIGHT_M) {
    const wantElev = elev0 + peakValue;
    const attractors: number[] = [];
    const nodeElev = new Float64Array(graph.nodeLat.length).fill(Number.NaN);
    for (const e of graph.edges) {
      if (!e.elev) continue;
      nodeElev[e.a] = e.elev[0]!;
      nodeElev[e.b] = e.elev[e.elev.length - 1]!;
    }
    for (let i = 0; i < nodeElev.length; i++) {
      if (Math.abs(nodeElev[i]! - wantElev) <= PEAK_ELEV_TOLERANCE_M) attractors.push(i);
    }
    if (attractors.length > 0) {
      peakDist = dijkstra(graph, attractors).dist;
      peakAtM = peakIdx * 25;
    }
  }

  return {
    cumGain,
    cumLoss,
    denom: Math.max(1, target.totalGain + target.totalLoss),
    turnsPerKm: target.turnsPerKm,
    peakDist,
    peakAtM,
  };
}

function partialRank(s: StateStore, i: number, weights: Weights, tp: TargetPrefix): number {
  const d = Math.max(1, s.dist[i]!);
  const n = Math.max(1, s.sampleCount[i]!);
  const mean = s.diffSum[i]! / n;
  const rmse = Math.sqrt(Math.max(0, s.sq[i]! / n - mean * mean));
  let ti = Math.round(s.dist[i]! / 25);
  if (ti >= tp.cumGain.length) ti = tp.cumGain.length - 1;
  const gainLossErr =
    (Math.abs(s.gain[i]! - tp.cumGain[ti]!) + Math.abs(s.loss[i]! - tp.cumLoss[ti]!)) / tp.denom;
  // Turn density is noisy on short prefixes; let it bite only after 500 m.
  const turnErr = d > 500 ? Math.abs(s.turns[i]! / (d / 1000) - tp.turnsPerKm) : 0;
  // Before the target's main peak: penalise states that can no longer reach
  // peak-capable terrain in the remaining distance (they will miss the climb).
  let peakMiss = 0;
  if (tp.peakDist && s.dist[i]! < tp.peakAtM) {
    const shortfall = tp.peakDist[s.node[i]!]! - (tp.peakAtM - s.dist[i]!);
    if (shortfall > 0) peakMiss = (shortfall / 1000) * PEAK_MISS_WEIGHT_PER_KM;
  }
  return (
    peakMiss +
    weights.rmse * rmse +
    weights.gainLoss * gainLossErr +
    weights.penalty * (s.penaltyLen[i]! / d) +
    weights.untracked * (s.untracedLen[i]! / d) +
    // repeatLen is reuse inside the oscillation window (see recentReuse). Use
    // a fraction of the final weight: at full strength the term dominates the
    // partial rank in dense/small graphs and starves the beam of diversity.
    (weights.oscillation / 4) * (s.repeatLen[i]! / d) +
    // Laps wider than that window are invisible to repeatLen, so the beam used
    // to build them for free and only learn they were bad once scored — by
    // which time the whole beam was lapping. Ground covered says it early.
    weights.confinement * confinementFraction(s.reach[i]!, d) +
    weights.turns * turnErr +
    weights.localShape * Math.sqrt(s.shapeSq[i]! / d)
  );
}

function reconstruct(s: StateStore, i: number): CoursePath {
  const edges: number[] = [];
  const dirs: number[] = [];
  for (let cur = i; cur >= 0 && s.edge[cur]! >= 0; cur = s.parent[cur]!) {
    edges.push(s.edge[cur]!);
    dirs.push(s.dir[cur]!);
  }
  edges.reverse();
  dirs.reverse();
  return { edges, dirs };
}

/**
 * 0 = unused within the oscillation window, 1 = reused same direction,
 * 2 = reused in reverse. Walks back along the path for OSCILLATION_WINDOW_M.
 */
function recentReuse(s: StateStore, i: number, edgeIndex: number, dir: number): number {
  const fromDist = s.dist[i]!;
  let cur = i;
  while (cur >= 0 && s.edge[cur]! >= 0 && fromDist - s.dist[cur]! <= OSCILLATION_WINDOW_M) {
    if (s.edge[cur] === edgeIndex) return s.dir[cur] === dir ? 1 : 2;
    cur = s.parent[cur]!;
  }
  return 0;
}

export async function beamSearch(
  graph: Graph,
  startNode: number,
  target: TargetProfile,
  targetLengthM: number,
  options: BeamOptions = {},
): Promise<WalkCandidate[]> {
  const {
    seed = 1,
    beamWidth = 200,
    bucketSizeM = 100,
    lengthTolerance = 0.03,
    keepBest = 20,
    desiredMix = MIX_ROAD,
    weights = DEFAULT_WEIGHTS,
    returnToStart = false,
    validEnd = null,
    startNodes = null,
    avoidEdges = null,
    vias = [],
    viaSlackM = Math.max(500, targetLengthM * 0.05),
    onProgress,
    shouldCancel,
  } = options;
  const fullViaMask = (1 << vias.length) - 1;

  const minLen = targetLengthM * (1 - lengthTolerance);
  const maxLen = targetLengthM * (1 + lengthTolerance);
  const mPerLon = 111_320 * Math.cos((graph.nodeLat[startNode]! * Math.PI) / 180);
  const totalBuckets = Math.ceil(maxLen / bucketSizeM) + 1;

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

  // Course elevation is taken relative to the start node's elevation.
  let elev0 = 0;
  const firstAdj = graph.adjOffset[startNode]!;
  if (firstAdj < graph.adjOffset[startNode + 1]!) {
    const e = graph.edges[graph.adjEdge[firstAdj]!]!;
    const elev = e.elev!;
    elev0 = e.a === startNode ? elev[0]! : elev[elev.length - 1]!;
  }

  // Multi-start: the course may begin at any allowed start node, but seeding
  // every zone node dilutes the beam across thousands of half-developed
  // lineages (measured: 54 vs 37 mismatch and a 10x slowdown). Subsample to
  // at most one root per ~250 m cell, max MAX_ROOTS, seeded shuffle first so
  // each seed picks a different representative per cell.
  let roots = returnToStart || !startNodes || startNodes.length === 0 ? [startNode] : startNodes;
  if (roots.length > 1) {
    const rng = mulberry32(seed * 7919 + 1);
    roots = [...roots];
    for (let i = roots.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [roots[i], roots[j]] = [roots[j]!, roots[i]!];
    }
    if (roots.length > MAX_ROOTS) {
      const cells = new Set<number>();
      const picked: number[] = [startNode];
      cells.add(rootCell(graph, startNode));
      for (const r of roots) {
        if (picked.length >= MAX_ROOTS) break;
        const c = rootCell(graph, r);
        if (cells.has(c)) continue;
        cells.add(c);
        picked.push(r);
      }
      roots = picked;
    }
  }
  // Capped at ten times the effort asked for, so a wide zone cannot run away
  // with it — start-anywhere is already documented as the slow option.
  const width = Math.max(beamWidth, Math.min(STATES_PER_ROOT * roots.length, 10 * beamWidth));

  const s = newStateStore(Math.max(4096, roots.length * 2));
  for (const r of roots) {
    const i = s.n++;
    s.node[i] = r;
    s.root[i] = r;
    s.exitHead[i] = Number.NaN;
    s.parent[i] = -1;
    s.edge[i] = -1;
    // Everything else starts at the typed arrays' own 0.
  }
  const tp = targetPrefix(target, graph, elev0);

  const buckets: number[][] = Array.from({ length: totalBuckets }, () => []);
  for (let i = 0; i < roots.length; i++) buckets[0]!.push(i);

  const best: WalkCandidate[] = [];
  const targetSamples = target.samples;
  const lastTargetIdx = targetSamples.length - 1;

  function complete(stateIdx: number): void {
    // Cheap near-lower-bound gate before the expensive assemble + full score:
    // offset-corrected RMSE and the shape max both reappear in the final
    // score, and every other term is >= -2 (penalty bonuses).
    if (best.length >= keepBest) {
      const n = Math.max(1, s.sampleCount[stateIdx]!);
      const mean = s.diffSum[stateIdx]! / n;
      const rmse = Math.sqrt(Math.max(0, s.sq[stateIdx]! / n - mean * mean));
      const shape = Math.sqrt(s.shapeSq[stateIdx]! / Math.max(1, s.dist[stateIdx]!));
      // The slack must cover the most negative the other terms can go, which
      // is the penalty bonuses — a function of the weight, not a constant
      // (the UI allows penalty weights far past the default 30).
      const bound = weights.rmse * rmse + weights.localShape * shape - weights.penalty * 0.1;
      if (bound > best[best.length - 1]!.score) return;
    }
    const path = reconstruct(s, stateIdx);
    if (path.edges.length === 0) return;
    const course = assembleCourse(graph, path);
    const score = scoreCourse(course, target, desiredMix, weights);
    if (best.length < keepBest || score < best[best.length - 1]!.score) {
      best.push({ path, course, score });
      best.sort((x, y) => x.score - y.score);
      if (best.length > keepBest) best.length = keepBest;
    }
  }

  for (let b = 0; b < totalBuckets; b++) {
    if (shouldCancel?.()) break;
    const bucket = buckets[b]!;
    if (bucket.length === 0) continue;

    // Seeded multiplicative noise on the pruning rank, so a new seed ("Try
    // another") explores genuinely different courses. With multi-start the
    // per-seed root selection already differs, so no rank noise is needed —
    // it measurably worsens pruning (observed 80 vs 46 beam score). Pinned
    // starts need a little noise for seeds to differ; seed 1 stays clean.
    const amp = roots.length > 1 || seed === 1 ? 0 : 0.03;
    const noise = (i: number) =>
      1 + amp * ((((i * 2654435761 + seed * 2246822519) >>> 0) % 1024) / 1024);
    bucket.sort(
      (x, y) =>
        partialRank(s, x, weights, tp) * noise(x) - partialRank(s, y, weights, tp) * noise(y),
    );
    // Cap states per end node, or the beam fills with near-identical prefixes
    // of the single best path and loses diversity. Small graphs have few
    // nodes, so the cap scales up to keep distinct histories alive.
    const perNodeCap = Math.max(
      2,
      Math.min(8, Math.floor((2 * width) / Math.max(1, graph.nodeLat.length))),
    );
    // First pass: best state per ~400 m map cell, so the frontier stays
    // spatially spread — otherwise the whole beam collapses onto one
    // neighbourhood and distant features (a bridge at km 5) are unreachable.
    const cellOf = (si: number) => {
      const n = s.node[si]!;
      const cy = Math.round((graph.nodeLat[n]! * 111320) / 400);
      const cx = Math.round((graph.nodeLon[n]! * 58000) / 400);
      return cy * 1_000_003 + cx;
    };
    const chosen = new Set<number>();
    const cells = new Set<number>();
    // Half the beam for spatial spread: measured best (a quarter lost ground
    // on the 21 km benchmark, 46.9 vs 45.5 average over three seeds).
    const diversityQuota = Math.floor(width / 2);
    for (const si of bucket) {
      if (chosen.size >= diversityQuota) break;
      const c = cellOf(si);
      if (cells.has(c)) continue;
      cells.add(c);
      chosen.add(si);
    }
    // Diversity picks are guaranteed slots; the rest fill up by rank.
    const kept: number[] = [];
    for (const si of bucket) if (chosen.has(si)) kept.push(si);
    const perNode = new Map<number, number>();
    for (const si of bucket) {
      if (kept.length >= width) break;
      if (chosen.has(si)) continue;
      // Via progress is part of a state's identity: a lineage that already
      // passed via 1 must not be deduped against one that has not.
      // Sized to the via count: a fixed 16 deduped lineages with different
      // via progress together once a course had five or more vias.
      const key = s.node[si]! * (fullViaMask + 1) + s.viaMask[si]!;
      const count = perNode.get(key) ?? 0;
      if (count >= perNodeCap) continue;
      perNode.set(key, count + 1);
      kept.push(si);
    }
    bucket.length = 0;
    bucket.push(...kept);

    // Same-bucket states (short edges) are appended to this queue and processed
    // now; distance strictly increases, and the cap bounds worst-case blowup.
    const maxProcessed = width * 10;
    for (let qi = 0; qi < bucket.length && qi < maxProcessed; qi++) {
      const si = bucket[qi]!;
      const node = s.node[si]!;
      const dist = s.dist[si]!;
      for (let k = graph.adjOffset[node]!; k < graph.adjOffset[node + 1]!; k++) {
        const ei = graph.adjEdge[k]!;
        // Immediate same-edge reversal is the in-and-back-again pattern; with
        // dead ends pruned there is always another way onward, so forbid it.
        if (ei === s.edge[si]) continue;
        const e = graph.edges[ei]!;
        const newDist = dist + e.lengthM;
        if (newDist > maxLen) continue;
        const nextNode = otherNode(e, node);
        if (distBack && newDist + distBack[nextNode]! > maxLen) continue;

        // Via constraints: the next unvisited via must stay reachable within
        // its km window (or within the course budget if it has no km).
        let viaMask = s.viaMask[si]!;
        if (vias.length > 0 && viaMask !== fullViaMask) {
          let vi = 0;
          while (vi < vias.length && (viaMask & (1 << vi)) !== 0) vi++;
          const via = vias[vi]!;
          if (via.nodes.has(nextNode) || via.edges?.has(ei)) {
            if (via.kmM === null || Math.abs(newDist - via.kmM) <= viaSlackM) {
              viaMask |= 1 << vi;
            }
          }
          if ((viaMask & (1 << vi)) === 0) {
            const reach = via.dist[nextNode]!;
            if (via.kmM !== null) {
              if (newDist > via.kmM + viaSlackM) continue; // window missed
              if (newDist + reach > via.kmM + viaSlackM) continue; // can't make it
            } else if (newDist + reach > maxLen) {
              continue;
            }
          }
        }

        const elev = e.elev!;
        const m = elev.length;
        const forward = e.a === node;
        const spacing = e.lengthM / (m - 1);
        let sq = s.sq[si]!;
        let gain = s.gain[si]!;
        let loss = s.loss[si]!;
        let diffSum = 0;
        let diffSq = 0;
        let prevRel = forward ? elev[0]! - elev0 : elev[m - 1]! - elev0;
        for (let p = 1; p < m; p++) {
          const rel = elev[forward ? p : m - 1 - p]! - elev0;
          let ti = Math.round((dist + p * spacing) / 25);
          if (ti > lastTargetIdx) ti = lastTargetIdx;
          const diff = rel - targetSamples[ti]!;
          sq += diff * diff;
          diffSum += diff;
          diffSq += diff * diff;
          const delta = rel - prevRel;
          if (delta > 0) gain += delta;
          else loss -= delta;
          prevRel = rel;
        }
        // Offset-corrected shape error over this edge: a cheap incremental
        // proxy for the final localShape window term.
        const mean = diffSum / (m - 1);
        const edgeShape = Math.sqrt(Math.max(0, diffSq / (m - 1) - mean * mean));
        const shapeSq = s.shapeSq[si]! + edgeShape * edgeShape * e.lengthM;

        const reuse = recentReuse(s, si, ei, forward ? 1 : 0);
        const repeat = reuse === 0 ? 0 : reuse === 1 ? e.lengthM : 2 * e.lengthM;

        const entry = entryHeading(e, forward);
        const prevExit = s.exitHead[si]!;
        let turns = s.turns[si]! + e.turnOffsets.length;
        if (
          Number.isFinite(prevExit) &&
          Number.isFinite(entry) &&
          Math.abs(angleDiffDeg(prevExit, entry)) > TURN_ANGLE_DEG
        ) {
          turns++;
        }

        if (s.n === s.node.length) growStore(s);
        const idx = s.n++;
        s.node[idx] = nextNode;
        s.dist[idx] = newDist;
        s.sq[idx] = sq;
        s.diffSum[idx] = s.diffSum[si]! + diffSum;
        s.sampleCount[idx] = s.sampleCount[si]! + m - 1;
        s.gain[idx] = gain;
        s.loss[idx] = loss;
        const avoided = avoidEdges?.has(ei) ? AVOID_PENALTY : 0;
        s.penaltyLen[idx] = s.penaltyLen[si]! + (e.penalty + avoided) * e.lengthM;
        s.untracedLen[idx] = s.untracedLen[si]! + (1 - e.traced) * e.lengthM;
        s.repeatLen[idx] = s.repeatLen[si]! + repeat;
        const rootIdx = s.root[si]!;
        const dy = (graph.nodeLat[nextNode]! - graph.nodeLat[rootIdx]!) * 111_320;
        const dx = (graph.nodeLon[nextNode]! - graph.nodeLon[rootIdx]!) * mPerLon;
        s.reach[idx] = Math.max(s.reach[si]!, Math.sqrt(dx * dx + dy * dy));
        s.root[idx] = rootIdx;
        s.viaMask[idx] = viaMask;
        s.shapeSq[idx] = shapeSq;
        s.turns[idx] = turns;
        s.exitHead[idx] = exitHeading(e, forward);
        s.parent[idx] = si;
        s.edge[idx] = ei;
        s.dir[idx] = forward ? 1 : 0;

        if (newDist >= minLen && (!endMask || endMask[nextNode]) && viaMask === fullViaMask) {
          complete(idx);
        }
        const nb = Math.floor(newDist / bucketSizeM);
        if (nb === b) bucket.push(idx);
        else if (nb < totalBuckets) buckets[nb]!.push(idx);
      }
    }
    buckets[b] = [];

    if (onProgress) {
      // bucket[0] is the rank leader after the sort — the search's current
      // best guess at the course, reconstructed for the live preview.
      const leader = bucket.length > 0 ? reconstruct(s, bucket[0]!) : null;
      onProgress(b + 1, totalBuckets, best[0] ?? null, leader);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return best;
}
