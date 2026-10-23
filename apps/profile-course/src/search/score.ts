import {
  GRADIENT_BIN_COUNT,
  gainLoss,
  gradientHistogram,
  movingMedian5,
  type TargetProfile,
} from '../gpx/profile';
import { TURN_ANGLE_DEG, angleDiffDeg } from '../shared/geo';
import type { Graph, GraphEdge } from '../graph/types';

export interface Weights {
  rmse: number;
  gainLoss: number;
  histogram: number;
  surface: number;
  penalty: number;
  /** Far-apart edge reuse (legitimate laps), mildly discouraged. */
  repeat: number;
  /**
   * Edge reuse within OSCILLATION_WINDOW_M of the previous use — bouncing up
   * and down the same hill. Weighted hard: re-climbing a small hill to fake
   * the target's gain is never what the runner wants.
   */
  oscillation: number;
  /**
   * Per unit of ground the course fails to cover (see `confinementFraction`).
   * Laps far enough apart to escape the oscillation window are otherwise free,
   * and a dense patch of paths — "the circles in the cemetery" — can fake any
   * distance and any profile without the runner ever going anywhere.
   */
  confinement: number;
  /** Per |turns/km| difference from the target. */
  turns: number;
  /** Per dense turn (within 100 m of the previous turn) per km. */
  denseTurns: number;
  /** Per signalized crossing per km (0 = ignore traffic lights). */
  trafficLights: number;
  /**
   * Local shape mismatch: RMS over 500 m windows of offset-corrected RMSE.
   * Catches a spike where the target is flat, and a sawtooth standing in for
   * one long climb — both of which global RMSE, the gain/loss term and the
   * gradient histogram happily trade away, the histogram because eight 4 %
   * bumps and one 4 % climb are the same distribution.
   */
  localShape: number;
  /**
   * Per unit of the course no public GPS trace has been run along (see
   * `applyTraceCoverage`). 0 unless the user asks for it: it is only as good
   * as the traces that have been downloaded, and ground nobody uploaded is
   * indistinguishable from ground nobody runs.
   */
  untracked: number;
}

// Local similarity (rmse, localShape) outweighs the global gain/loss match —
// Leo's explicit priority: a course that locally mirrors the race beats one
// that fakes matching totals.
export const DEFAULT_WEIGHTS: Weights = {
  rmse: 1.0,
  gainLoss: 8,
  histogram: 10,
  surface: 15,
  penalty: 30,
  // Lap-driven courses ("circles in the cemetery") reused a third of their
  // edges at weight 10 and barely noticed; 30 makes improve unroll laps.
  repeat: 30,
  oscillation: 80,
  confinement: 20,
  turns: 2,
  denseTurns: 2,
  trafficLights: 0,
  localShape: 9,
  untracked: 0,
};

export const OSCILLATION_WINDOW_M = 1000;

/**
 * Ground a course is expected to cover: the farthest it gets from its start,
 * per metre run. A plain loop manages 0.32 (L/π) and an out-and-back 0.5, so
 * half of what even a wandering loop covers still leaves room to zigzag — it
 * asks a half marathon for 3 km of elbow room, which laps never find.
 */
const MIN_REACH_RATIO = 0.15;

/** 0 = covers enough ground, 1 = never leaves its own start. */
export function confinementFraction(reachM: number, lengthM: number): number {
  const want = lengthM * MIN_REACH_RATIO;
  return want > 0 ? Math.max(0, 1 - reachM / want) : 0;
}

const DENSE_TURN_GAP_M = 100;

export function entryHeading(e: GraphEdge, forward: boolean): number {
  return forward ? e.headOutA : (e.headInB + 180) % 360;
}

export function exitHeading(e: GraphEdge, forward: boolean): number {
  return forward ? e.headInB : (e.headOutA + 180) % 360;
}

/**
 * Desired fraction of distance per surface class [paved, gravel, trail, unknown];
 * null = any surface is fine (no surface term).
 */
export type SurfaceMix = [number, number, number, number];
export const MIX_ROAD: SurfaceMix = [1, 0, 0, 0];
export const MIX_GRAVEL: SurfaceMix = [0.3, 0.7, 0, 0];
export const MIX_TRAIL: SurfaceMix = [0, 0.3, 0.7, 0];

export const SURFACE_PRESETS: Record<string, SurfaceMix | null> = {
  road: MIX_ROAD,
  gravel: MIX_GRAVEL,
  trail: MIX_TRAIL,
  any: null,
};

export interface CoursePath {
  edges: number[];
  /** 1 = traversed a→b, 0 = b→a. */
  dirs: number[];
}

