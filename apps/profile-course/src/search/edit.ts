import { dijkstra, reconstructPath, type EdgePath } from '../graph/dijkstra';
import { pathNodes } from '../graph/ksp';
import type { Graph } from '../graph/types';
import { haversineMeters } from '../shared/geo';
import type { CoursePath } from './score';

export const DEFAULT_WINDOW_M = 600;

/** Per metre of replaced course, as a share of a metre of length error. */
const SPAN_TIEBREAK = 0.05;

export interface RerouteOptions {
  /** Half-width of the stretch that may be replaced (m). */
  windowM?: number;
  /** Nodes the reroute must leave on the course (via points). */
  keepNodes?: ReadonlySet<number>;
  /** Edges the reroute must leave on the course (via points). */
  keepEdges?: ReadonlySet<number>;
}

/** Root node of a path (start of its first edge). */
export function pathRoot(graph: Graph, path: CoursePath): number {
  const first = graph.edges[path.edges[0]!]!;
  return path.dirs[0] === 1 ? first.a : first.b;
}

function reversed(leg: EdgePath): EdgePath {
  return {
    edges: [...leg.edges].reverse(),
    dirs: [...leg.dirs].reverse().map((d) => (d === 1 ? 0 : 1)),
    lengthM: leg.lengthM,
  };
}

/**
 * Reroute the course around `atM` so it passes through `targetNode`: the
 * stretch between two course nodes is replaced by shortest paths from the
 * first to the target and on to the second. Both of those nodes must lie within
 * `windowM` of `atM` along the course *and* within `windowM` of the drag as the
 * crow flies, so the course outside the window keeps its exact shape and length
 * and a lap that passes back by is left alone; the stretch between them is free
 * to come out longer or shorter, which only shifts the km marks after it. The
 * dragged point no longer has to be reached at the km that was picked. Returns
 * null when no node inside the window can reach the target at all.
 */
export function reroutePath(
  graph: Graph,
  path: CoursePath,
  atM: number,
  targetNode: number,
  options: RerouteOptions = {},
): CoursePath | null {
  const windowM = options.windowM ?? DEFAULT_WINDOW_M;
  const root = pathRoot(graph, path);
  const nodes = pathNodes(graph, path, root);
  const cum: number[] = [0];
  for (const ei of path.edges) cum.push(cum[cum.length - 1]! + graph.edges[ei]!.lengthM);
  const total = cum[cum.length - 1]!;
  const at = Math.max(0, Math.min(atM, total));

  let atIdx = 0;
  for (let i = 1; i < nodes.length; i++) {
    if (Math.abs(cum[i]! - at) < Math.abs(cum[atIdx]! - at)) atIdx = i;
  }

  // Vias outrank edits: shrink the window until it holds no via of its own.
  let lowFrom = 0;
  let highTo = nodes.length - 1;
  for (let i = 0; i < nodes.length; i++) {
    if (!options.keepNodes?.has(nodes[i]!)) continue;
    if (i <= atIdx) lowFrom = Math.max(lowFrom, i);
    if (i >= atIdx) highTo = Math.min(highTo, i);
  }
  for (let i = 0; i < path.edges.length; i++) {
    if (!options.keepEdges?.has(path.edges[i]!)) continue;
    if (i + 1 <= atIdx) lowFrom = Math.max(lowFrom, i + 1);
    if (i >= atIdx) highTo = Math.min(highTo, i);
  }
  if (lowFrom >= highTo) return null;

  const budget = Math.max(1500, windowM * 4);
  const tree = dijkstra(graph, [targetNode], { maxDist: budget });

  // The two nodes the rerouted stretch hangs from, both inside the window.
  let windowLow = lowFrom;
  while (windowLow < atIdx && cum[windowLow]! < at - windowM) windowLow++;
  let windowHigh = highTo;
  while (windowHigh > atIdx && cum[windowHigh]! > at + windowM) windowHigh--;

  // Where the course laps, ground a long way round the course comes back within
  // the window's reach, and replacing the stretch between two such nodes would
  // rewrite a whole lap — nowhere near the point being dragged, however close
  // along the course it is. So the window is a radius as well as a distance:
  // the stretch runs out from the drag until the course first leaves it.
  const nearDrag = (i: number): boolean =>
    haversineMeters(
      graph.nodeLat[nodes[atIdx]!]!,
      graph.nodeLon[nodes[atIdx]!]!,
      graph.nodeLat[nodes[i]!]!,
      graph.nodeLon[nodes[i]!]!,
    ) <= windowM;
  // The nodes either side go in regardless: on a sparse network one edge can be
  // longer than the whole radius, and there has to be a stretch to replace.
  let low = Math.max(windowLow, atIdx - 1);
  while (low > windowLow && nearDrag(low - 1)) low--;
  windowLow = low;
  let high = Math.min(windowHigh, atIdx + 1);
  while (high < windowHigh && nearDrag(high + 1)) high++;
  windowHigh = high;

  let fromIdx = -1;
  let toIdx = -1;
  let bestErr = Infinity;
  for (let i = Math.min(atIdx, highTo - 1); i >= windowLow; i--) {
    const out = tree.dist[nodes[i]!]!;
    if (!Number.isFinite(out)) continue;
    for (let j = Math.max(atIdx, i + 1); j <= windowHigh; j++) {
      const back = tree.dist[nodes[j]!]!;
      if (!Number.isFinite(back)) continue;
      const span = cum[j]! - cum[i]!;
      // A detour costing about what the stretch it replaces cost, so the
      // course bulges out to the point; a pair any tighter than the two legs
      // makes it spike out and straight back instead. Ties to the shorter
      // stretch, so an edit rewrites as little of the course as it can.
      const err = Math.abs(out + back - span) + SPAN_TIEBREAK * span;
      if (err < bestErr) {
        bestErr = err;
        fromIdx = i;
        toIdx = j;
      }
    }
  }
  if (fromIdx < 0 || toIdx < 0) return null;

  const back = reconstructPath(graph, tree, targetNode, nodes[fromIdx]!);
  const leg2 = reconstructPath(graph, tree, targetNode, nodes[toIdx]!);
  if (!back || !leg2) return null;
  const leg1 = reversed(back);

  return {
    edges: [
      ...path.edges.slice(0, fromIdx),
      ...leg1.edges,
      ...leg2.edges,
      ...path.edges.slice(toIdx),
    ],
    dirs: [...path.dirs.slice(0, fromIdx), ...leg1.dirs, ...leg2.dirs, ...path.dirs.slice(toIdx)],
  };
}

