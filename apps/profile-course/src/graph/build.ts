import { bearingDeg, haversineMeters, turnPositions } from '../shared/geo';
import { SAMPLE_STEP_M } from '../gpx/profile';
import type { OverpassResponse, OverpassWay } from '../net/overpass';
import type { TerrainSampler } from '../net/terrain';
import { cellIdAt } from './cells';
import {
  otherNode,
  SURFACE_GRAVEL,
  SURFACE_PAVED,
  SURFACE_TRAIL,
  SURFACE_UNKNOWN,
  type Graph,
  type GraphEdge,
  type SurfaceClass,
} from './types';

const PAVED_SURFACES = new Set(['asphalt', 'paved', 'concrete', 'paving_stones', 'sett']);
const GRAVEL_SURFACES = new Set(['gravel', 'fine_gravel', 'compacted', 'pebblestone']);
const TRAIL_SURFACES = new Set([
  'dirt',
  'earth',
  'ground',
  'grass',
  'mud',
  'sand',
  'wood',
  'unpaved',
]);
const PAVED_HIGHWAYS = new Set([
  'residential',
  'living_street',
  'tertiary',
  'unclassified',
  'service',
  'cycleway',
  'footway',
  'pedestrian',
]);

export function classifySurface(tags: Record<string, string>): SurfaceClass {
  const surface = tags['surface'];
  if (surface) {
    if (PAVED_SURFACES.has(surface)) return SURFACE_PAVED;
    if (GRAVEL_SURFACES.has(surface)) return SURFACE_GRAVEL;
    if (TRAIL_SURFACES.has(surface)) return SURFACE_TRAIL;
  }
  const highway = tags['highway'];
  if (highway === 'path' && !surface) return SURFACE_TRAIL;
  if (highway && PAVED_HIGHWAYS.has(highway) && !surface) return SURFACE_PAVED;
  if (highway === 'track' && !surface) return SURFACE_GRAVEL;
  return SURFACE_UNKNOWN;
}

const CAR_HIGHWAYS = new Set(['residential', 'unclassified', 'tertiary']);
const SIDEWALK_KEYS = ['sidewalk', 'sidewalk:both', 'sidewalk:left', 'sidewalk:right'];

export function edgePenalty(tags: Record<string, string>): number {
  const highway = tags['highway'];
  if (highway === 'steps') return 1.0;

  let p = 0;
  const tracktype = tags['tracktype'];
  if (tracktype === 'grade4' || tracktype === 'grade5') p += 0.5;
  if (highway === 'tertiary') p += 0.4;

  if (highway && CAR_HIGHWAYS.has(highway)) {
    // One side tagged `no` says nothing about the other, and `separate` means
    // the sidewalk is mapped as its own way — both are still runnable.
    const hasSidewalk = SIDEWALK_KEYS.some((k) => {
      const v = tags[k];
      return v !== undefined && v !== 'no' && v !== 'none';
    });
    if (!hasSidewalk) p += 0.2;
    const maxspeed = Number.parseInt(tags['maxspeed'] ?? '', 10);
    if (maxspeed > 50) p += 0.3;
  }

  if (highway === 'cycleway' || tags['foot'] === 'designated') p -= 0.1;
  if (tags['lit'] === 'yes') p -= 0.05;

  return Math.max(-0.1, p);
}

const CONNECTOR_MAX_M = 16;
const CONNECTOR_PENALTY = 0.15;
const CONNECTOR_TAG = 'profile:connector';
/**
 * Connectors only target street-class ways: "cross the residential street
 * anywhere" is the intent. Unrestricted path-to-path connectors meshed up
 * dense path areas (cemeteries) and measurably hurt course quality.
 */
const CONNECTOR_TARGETS = new Set([
  'residential',
  'living_street',
  'unclassified',
  'tertiary',
  'service',
  'pedestrian',
]);

/**
 * OSM sidewalks and paths often dead-end a few metres from the street they
 * meet (no mapped crossing), which both blocks legitimate "cross the
 * residential street anywhere" routes and gets the stub dead-end pruned.
 * Synthesize a short connector from every dead-end way endpoint to the
 * nearest point of a nearby other way, unless a separator (fence, rail,
 * water) lies between.
 */
