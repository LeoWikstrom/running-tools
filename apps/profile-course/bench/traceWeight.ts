import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseGpx } from '../src/gpx/parse';
import { buildTargetProfile, sliceProfile } from '../src/gpx/profile';
import {
  buildGraph,
  filterToComponent,
  pruneDeadEnds,
  sampleEdgeElevations,
  snapToNode,
} from '../src/graph/build';
import { applyTraceCoverage } from '../src/graph/traces';
import type { Graph } from '../src/graph/types';
import { fetchNetwork, type OverpassResponse } from '../src/net/overpass';
import { fetchTracePoints, type TraceGrid } from '../src/net/traces';
import { beamSearch } from '../src/search/beam';
import { improveCandidates } from '../src/search/improve';
import {
  assembleCourse,
  scoreBreakdown,
  DEFAULT_WEIGHTS,
  MIX_ROAD,
  type Weights,
} from '../src/search/score';
import { haversineMeters } from '../src/shared/geo';
import { NodeSampler } from './sampler';

/**
 * Does preferring ground people are seen running on cost us the elevation
 * match? Both courses are rescored with the *same* weights (untracked 0), so
 * the profile terms are comparable; the mismatch totals of two different
 * weight sets are not.
 */

const START = { lat: 57.6889, lon: 11.9453 }; // Slottsskogsvallen
const ZONE_M = 500;
const TARGET_M = 3000;
const GRAPH_M = ZONE_M + TARGET_M / 2;
const TRACE_M = 2000;
const SEEDS = [1, 2, 3];
const SWEEP = [0, 5, 10, 20, 40];

const say = (line: string) => process.stderr.write(`${line}\n`);

async function network(): Promise<OverpassResponse> {
  const file = `bench/cache/overpass_${START.lat}_${START.lon}_${GRAPH_M}.json`;
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as OverpassResponse;
  say(`fetching network (${GRAPH_M} m)…`);
  const res = await fetchNetwork(START, GRAPH_M, { rounds: 4 });
  writeFileSync(file, JSON.stringify(res));
  return res;
}

async function traceCounts(): Promise<Map<number, number>> {
  const file = `bench/cache/traces_${START.lat}_${START.lon}_${TRACE_M}.json`;
  let grid: TraceGrid;
  if (existsSync(file)) {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { cells: number[]; counts: number[] };
    grid = { cells: Int32Array.from(raw.cells), counts: Uint16Array.from(raw.counts) };
  } else {
    say(`downloading GPS traces (${TRACE_M} m)… this is the slow part`);
    const found = await fetchTracePoints(START, TRACE_M, {
      onProgress: (done, total, kept) => say(`  box ${done}/${total}, ${kept} run points`),
    });
    say(`  ${found.points} points, ${found.timed} timed, ${found.kept} at running pace`);
    grid = found.grid;
    writeFileSync(
      file,
      JSON.stringify({ cells: [...grid.cells], counts: [...grid.counts] }),
    );
  }
  const counts = new Map<number, number>();
  for (let i = 0; i < grid.cells.length; i++) counts.set(grid.cells[i]!, grid.counts[i]!);
  return counts;
}

async function main(): Promise<void> {
  mkdirSync('bench/cache', { recursive: true });

  const gpx = parseGpx(readFileSync('test/fixtures/lidingoloppet.gpx', 'utf8'));
  const target = sliceProfile(buildTargetProfile(gpx.points), 0, TARGET_M);
  say(`target: ${(target.totalDistance / 1000).toFixed(2)} km, +${Math.round(target.totalGain)} m`);

  const response = await network();
  const full = buildGraph(response);
  const snapped = snapToNode(full, START.lat, START.lon);
  const filtered = filterToComponent(full, snapped);
  const pruned = pruneDeadEnds(filtered.graph, filtered.startNode);
  const graph: Graph = pruned.graph;
  const startNode = pruned.keepNode;
  say(`graph: ${graph.nodeLat.length} nodes, ${graph.edges.length} edges`);
  await sampleEdgeElevations(graph, new NodeSampler());

  const validEnd = new Uint8Array(graph.nodeLat.length);
  for (let i = 0; i < validEnd.length; i++) {
    if (haversineMeters(START.lat, START.lon, graph.nodeLat[i]!, graph.nodeLon[i]!) <= ZONE_M) {
      validEnd[i] = 1;
    }
  }

  const counts = await traceCounts();
  applyTraceCoverage(graph, counts);
  let tracedEdges = 0;
  for (const e of graph.edges) if (e.traced > 0.5) tracedEdges++;
  say(`traces: ${counts.size} cells; ${tracedEdges}/${graph.edges.length} edges mostly run\n`);

  const run = async (seed: number, untracked: number) => {
    const weights: Weights = { ...DEFAULT_WEIGHTS, untracked };
    const found = await beamSearch(graph, startNode, target, TARGET_M, {
      seed,
      validEnd,
      weights,
      desiredMix: MIX_ROAD,
    });
    const improved = await improveCandidates(graph, startNode, found, target, TARGET_M, {
      weights,
      desiredMix: MIX_ROAD,
      validEnd,
    });
    const best = improved[0] ?? found[0]!;
    const course = assembleCourse(graph, best.path);
    // Rescored with untracked 0: the elevation terms and the total are then
    // the same yardstick for both runs.
    const fair = scoreBreakdown(course, target, MIX_ROAD, DEFAULT_WEIGHTS);
    const total = Object.values(fair).reduce((a, b) => a + b, 0);
    return { course, fair, total };
  };

  const f = (n: number) => n.toFixed(2).padStart(7);
  for (const untracked of SWEEP) {
    const totals: number[] = [];
    const unrun: number[] = [];
    const terms = new Map<string, number>();
    for (const seed of SEEDS) {
      const r = await run(seed, untracked);
      totals.push(r.total);
      unrun.push(r.course.untrackedFraction);
      for (const [k, v] of Object.entries(r.fair)) terms.set(k, (terms.get(k) ?? 0) + v);
    }
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const worst = [...terms]
      .map(([k, v]) => `${k} ${(v / SEEDS.length).toFixed(1)}`)
      .join(', ');
    say(
      `untracked ${String(untracked).padStart(2)}: total${f(mean(totals))} ` +
        `unrun ${(mean(unrun) * 100).toFixed(0)} %`,
    );
    say(`             ${worst}`);
  }
}

await main();
