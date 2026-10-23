import { cellIdAt } from '../graph/cells';
import { haversineMeters } from '../shared/geo';
import type { LatLon } from '../shared/messages';

/** One recorded point. `t` is epoch ms, or NaN for an anonymised trace. */
export interface TracePoint {
  lat: number;
  lon: number;
  t: number;
}

/** Trace point counts per ~14 m cell, sorted by cell id. */
export interface TraceGrid {
  cells: Int32Array;
  counts: Uint16Array;
}

export interface TraceYield {
  grid: TraceGrid;
  /** Every point the API returned. */
  points: number;
  /** Points from identifiable traces, which are the only ones with a clock. */
  timed: number;
  /** Timed points moving at a running pace. */
  kept: number;
  /** Boxes the API refused, after the retry. */
  failedBoxes: number;
  /** Boxes silently capped at MAX_PAGES; their later pages were not fetched. */
  truncated?: number;
}

/**
 * Running pace, wide enough for a slow jog and a hard interval but not for a
 * car. Bikes between 4 and 5.5 m/s do leak through: no public GPS source says
 * how someone travelled, and the speed is all we have to go on.
 */
export const MIN_RUN_SPEED = 1.5;
export const MAX_RUN_SPEED = 5.5;

/** Longer than this between two points and they are not one stride apart. */
const MAX_GAP_S = 60;

const API = 'https://api.openstreetmap.org/api/0.6/trackpoints';

/** Well under the API's 0.25 deg² limit, so a box is ~2 km and progress moves. */
const BOX_DEG = 0.02;

const PAGE_SIZE = 5000;

/** Pages per box. A dense city centre would otherwise page for many minutes. */
const MAX_PAGES = 12;

/**
 * Points grouped by `<trkseg>`, by regex: this runs in the worker, where there
 * is no DOMParser, and the payload is megabytes of a known shape.
 */