function connectCrossings(
  ways: OverpassWay[],
  separators: OverpassWay[],
  nodeCoord: Map<number, { lat: number; lon: number }>,
  usage: Map<number, number>,
): void {
  const cosLat = Math.cos(((nodeCoord.values().next().value?.lat ?? 57) * Math.PI) / 180);
  const CELL = 24;

  // Spatial hash of way segments (and separator segments).
  interface Seg {
    wayIdx: number;
    ax: number;
    ay: number;
    bx: number;
    by: number;
    aId: number;
    bId: number;
  }
  const segHash = new Map<number, Seg[]>();
  const sepSegs = new Map<number, [number, number, number, number][]>();
  const register = (
    hash: Map<number, unknown[]>,
    item: unknown,
    ax: number,
    ay: number,
    bx: number,
    by: number,
  ) => {
    const x0 = Math.min(ax, bx) - CELL;
    const x1 = Math.max(ax, bx) + CELL;
    const y0 = Math.min(ay, by) - CELL;
    const y1 = Math.max(ay, by) + CELL;
    for (let cy = Math.round(y0 / CELL); cy <= Math.round(y1 / CELL); cy++) {
      for (let cx = Math.round(x0 / CELL); cx <= Math.round(x1 / CELL); cx++) {
        const key = cy * 1_000_003 + cx;
        let arr = hash.get(key);
        if (!arr) hash.set(key, (arr = []));
        arr.push(item);
      }
    }
  };

  const xyOf = (id: number): [number, number] | null => {
    const c = nodeCoord.get(id);
    return c ? toXY(c.lat, c.lon, cosLat) : null;
  };

  for (let wi = 0; wi < ways.length; wi++) {
    const nodes = ways[wi]!.nodes;
    for (let j = 1; j < nodes.length; j++) {
      const a = xyOf(nodes[j - 1]!);
      const b = xyOf(nodes[j]!);
      if (!a || !b) continue;
      register(
        segHash as Map<number, unknown[]>,
        {
          wayIdx: wi,
          ax: a[0],
          ay: a[1],
          bx: b[0],
          by: b[1],
          aId: nodes[j - 1]!,
          bId: nodes[j]!,
        },
        a[0],
        a[1],
        b[0],
        b[1],
      );
    }
  }
  for (const sep of separators) {
    for (let j = 1; j < sep.nodes.length; j++) {
      const a = xyOf(sep.nodes[j - 1]!);
      const b = xyOf(sep.nodes[j]!);
      if (!a || !b) continue;
      register(
        sepSegs as unknown as Map<number, unknown[]>,
        [a[0], a[1], b[0], b[1]],
        a[0],
        a[1],
        b[0],
        b[1],
      );
    }
  }

  const blocked = (ax: number, ay: number, bx: number, by: number): boolean => {
    const seen = new Set<[number, number, number, number][]>();
    for (const cy of [Math.round(ay / CELL), Math.round(by / CELL)]) {
      for (const cx of [Math.round(ax / CELL), Math.round(bx / CELL)]) {
        const arr = sepSegs.get(cy * 1_000_003 + cx);
        if (!arr || seen.has(arr)) continue;
        seen.add(arr);
        for (const s of arr) {
          if (segmentsIntersect(ax, ay, bx, by, s[0], s[1], s[2], s[3])) return true;
        }
      }
    }
    return false;
  };

  let synthetic = -1;
  const wayCount = ways.length;
  const wayNodeSets = new Map<number, Set<number>>();
  /**
   * Nodes already inserted into a hashed segment, with their projection t —
   * a second split of the same segment must land in t order, or the way's
   * geometry zigzags. Keyed by Seg identity (one object, however many cells).
   */
  const segSplits = new Map<object, { t: number; id: number }[]>();
  /** Ways whose node lists were copied before splicing: the response is a
   * cache object and may be handed out again for a rebuild. */
  const copiedWays = new Set<number>();
  const nodeSetOf = (wi: number): Set<number> => {
    let s = wayNodeSets.get(wi);
    if (!s) wayNodeSets.set(wi, (s = new Set(ways[wi]!.nodes)));
    return s;
  };
  for (let wi = 0; wi < wayCount; wi++) {
    const way = ways[wi]!;
    const wayNodeSet = nodeSetOf(wi);
    for (const endId of [way.nodes[0]!, way.nodes[way.nodes.length - 1]!]) {
      if ((usage.get(endId) ?? 0) > 1) continue; // already a junction
      const e = xyOf(endId);
      if (!e) continue;

      let best: { seg: Seg; t: number; dist: number } | null = null;
      const cy0 = Math.round(e[1] / CELL);
      const cx0 = Math.round(e[0] / CELL);
      for (let cy = cy0 - 1; cy <= cy0 + 1; cy++) {
        for (let cx = cx0 - 1; cx <= cx0 + 1; cx++) {
          const segs = segHash.get(cy * 1_000_003 + cx) as Seg[] | undefined;
          if (!segs) continue;
          for (const s of segs) {
            if (s.wayIdx === wi) continue;
            if (!CONNECTOR_TARGETS.has(ways[s.wayIdx]!.tags?.['highway'] ?? '')) continue;
            // Skip when the two ways already meet anywhere (the sidewalk
            // typically joins the street at the corner) — such connectors are
            // redundant and flooded the graph with tiny edges.
            let shares = false;
            const targetSet = nodeSetOf(s.wayIdx);
            for (const id of wayNodeSet) {
              if (targetSet.has(id)) {
                shares = true;
                break;
              }
            }
            if (shares) continue;
            const dx = s.bx - s.ax;
            const dy = s.by - s.ay;
            const len2 = dx * dx + dy * dy;
            const t =
              len2 > 0
                ? Math.max(0, Math.min(1, ((e[0] - s.ax) * dx + (e[1] - s.ay) * dy) / len2))
                : 0;
            const px = s.ax + t * dx;
            const py = s.ay + t * dy;
            const dist = Math.hypot(e[0] - px, e[1] - py);
            if (dist < (best?.dist ?? CONNECTOR_MAX_M) && dist > 0.5) {
              best = { seg: s, t, dist };
            }
          }
        }
      }
      if (!best) continue;

      const { seg, t } = best;
      const px = seg.ax + t * (seg.bx - seg.ax);
      const py = seg.ay + t * (seg.by - seg.ay);
      if (blocked(e[0], e[1], px, py)) continue;

      let targetId: number;
      // Prefer snapping to an existing vertex over splitting the way: splits
      // multiply tiny edges, which measurably starves the beam.
      if (t < 0.3) targetId = seg.aId;
      else if (t > 0.7) targetId = seg.bId;
      else {
        // Split the target way: insert a new node at the projection point.
        if (!copiedWays.has(seg.wayIdx)) {
          const original = ways[seg.wayIdx]!;
          ways[seg.wayIdx] = { ...original, nodes: [...original.nodes] };
          copiedWays.add(seg.wayIdx);
        }
        const targetWay = ways[seg.wayIdx]!;
        const splits = segSplits.get(seg) ?? [];
        const base = targetWay.nodes.indexOf(seg.aId);
        // After k splits, bId sits k+1 past aId; anything else means the way
        // visits these nodes in some order this bookkeeping cannot follow.
        if (base < 0 || targetWay.nodes[base + 1 + splits.length] !== seg.bId) continue;
        targetId = synthetic--;
        const aC = nodeCoord.get(seg.aId)!;
        const bC = nodeCoord.get(seg.bId)!;
        nodeCoord.set(targetId, {
          lat: aC.lat + t * (bC.lat - aC.lat),
          lon: aC.lon + t * (bC.lon - aC.lon),
        });
        const insertAt = base + 1 + splits.filter((s) => s.t < t).length;
        targetWay.nodes.splice(insertAt, 0, targetId);
        splits.push({ t, id: targetId });
        segSplits.set(seg, splits);
        usage.set(targetId, 1);
      }

      ways.push({
        type: 'way',
        id: synthetic--,
        nodes: [endId, targetId],
        tags: { highway: 'footway', [CONNECTOR_TAG]: '1' },
      });
      usage.set(endId, (usage.get(endId) ?? 0) + 1);
      usage.set(targetId, (usage.get(targetId) ?? 0) + 1);
    }
  }
}

