import { otherNode, type Graph } from './types';

class MinHeap {
  private nodes: number[] = [];
  private dists: number[] = [];

  get size(): number {
    return this.nodes.length;
  }

  push(node: number, dist: number): void {
    this.nodes.push(node);
    this.dists.push(dist);
    let i = this.nodes.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.dists[p]! <= this.dists[i]!) break;
      this.swap(i, p);
      i = p;
    }
  }

  pop(): { node: number; dist: number } {
    const node = this.nodes[0]!;
    const dist = this.dists[0]!;
    const lastN = this.nodes.pop()!;
    const lastD = this.dists.pop()!;
    if (this.nodes.length > 0) {
      this.nodes[0] = lastN;
      this.dists[0] = lastD;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let smallest = i;
        if (l < this.dists.length && this.dists[l]! < this.dists[smallest]!) smallest = l;
        if (r < this.dists.length && this.dists[r]! < this.dists[smallest]!) smallest = r;
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return { node, dist };
  }

  private swap(i: number, j: number): void {
    [this.nodes[i], this.nodes[j]] = [this.nodes[j]!, this.nodes[i]!];
    [this.dists[i], this.dists[j]] = [this.dists[j]!, this.dists[i]!];
  }
}

export interface DijkstraOptions {
  /** Stop once this node's distance is final. */
  target?: number;
  /** Ignore paths longer than this. */
  maxDist?: number;
  /** Edge indices to treat as removed. */
  excludedEdges?: Set<number>;
  /** Node indices to treat as removed (sources/target are never excluded). */
  excludedNodes?: Set<number>;
}

export interface DijkstraResult {
  dist: Float64Array;
  /** Edge index used to reach each node, -1 for sources/unreached. */
  viaEdge: Int32Array;
}

/** Multi-source Dijkstra over edge lengths. */
export function dijkstra(
  graph: Graph,
  sources: number[],
  options: DijkstraOptions = {},
): DijkstraResult {
  const n = graph.nodeLat.length;
  const dist = new Float64Array(n).fill(Infinity);
  const viaEdge = new Int32Array(n).fill(-1);
  const heap = new MinHeap();
  for (const s of sources) {
    dist[s] = 0;
    heap.push(s, 0);
  }
  const maxDist = options.maxDist ?? Infinity;

  while (heap.size > 0) {
    const { node, dist: d } = heap.pop();
    if (d > dist[node]!) continue;
    if (options.target !== undefined && node === options.target) break;
    for (let k = graph.adjOffset[node]!; k < graph.adjOffset[node + 1]!; k++) {
      const ei = graph.adjEdge[k]!;
      if (options.excludedEdges?.has(ei)) continue;
      const e = graph.edges[ei]!;
      const next = otherNode(e, node);
      if (options.excludedNodes?.has(next) && next !== options.target) continue;
      const nd = d + e.lengthM;
      if (nd < dist[next]! && nd <= maxDist) {
        dist[next] = nd;
        viaEdge[next] = ei;
        heap.push(next, nd);
      }
    }
  }
  return { dist, viaEdge };
}

export interface EdgePath {
  edges: number[];
  dirs: number[];
  lengthM: number;
}

/** Reconstruct the from→to edge path out of a Dijkstra run rooted at `from`. */
export function reconstructPath(
  graph: Graph,
  result: DijkstraResult,
  from: number,
  to: number,
): EdgePath | null {
  if (!Number.isFinite(result.dist[to]!)) return null;
  const edges: number[] = [];
  const dirs: number[] = [];
  let node = to;
  while (node !== from) {
    const ei = result.viaEdge[node]!;
    if (ei < 0) return null;
    const e = graph.edges[ei]!;
    const prev = otherNode(e, node);
    edges.push(ei);
    dirs.push(e.a === prev ? 1 : 0);
    node = prev;
  }
  edges.reverse();
  dirs.reverse();
  return { edges, dirs, lengthM: result.dist[to]! };
}
