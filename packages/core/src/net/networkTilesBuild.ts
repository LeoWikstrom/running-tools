import {
  isForbiddenZoneTags,
  RUNNABLE_HIGHWAYS,
  type OverpassNode,
  type OverpassRelation,
  type OverpassWay,
} from './overpass';
import { TILE_LAT_STEP, TILE_LON_STEP } from './networkTiles';

/**
 * Build-side half of the network tiles (scripts/build-network-tiles.ts runs
 * it in CI): parse osmium's OPL lines and replicate buildQuery's clause
 * logic exactly, so a baked tile holds what Overpass would have answered.
 * Pure functions, kept in core for the tests' sake.
 */

/** OPL escapes special characters as %<codepoint-hex>%. */
export function decodeOpl(s: string): string {
  return s.replace(/%([0-9a-fA-F]+)%/g, (_, hex: string) =>
    String.fromCodePoint(parseInt(hex, 16)),
  );
}

function parseTags(field: string): Record<string, string> {
  const tags: Record<string, string> = {};
  if (field === '') return tags;
  for (const pair of field.split(',')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    tags[decodeOpl(pair.slice(0, eq))] = decodeOpl(pair.slice(eq + 1));
  }
  return tags;
}

export type OplElement =
  | { type: 'node'; id: number; lat: number; lon: number; tags?: Record<string, string> }
  | { type: 'way'; id: number; nodes: number[]; tags: Record<string, string> }
  | {
      type: 'relation';
      id: number;
      members: { type: string; ref: number; role: string }[];
      tags: Record<string, string>;
    };

/** One OPL line → element; null for malformed or non-object lines. */
export function parseOplLine(line: string): OplElement | null {
  const kind = line[0];
  if (kind !== 'n' && kind !== 'w' && kind !== 'r') return null;
  const fields = line.split(' ');
  const id = Number(fields[0]!.slice(1));
  if (!Number.isFinite(id)) return null;
  let tags: Record<string, string> = {};
  let lat = NaN;
  let lon = NaN;
  let nodes: number[] = [];
  let members: { type: string; ref: number; role: string }[] = [];
  for (let i = 1; i < fields.length; i++) {
    const f = fields[i]!;
    const prefix = f[0];
    if (prefix === 'T') tags = parseTags(f.slice(1));
    else if (prefix === 'x') lon = Number(f.slice(1));
    else if (prefix === 'y') lat = Number(f.slice(1));
    else if (prefix === 'N') {
      nodes = f
        .slice(1)
        .split(',')
        .map((r) => Number(r.slice(1)))
        .filter((n) => Number.isFinite(n));
    } else if (prefix === 'M' && f.length > 1) {
      members = f
        .slice(1)
        .split(',')
        .map((m) => {
          const at = m.indexOf('@');
          const typeChar = m[0]!;
          const ref = Number(m.slice(1, at < 0 ? undefined : at));
          const type = typeChar === 'w' ? 'way' : typeChar === 'n' ? 'node' : 'relation';
          return { type, ref, role: at < 0 ? '' : decodeOpl(m.slice(at + 1)) };
        })
        .filter((m) => Number.isFinite(m.ref));
    }
  }
  if (kind === 'n') {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const node: OplElement = { type: 'node', id, lat, lon };
    if (Object.keys(tags).length > 0) node.tags = tags;
    return node;
  }
  if (kind === 'r') {
    if (members.length === 0) return null;
    return { type: 'relation', id, members, tags };
  }
  if (nodes.length < 2) return null;
  return { type: 'way', id, nodes, tags };
}

const RUNNABLE_RE = new RegExp(`^(${RUNNABLE_HIGHWAYS})$`);
const RAILWAY_RE = /^(rail|tram|light_rail)$/;
const WATERWAY_RE = /^(river|stream|canal|ditch)$/;
const ACCESS_RE = /private|no/;

/** The four buildQuery clauses, OR'd exactly as Overpass unions them: a
    runnable highway must pass the access/foot filters, but a barrier, rail
    or water way is kept regardless (they are separators, never edges). */
export function keepWay(tags: Record<string, string>): boolean {
  if (
    tags.highway !== undefined &&
    RUNNABLE_RE.test(tags.highway) &&
    !(tags.access !== undefined && ACCESS_RE.test(tags.access)) &&
    tags.foot !== 'no'
  ) {
    return true;
  }
  if (tags.barrier !== undefined) return true;
  if (tags.railway !== undefined && RAILWAY_RE.test(tags.railway)) return true;
  if (tags.waterway !== undefined && WATERWAY_RE.test(tags.waterway)) return true;
  if (isForbiddenZoneTags(tags)) return true;
  return false;
}

export function toOverpassRelation(
  el: Extract<OplElement, { type: 'relation' }>,
): OverpassRelation {
  return { type: 'relation', id: el.id, members: el.members, tags: el.tags };
}

/** Every tile any of the points falls in — a boundary ring is duplicated
    into both tiles whole, and the client dedupes by id. */
export function coordTiles(points: readonly { lat: number; lon: number }[]): Set<string> {
  const out = new Set<string>();
  for (const p of points) {
    out.add(`${Math.floor(p.lon / TILE_LON_STEP)}_${Math.floor(p.lat / TILE_LAT_STEP)}`);
  }
  return out;
}

/** Every tile any of the way's nodes falls in — a boundary way is duplicated
    into both tiles whole, and the client's merge dedupes it. */
export function wayTiles(
  nodeIds: readonly number[],
  nodePos: (id: number) => { lat: number; lon: number } | undefined,
): Set<string> {
  const out = new Set<string>();
  for (const id of nodeIds) {
    const p = nodePos(id);
    if (!p) continue;
    out.add(`${Math.floor(p.lon / TILE_LON_STEP)}_${Math.floor(p.lat / TILE_LAT_STEP)}`);
  }
  return out;
}

export function toOverpassWay(el: Extract<OplElement, { type: 'way' }>): OverpassWay {
  return { type: 'way', id: el.id, nodes: el.nodes, tags: el.tags };
}

export function toOverpassNode(el: Extract<OplElement, { type: 'node' }>): OverpassNode {
  const node: OverpassNode = { type: 'node', id: el.id, lat: el.lat, lon: el.lon };
  if (el.tags) node.tags = el.tags;
  return node;
}
