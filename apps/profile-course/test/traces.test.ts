import { describe, expect, it } from 'vitest';
import {
  buildTraceGrid,
  parseTrackSegments,
  runPacedPoints,
  traceBoxes,
  type TracePoint,
} from '../src/net/traces';
import { applyTraceCoverage, MIN_CELL_POINTS } from '../src/graph/traces';
import { cellIdAt } from '../src/graph/cells';
import { haversineMeters } from '../src/shared/geo';
import type { Graph, GraphEdge } from '../src/graph/types';

/** A straight run of `n` points 10 m apart in latitude, one second each. */
function straightRun(lat: number, lon: number, n: number, metresPerPoint: number): TracePoint[] {
  const out: TracePoint[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ lat: lat + (i * metresPerPoint) / 111320, lon, t: 1_700_000_000_000 + i * 1000 });
  }
  return out;
}

describe('parseTrackSegments', () => {
  it('reads both self-closing and wrapped trackpoints, with and without a clock', () => {
    const gpx = `<?xml version="1.0"?>
      <gpx><trk><trkseg>
        <trkpt lat="57.69" lon="11.95"><time>2024-05-01T06:00:00Z</time></trkpt>
        <trkpt lat="57.6901" lon="11.9501"><time>2024-05-01T06:00:01Z</time></trkpt>
      </trkseg></trk>
      <trk><trkseg>
        <trkpt lat="57.70" lon="11.96"/>
        <trkpt lat="57.7001" lon="11.9601"/>
      </trkseg></trk></gpx>`;
    const segments = parseTrackSegments(gpx);
    expect(segments.length).toBe(2);
    expect(segments[0]!.length).toBe(2);
    expect(segments[0]![0]!.lat).toBeCloseTo(57.69, 5);
    expect(Number.isFinite(segments[0]![1]!.t)).toBe(true);
    expect(segments[1]!.length).toBe(2);
    expect(Number.isFinite(segments[1]![0]!.t)).toBe(false);
  });
});

describe('runPacedPoints', () => {
  it('keeps running pace and drops walking, driving and untimed points', () => {
    const run = straightRun(57.7, 11.95, 5, 3); // 3 m/s
    const walk = straightRun(57.8, 11.95, 5, 1); // 1 m/s
    const drive = straightRun(57.9, 11.95, 5, 15); // 15 m/s
    const anonymous = straightRun(57.95, 11.95, 5, 3).map((p) => ({ ...p, t: Number.NaN }));
    const { kept, timed } = runPacedPoints([run, walk, drive, anonymous]);
    expect(timed).toBe(15);
    expect(kept.length).toBe(5);
    for (const p of kept) expect(p.lat).toBeLessThan(57.8);
  });

  it('ignores a pause in the middle of a track', () => {
    const seg = straightRun(57.7, 11.95, 3, 3);
    seg[2] = { ...seg[2]!, t: seg[1]!.t + 3_600_000 };
    const { kept } = runPacedPoints([seg]);
    // The first pair is a run; the hour-long gap is not a 3 m stride.
    expect(kept.length).toBe(2);
  });
});

describe('buildTraceGrid', () => {
  it('counts points per cell', () => {
    const here = { lat: 57.7, lon: 11.95, t: 0 };
    const grid = buildTraceGrid([here, { ...here }, { lat: 57.8, lon: 11.95, t: 0 }]);
    expect(grid.cells.length).toBe(2);
    const i = grid.cells.indexOf(cellIdAt(here.lat, here.lon));
    expect(grid.counts[i]).toBe(2);
  });
});

describe('traceBoxes', () => {
  it('covers the circle without the corners of its bounding square', () => {
    const center = { lat: 57.7, lon: 11.95 };
    const boxes = traceBoxes(center, 10000);
    expect(boxes.length).toBeGreaterThan(4);
    for (const b of boxes) {
      const nearLat = Math.min(b.top, Math.max(b.bottom, center.lat));
      const nearLon = Math.min(b.right, Math.max(b.left, center.lon));
      expect(haversineMeters(center.lat, center.lon, nearLat, nearLon)).toBeLessThanOrEqual(10000);
    }
    const rows = Math.round(
      (Math.max(...boxes.map((b) => b.top)) - Math.min(...boxes.map((b) => b.bottom))) / 0.02,
    );
    const cols = Math.round(
      (Math.max(...boxes.map((b) => b.right)) - Math.min(...boxes.map((b) => b.left))) / 0.02,
    );
    expect(boxes.length).toBeLessThan(rows * cols);
  });
});

describe('applyTraceCoverage', () => {
  const edge = (cells: number[]): GraphEdge => ({
    a: 0,
    b: 1,
    lengthM: 100,
    surface: 0,
    penalty: 0,
    lats: new Float64Array([0, 0]),
    lons: new Float64Array([0, 0]),
    elev: new Float32Array([0, 0]),
    levelled: false,
    eleTag: null,
    signals: 0,
    cellIds: Int32Array.from(cells),
    cellHead: null,
    traced: 1,
    turnOffsets: new Float64Array(0),
    headOutA: Number.NaN,
    headInB: Number.NaN,
  });

  function graphOf(edges: GraphEdge[]): Graph {
    return {
      nodeLat: new Float64Array([0, 0]),
      nodeLon: new Float64Array([0, 0]),
      edges,
      adjOffset: new Int32Array([0, 0, 0]),
      adjEdge: new Int32Array(0),
    };
  }

  const run = cellIdAt(57.7, 11.95);
  const elsewhere = cellIdAt(57.9, 11.95);

  it('leaves every edge tracked when nothing has been downloaded', () => {
    const g = graphOf([edge([elsewhere])]);
    applyTraceCoverage(g, new Map());
    expect(g.edges[0]!.traced).toBe(1);
  });

  it('marks ground no trace covers as unrun, dilating by one cell', () => {
    const covered = edge([run]);
    const beside = edge([run + 1]); // the next cell along, ~14 m away
    const far = edge([elsewhere]);
    const g = graphOf([covered, beside, far]);
    applyTraceCoverage(g, new Map([[run, MIN_CELL_POINTS]]));
    expect(covered.traced).toBe(1);
    expect(beside.traced).toBe(1);
    expect(far.traced).toBe(0);
  });

  it('ignores a cell with too few points to be more than a stray fix', () => {
    const covered = edge([run]);
    applyTraceCoverage(graphOf([covered]), new Map([[run, MIN_CELL_POINTS - 1]]));
    expect(covered.traced).toBe(0);
  });

  it('reports the fraction of an edge that was run', () => {
    const half = edge([run, elsewhere]);
    applyTraceCoverage(graphOf([half]), new Map([[run, 5]]));
    expect(half.traced).toBe(0.5);
  });
});
