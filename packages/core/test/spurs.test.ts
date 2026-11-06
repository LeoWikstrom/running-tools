import { describe, expect, it } from 'vitest';
import { findPointSpurs } from '../src/geo/spurs';

const LAT = 57.7;
const M = 1 / 111_195; // degrees latitude per metre

describe('findPointSpurs', () => {
  it('finds a mirrored out-and-back and reports its reach', () => {
    // East 3 points, north spur 2 points out and back, east again.
    const pts: [number, number][] = [
      [LAT, 0],
      [LAT, 50 * M],
      [LAT, 100 * M],
      [LAT + 40 * M, 100 * M],
      [LAT + 80 * M, 100 * M], // tip
      [LAT + 40 * M, 100 * M],
      [LAT, 100 * M],
      [LAT, 150 * M],
      [LAT, 200 * M],
    ];
    const spurs = findPointSpurs(
      pts.map((p) => p[0]),
      pts.map((p) => p[1]),
    );
    expect(spurs).toHaveLength(1);
    expect(spurs[0]!.tip).toBe(4);
    expect(spurs[0]!.from).toBe(2);
    expect(spurs[0]!.to).toBe(5);
    expect(spurs[0]!.lengthM).toBeCloseTo(80, 0);
  });

  it('finds an eastward spur too — the reversal check must not care about wrap sign', () => {
    // On a sphere an east/west reversal is a hair over 180°, which wraps to a
    // negative angleDiffDeg; the unsigned check must still see the U-turn.
    const LONM = M / Math.cos((LAT * Math.PI) / 180);
    const pts: [number, number][] = [
      [LAT, 0],
      [LAT, 150 * LONM],
      [LAT, 300 * LONM],
      [LAT, 500 * LONM], // tip
      [LAT, 300 * LONM],
      [LAT, 150 * LONM],
      [LAT + 150 * M, 150 * LONM],
    ];
    const spurs = findPointSpurs(
      pts.map((p) => p[0]),
      pts.map((p) => p[1]),
    );
    expect(spurs).toHaveLength(1);
    expect(spurs[0]!.tip).toBe(3);
  });

  it('catches a spur whose return leg runs on a parallel offset path', () => {
    // Out north on one path, back south on a twin 10 m east — no mirrored
    // points, but the course returns beside the junction heading reversed.
    const pts: [number, number][] = [
      [LAT, 0],
      [LAT, 100 * M],
      [LAT + 60 * M, 100 * M],
      [LAT + 120 * M, 100 * M], // tip
      [LAT + 120 * M, 110 * M],
      [LAT + 60 * M, 110 * M],
      [LAT, 110 * M],
      [LAT, 200 * M],
      [LAT, 300 * M],
    ];
    const spurs = findPointSpurs(
      pts.map((p) => p[0]),
      pts.map((p) => p[1]),
    );
    expect(spurs).toHaveLength(1);
    expect(spurs[0]!.from).toBe(1);
    // Either cap corner is an honest tip; they differ by centimetres.
    expect([3, 4]).toContain(spurs[0]!.tip);
  });

  it('offers only the inner spur of a street→square→spur lobe, never the whole bite', () => {
    // Out a street, along the south side of a square, up a spur and back,
    // along the north side, back down the street. The street legs retrace
    // each other but the square sides do not — so the only dot belongs to
    // the inner spur, and peeling stops at the square.
    const course: [number, number][] = [
      [LAT, 0],
      [LAT, 100 * M],
      [LAT + 60 * M, 100 * M],
      [LAT + 120 * M, 100 * M], // square south entry
      [LAT + 120 * M, 160 * M], // south side east end
      [LAT + 180 * M, 160 * M], // spur out
      [LAT + 240 * M, 160 * M], // spur tip
      [LAT + 180 * M, 160 * M], // spur back
      [LAT + 120 * M, 160 * M], // back at square east
      [LAT + 180 * M, 130 * M], // north side (different ground, ~55 m off)
      [LAT + 120 * M, 100 * M], // square exit = street top
      [LAT + 60 * M, 100 * M], // down the street
      [LAT, 100 * M],
      [LAT, 200 * M], // main path continues
    ];
    const spurs = findPointSpurs(
      course.map((p) => p[0]),
      course.map((p) => p[1]),
    );
    expect(spurs).toHaveLength(1);
    expect(spurs[0]!.tip).toBe(6);
    // The mirrored range reaches the square corner, present on both sides.
    expect(spurs[0]!.from).toBe(4);
    expect(spurs[0]!.to).toBe(7);
  });

  it('leaves a genuine little loop alone — it closes travelling forward', () => {
    // A square lobe: leave north, round the block, arrive heading north again.
    const pts: [number, number][] = [
      [LAT, 0],
      [LAT, 100 * M],
      [LAT + 80 * M, 100 * M],
      [LAT + 80 * M, 180 * M],
      [LAT - 5 * M, 180 * M],
      [LAT - 5 * M, 100 * M],
      [LAT, 100 * M],
      [LAT, 200 * M],
    ];
    const spurs = findPointSpurs(
      pts.map((p) => p[0]),
      pts.map((p) => p[1]),
    );
    expect(spurs).toHaveLength(0);
  });

  it('ignores reversals shorter than the minimum and plain corners', () => {
    const corner: [number, number][] = [
      [LAT, 0],
      [LAT, 100 * M],
      [LAT + 100 * M, 100 * M],
      [LAT + 100 * M, 200 * M],
    ];
    expect(
      findPointSpurs(
        corner.map((p) => p[0]),
        corner.map((p) => p[1]),
      ),
    ).toHaveLength(0);
    const tiny: [number, number][] = [
      [LAT, 0],
      [LAT, 100 * M],
      [LAT + 10 * M, 100 * M], // 10 m nub
      [LAT, 100 * M],
      [LAT, 200 * M],
    ];
    expect(
      findPointSpurs(
        tiny.map((p) => p[0]),
        tiny.map((p) => p[1]),
      ),
    ).toHaveLength(0);
  });
});