/**
 * Node editing treats the course nodes as waypoints: an edit replaces the legs
 * around one of them with the shortest route, leaving the rest of the course
 * exactly as it was. Scores play no part — the user is in charge.
 */
export type NodeEditOptions = Pick<RerouteOptions, 'keepNodes' | 'keepEdges'>;

/** Long enough to reach around the edited node, short enough to stay local. */
const legBudget = (spanM: number) => Math.max(3000, spanM * 8);

function cumulative(graph: Graph, path: CoursePath): number[] {
  const cum: number[] = [0];
  for (const ei of path.edges) cum.push(cum[cum.length - 1]! + graph.edges[ei]!.lengthM);
  return cum;
}

type Legs = Pick<CoursePath, 'edges' | 'dirs'>;

/** Shortest legs a → via → b as one path, or null if either end is out of reach. */
function legsThrough(
  graph: Graph,
  a: number,
  via: number,
  b: number,
  budget: number,
  avoid?: number,
): Legs | null {
  const tree = dijkstra(graph, [via], {
    maxDist: budget,
    ...(avoid === undefined ? {} : { excludedNodes: new Set([avoid]) }),
  });
  const back = reconstructPath(graph, tree, via, a);
  const out = reconstructPath(graph, tree, via, b);
  if (!back || !out) return null;
  const first = reversed(back);
  return { edges: [...first.edges, ...out.edges], dirs: [...first.dirs, ...out.dirs] };
}

function splice(path: CoursePath, fromIdx: number, toIdx: number, legs: Legs): CoursePath {
  return {
    edges: [...path.edges.slice(0, fromIdx), ...legs.edges, ...path.edges.slice(toIdx)],
    dirs: [...path.dirs.slice(0, fromIdx), ...legs.dirs, ...path.dirs.slice(toIdx)],
  };
}

interface NodeSpot {
  nodes: number[];
  cum: number[];
  /** Index of the interior course node nearest the distance asked for. */
  at: number;
}

function locateNode(graph: Graph, path: CoursePath, atM: number): NodeSpot | null {
  const nodes = pathNodes(graph, path, pathRoot(graph, path));
  if (nodes.length < 4) return null;
  const cum = cumulative(graph, path);
  let at = 0;
  for (let i = 1; i < nodes.length; i++) {
    if (Math.abs(cum[i]! - atM) < Math.abs(cum[at]! - atM)) at = i;
  }
  // The start and finish are set elsewhere; an edit there is not a node edit.
  if (at === 0 || at === nodes.length - 1) return null;
  return { nodes, cum, at };
}

/** A via on the node, or on either leg into it, puts the node off limits. */
function pinned(path: CoursePath, spot: NodeSpot, options: NodeEditOptions): boolean {
  if (options.keepNodes?.has(spot.nodes[spot.at]!)) return true;
  return (
    options.keepEdges?.has(path.edges[spot.at - 1]!) === true ||
    options.keepEdges?.has(path.edges[spot.at]!) === true
  );
}

/**
 * Drop the course node nearest `atM`: its neighbours reconnect by the shortest
 * route that no longer passes through it, so the course visibly stops going
 * there. Returns null when the node carries a via, is an endpoint, or has no
 * way round it at all.
 */
export function deleteNodeFromPath(
  graph: Graph,
  path: CoursePath,
  atM: number,
  options: NodeEditOptions = {},
): CoursePath | null {
  return deleteNodesFromPath(graph, path, [atM], options);
}

