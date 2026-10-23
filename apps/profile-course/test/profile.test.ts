import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseGpx } from '../src/gpx/parse';
import {
  GRADIENT_BIN_COUNT,
  buildTargetProfile,
  gainLoss,
  gradientHistogram,
  movingMedian5,
  resampleElevation,
} from '../src/gpx/profile';

describe('movingMedian5', () => {
  it('removes a single spike', () => {
    const out = movingMedian5(new Float32Array([10, 10, 90, 10, 10]));
    expect(out[2]).toBe(10);
  });

  it('preserves a constant series', () => {
    const out = movingMedian5(new Float32Array([5, 5, 5, 5, 5, 5]));
    expect(Array.from(out)).toEqual([5, 5, 5, 5, 5, 5]);
  });
});

describe('resampleElevation', () => {
  it('interpolates linearly', () => {
    const cum = new Float64Array([0, 100]);
    const elev = new Float32Array([0, 100]);
    const out = resampleElevation(cum, elev, 100, 25);
    expect(Array.from(out)).toEqual([0, 25, 50, 75, 100]);
  });
});

describe('gainLoss', () => {
  it('splits ascent and descent', () => {
    const { gain, loss } = gainLoss(new Float32Array([0, 10, 5, 15]));
    expect(gain).toBe(20);
    expect(loss).toBe(5);
  });
});

describe('gradientHistogram', () => {
  it('puts a flat profile entirely in the middle bin', () => {
    const hist = gradientHistogram(new Float32Array([0, 0, 0, 0]));
    const mid = (GRADIENT_BIN_COUNT - 1) / 2;
    expect(hist[mid]).toBeCloseTo(1);
  });

  it('sums to 1', () => {
    const hist = gradientHistogram(new Float32Array([0, 1, 3, 2, 0, -2]));
    const sum = Array.from(hist).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1);
  });
});

describe('sliceProfile', () => {
  it('cuts a window and rebases it to its own start', async () => {
    const { sliceProfile, buildProfileFromSamples } = await import('../src/gpx/profile');
    const samples = new Float32Array(401); // 10 km
    for (let i = 0; i < 401; i++) samples[i] = i * 0.5; // steady climb
    const full = buildProfileFromSamples(samples, 400 * 25);
    const part = sliceProfile(full, 2000, 7000);
    expect(part.totalDistance).toBe(5000);
    expect(part.samples[0]).toBe(0);
    expect(part.totalGain).toBeCloseTo(100, 0); // 5 km of the 0.5 m / 25 m climb
  });

  it('clamps out-of-range windows', async () => {
    const { sliceProfile, buildProfileFromSamples } = await import('../src/gpx/profile');
    const full = buildProfileFromSamples(new Float32Array(101), 100 * 25);
    const part = sliceProfile(full, -5000, 99_000);
    expect(part.totalDistance).toBe(full.totalDistance);
  });
});

describe('buildTargetProfile on real races', () => {
  it('goteborgsvarvet is a half marathon with meaningful gain', () => {
    const gpx = parseGpx(readFileSync('test/fixtures/goteborgsvarvet.gpx', 'utf8'));
    const profile = buildTargetProfile(gpx.points);
    expect(profile.totalDistance).toBeGreaterThan(20_000);
    expect(profile.totalDistance).toBeLessThan(22_500);
    expect(profile.totalGain).toBeGreaterThan(50);
    expect(profile.totalGain).toBeLessThan(500);
    expect(profile.samples[0]).toBe(0);
    expect(profile.samples.length).toBe(Math.floor(profile.totalDistance / 25) + 1);
  });

  it('lidingoloppet is ~30 km and hillier per km than goteborgsvarvet', () => {
    const gbg = buildTargetProfile(
      parseGpx(readFileSync('test/fixtures/goteborgsvarvet.gpx', 'utf8')).points,
    );
    const lidingo = buildTargetProfile(
      parseGpx(readFileSync('test/fixtures/lidingoloppet.gpx', 'utf8')).points,
    );
    expect(lidingo.totalDistance).toBeGreaterThan(28_000);
    expect(lidingo.totalDistance).toBeLessThan(32_000);
    expect(lidingo.totalGain / lidingo.totalDistance).toBeGreaterThan(
      gbg.totalGain / gbg.totalDistance,
    );
  });

  it('throws if a point lacks elevation', () => {
    const gpx = parseGpx(readFileSync('test/fixtures/lerumsloppet.gpx', 'utf8'));
    expect(() => buildTargetProfile(gpx.points)).toThrow();
  });
});