export interface AssembledCourse {
  /** Elevation every ~25 m, relative to the course start. */
  samples: Float32Array;
  lengthM: number;
  gain: number;
  loss: number;
  surfaceSplit: SurfaceMix;
  penaltyFraction: number;
  repeatFraction: number;
  oscillationFraction: number;
  /** Share of the course no downloaded GPS trace has been run along, 0..1. */
  untrackedFraction: number;
  /** The farthest the course gets from its start, in metres. */
  reachM: number;
  turnsPerKm: number;
  denseTurnsPerKm: number;
  signalsPerKm: number;
}

export function assembleCourse(graph: Graph, path: CoursePath): AssembledCourse {
  let sampleCount = 1;
  let lengthM = 0;
  for (const ei of path.edges) {
    const e = graph.edges[ei]!;
    sampleCount += (e.elev?.length ?? 2) - 1;
    lengthM += e.lengthM;
  }

  const samples = new Float32Array(sampleCount);
  const surfaceLen: SurfaceMix = [0, 0, 0, 0];
  let penaltyLen = 0;
  let repeatLen = 0;
  let oscillationLen = 0;
  let untracedLen = 0;

  const firstEdge = graph.edges[path.edges[0] ?? 0];
  const root = firstEdge ? (path.dirs[0] === 1 ? firstEdge.a : firstEdge.b) : 0;
  const lat0 = graph.nodeLat[root] ?? 0;
  const lon0 = graph.nodeLon[root] ?? 0;
  const mPerLon = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  let reachSq = 0;
  /** Edge index -> direction and course distance of the last traversal. */
  const used = new Map<number, { dir: number; endDist: number }>();

  const turnDists: number[] = [];
  let prevExitHead = Number.NaN;
  let distSoFar = 0;
  let signalCount = 0;
  /** Corridor cell -> last pass {heading, course distance, edge}. */
  const corridor = new Map<number, { head: number; dist: number; edge: number }>();

  let w = 0;
  let first = true;
  for (let i = 0; i < path.edges.length; i++) {
    const ei = path.edges[i]!;
    const e = graph.edges[ei]!;
    const elev = e.elev;
    if (!elev) throw new Error('assembleCourse requires sampled edge elevations');
    const forward = path.dirs[i] === 1;
    const n = elev.length;
    for (let k = first ? 0 : 1; k < n; k++) {
      samples[w++] = elev[forward ? k : n - 1 - k]!;
    }
    first = false;

    const entry = entryHeading(e, forward);
    if (
      Number.isFinite(prevExitHead) &&
      Number.isFinite(entry) &&
      Math.abs(angleDiffDeg(prevExitHead, entry)) > TURN_ANGLE_DEG
    ) {
      turnDists.push(distSoFar);
    }
    const t = e.turnOffsets;
    for (let k = 0; k < t.length; k++) {
      turnDists.push(distSoFar + (forward ? t[k]! : e.lengthM - t[t.length - 1 - k]!));
    }
    prevExitHead = exitHeading(e, forward);
    distSoFar += e.lengthM;

    surfaceLen[e.surface] += e.lengthM;
    penaltyLen += e.penalty * e.lengthM;
    untracedLen += (1 - e.traced) * e.lengthM;
    signalCount += e.signals;

    const far = forward ? e.b : e.a;
    const dy = (graph.nodeLat[far]! - lat0) * 111_320;
    const dx = (graph.nodeLon[far]! - lon0) * mPerLon;
    if (dx * dx + dy * dy > reachSq) reachSq = dx * dx + dy * dy;

    // Corridor check: covering ground a second time counts even when the path
    // is a different one — a twin bike/foot path alongside, or the next aisle
    // of a cemetery. ~14 m cells keep opposite street sidewalks (15-20 m
    // apart) distinct. Without this, a lap that comes back round on parallel
    // paths re-climbs the same hill for free, which is how courses used to
    // manufacture the target's gain instead of matching its features.
    if (e.cellIds && e.cellHead) {
      const m2 = e.cellIds.length;
      const spacing = e.lengthM / Math.max(1, m2 - 1);
      for (let k = 0; k < m2; k++) {
        const idx = forward ? k : m2 - 1 - k;
        const cell = e.cellIds[idx]!;
        const head = forward ? e.cellHead[idx]! : (e.cellHead[idx]! + 180) % 360;
        // distSoFar already includes this edge, so the sample's distance is
        // measured from the edge's start — else every pass gap is inflated by
        // one edge length and oscillation vs lap misclassifies near the window.
        const d = distSoFar - e.lengthM + k * spacing;
        const prevPass = corridor.get(cell);
        if (prevPass && prevPass.edge !== ei) {
          // Same-edge reuse is handled below; this is the parallel case.
          if (d - prevPass.dist < OSCILLATION_WINDOW_M) {
            // Reversing is a bounce, carrying on is a tight circle.
            oscillationLen +=
              Math.abs(angleDiffDeg(prevPass.head, head)) > 135 ? 2 * spacing : spacing;
          } else {
            repeatLen += spacing; // a lap: the same ground and the same climb
          }
        }
        corridor.set(cell, { head, dist: d, edge: ei });
      }
    }

    const dir = forward ? 1 : 0;
    const prev = used.get(ei);
    if (prev !== undefined) {
      // Reversed reuse counts double; reuse soon after the previous pass is
      // oscillation (bouncing on the same hill), not a lap.
      const weighted = prev.dir === dir ? e.lengthM : 2 * e.lengthM;
      if (distSoFar - prev.endDist < OSCILLATION_WINDOW_M) oscillationLen += weighted;
      else repeatLen += weighted;
    }
    used.set(ei, { dir, endDist: distSoFar + e.lengthM });
  }

  // Same median filter as the target profile: kills single-sample DEM spikes
  // that survive per-edge smoothing (short edges, edge joints).
  const smoothed = movingMedian5(samples);
  const start = smoothed[0] ?? 0;
  for (let i = 0; i < w; i++) smoothed[i]! -= start;

  const { gain, loss } = gainLoss(smoothed);
  const split = surfaceLen.map((v) => (lengthM > 0 ? v / lengthM : 0)) as SurfaceMix;
  let denseTurns = 0;
  for (let i = 1; i < turnDists.length; i++) {
    if (turnDists[i]! - turnDists[i - 1]! < DENSE_TURN_GAP_M) denseTurns++;
  }
  const km = Math.max(0.001, lengthM / 1000);
  return {
    samples: smoothed,
    lengthM,
    gain,
    loss,
    surfaceSplit: split,
    penaltyFraction: lengthM > 0 ? penaltyLen / lengthM : 0,
    repeatFraction: lengthM > 0 ? repeatLen / lengthM : 0,
    oscillationFraction: lengthM > 0 ? oscillationLen / lengthM : 0,
    untrackedFraction: lengthM > 0 ? untracedLen / lengthM : 0,
    reachM: Math.sqrt(reachSq),
    turnsPerKm: turnDists.length / km,
    denseTurnsPerKm: denseTurns / km,
    signalsPerKm: signalCount / km,
  };
}

