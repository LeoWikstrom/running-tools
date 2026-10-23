import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseGpx } from '../src/gpx/parse';

const fixture = (name: string) => readFileSync(`test/fixtures/${name}`, 'utf8');

describe('parseGpx on real races', () => {
  it('parses goteborgsvarvet.gpx with elevation', () => {
    const gpx = parseGpx(fixture('goteborgsvarvet.gpx'));
    expect(gpx.points.length).toBe(2403);
    expect(gpx.hasElevation).toBe(true);
  });

  it('parses lidingoloppet.gpx with elevation', () => {
    const gpx = parseGpx(fixture('lidingoloppet.gpx'));
    expect(gpx.points.length).toBeGreaterThan(100);
    expect(gpx.hasElevation).toBe(true);
    expect(gpx.name).toContain('Liding');
  });

  it('parses lerumsloppet.gpx without elevation', () => {
    const gpx = parseGpx(fixture('lerumsloppet.gpx'));
    expect(gpx.points.length).toBe(545);
    expect(gpx.hasElevation).toBe(false);
    expect(gpx.points[0]?.ele).toBeNull();
  });
});

describe('parseGpx on synthetic inputs', () => {
  it('falls back to rtept when there are no trkpt', () => {
    const xml = `<gpx><rte>
      <rtept lat="57.0" lon="12.0"><ele>10</ele></rtept>
      <rtept lat="57.001" lon="12.0"><ele>12</ele></rtept>
    </rte></gpx>`;
    const gpx = parseGpx(xml);
    expect(gpx.points.length).toBe(2);
    expect(gpx.points[1]?.ele).toBe(12);
  });

  it('prefers trkpt when both exist', () => {
    const xml = `<gpx>
      <rte><rtept lat="1" lon="1"/><rtept lat="2" lon="2"/></rte>
      <trk><trkseg>
        <trkpt lat="57.0" lon="12.0"/><trkpt lat="57.1" lon="12.1"/><trkpt lat="57.2" lon="12.2"/>
      </trkseg></trk>
    </gpx>`;
    const gpx = parseGpx(xml);
    expect(gpx.points.length).toBe(3);
    expect(gpx.points[0]?.lat).toBe(57.0);
  });

  it('handles self-closing trkpt without elevation', () => {
    const xml = `<gpx><trk><trkseg>
      <trkpt lat="57.0" lon="12.0"/><trkpt lat="57.001" lon="12.0"/>
    </trkseg></trk></gpx>`;
    const gpx = parseGpx(xml);
    expect(gpx.hasElevation).toBe(false);
  });

  it('throws on fewer than 2 points', () => {
    expect(() =>
      parseGpx('<gpx><trk><trkseg><trkpt lat="1" lon="1"/></trkseg></trk></gpx>'),
    ).toThrow();
  });

  it('handles mixed self-closing and wrapped trkpt in one trkseg', () => {
    // Bug guard: self-closing after wrapped must not steal the next wrapped point's <ele>.
    const xml = `<gpx><trk><trkseg>
      <trkpt lat="57.0" lon="12.0"><ele>100</ele></trkpt>
      <trkpt lat="57.001" lon="12.001"/>
      <trkpt lat="57.002" lon="12.002"><ele>200</ele></trkpt>
    </trkseg></trk></gpx>`;
    const gpx = parseGpx(xml);
    expect(gpx.points.length).toBe(3);
    expect(gpx.points[0]?.ele).toBe(100);
    expect(gpx.points[1]?.ele).toBeNull();
    expect(gpx.points[2]?.ele).toBe(200);
    expect(gpx.points[0]?.lat).toBe(57.0);
    expect(gpx.points[1]?.lat).toBe(57.001);
    expect(gpx.points[2]?.lat).toBe(57.002);
  });
});