export function parseTrackSegments(gpx: string): TracePoint[][] {
  const segments: TracePoint[][] = [];
  const segRe = /<trkseg>([\s\S]*?)<\/trkseg>/g;
  let seg: RegExpExecArray | null;
  while ((seg = segRe.exec(gpx)) !== null) {
    const body = seg[1]!;
    const points: TracePoint[] = [];
    const ptRe = /<trkpt\b([^>]*)>/g;
    let pt: RegExpExecArray | null;
    while ((pt = ptRe.exec(body)) !== null) {
      const lat = Number(/\blat="([-\d.eE+]+)"/.exec(pt[1]!)?.[1]);
      const lon = Number(/\blon="([-\d.eE+]+)"/.exec(pt[1]!)?.[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      // A point is either self-closing or holds its children until the next
      // one opens; either way the clock, if any, is before that.
      const from = ptRe.lastIndex;
      const next = body.indexOf('<trkpt', from);
      const tail = body.slice(from, next < 0 ? undefined : next);
      const time = /<time>([^<]+)<\/time>/.exec(tail)?.[1];
      points.push({ lat, lon, t: time ? Date.parse(time) : NaN });
    }
    if (points.length > 0) segments.push(points);
  }
  return segments;
}

/**
 * Keeps the points whose own stretch of track was covered at a running pace.
 * Untimed points are dropped: public-visibility traces come back stripped of
 * their clock *and* their order, so there is no telling a run from a commute —
 * and a trace layer that cannot is what made the first attempt useless.
 */
export function runPacedPoints(segments: TracePoint[][]): { kept: TracePoint[]; timed: number } {
  const kept: TracePoint[] = [];
  let timed = 0;
  for (const seg of segments) {
    const keep = new Uint8Array(seg.length);
    for (let i = 0; i < seg.length; i++) if (Number.isFinite(seg[i]!.t)) timed++;
    for (let i = 1; i < seg.length; i++) {
      const a = seg[i - 1]!;
      const b = seg[i]!;
      const dt = (b.t - a.t) / 1000;
      if (!(dt > 0) || dt > MAX_GAP_S) continue;
      const speed = haversineMeters(a.lat, a.lon, b.lat, b.lon) / dt;
      if (speed < MIN_RUN_SPEED || speed > MAX_RUN_SPEED) continue;
      keep[i - 1] = 1;
      keep[i] = 1;
    }
    for (let i = 0; i < seg.length; i++) if (keep[i]) kept.push(seg[i]!);
  }
  return { kept, timed };
}

export function buildTraceGrid(points: TracePoint[]): TraceGrid {
  const counts = new Map<number, number>();
  for (const p of points) {
    const id = cellIdAt(p.lat, p.lon);
    counts.set(id, Math.min(65535, (counts.get(id) ?? 0) + 1));
  }
  const cells = Int32Array.from(counts.keys()).sort();
  const out = new Uint16Array(cells.length);
  for (let i = 0; i < cells.length; i++) out[i] = counts.get(cells[i]!)!;
  return { cells, counts: out };
}

/** The ~2 km boxes covering a circle, in rows from the south. */
export function traceBoxes(
  center: LatLon,
  radiusMeters: number,
): { left: number; bottom: number; right: number; top: number }[] {
  const dLat = radiusMeters / 111320;
  const dLon = radiusMeters / (111320 * Math.cos((center.lat * Math.PI) / 180));
  const boxes = [];
  const lat0 = Math.floor((center.lat - dLat) / BOX_DEG) * BOX_DEG;
  const lon0 = Math.floor((center.lon - dLon) / BOX_DEG) * BOX_DEG;
  for (let bottom = lat0; bottom < center.lat + dLat; bottom += BOX_DEG) {
    for (let left = lon0; left < center.lon + dLon; left += BOX_DEG) {
      const top = bottom + BOX_DEG;
      const right = left + BOX_DEG;
      // Corner boxes of the bounding square never touch the circle.
      const nearLat = Math.min(top, Math.max(bottom, center.lat));
      const nearLon = Math.min(right, Math.max(left, center.lon));
      if (haversineMeters(center.lat, center.lon, nearLat, nearLon) > radiusMeters) continue;
      boxes.push({ left, bottom, right, top });
    }
  }
  return boxes;
}

export interface FetchTracesOptions {
  fetchFn?: typeof fetch;
  /** Called after every box; `kept` is the running total of running-paced points. */
  onProgress?: (doneBoxes: number, totalBoxes: number, kept: number) => void;
  shouldCancel?: () => boolean;
}

/**
 * Downloads every public GPS trackpoint around a start and keeps the ones that
 * were recorded at a running pace, as counts per ~14 m cell. Slow by nature:
 * the API hands out 5 000 points a page, one box at a time, and we are a guest
 * on it — so the requests are strictly sequential.
 */
export async function fetchTracePoints(
  center: LatLon,
  radiusMeters: number,
  opts: FetchTracesOptions = {},
): Promise<TraceYield> {
  const doFetch = opts.fetchFn ?? fetch;
  const boxes = traceBoxes(center, radiusMeters);
  const kept: TracePoint[] = [];
  let points = 0;
  let timed = 0;
  let failedBoxes = 0;
  let truncated = 0;

  for (let b = 0; b < boxes.length; b++) {
    if (opts.shouldCancel?.()) break;
    const box = boxes[b]!;
    const bbox = `${box.left.toFixed(5)},${box.bottom.toFixed(5)},${box.right.toFixed(5)},${box.top.toFixed(5)}`;
    let hitMaxPages = true;
    for (let page = 0; page < MAX_PAGES; page++) {
      if (opts.shouldCancel?.()) break;
      let text: string;
      try {
        text = await fetchPage(doFetch, bbox, page);
      } catch {
        failedBoxes++;
        hitMaxPages = false;
        break;
      }
      const segments = parseTrackSegments(text);
      const pageCount = segments.reduce((n, s) => n + s.length, 0);
      points += pageCount;
      const paced = runPacedPoints(segments);
      timed += paced.timed;
      kept.push(...paced.kept);
      // A short page is the last one; the API pages in fixed 5 000s.
      if (pageCount < PAGE_SIZE) {
        hitMaxPages = false;
        break;
      }
    }
    if (hitMaxPages) truncated++;
    opts.onProgress?.(b + 1, boxes.length, kept.length);
  }

  return { grid: buildTraceGrid(kept), points, timed, kept: kept.length, failedBoxes, truncated };
}

async function fetchPage(doFetch: typeof fetch, bbox: string, page: number): Promise<string> {
  const url = `${API}?bbox=${bbox}&page=${page}`;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const res = await doFetch(url, {
        headers: { Accept: 'application/gpx+xml' },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) return await res.text();
      // Deterministic 4xx (except 429 rate-limit): retrying will not help.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        throw new Error(`trackpoints API returned ${res.status}`);
      }
      // 509 is the API's bandwidth cap: backing off and retrying is the only
      // thing that helps, and failing the box is better than hammering it.
      lastError = new Error(`trackpoints API returned ${res.status}`);
    } catch (err) {
      clearTimeout(timer);
      // Non-retryable 4xx: propagate immediately without a retry.
      if (err instanceof Error && err.message.startsWith('trackpoints API returned 4')) throw err;
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw lastError ?? new Error('trackpoints API is not answering');
}
