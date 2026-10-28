import { haversineMeters, type LatLon } from '../geo';

/** A gap between consecutive member ways larger than this is reported. */
const GAP_M = 30;
/** Joints closer than this are the same node; skip the duplicate point. */
const JOIN_M = 1;

export interface BusLine {
  id: number;
  /** Line number as signed, e.g. "16". */
  ref: string;
  name: string;
  from?: string;
  to?: string;
}

export interface OverpassRelationMember {
  type: 'node' | 'way' | 'relation';
  ref: number;
  role: string;
}

export interface OverpassRelation {
  type: 'relation';
  id: number;
  members?: OverpassRelationMember[];
  tags?: Record<string, string>;
}

/** A way from an `out geom` query: coordinates inline, in way order. */
export interface OverpassGeomWay {
  type: 'way';
  id: number;
  geometry?: { lat: number; lon: number }[];
}

export function buildBusRoutesListQuery(center: LatLon, radiusMeters: number): string {
  const around = `(around:${Math.round(radiusMeters)},${center.lat.toFixed(6)},${center.lon.toFixed(6)})`;
  return `[out:json][timeout:30];relation[type=route][route=bus]${around};out tags;`;
}

export function buildBusRouteGeomQuery(relationId: number): string {
  return `[out:json][timeout:60];relation(${relationId});out body;way(r);out geom;`;
}

export function relationsToBusLines(relations: OverpassRelation[]): BusLine[] {
  const out: BusLine[] = [];
  for (const r of relations) {
    const tags = r.tags;
    if (!tags) continue;
    const name = tags.name ?? [tags.ref, tags.to].filter(Boolean).join(' → ');
    if (!name) continue;
    out.push({ id: r.id, ref: tags.ref ?? '', name, from: tags.from, to: tags.to });
  }
  out.sort((a, b) => {
    const na = Number(a.ref);
    const nb = Number(b.ref);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return a.ref.localeCompare(b.ref) || a.name.localeCompare(b.name);
  });
  return out;
}

const dist = (a: LatLon, b: LatLon): number => haversineMeters(a.lat, a.lon, b.lat, b.lon);

function nearestIndex(ring: LatLon[], p: LatLon): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const d = dist(ring[i]!, p);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Walk a closed ring from index `a` to index `b`, the shorter way around. */
function ringArcByIndex(ring: LatLon[], a: number, b: number): LatLon[] {
  const n = ring.length;
  const forward: LatLon[] = [];
  for (let i = a; ; i = (i + 1) % n) {
    forward.push(ring[i]!);
    if (i === b) break;
  }
  const backward: LatLon[] = [];
  for (let i = a; ; i = (i - 1 + n) % n) {
    backward.push(ring[i]!);
    if (i === b) break;
  }
  return forward.length <= backward.length ? forward : backward;
}

/** Walk a closed ring from the node nearest `from` to the node nearest `to`. */
function ringArc(ring: LatLon[], from: LatLon, to: LatLon): LatLon[] {
  return ringArcByIndex(ring, nearestIndex(ring, from), nearestIndex(ring, to));
}

/**
 * Chain a bus-route relation's member ways into one polyline, best effort.
 * Members come in relation order; stops and platforms are skipped; each way is
 * oriented to continue from the chain's end; roundabouts (closed ways) are
 * entered and left on the shorter arc. Split oneways can still zigzag — the
 * returned `gaps` counts joints further apart than 30 m so the UI can warn.
 */
export function assembleRoutePolyline(
  relation: OverpassRelation,
  ways: ReadonlyMap<number, OverpassGeomWay>,
): { points: LatLon[]; gaps: number } {
  const segs: LatLon[][] = [];
  for (const m of relation.members ?? []) {
    if (m.type !== 'way') continue;
    if (/stop|platform/.test(m.role)) continue;
    const geometry = ways.get(m.ref)?.geometry;
    if (geometry && geometry.length >= 2) segs.push(geometry.map((g) => ({ ...g })));
  }
  if (segs.length === 0) return { points: [], gaps: 0 };

  const points: LatLon[] = [];
  let gaps = 0;
  for (let i = 0; i < segs.length; i++) {
    let seg = segs[i]!;
    const closed = dist(seg[0]!, seg[seg.length - 1]!) < JOIN_M;

    if (points.length === 0) {
      if (closed) {
        let ring = seg.slice(0, -1);
        // No chain yet: leave the ring nearest the next member, entering from
        // the far side — a fair guess at where the route came onto it.
        const next = segs[i + 1];
        if (next) {
          const exit = nearestIndex(ring, next[0]!);
          const enter = (exit + Math.floor(ring.length / 2)) % ring.length;
          ring = ringArcByIndex(ring, enter, exit);
        }
        points.push(...ring);
        continue;
      }
      // Orient the first way so its far end faces the second way.
      const next = segs[i + 1];
      if (next) {
        const endGap = Math.min(dist(seg[seg.length - 1]!, next[0]!), dist(seg[seg.length - 1]!, next[next.length - 1]!));
        const startGap = Math.min(dist(seg[0]!, next[0]!), dist(seg[0]!, next[next.length - 1]!));
        if (startGap < endGap) seg = [...seg].reverse();
      }
      points.push(...seg);
      continue;
    }

    const end = points[points.length - 1]!;
    if (closed) {
      const ring = seg.slice(0, -1);
      const next = segs[i + 1];
      const exitTarget = next
        ? dist(next[0]!, end) <= dist(next[next.length - 1]!, end)
          ? next[0]!
          : next[next.length - 1]!
        : end;
      seg = ringArc(ring, end, exitTarget);
    } else if (dist(end, seg[seg.length - 1]!) < dist(end, seg[0]!)) {
      seg = [...seg].reverse();
    }

    const gap = dist(end, seg[0]!);
    if (gap > GAP_M) gaps++;
    points.push(...(gap < JOIN_M ? seg.slice(1) : seg));
  }
  return { points, gaps };
}
