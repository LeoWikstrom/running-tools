import { haversineMeters } from '../shared/geo';
import type { CoursePath } from '../search/score';
import { dijkstra, reconstructPath } from './dijkstra';
import { snapToNode } from './build';
import type { Graph } from './types';

export interface MatchResult {
  path: CoursePath;
  /** Fraction of waypoints that could be snapped to the graph. */
  snappedFraction: number;
}

const WAYPOINT_SPACING_M = 80;
const SNAP_RADIUS_M = 40;
const JOIN_MAX_FACTOR = 3;

/**
 * Map-match a GPS track onto the graph: snap waypoints every ~80 m and join
 * consecutive snaps with shortest paths. Throws with a km position when the
 * track cannot be followed (outside the graph, or a gap too wide to bridge).
 */
export function matchTrackToGraph(
  graph: Graph,
  lats: ArrayLike<number>,
  lons: ArrayLike<number>,
): MatchResult {
  const waypoints: { node: number; atM: number }[] = [];
  let cum = 0;
  let sinceLast = Infinity;
  let snapped = 0;
  let total = 0;
  for (let i = 0; i < lats.length; i++) {
    if (i > 0) {
      const d = haversineMeters(lats[i - 1]!, lons[i - 1]!, lats[i]!, lons[i]!);
      cum += d;
      sinceLast += d;
    }
    if (sinceLast < WAYPOINT_SPACING_M) continue;
    sinceLast = 0;
    total++;
    const node = snapToNode(graph, lats[i]!, lons[i]!, SNAP_RADIUS_M);
    if (node < 0) continue;
    snapped++;
    if (waypoints.length === 0 || waypoints[waypoints.length - 1]!.node !== node) {
      waypoints.push({ node, atM: cum });
    }
  }
  if (waypoints.length < 2) {
    throw new Error('Could not match the course to the path network (too far from any path)');
  }

  const path: CoursePath = { edges: [], dirs: [] };
  let i = 0;
  while (i < waypoints.length - 1) {
    const from = waypoints[i]!;
    // When a join fails (a short unmapped stretch in the user's track), skip
    // ahead a few waypoints and try to bridge over it before giving up.
    let seg = null;
    let j = i + 1;
    for (; j < Math.min(i + 6, waypoints.length); j++) {
      const to = waypoints[j]!;
      const crow = to.atM - from.atM;
      const res = dijkstra(graph, [from.node], {
        target: to.node,
        maxDist: Math.max(300, crow * JOIN_MAX_FACTOR),
      });
      seg = reconstructPath(graph, res, from.node, to.node);
      if (seg) break;
    }
    if (!seg) {
      throw new Error(
        `Could not follow the course near km ${(from.atM / 1000).toFixed(1)} — ` +
          `is it inside the loaded area?`,
      );
    }
    path.edges.push(...seg.edges);
    path.dirs.push(...seg.dirs);
    i = j;
  }
  return { path, snappedFraction: total > 0 ? snapped / total : 0 };
}
