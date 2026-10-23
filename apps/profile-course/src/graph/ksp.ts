import { dijkstra, reconstructPath, type EdgePath } from './dijkstra';
import { otherNode, type Graph } from './types';

export function pathNodes(
  graph: Graph,
  path: { edges: number[]; dirs: number[] },
  startNode: number,
): number[] {
  const nodes = [startNode];
  let node = startNode;
  for (let i = 0; i < path.edges.length; i++) {
    node = otherNode(graph.edges[path.edges[i]!]!, node);
    nodes.push(node);
  }
  return nodes;
}

function samePath(a: EdgePath, b: EdgePath): boolean {
  if (a.edges.length !== b.edges.length) return false;
  for (let i = 0; i < a.edges.length; i++) if (a.edges[i] !== b.edges[i]) return false;
  return true;
}

/** Yen's algorithm; paths longer than maxDist are not considered. */
export function kShortestPaths(
  graph: Graph,
  from: number,
  to: number,
  k: number,
  maxDist: number,
): EdgePath[] {
  const first = reconstructPath(graph, dijkstra(graph, [from], { target: to, maxDist }), from, to);
  if (!first) return [];
  const found: EdgePath[] = [first];
  const candidates: EdgePath[] = [];

  while (found.length < k) {
    const prev = found[found.length - 1]!;
    const prevNodes = pathNodes(graph, prev, from);

    for (let spur = 0; spur < prev.edges.length; spur++) {
      const spurNode = prevNodes[spur]!;
      const excludedEdges = new Set<number>();
      for (const p of found) {
        let matches = true;
        for (let i = 0; i < spur && matches; i++) {
          if (p.edges[i] !== prev.edges[i]) matches = false;
        }
        if (matches && p.edges.length > spur) excludedEdges.add(p.edges[spur]!);
      }
      const excludedNodes = new Set<number>(prevNodes.slice(0, spur));

      const spurPath = reconstructPath(
        graph,
        dijkstra(graph, [spurNode], { target: to, maxDist, excludedEdges, excludedNodes }),
        spurNode,
        to,
      );
      if (!spurPath) continue;

      let rootLen = 0;
      for (let i = 0; i < spur; i++) rootLen += graph.edges[prev.edges[i]!]!.lengthM;
      const total: EdgePath = {
        edges: [...prev.edges.slice(0, spur), ...spurPath.edges],
        dirs: [...prev.dirs.slice(0, spur), ...spurPath.dirs],
        lengthM: rootLen + spurPath.lengthM,
      };
      if (total.lengthM > maxDist) continue;
      if (!found.some((p) => samePath(p, total)) && !candidates.some((p) => samePath(p, total))) {
        candidates.push(total);
      }
    }

    if (candidates.length === 0) break;
    candidates.sort((a, b) => a.lengthM - b.lengthM);
    found.push(candidates.shift()!);
  }
  return found;
}
