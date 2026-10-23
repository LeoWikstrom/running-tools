import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { turnPositions } from '../src/shared/geo';
import { parseGpx } from '../src/gpx/parse';
import { buildTargetProfile } from '../src/gpx/profile';

// ~0.00045° lat ≈ 50 m
const STEP = 0.00045;

function line(points: [number, number][]): { lats: number[]; lons: number[] } {
  return { lats: points.map((p) => p[0]), lons: points.map((p) => p[1]) };
}

describe('turnPositions', () => {
  it('a straight line has no turns', () => {
    const { lats, lons } = line([
      [57.7, 12.0],
      [57.7 + 4 * STEP, 12.0],
      [57.7 + 8 * STEP, 12.0],
    ]);
    expect(turnPositions(lats, lons)).toEqual([]);
  });

  it('a right angle is one turn, at the corner', () => {
    const { lats, lons } = line([
      [57.7, 12.0],
      [57.7 + 4 * STEP, 12.0], // ~200 m north
      [57.7 + 4 * STEP, 12.0 + 8 * STEP], // then east
    ]);
    const turns = turnPositions(lats, lons);
    expect(turns.length).toBe(1);
    expect(turns[0]).toBeGreaterThan(150);
    expect(turns[0]).toBeLessThan(250);
  });

  it('a gentle arc does not count as turns', () => {
    // 90° spread over many small 5°-per-segment bends
    const pts: [number, number][] = [];
    for (let i = 0; i <= 18; i++) {
      const angle = (i * 5 * Math.PI) / 180;
      pts.push([57.7 + Math.sin(angle) * 20 * STEP, 12.0 + (1 - Math.cos(angle)) * 20 * STEP]);
    }
    const { lats, lons } = line(pts);
    expect(turnPositions(lats, lons).length).toBe(0);
  });

  it('a zigzag has many turns', () => {
    const pts: [number, number][] = [];
    for (let i = 0; i <= 10; i++) {
      pts.push([57.7 + i * 2 * STEP, i % 2 === 0 ? 12.0 : 12.0 + 4 * STEP]);
    }
    const { lats, lons } = line(pts);
    expect(turnPositions(lats, lons).length).toBeGreaterThanOrEqual(8);
  });
});

describe('turnsPerKm on real races', () => {
  it('is plausible and city race turns more than not at all', () => {
    const gbg = buildTargetProfile(
      parseGpx(readFileSync('test/fixtures/goteborgsvarvet.gpx', 'utf8')).points,
    );
    expect(gbg.turnsPerKm).toBeGreaterThan(0.5);
    expect(gbg.turnsPerKm).toBeLessThan(20);
  });
});
