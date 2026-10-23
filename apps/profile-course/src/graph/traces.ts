import { cellAndNeighbours } from './cells';
import type { Graph } from './types';

/**
 * Trace points in a cell before it counts as run ground. One stray point is a
 * GPS fix thrown across a block; a path somebody actually ran collects a point
 * every second or two.
 */
export const MIN_CELL_POINTS = 3;

/**
 * Marks how much of each edge public GPS traces have been run along, from the
 * cell counts a download produced.
 *
 * The grid is dilated by one cell (±14 m) first, because a consumer GPS lands
 * beside the path as often as on it; without that a whole street could read as
 * untrodden because the fixes fell in the cells of its verge. Ground no
 * download covered reads as untrodden, which is deliberate: an uncovered edge
 * must not be *cheaper* than a covered one nobody runs, or the search would be
 * pulled straight out of the area that was downloaded.
 */
export function applyTraceCoverage(graph: Graph, counts: Map<number, number>): void {
  if (counts.size === 0) {
    for (const e of graph.edges) e.traced = 1;
    return;
  }
  const run = new Set<number>();
  const around: number[] = [];
  for (const [id, n] of counts) {
    if (n < MIN_CELL_POINTS) continue;
    cellAndNeighbours(id, around);
    for (const c of around) run.add(c);
  }
  for (const e of graph.edges) {
    if (!e.cellIds || e.cellIds.length === 0) {
      e.traced = 0;
      continue;
    }
    let seen = 0;
    for (const c of e.cellIds) if (run.has(c)) seen++;
    e.traced = seen / e.cellIds.length;
  }
}
