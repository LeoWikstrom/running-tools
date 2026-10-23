import { haversineMeters, turnPositions } from '../shared/geo';
import type { GpxPoint } from './parse';

export const SAMPLE_STEP_M = 25;
export const GRADIENT_BIN_PERCENT = 2;
export const GRADIENT_BIN_COUNT = 21; // -20%..+20% in 2% bins, clamped

export interface TargetProfile {
  totalDistance: number;
  /** Elevation every SAMPLE_STEP_M metres, relative to the start (samples[0] === 0). */
  samples: Float32Array;
  totalGain: number;
  totalLoss: number;
  /** Fraction of distance per gradient bin; bin i covers [-21 + 2i, -19 + 2i) %. */
  gradientHistogram: Float32Array;
  /** Significant direction changes per km along the race geometry. */
  turnsPerKm: number;
}

export function movingMedian5(values: Float32Array): Float32Array {
  const n = values.length;
  const out = new Float32Array(n);
  const window: number[] = [];
  for (let i = 0; i < n; i++) {
    window.length = 0;
    for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) {
      window.push(values[j]!);
    }
    window.sort((a, b) => a - b);
    out[i] = window[window.length >> 1]!;
  }
  return out;
}

export function resampleElevation(
  cumDist: Float64Array,
  elev: Float32Array,
  totalDistance: number,
  stepM: number = SAMPLE_STEP_M,
): Float32Array {
  const count = Math.floor(totalDistance / stepM) + 1;
  const out = new Float32Array(count);
  let seg = 0;
  for (let i = 0; i < count; i++) {
    const d = Math.min(i * stepM, totalDistance);
    while (seg < cumDist.length - 2 && cumDist[seg + 1]! < d) seg++;
    const d0 = cumDist[seg]!;
    const d1 = cumDist[seg + 1]!;
    const t = d1 > d0 ? (d - d0) / (d1 - d0) : 0;
    out[i] = elev[seg]! + t * (elev[seg + 1]! - elev[seg]!);
  }
  return out;
}

/**
 * Gain/loss with hysteresis: direction only flips after the elevation moves
 * more than thresholdM against the current trend. Plain summation counts
 * every DEM wiggle and inflates a course's totals far above the (smoother)
 * race GPX figures.
 */
export function gainLoss(samples: Float32Array, thresholdM = 2): { gain: number; loss: number } {
  let gain = 0;
  let loss = 0;
  if (samples.length === 0) return { gain, loss };
  let ref = samples[0]!;
  let dir = 0;
  for (let i = 1; i < samples.length; i++) {
    const d = samples[i]! - ref;
    if (dir >= 0) {
      if (d > 0) {
        gain += d;
        ref = samples[i]!;
        if (dir === 0) dir = 1;
      } else if (d < -thresholdM) {
        loss -= d;
        ref = samples[i]!;
        dir = -1;
      }
    } else {
      if (d < 0) {
        loss -= d;
        ref = samples[i]!;
      } else if (d > thresholdM) {
        gain += d;
        ref = samples[i]!;
        dir = 1;
      }
    }
  }
  return { gain, loss };
}

export function gradientHistogram(
  samples: Float32Array,
  stepM: number = SAMPLE_STEP_M,
): Float32Array {
  const hist = new Float32Array(GRADIENT_BIN_COUNT);
  const segments = samples.length - 1;
  if (segments <= 0) return hist;
  const half = (GRADIENT_BIN_COUNT - 1) / 2;
  for (let i = 1; i < samples.length; i++) {
    const gradPct = ((samples[i]! - samples[i - 1]!) / stepM) * 100;
    let bin = Math.round(gradPct / GRADIENT_BIN_PERCENT) + half;
    if (bin < 0) bin = 0;
    if (bin >= GRADIENT_BIN_COUNT) bin = GRADIENT_BIN_COUNT - 1;
    hist[bin]! += 1 / segments;
  }
  return hist;
}

export function buildProfileFromSamples(
  samples: Float32Array,
  totalDistance: number,
  turnsPerKm = 0,
): TargetProfile {
  const relative = new Float32Array(samples.length);
  const start = samples[0] ?? 0;
  for (let i = 0; i < samples.length; i++) relative[i] = samples[i]! - start;
  const { gain, loss } = gainLoss(relative);
  return {
    totalDistance,
    samples: relative,
    totalGain: gain,
    totalLoss: loss,
    gradientHistogram: gradientHistogram(relative),
    turnsPerKm,
  };
}

/** Cut a [fromM, toM] window out of a profile and rebase it to its own start. */
export function sliceProfile(profile: TargetProfile, fromM: number, toM: number): TargetProfile {
  const last = profile.samples.length - 1;
  const i0 = Math.max(0, Math.min(Math.round(fromM / SAMPLE_STEP_M), last - 1));
  const i1 = Math.max(i0 + 1, Math.min(Math.round(toM / SAMPLE_STEP_M), last));
  return buildProfileFromSamples(
    profile.samples.slice(i0, i1 + 1),
    (i1 - i0) * SAMPLE_STEP_M,
    profile.turnsPerKm,
  );
}

/** Points must all carry elevation; fetch missing elevation before calling. */
export function buildTargetProfile(points: GpxPoint[]): TargetProfile {
  const n = points.length;
  const cumDist = new Float64Array(n);
  const elev = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = points[i]!;
    if (p.ele === null) throw new Error('buildTargetProfile requires elevation on every point');
    elev[i] = p.ele;
    if (i > 0) {
      const q = points[i - 1]!;
      cumDist[i] = cumDist[i - 1]! + haversineMeters(q.lat, q.lon, p.lat, p.lon);
    }
  }
  const totalDistance = cumDist[n - 1]!;
  const smoothed = movingMedian5(elev);
  const samples = resampleElevation(cumDist, smoothed, totalDistance);
  const turns = turnPositions(
    points.map((p) => p.lat),
    points.map((p) => p.lon),
  );
  const turnsPerKm = totalDistance > 0 ? turns.length / (totalDistance / 1000) : 0;
  return buildProfileFromSamples(samples, totalDistance, turnsPerKm);
}