/** 1D earth mover's distance between two histograms that each sum to ~1. */
export function emd(a: Float32Array, b: Float32Array): number {
  let cum = 0;
  let total = 0;
  for (let i = 0; i < a.length; i++) {
    cum += a[i]! - b[i]!;
    total += Math.abs(cum);
  }
  return total / a.length;
}

/**
 * Cost of running on class `row` when class `col` was wanted. Paved and
 * gravel are near-equivalent for a runner; trails differ meaningfully.
 */
const SURFACE_COST: number[][] = [
  // paved gravel trail unknown
  [0.0, 0.1, 1.0, 0.4], // paved
  [0.1, 0.0, 0.4, 0.3], // gravel
  [1.0, 0.4, 0.0, 0.4], // trail
  [0.4, 0.3, 0.4, 0.0], // unknown
];

/** Greedy transport of the actual mix onto the desired mix, weighted by SURFACE_COST. */
export function surfaceMismatch(actual: SurfaceMix, desired: SurfaceMix): number {
  const surplus = [0, 0, 0, 0];
  const deficit = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    const d = actual[i]! - desired[i]!;
    if (d > 0) surplus[i] = d;
    else deficit[i] = -d;
  }
  const moves: { from: number; to: number; cost: number }[] = [];
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      if (i !== j) moves.push({ from: i, to: j, cost: SURFACE_COST[i]![j]! });
    }
  }
  moves.sort((a, b) => a.cost - b.cost);
  let total = 0;
  for (const m of moves) {
    const amount = Math.min(surplus[m.from]!, deficit[m.to]!);
    if (amount > 0) {
      surplus[m.from]! -= amount;
      deficit[m.to]! -= amount;
      total += amount * m.cost;
    }
  }
  return total;
}

const SHAPE_WINDOW_SAMPLES = 20; // 500 m at 25 m spacing
const SHAPE_SHIFT_SAMPLES = 6; // tolerate ±150 m longitudinal misalignment