/**
 * Drop every course node nearest one of `atMs` at once. Nodes next to each
 * other on the course go as one piece, so the two closest survivors either
 * side reconnect by a single shortest route that avoids all of them — deleting
 * them one at a time would instead route through the next one about to go.
 * Returns null if any of them cannot be dropped.
 */
export function deleteNodesFromPath(
  graph: Graph,
  path: CoursePath,
  atMs: number[],
  options: NodeEditOptions = {},
): CoursePath | null {
  const spots = atMs.map((atM) => locateNode(graph, path, atM));
  if (spots.length === 0) return null;
  const first = spots[0];
  if (!first) return null;
  const { nodes, cum } = first;
  const indices: number[] = [];
  for (const spot of spots) {
    if (!spot || pinned(path, spot, options)) return null;
    if (!indices.includes(spot.at)) indices.push(spot.at);
  }
  indices.sort((a, b) => a - b);

  // Runs of neighbouring nodes, spliced back to front so the earlier runs'
  // indices into the untouched head of the path stay valid.
  const runs: [number, number][] = [];
  for (const at of indices) {
    const last = runs[runs.length - 1];
    if (last && last[1] === at - 1) last[1] = at;
    else runs.push([at, at]);
  }

  // Every marked node is avoided by every run's detour, not just by its own:
  // one run's way round must not lead through a node another run is dropping,
  // or a node the user marked comes back on the course by the side door.
  const avoid = new Set(indices.map((at) => nodes[at]!));

  let out = path;
  for (let r = runs.length - 1; r >= 0; r--) {
    const [lo, hi] = runs[r]!;
    const legs = bypass(graph, nodes, cum, lo, hi, out, lo - 1, hi + 1, avoid);
    if (!legs) return null;
    out = splice(out, lo - 1, hi + 1, legs);
  }
  return out;
}

/** Shortest route from the node before `lo` to the one after `hi`, round them. */
function bypass(
  graph: Graph,
  nodes: number[],
  cum: number[],
  lo: number,
  hi: number,
  path: CoursePath,
  fromIdx: number,
  toIdx: number,
  alsoAvoid?: Set<number>,
): Legs | null {
  const from = nodes[fromIdx]!;
  const to = nodes[toIdx]!;
  // The course went out to the nodes and straight back: both legs go with them.
  if (from === to) {
    if (path.edges.length <= toIdx - fromIdx) return null;
    return { edges: [], dirs: [] };
  }
  const excluded = new Set<number>(alsoAvoid);
  for (let i = lo; i <= hi; i++) excluded.add(nodes[i]!);
  const direct = reconstructPath(
    graph,
    dijkstra(graph, [from], {
      target: to,
      maxDist: legBudget(cum[toIdx]! - cum[fromIdx]!),
      excludedNodes: excluded,
    }),
    from,
    to,
  );
  if (!direct || direct.edges.length === 0) return null;
  return direct;
}

/**
 * Move the course node nearest `atM` onto `targetNode`: its two neighbours
 * reconnect to it by the shortest route and nothing else on the course moves.
 * The route avoids the node's old position where the network allows it.
 */
export function moveNodeInPath(
  graph: Graph,
  path: CoursePath,
  atM: number,
  targetNode: number,
  options: NodeEditOptions = {},
): CoursePath | null {
  const spot = locateNode(graph, path, atM);
  if (!spot || pinned(path, spot, options)) return null;
  const { nodes, cum, at } = spot;
  const budget = legBudget(cum[at + 1]! - cum[at - 1]!);
  const from = nodes[at - 1]!;
  const to = nodes[at + 1]!;
  const legs =
    legsThrough(graph, from, targetNode, to, budget, nodes[at]!) ??
    // Only reachable through where the node was, so the course keeps going there.
    legsThrough(graph, from, targetNode, to, budget);
  if (!legs || legs.edges.length === 0) return null;
  return splice(path, at - 1, at + 1, legs);
}

/**
 * Add `targetNode` as a new course node on the leg covering `atM`, reached by
 * the shortest route from each end of that leg.
 */
export function insertNodeIntoPath(
  graph: Graph,
  path: CoursePath,
  atM: number,
  targetNode: number,
  options: NodeEditOptions = {},
): CoursePath | null {
  const nodes = pathNodes(graph, path, pathRoot(graph, path));
  const cum = cumulative(graph, path);
  // The leg the distance falls on, so the node lands where it was asked for.
  let leg = path.edges.length - 1;
  for (let i = 0; i < path.edges.length; i++) {
    if (atM <= cum[i + 1]!) {
      leg = i;
      break;
    }
  }
  if (options.keepEdges?.has(path.edges[leg]!)) return null;
  const a = nodes[leg]!;
  const b = nodes[leg + 1]!;
  if (targetNode === a || targetNode === b) return null;
  const legs = legsThrough(graph, a, targetNode, b, legBudget(cum[leg + 1]! - cum[leg]!));
  if (!legs || legs.edges.length === 0) return null;
  return splice(path, leg, leg + 1, legs);
}
