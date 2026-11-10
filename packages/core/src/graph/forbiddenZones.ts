import {
  isForbiddenZoneTags,
  type OverpassElement,
  type OverpassRelation,
  type OverpassWay,
} from '../net/overpass';

/**
 * Closed areas the course must not enter (landuse=military): the area
 * polygon carries the restriction while the service roads inside it are
 * usually untagged, so they pass the access/foot way filters and the only
 * defence is geometric.
 */
export interface ForbiddenRing {
  lats: number[];
  lons: number[];
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

function ringFromCoords(lats: number[], lons: number[]): ForbiddenRing | null {
  if (lats.length < 3) return null;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (let i = 0; i < lats.length; i++) {
    if (lats[i]! < minLat) minLat = lats[i]!;
    if (lats[i]! > maxLat) maxLat = lats[i]!;
    if (lons[i]! < minLon) minLon = lons[i]!;
    if (lons[i]! > maxLon) maxLon = lons[i]!;
  }
  return { lats, lons, minLat, maxLat, minLon, maxLon };
}

/**
 * Join way segments into rings by matching endpoint node ids, reversing
 * segments as needed. A chain that cannot be closed (members clipped away)
 * still counts as a ring — closing it across the gap forbids roughly the
 * right area, and too much is safer than too little here.
 */
function assembleRings(
  memberWays: OverpassWay[],
  nodePos: (id: number) => { lat: number; lon: number } | undefined,
): ForbiddenRing[] {
  const segments = memberWays
    .map((w) => w.nodes)
    .filter((n) => n.length >= 2)
    .map((n) => [...n]);
  const rings: ForbiddenRing[] = [];
  while (segments.length > 0) {
    const chain = segments.pop()!;
    let grew = true;
    while (chain[0] !== chain[chain.length - 1] && grew) {
      grew = false;
      const tail = chain[chain.length - 1]!;
      for (let i = 0; i < segments.length; i++) {
        const s = segments[i]!;
        if (s[0] === tail) chain.push(...s.slice(1));
        else if (s[s.length - 1] === tail) chain.push(...[...s].reverse().slice(1));
        else continue;
        segments.splice(i, 1);
        grew = true;
        break;
      }
    }
    const lats: number[] = [];
    const lons: number[] = [];
    for (const id of chain) {
      const p = nodePos(id);
      if (!p) continue;
      lats.push(p.lat);
      lons.push(p.lon);
    }
    const ring = ringFromCoords(lats, lons);
    if (ring) rings.push(ring);
  }
  return rings;
}

/** Every forbidden ring in the response: closed military ways and the outer
    rings of military multipolygon relations. Inner rings (enclaves) are
    deliberately ignored — a hole in a military area is still no place to
    route a run through. */
export function collectForbiddenZones(elements: readonly OverpassElement[]): ForbiddenRing[] {
  const wayById = new Map<number, OverpassWay>();
  const relations: OverpassRelation[] = [];
  const zoneWays: OverpassWay[] = [];
  const nodeCoord = new Map<number, { lat: number; lon: number }>();
  for (const el of elements) {
    if (el.type === 'node') nodeCoord.set(el.id, { lat: el.lat, lon: el.lon });
    else if (el.type === 'way') {
      wayById.set(el.id, el);
      if (isForbiddenZoneTags(el.tags)) zoneWays.push(el);
    } else if (isForbiddenZoneTags(el.tags)) relations.push(el);
  }
  const nodePos = (id: number): { lat: number; lon: number } | undefined => nodeCoord.get(id);

  const rings = assembleRings(zoneWays, nodePos);
  for (const rel of relations) {
    const members: OverpassWay[] = [];
    for (const m of rel.members) {
      if (m.type !== 'way' || m.role === 'inner') continue;
      const w = wayById.get(m.ref);
      if (w) members.push(w);
    }
    rings.push(...assembleRings(members, nodePos));
  }
  return rings;
}

/** Ray cast with a bounding-box precheck; boundary points count as outside. */
export function pointInForbiddenZone(
  rings: readonly ForbiddenRing[],
  lat: number,
  lon: number,
): boolean {
  for (const r of rings) {
    if (lat < r.minLat || lat > r.maxLat || lon < r.minLon || lon > r.maxLon) continue;
    let inside = false;
    const n = r.lats.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const yi = r.lats[i]!;
      const xi = r.lons[i]!;
      const yj = r.lats[j]!;
      const xj = r.lons[j]!;
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    if (inside) return true;
  }
  return false;
}
