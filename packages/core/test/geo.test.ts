import { describe, expect, it } from 'vitest';
import { haversineMeters, projectOnPolyline } from '../src/geo';

describe('haversineMeters', () => {
  it('returns 0 for identical points', () => {
    expect(haversineMeters(57.7, 11.97, 57.7, 11.97)).toBe(0);
  });

  it('matches a known distance (Gothenburg to Stockholm ~398 km)', () => {
    const d = haversineMeters(57.7089, 11.9746, 59.3293, 18.0686);
    expect(d).toBeGreaterThan(390_000);
    expect(d).toBeLessThan(410_000);
  });

  it('one degree of latitude is ~111.2 km', () => {
    const d = haversineMeters(57, 12, 58, 12);
    expect(d).toBeGreaterThan(110_500);
    expect(d).toBeLessThan(111_900);
  });
});

describe('projectOnPolyline', () => {
  // A straight ~1113 m west-to-east line at Gothenburg's latitude.
  const lats = [57.7, 57.7, 57.7];
  const lons = [11.97, 11.98, 11.99];
  const segLen = () => haversineMeters(57.7, 11.97, 57.7, 11.98);

  it('projects a point beside the middle of a segment', () => {
    // 100 m north of the midpoint of the first segment.
    const p = projectOnPolyline(lats, lons, 57.7 + 100 / 111_195, 11.975)!;
    expect(p.offset).toBeGreaterThan(95);
    expect(p.offset).toBeLessThan(105);
    expect(p.along).toBeGreaterThan(segLen() * 0.49);
    expect(p.along).toBeLessThan(segLen() * 0.51);
    expect(p.segment).toBe(0);
  });

  it('accumulates distance along later segments', () => {
    const p = projectOnPolyline(lats, lons, 57.7, 11.985)!;
    expect(p.offset).toBeLessThan(1);
    expect(p.along).toBeGreaterThan(segLen() * 1.49);
    expect(p.along).toBeLessThan(segLen() * 1.51);
    expect(p.segment).toBe(1);
  });

  it('clamps to the ends', () => {
    const before = projectOnPolyline(lats, lons, 57.7, 11.96)!;
    expect(before.along).toBe(0);
    expect(before.lat).toBe(57.7);
    expect(before.lon).toBe(11.97);
    const after = projectOnPolyline(lats, lons, 57.7, 12.0)!;
    expect(after.along).toBeGreaterThan(segLen() * 1.99);
    expect(after.lon).toBe(11.99);
  });

  it('picks the nearest of two far-apart passes', () => {
    // Out-and-back with the return leg 200 m north.
    const la = [57.7, 57.7, 57.7 + 200 / 111_195, 57.7 + 200 / 111_195];
    const lo = [11.97, 11.99, 11.99, 11.97];
    // 20 m north of the return leg, above the start.
    const p = projectOnPolyline(la, lo, 57.7 + 220 / 111_195, 11.97)!;
    expect(p.segment).toBe(2);
    expect(p.offset).toBeGreaterThan(15);
    expect(p.offset).toBeLessThan(25);
  });

  it('handles a single point and an empty line', () => {
    const single = projectOnPolyline([57.7], [11.97], 57.701, 11.97)!;
    expect(single.along).toBe(0);
    expect(single.offset).toBeGreaterThan(100);
    expect(projectOnPolyline([], [], 57.7, 11.97)).toBeNull();
  });

  it('a point on a vertex projects with zero offset', () => {
    const p = projectOnPolyline(lats, lons, 57.7, 11.98)!;
    expect(p.offset).toBeLessThan(0.01);
    expect(Math.abs(p.along - segLen())).toBeLessThan(0.5);
  });
});