/** Local metric coordinates (metres) around a reference latitude. */
function toXY(lat: number, lon: number, cosLat: number): [number, number] {
  return [lon * 111320 * cosLat, lat * 111320];
}

function segmentsIntersect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): boolean {
  const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  const d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

export function buildGraph(response: OverpassResponse, opts: { connectors?: boolean } = {}): Graph {
  const nodeCoord = new Map<number, { lat: number; lon: number }>();
  const signalNodes = new Set<number>();
  const ways: OverpassWay[] = [];
  const separators: OverpassWay[] = [];
  for (const el of response.elements) {
    if (el.type === 'node') {
      nodeCoord.set(el.id, { lat: el.lat, lon: el.lon });
      const t = el.tags;
      if (t && (t['highway'] === 'traffic_signals' || t['crossing'] === 'traffic_signals')) {
        signalNodes.add(el.id);
      }
    } else if (el.type === 'way') {
      if (el.tags?.['highway']) ways.push(el);
      else if (el.tags?.['barrier'] || el.tags?.['railway'] || el.tags?.['waterway']) {
        separators.push(el);
      }
    }
  }

  const usage = new Map<number, number>();
  for (const way of ways) {
    for (const id of way.nodes) usage.set(id, (usage.get(id) ?? 0) + 1);
  }

  if (opts.connectors !== false) connectCrossings(ways, separators, nodeCoord, usage);

  const graphNodeIndex = new Map<number, number>();
  const nodeLats: number[] = [];
  const nodeLons: number[] = [];
  function graphNode(osmId: number): number {
    let idx = graphNodeIndex.get(osmId);
    if (idx === undefined) {
      const coord = nodeCoord.get(osmId);
      if (!coord) return -1;
      idx = nodeLats.length;
      graphNodeIndex.set(osmId, idx);
      nodeLats.push(coord.lat);
      nodeLons.push(coord.lon);
    }
    return idx;
  }

  const edges: GraphEdge[] = [];
  for (const way of ways) {
    const tags = way.tags ?? {};
    // Driveways and parking aisles only add noise and in-and-back detours.
    const service = tags['service'];
    if (tags['highway'] === 'service' && (service === 'driveway' || service === 'parking_aisle')) {
      continue;
    }
    const surface = classifySurface(tags);
    const penalty = tags[CONNECTOR_TAG]
      ? Math.max(edgePenalty(tags), CONNECTOR_PENALTY)
      : edgePenalty(tags);
    let segStart = 0;
    for (let i = 1; i < way.nodes.length; i++) {
      const isLast = i === way.nodes.length - 1;
      const isJunction = (usage.get(way.nodes[i]!) ?? 0) >= 2;
      if (!isLast && !isJunction) continue;

      const segIds = way.nodes.slice(segStart, i + 1);
      segStart = i;
      const coords = segIds
        .map((id) => nodeCoord.get(id))
        .filter((c): c is { lat: number; lon: number } => c !== undefined);
      if (coords.length < 2) continue;

      const a = graphNode(segIds[0]!);
      const b = graphNode(segIds[segIds.length - 1]!);
      if (a < 0 || b < 0 || a === b) continue;

      const lats = new Float64Array(coords.length);
      const lons = new Float64Array(coords.length);
      let lengthM = 0;
      for (let j = 0; j < coords.length; j++) {
        lats[j] = coords[j]!.lat;
        lons[j] = coords[j]!.lon;
        if (j > 0) {
          lengthM += haversineMeters(lats[j - 1]!, lons[j - 1]!, lats[j]!, lons[j]!);
        }
      }
      if (lengthM < 1) continue;
      const last = lats.length - 1;
      const bridge = tags['bridge'];
      const tunnel = tags['tunnel'];
      const ele = Number.parseFloat(tags['ele'] ?? '');
      let signals = 0;
      for (const id of segIds) {
        if (signalNodes.has(id)) signals++;
      }
      edges.push({
        signals,
        cellIds: null,
        cellHead: null,
        traced: 1,
        eleTag: Number.isFinite(ele) ? ele : null,
        a,
        b,
        lengthM,
        surface,
        penalty,
        lats,
        lons,
        elev: null,
        levelled: (!!bridge && bridge !== 'no') || (!!tunnel && tunnel !== 'no'),
        turnOffsets: Float64Array.from(turnPositions(lats, lons)),
        headOutA: bearingDeg(lats[0]!, lons[0]!, lats[1]!, lons[1]!),
        headInB: bearingDeg(lats[last - 1]!, lons[last - 1]!, lats[last]!, lons[last]!),
      });
    }
  }

  const nodeCount = nodeLats.length;
  const degree = new Int32Array(nodeCount);
  for (const e of edges) {
    degree[e.a]!++;
    degree[e.b]!++;
  }
  const adjOffset = new Int32Array(nodeCount + 1);
  for (let i = 0; i < nodeCount; i++) adjOffset[i + 1] = adjOffset[i]! + degree[i]!;
  const adjEdge = new Int32Array(edges.length * 2);
  const fill = Int32Array.from(adjOffset.subarray(0, nodeCount));
  for (let ei = 0; ei < edges.length; ei++) {
    const e = edges[ei]!;
    adjEdge[fill[e.a]!++] = ei;
    adjEdge[fill[e.b]!++] = ei;
  }

  return {
    nodeLat: Float64Array.from(nodeLats),
    nodeLon: Float64Array.from(nodeLons),
    edges,
    adjOffset,
    adjEdge,
  };
}

/** Nearest graph node to (lat, lon) within maxDistM, or -1. */
const SNAP_CELL_M = 64;
/** Per-graph node cell hash: map-matching snaps a waypoint every ~80 m, and a
 * full scan per snap made uploads quadratic-ish in course length. */
const snapIndexCache = new WeakMap<Graph, Map<number, number[]>>();

function snapMPerLon(graph: Graph): number {
  return 111320 * Math.cos(((graph.nodeLat[0] ?? 57) * Math.PI) / 180);
}

function snapIndex(graph: Graph): Map<number, number[]> {
  let idx = snapIndexCache.get(graph);
  if (idx) return idx;
  idx = new Map();
  const mPerLon = snapMPerLon(graph);
  for (let i = 0; i < graph.nodeLat.length; i++) {
    const cy = Math.round((graph.nodeLat[i]! * 111320) / SNAP_CELL_M);
    const cx = Math.round((graph.nodeLon[i]! * mPerLon) / SNAP_CELL_M);
    const key = cy * 1_000_003 + cx;
    let bucket = idx.get(key);
    if (!bucket) idx.set(key, (bucket = []));
    bucket.push(i);
  }
  snapIndexCache.set(graph, idx);
  return idx;
}

export function snapToNode(graph: Graph, lat: number, lon: number, maxDistM = 100): number {
  if (graph.nodeLat.length === 0) return -1;
  const idx = snapIndex(graph);
  const mPerLon = snapMPerLon(graph);
  const cy0 = Math.round((lat * 111320) / SNAP_CELL_M);
  const cx0 = Math.round((lon * mPerLon) / SNAP_CELL_M);
  // +1 covers the cell rounding: any node within maxDistM lies in this ring.
  const r = Math.ceil(maxDistM / SNAP_CELL_M) + 1;
  let best = -1;
  let bestDist = maxDistM;
  for (let cy = cy0 - r; cy <= cy0 + r; cy++) {
    for (let cx = cx0 - r; cx <= cx0 + r; cx++) {
      const bucket = idx.get(cy * 1_000_003 + cx);
      if (!bucket) continue;
      for (const i of bucket) {
        const d = haversineMeters(lat, lon, graph.nodeLat[i]!, graph.nodeLon[i]!);
        if (d <= bestDist) {
          bestDist = d;
          best = i;
        }
      }
    }
  }
  return best;
}

/**
 * Remove dead-end subtrees (cul-de-sacs, driveways) so courses never need an
 * in-and-back-out detour. The start node is kept even if it is a leaf.
 */
export function pruneDeadEnds(graph: Graph, keepNode: number): { graph: Graph; keepNode: number } {
  const n = graph.nodeLat.length;
  const alive = new Uint8Array(graph.edges.length).fill(1);
  const degree = new Int32Array(n);
  for (const e of graph.edges) {
    degree[e.a]!++;
    degree[e.b]!++;
  }

  const queue: number[] = [];
  for (let i = 0; i < n; i++) {
    if (degree[i] === 1 && i !== keepNode) queue.push(i);
  }
  while (queue.length > 0) {
    const node = queue.pop()!;
    if (degree[node] !== 1 || node === keepNode) continue;
    for (let k = graph.adjOffset[node]!; k < graph.adjOffset[node + 1]!; k++) {
      const ei = graph.adjEdge[k]!;
      if (!alive[ei]) continue;
      alive[ei] = 0;
      const e = graph.edges[ei]!;
      const next = e.a === node ? e.b : e.a;
      degree[node]!--;
      degree[next]!--;
      if (degree[next] === 1 && next !== keepNode) queue.push(next);
    }
  }

  const keptEdges = graph.edges.filter((_, ei) => alive[ei] === 1);
  const used = new Uint8Array(n);
  used[keepNode] = 1;
  for (const e of keptEdges) {
    used[e.a] = 1;
    used[e.b] = 1;
  }
  const remap = new Int32Array(n).fill(-1);
  const nodeLats: number[] = [];
  const nodeLons: number[] = [];
  for (let i = 0; i < n; i++) {
    if (used[i]) {
      remap[i] = nodeLats.length;
      nodeLats.push(graph.nodeLat[i]!);
      nodeLons.push(graph.nodeLon[i]!);
    }
  }
  const edges = keptEdges.map((e) => ({ ...e, a: remap[e.a]!, b: remap[e.b]! }));
  return {
    graph: buildAdjacency(Float64Array.from(nodeLats), Float64Array.from(nodeLons), edges),
    keepNode: remap[keepNode]!,
  };
}

/** Keep only nodes/edges reachable from startNode; returns the new graph and start index. */
export function filterToComponent(
  graph: Graph,
  startNode: number,
): { graph: Graph; startNode: number } {
  const n = graph.nodeLat.length;
  const visited = new Uint8Array(n);
  const stack = [startNode];
  visited[startNode] = 1;
  while (stack.length > 0) {
    const node = stack.pop()!;
    for (let k = graph.adjOffset[node]!; k < graph.adjOffset[node + 1]!; k++) {
      const e = graph.edges[graph.adjEdge[k]!]!;
      const next = e.a === node ? e.b : e.a;
      if (!visited[next]) {
        visited[next] = 1;
        stack.push(next);
      }
    }
  }

  const remap = new Int32Array(n).fill(-1);
  const nodeLats: number[] = [];
  const nodeLons: number[] = [];
  for (let i = 0; i < n; i++) {
    if (visited[i]) {
      remap[i] = nodeLats.length;
      nodeLats.push(graph.nodeLat[i]!);
      nodeLons.push(graph.nodeLon[i]!);
    }
  }
  const edges = graph.edges
    .filter((e) => visited[e.a] && visited[e.b])
    .map((e) => ({ ...e, a: remap[e.a]!, b: remap[e.b]! }));

  const sub = buildAdjacency(Float64Array.from(nodeLats), Float64Array.from(nodeLons), edges);
  return { graph: sub, startNode: remap[startNode]! };
}

function buildAdjacency(nodeLat: Float64Array, nodeLon: Float64Array, edges: GraphEdge[]): Graph {
  const nodeCount = nodeLat.length;
  const degree = new Int32Array(nodeCount);
  for (const e of edges) {
    degree[e.a]!++;
    degree[e.b]!++;
  }
  const adjOffset = new Int32Array(nodeCount + 1);
  for (let i = 0; i < nodeCount; i++) adjOffset[i + 1] = adjOffset[i]! + degree[i]!;
  const adjEdge = new Int32Array(edges.length * 2);
  const fill = Int32Array.from(adjOffset.subarray(0, nodeCount));
  for (let ei = 0; ei < edges.length; ei++) {
    const e = edges[ei]!;
    adjEdge[fill[e.a]!++] = ei;
    adjEdge[fill[e.b]!++] = ei;
  }
  return { nodeLat, nodeLon, edges, adjOffset, adjEdge };
}

/** Positions every SAMPLE_STEP_M along an edge's geometry (both endpoints included). */
export function edgeSamplePositions(edge: GraphEdge): { lats: Float64Array; lons: Float64Array } {
  const count = Math.max(2, Math.floor(edge.lengthM / SAMPLE_STEP_M) + 1);
  const lats = new Float64Array(count);
  const lons = new Float64Array(count);
  const segLen: number[] = [];
  let total = 0;
  for (let j = 1; j < edge.lats.length; j++) {
    const d = haversineMeters(edge.lats[j - 1]!, edge.lons[j - 1]!, edge.lats[j]!, edge.lons[j]!);
    segLen.push(d);
    total += d;
  }
  let seg = 0;
  let segStartDist = 0;
  for (let i = 0; i < count; i++) {
    const d = (i / (count - 1)) * total;
    while (seg < segLen.length - 1 && segStartDist + segLen[seg]! < d) {
      segStartDist += segLen[seg]!;
      seg++;
    }
    const t = segLen[seg]! > 0 ? (d - segStartDist) / segLen[seg]! : 0;
    lats[i] = edge.lats[seg]! + t * (edge.lats[seg + 1]! - edge.lats[seg]!);
    lons[i] = edge.lons[seg]! + t * (edge.lons[seg + 1]! - edge.lons[seg]!);
  }
  return { lats, lons };
}

/** Fraction of an ele-tagged bridge chain that ramps up on each side. */
const CHAIN_RAMP_FRACTION = 0.4;

/**
 * Model each chain of connected ele-tagged bridge edges as a trapezoid:
 * ground elevation at the chain ends, linear ramps over 40 % of the length
 * on each side, and a crest at the ele tag in the middle. A flat plateau at
 * deck height mismatched the real profile of Älvsborgsbron (climb, short
 * crest, descent) so badly that the scorer rejected the real race route.
 */
export function shapeBridgeChains(graph: Graph): void {
  const isDeck = (e: GraphEdge) => e.levelled && e.eleTag !== null && e.elev !== null;
  const assigned = new Set<number>();

  const deckAt = (node: number, exclude: number): number => {
    for (let k = graph.adjOffset[node]!; k < graph.adjOffset[node + 1]!; k++) {
      const ei = graph.adjEdge[k]!;
      if (ei !== exclude && isDeck(graph.edges[ei]!) && !assigned.has(ei)) return ei;
    }
    return -1;
  };

  for (let seed = 0; seed < graph.edges.length; seed++) {
    if (assigned.has(seed) || !isDeck(graph.edges[seed]!)) continue;

    // Walk to one end of the chain, then collect it in order.
    let startEdge = seed;
    let startNode = graph.edges[seed]!.a;
    for (;;) {
      const prev = deckAt(startNode, startEdge);
      if (prev < 0) break;
      startEdge = prev;
      startNode = otherNode(graph.edges[prev]!, startNode);
    }
    const chain: { ei: number; fromNode: number }[] = [];
    let node = startNode;
    let ei = startEdge;
    for (;;) {
      chain.push({ ei, fromNode: node });
      assigned.add(ei);
      node = otherNode(graph.edges[ei]!, node);
      const next = deckAt(node, ei);
      if (next < 0) break;
      ei = next;
    }

    const chainLen = chain.reduce((sum, c) => sum + graph.edges[c.ei]!.lengthM, 0);
    const rampLen = chainLen * CHAIN_RAMP_FRACTION;
    const crest = Math.max(...chain.map((c) => graph.edges[c.ei]!.eleTag!));
    // Ground at the ends comes from the DEM's value there (quay/street level).
    const first = graph.edges[chain[0]!.ei]!;
    const last = graph.edges[chain[chain.length - 1]!.ei]!;
    const groundA = Math.min(
      crest,
      chain[0]!.fromNode === first.a ? first.elev![0]! : first.elev![first.elev!.length - 1]!,
    );
    const endNodeIsA = otherNode(last, chain[chain.length - 1]!.fromNode) === last.a;
    const groundB = Math.min(
      crest,
      endNodeIsA ? last.elev![0]! : last.elev![last.elev!.length - 1]!,
    );

    const profileAt = (d: number): number => {
      if (d < rampLen) return groundA + ((crest - groundA) * d) / rampLen;
      if (d > chainLen - rampLen) return groundB + ((crest - groundB) * (chainLen - d)) / rampLen;
      return crest;
    };

    let offset = 0;
    for (const { ei: edgeIdx, fromNode } of chain) {
      const e = graph.edges[edgeIdx]!;
      const count = e.elev!.length;
      const spacing = e.lengthM / (count - 1);
      const out = new Float32Array(count);
      const forward = fromNode === e.a;
      for (let i = 0; i < count; i++) {
        const dAlong = offset + i * spacing;
        out[forward ? i : count - 1 - i] = profileAt(dAlong);
      }
      e.elev = out;
      offset += e.lengthM;
    }
  }
}

export async function sampleEdgeElevations(graph: Graph, sampler: TerrainSampler): Promise<void> {
  const pending: { edge: GraphEdge; count: number }[] = [];
  let total = 0;
  for (const edge of graph.edges) {
    if (edge.elev) continue;
    const count = Math.max(2, Math.floor(edge.lengthM / SAMPLE_STEP_M) + 1);
    pending.push({ edge, count });
    total += count;
  }
  if (pending.length === 0) return;

  const lats = new Float64Array(total);
  const lons = new Float64Array(total);
  let offset = 0;
  for (const { edge } of pending) {
    const pos = edgeSamplePositions(edge);
    lats.set(pos.lats, offset);
    lons.set(pos.lons, offset);
    offset += pos.lats.length;
  }

  const elev = await sampler.elevations(lats, lons);
  offset = 0;
  for (const { edge, count } of pending) {
    // Corridor cells: ~14 m grid + local heading per sample, for detecting
    // out-and-backs over parallel twin paths that are distinct edges.
    const cellIds = new Int32Array(count);
    const cellHead = new Float32Array(count);
    for (let k = 0; k < count; k++) {
      const la = lats[offset + k]!;
      const lo = lons[offset + k]!;
      cellIds[k] = cellIdAt(la, lo);
      const k2 = Math.min(k + 1, count - 1);
      const k1 = k2 === k ? k - 1 : k;
      cellHead[k] = bearingDeg(
        lats[offset + k1]!,
        lons[offset + k1]!,
        lats[offset + k2]!,
        lons[offset + k2]!,
      );
    }
    edge.cellIds = cellIds;
    edge.cellHead = cellHead;
    const raw = elev.subarray(offset, offset + count);
    if (edge.levelled && edge.eleTag !== null) {
      // Keep the raw DEM for now; shapeBridgeChains replaces it with the
      // trapezoid profile (ground ends, crest at the ele tag) per chain.
      edge.elev = Float32Array.from(raw);
    } else if (edge.levelled && count > 2) {
      // Bridges span valleys and tunnels pass under hills; the DEM would show
      // a spike. Runners stay level: interpolate between the endpoints.
      const first = raw[0]!;
      const last = raw[count - 1]!;
      const out = new Float32Array(count);
      for (let i = 0; i < count; i++) out[i] = first + ((last - first) * i) / (count - 1);
      edge.elev = out;
    } else {
      // Raw, deliberately. The median belongs to GPX, where it removes
      // barometric spikes; the DEM is bilinear over a ~30 m grid and already
      // smooth. Worse, an edge is a street between two junctions — most are
      // 25-50 m, so a 5-wide window spans the whole edge and flattens it to one
      // value, and a shared junction came out at a different height depending
      // on which edge was asked. On the test graph that lost four fifths of the
      // real relief and moved edge ends by 3 m on average, 56 m at worst.
      edge.elev = Float32Array.from(raw);
    }
    offset += count;
  }

  shapeBridgeChains(graph);
}