/**
 * How unlike the race the course is stretch by stretch: the RMS over sliding
 * windows of the offset-corrected RMSE, where each window may shift up to
 * ±150 m along the target. A real climb sitting slightly earlier or later than
 * in the race aligns at some shift; a spike where the target is flat stays bad
 * at every shift.
 *
 * RMS, not the worst window: with a max, a course that has already ruined one
 * stretch gets every other stretch for free, which is how a course could trade
 * the race's one long climb for a sawtooth of small hills the whole way round
 * and pay only once. Squaring still lets a single awful window dominate a
 * course that is merely approximate throughout.
 */
export function windowShapeError(course: Float32Array, target: Float32Array): number {
  const n = Math.min(course.length, target.length);
  if (n < SHAPE_WINDOW_SAMPLES) return 0;
  let sumSq = 0;
  let windows = 0;
  for (let start = 0; start + SHAPE_WINDOW_SAMPLES <= n; start += SHAPE_WINDOW_SAMPLES / 2) {
    let best = Infinity;
    for (let shift = -SHAPE_SHIFT_SAMPLES; shift <= SHAPE_SHIFT_SAMPLES; shift++) {
      const t0 = start + shift;
      if (t0 < 0 || t0 + SHAPE_WINDOW_SAMPLES > target.length) continue;
      let mean = 0;
      for (let i = 0; i < SHAPE_WINDOW_SAMPLES; i++) {
        mean += course[start + i]! - target[t0 + i]!;
      }
      mean /= SHAPE_WINDOW_SAMPLES;
      let sq = 0;
      for (let i = 0; i < SHAPE_WINDOW_SAMPLES; i++) {
        const d = course[start + i]! - target[t0 + i]! - mean;
        sq += d * d;
      }
      const rmse = Math.sqrt(sq / SHAPE_WINDOW_SAMPLES);
      if (rmse < best) best = rmse;
    }
    if (best === Infinity) continue;
    sumSq += best * best;
    windows++;
  }
  return windows > 0 ? Math.sqrt(sumSq / windows) : 0;
}

/** Per-term contributions; scoreCourse is their sum. */
export function scoreBreakdown(
  course: AssembledCourse,
  target: TargetProfile,
  desiredMix: SurfaceMix | null = MIX_ROAD,
  weights: Weights = DEFAULT_WEIGHTS,
): Record<string, number> {
  // Offset-corrected RMSE: a constant vertical offset between the two
  // profiles is DEM-vs-GPX measurement bias at the start point (observed:
  // 7 m at Slottsskogsvallen), not a real mismatch. Shape is what matters.
  const n = Math.min(course.samples.length, target.samples.length);
  let diffSum = 0;
  let diffSq = 0;
  for (let i = 0; i < n; i++) {
    const d = course.samples[i]! - target.samples[i]!;
    diffSum += d;
    diffSq += d * d;
  }
  const mean = n > 0 ? diffSum / n : 0;
  const rmse = n > 0 ? Math.sqrt(Math.max(0, diffSq / n - mean * mean)) : 0;

  const denom = Math.max(1, target.totalGain + target.totalLoss);
  const gainLossErr =
    (Math.abs(course.gain - target.totalGain) + Math.abs(course.loss - target.totalLoss)) / denom;

  const courseHist = gradientHistogram(course.samples);
  const histErr = emd(courseHist, target.gradientHistogram);

  return {
    profile: weights.rmse * rmse,
    'gain/loss': weights.gainLoss * gainLossErr,
    gradients: weights.histogram * histErr,
    surface: weights.surface * (desiredMix ? surfaceMismatch(course.surfaceSplit, desiredMix) : 0),
    safety: weights.penalty * course.penaltyFraction,
    repeats: weights.repeat * course.repeatFraction,
    'out-and-back': weights.oscillation * course.oscillationFraction,
    'stays put': weights.confinement * confinementFraction(course.reachM, course.lengthM),
    turns: weights.turns * Math.abs(course.turnsPerKm - target.turnsPerKm),
    'dense turns': weights.denseTurns * course.denseTurnsPerKm,
    'traffic lights': weights.trafficLights * course.signalsPerKm,
    'local shape': weights.localShape * windowShapeError(course.samples, target.samples),
    'unrun ground': weights.untracked * course.untrackedFraction,
  };
}

export function scoreCourse(
  course: AssembledCourse,
  target: TargetProfile,
  desiredMix: SurfaceMix | null = MIX_ROAD,
  weights: Weights = DEFAULT_WEIGHTS,
): number {
  let sum = 0;
  for (const v of Object.values(scoreBreakdown(course, target, desiredMix, weights))) sum += v;
  return sum;
}

export { GRADIENT_BIN_COUNT };
