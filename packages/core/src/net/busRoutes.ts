import { haversineMeters, projectOnPolyline, type LatLon } from '../geo';

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
  kind: 'bus' | 'tram';
}

export interface BusStop {
  id: number;
  name: string;
  lat: number;
  lon: number;
}

/** One line with everything the picker needs: geometry and ordered stops. */
export interface BusLineData extends BusLine {
  points: LatLon[];
  /** Joints further apart than 30 m while chaining the ways. */
  gaps: number;
  stops: BusStop[];
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

export interface OverpassGeomNode {
  type: 'node';
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
}

export type BusAreaElement = OverpassRelation | OverpassGeomWay | OverpassGeomNode;

export interface BBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

/**
 * Every bus and tram line crossing the box, with full geometry and stops, in
 * one query. Seeded from nearby ways then rel(bw) — the direct
 * relation[...](bbox) form makes Overpass geometry-check every route on the
 * planet and routinely times out at the dispatcher. Tram tracks are railway,
 * not highway, hence the union seed.
 */
export function buildBusAreaQuery(bbox: BBox): string {
  const b = `(${bbox.south.toFixed(5)},${bbox.west.toFixed(5)},${bbox.north.toFixed(5)},${bbox.east.toFixed(5)})`;
  return (
    `[out:json][timeout:90];(` +
    `way[highway]${b};` +
    `way[railway~"^(tram|light_rail)$"]${b};` +
    `);rel(bw)[type=route][route~"^(bus|tram)$"]->.rt;` +
    `.rt out body;way(r.rt);out geom;node(r.rt);out body;`
  );
}

/**
 * A targeted search by line number or name over a widened box. Unlike the
 * area query, the direct relation(bbox) form is fine here: the ref/name tag
 * filters cut the candidate set to a handful before any geometry is checked.
 */
export function buildBusSearchQuery(bbox: BBox, text: string, kind?: 'bus' | 'tram'): string {
  const b = `(${bbox.south.toFixed(5)},${bbox.west.toFixed(5)},${bbox.north.toFixed(5)},${bbox.east.toFixed(5)})`;
  const route = kind ? `^${kind}$` : '^(bus|tram)$';
  // `]` must be escaped too: unescaped it closes the ["ref"="…"] filter early.
  const qlEscape = (s: string): string =>
    s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\]/g, '\\]');
  const quoted = qlEscape(text);
  const regex = qlEscape(text.replace(/[.*+?^${}()|[\]]/g, '\\$&'));
  return (
    `[out:json][timeout:60];(` +
    `relation[type=route][route~"${route}"]["ref"="${quoted}"]${b};` +
    `relation[type=route][route~"${route}"]["name"~"${regex}",i]${b};` +
    `)->.rt;.rt out body;way(r.rt);out geom;node(r.rt);out body;`
  );
}

function relationToBusLine(r: OverpassRelation): BusLine | null {
  const tags = r.tags;
  if (!tags) return null;
  const name = tags.name ?? [tags.ref, tags.to].filter(Boolean).join(' → ');
  if (!name) return null;
  return {
    id: r.id,
    ref: tags.ref ?? '',
    name,
    from: tags.from,
    to: tags.to,
    kind: tags.route === 'tram' ? 'tram' : 'bus',
  };
}

/** The relation's stop nodes in travel order; platforms fill in when a line
    has no stop roles at all. */
function relationStops(
  relation: OverpassRelation,
  nodes: ReadonlyMap<number, OverpassGeomNode>,
): BusStop[] {
  const pick = (test: (role: string) => boolean): BusStop[] => {
    const out: BusStop[] = [];
    for (const m of relation.members ?? []) {
      if (m.type !== 'node' || !test(m.role)) continue;
      const node = nodes.get(m.ref);
      if (!node) continue;
      out.push({
        id: node.id,
        name: node.tags?.name ?? `Stop ${out.length + 1}`,
        lat: node.lat,
        lon: node.lon,
      });
    }
    return out;
  };
  const stops = pick((role) => role.startsWith('stop'));
  return stops.length > 0 ? stops : pick((role) => role.startsWith('platform'));
}

/** Turn one bus-area response into ready-to-preview lines, sorted by ref. */
export function parseBusLines(elements: BusAreaElement[]): BusLineData[] {
  const ways = new Map<number, OverpassGeomWay>();
  const nodes = new Map<number, OverpassGeomNode>();
  const relations: OverpassRelation[] = [];
  for (const el of elements) {
    if (el.type === 'way') ways.set(el.id, el);
    else if (el.type === 'node') nodes.set(el.id, el);
    else if (el.type === 'relation') relations.push(el);
  }
  const out: BusLineData[] = [];
  for (const r of relations) {
    const line = relationToBusLine(r);
    if (!line) continue;
    const { points, gaps } = assembleRoutePolyline(r, ways);
    if (points.length < 2) continue;
    out.push({ ...line, points, gaps, stops: relationStops(r, nodes) });
  }
  out.sort((a, b) => {
    const na = Number(a.ref);
    const nb = Number(b.ref);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return a.ref.localeCompare(b.ref) || a.name.localeCompare(b.name);
  });
  return out;
}

/**
 * The stretch of the line between two stops, endpoints interpolated onto the
 * geometry. Stops project onto their nearest point of the line; the result
 * always runs in the line's travel direction — the bus only goes one way.
 */
export function cropBetweenStops(points: LatLon[], a: BusStop, b: BusStop): LatLon[] {
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  const pa = projectOnPolyline(lats, lons, a.lat, a.lon);
  const pb = projectOnPolyline(lats, lons, b.lat, b.lon);
  if (!pa || !pb) return points;
  const [from, to] = pa.along <= pb.along ? [pa, pb] : [pb, pa];
  const out: LatLon[] = [{ lat: from.lat, lon: from.lon }];
  for (let i = from.segment + 1; i <= to.segment; i++) out.push(points[i]!);
  out.push({ lat: to.lat, lon: to.lon });
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
