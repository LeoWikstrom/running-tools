import type { LatLon } from '../geo';
import type { BBox, BusLineData, BusStop } from './busRoutes';

/**
 * Prebuilt bus/tram lines from a GTFS feed (Trafiklab's GTFS Regional, CC0),
 * baked into a compact JSON by scripts/build-gtfs-lines.mjs and served as a
 * static file beside the app. One entry per route and direction, like the
 * OSM relations the Overpass path returns — but instant, gapless (operator
 * geometry) and with stops always in travel order.
 */

export interface GtfsLine {
  /** Line number as signed, e.g. "16". */
  ref: string;
  name: string;
  to?: string;
  kind: 'bus' | 'tram';
  /** Google encoded polyline, precision 5. */
  polyline: string;
  stops: { name: string; lat: number; lon: number }[];
}

export interface GtfsFeedLines {
  version: 1;
  feed: string;
  /** ISO date the JSON was generated. */
  generated: string;
  bbox: BBox;
  lines: GtfsLine[];
}

/** Encode coordinates as a Google polyline (precision 5). */
export function encodePolyline(points: readonly LatLon[]): string {
  let out = '';
  let prevLat = 0;
  let prevLon = 0;
  const emit = (value: number): void => {
    let v = value < 0 ? ~(value << 1) : value << 1;
    while (v >= 0x20) {
      out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    out += String.fromCharCode(v + 63);
  };
  for (const p of points) {
    const lat = Math.round(p.lat * 1e5);
    const lon = Math.round(p.lon * 1e5);
    emit(lat - prevLat);
    emit(lon - prevLon);
    prevLat = lat;
    prevLon = lon;
  }
  return out;
}

/** Decode a Google polyline (precision 5) back to coordinates. */
export function decodePolyline(encoded: string): LatLon[] {
  const points: LatLon[] = [];
  let lat = 0;
  let lon = 0;
  let i = 0;
  const next = (): number => {
    let result = 0;
    let shift = 0;
    let b;
    do {
      b = encoded.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < encoded.length) {
    lat += next();
    lon += next();
    points.push({ lat: lat / 1e5, lon: lon / 1e5 });
  }
  return points;
}

/**
 * One CSV line → fields, RFC 4180 quoting (quoted fields may hold commas and
 * doubled quotes). GTFS files are plain enough that this is all they need.
 */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      out.push(field);
      field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  out.push(field);
  return out;
}

export interface GtfsRoute {
  routeId: string;
  shortName: string;
  longName: string;
  /** GTFS route_type: 3/700–716 bus, 0/900–906 tram; others are skipped. */
  routeType: number;
}

export interface GtfsTrip {
  routeId: string;
  tripId: string;
  directionId: string;
  shapeId: string;
  headsign: string;
}

export function gtfsKind(routeType: number): 'bus' | 'tram' | null {
  if (routeType === 3 || (routeType >= 700 && routeType <= 716)) return 'bus';
  if (routeType === 0 || (routeType >= 900 && routeType <= 906)) return 'tram';
  return null;
}

export interface GtfsRepresentative {
  route: GtfsRoute;
  kind: 'bus' | 'tram';
  tripId: string;
  shapeId: string;
  headsign: string;
}

/**
 * One representative trip per route and direction: the most common shape of
 * that direction (timetable variants mostly share it), its first trip
 * supplying the stop sequence and headsign.
 */
export function chooseRepresentatives(
  routes: readonly GtfsRoute[],
  trips: readonly GtfsTrip[],
): GtfsRepresentative[] {
  const byRoute = new Map<string, GtfsRoute>();
  for (const r of routes) byRoute.set(r.routeId, r);

  // (routeId, directionId) → shapeId → { count, first trip }
  const groups = new Map<string, Map<string, { count: number; trip: GtfsTrip }>>();
  for (const t of trips) {
    if (!byRoute.has(t.routeId) || t.shapeId === '') continue;
    const g = `${t.routeId}\u0000${t.directionId}`;
    let shapes = groups.get(g);
    if (!shapes) groups.set(g, (shapes = new Map()));
    const entry = shapes.get(t.shapeId);
    if (entry) entry.count++;
    else shapes.set(t.shapeId, { count: 1, trip: t });
  }

  const out: GtfsRepresentative[] = [];
  for (const shapes of groups.values()) {
    let best: { count: number; trip: GtfsTrip } | null = null;
    for (const entry of shapes.values()) {
      if (!best || entry.count > best.count) best = entry;
    }
    if (!best) continue;
    const route = byRoute.get(best.trip.routeId)!;
    const kind = gtfsKind(route.routeType);
    if (!kind) continue;
    out.push({
      route,
      kind,
      tripId: best.trip.tripId,
      shapeId: best.trip.shapeId,
      headsign: best.trip.headsign,
    });
  }
  return out;
}

/** Assemble the chosen trips into feed lines; reps without a usable shape or
    stops are dropped rather than shipped broken. */
export function assembleGtfsLines(
  feed: string,
  reps: readonly GtfsRepresentative[],
  stopIdsByTrip: ReadonlyMap<string, string[]>,
  stops: ReadonlyMap<string, { name: string; lat: number; lon: number }>,
  shapes: ReadonlyMap<string, LatLon[]>,
): GtfsFeedLines {
  const lines: GtfsLine[] = [];
  const bbox: BBox = { south: 90, west: 180, north: -90, east: -180 };
  for (const rep of reps) {
    const points = shapes.get(rep.shapeId);
    if (!points || points.length < 2) continue;
    const lineStops = (stopIdsByTrip.get(rep.tripId) ?? [])
      .map((id) => stops.get(id))
      .filter((s): s is { name: string; lat: number; lon: number } => s !== undefined);
    if (lineStops.length < 2) continue;
    for (const p of points) {
      if (p.lat < bbox.south) bbox.south = p.lat;
      if (p.lat > bbox.north) bbox.north = p.lat;
      if (p.lon < bbox.west) bbox.west = p.lon;
      if (p.lon > bbox.east) bbox.east = p.lon;
    }
    const kindName = rep.kind === 'tram' ? 'Tram' : 'Bus';
    lines.push({
      ref: rep.route.shortName,
      name: rep.route.longName || `${kindName} ${rep.route.shortName}`,
      // Västtrafik ships empty trip_headsigns; the last stop is the headsign.
      to: rep.headsign || lineStops[lineStops.length - 1]!.name,
      kind: rep.kind,
      polyline: encodePolyline(points),
      stops: lineStops,
    });
  }
  lines.sort((a, b) => {
    const na = Number(a.ref);
    const nb = Number(b.ref);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return a.ref.localeCompare(b.ref) || (a.to ?? '').localeCompare(b.to ?? '');
  });
  return { version: 1, feed, generated: new Date().toISOString(), bbox, lines };
}

/**
 * A feed line in the shape the picker already speaks. Ids are synthetic and
 * negative so they can never collide with OSM relation ids in a mixed pool.
 */
export function gtfsLineToBusLineData(line: GtfsLine, index: number): BusLineData {
  const stops: BusStop[] = line.stops.map((s, i) => ({
    id: -(index * 1_000 + i + 1),
    name: s.name,
    lat: s.lat,
    lon: s.lon,
  }));
  return {
    id: -(index + 1),
    ref: line.ref,
    name: line.name,
    to: line.to,
    kind: line.kind,
    points: decodePolyline(line.polyline),
    gaps: 0,
    stops,
  };
}
