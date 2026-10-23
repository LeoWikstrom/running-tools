import { describe, expect, it } from 'vitest';
import { haversineMeters } from '../src/shared/geo';

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
