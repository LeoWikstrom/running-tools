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
import type { Graph } from '../src/graph/types';
import { fetchNetwork, type OverpassResponse } from '../src/net/overpass';
import { beamSearch } from '../src/search/beam';
import { improveCandidates } from '../src/search/improve';
import { assembleCourse, DEFAULT_WEIGHTS, MIX_ROAD } from '../src/search/score';
import { haversineMeters } from '../src/geo';
import { NodeSampler } from './sampler';

/**
 * Repro for Leo's report (2026-10-30): a course that covers the same ground
 * twice showed it at two different heights on the plot. Runs his share-link
 * parameters and then hunts the found course for corridor-cell revisits whose
 * plotted heights disagree — printing which edges, their bridge/levelling
 * flags and coordinates, to name the mechanism.
 */

const START = { lat: 57.71546, lon: 12.02915 };
const ZONE_M = 1000;
const TARGET_M = 21_000;
const GRAPH_M = Math.min(ZONE_M + TARGET_M / 2, 15_000);
const SEED = 1;
const BEAM_WIDTH = 400;

const say = (line: string) => process.stderr.write(`${line}\n`);

async function network(): Promise<OverpassResponse> {
  const file = `bench/cache/overpass_${START.lat}_${START.lon}_${GRAPH_M}.json`;
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as OverpassResponse;
  say(`fetching network (${GRAPH_M} m)…`);
  const res = await fetchNetwork(START, GRAPH_M, { rounds: 4, headerTimeoutMs: 180_000 });
  writeFileSync(file, JSON.stringify(res));
  return res;
}

async function main(): Promise<void> {
  mkdirSync('bench/cache', { recursive: true });

  const gpx = parseGpx(readFileSync('test/fixtures/goteborgsvarvet.gpx', 'utf8'));
  const target = sliceProfile(buildTargetProfile(gpx.points), 0, TARGET_M);
  say(`target: ${(target.totalDistance / 1000).toFixed(2)} km, +${Math.round(target.totalGain)} m`);

  const response = await network();
  say(`network: ${response.elements.length} elements`);
  const full = buildGraph(response, { connectors: false });
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

  say('searching…');
  const found = await beamSearch(graph, startNode, target, TARGET_M, {
    seed: SEED,
    beamWidth: BEAM_WIDTH,
    desiredMix: MIX_ROAD,
    returnToStart: false,
    weights: DEFAULT_WEIGHTS,
    validEnd,
  });
  say(`beam: ${found.length} candidates, best ${found[0]?.score.toFixed(2)}`);
  const improved = await improveCandidates(graph, startNode, found, target, TARGET_M, {
    weights: DEFAULT_WEIGHTS,
    desiredMix: MIX_ROAD,
  });
  const best = improved[0] ?? found[0]!;
  const course = assembleCourse(graph, best.path);
  say(`course: ${(course.lengthM / 1000).toFixed(2)} km, +${Math.round(course.gain)} m\n`);

  // Hunt: corridor-cell revisits whose plotted heights disagree.
  const heightAt = (d: number): number =>
    course.samples[Math.max(0, Math.min(course.samples.length - 1, Math.round(d / 25)))]!;
  const seen = new Map<number, { dist: number; ei: number }>();
  let dist = 0;
  const reported = new Set<string>();
  for (let i = 0; i < best.path.edges.length; i++) {
    const ei = best.path.edges[i]!;
    const e = graph.edges[ei]!;
    const forward = best.path.dirs[i] === 1;
    if (e.cellIds) {
      const m = e.cellIds.length;
      const spacing = e.lengthM / Math.max(1, m - 1);
      for (let k = 0; k < m; k++) {
        const idx = forward ? k : m - 1 - k;
        const cell = e.cellIds[idx]!;
        const d = dist + k * spacing;
        const prev = seen.get(cell);
        if (prev && d - prev.dist > 100) {
          const h1 = heightAt(prev.dist);
          const h2 = heightAt(d);
          const key = `${prev.ei}:${ei}`;
          if (Math.abs(h1 - h2) > 2.5 && !reported.has(key)) {
            reported.add(key);
            const p = graph.edges[prev.ei]!;
            const mid = Math.floor(e.lats.length / 2);
            say(
              `SAME GROUND, DIFFERENT HEIGHT at km ${(prev.dist / 1000).toFixed(2)} vs ` +
                `${(d / 1000).toFixed(2)}: ${h1.toFixed(1)} m vs ${h2.toFixed(1)} m ` +
                `(Δ ${(h2 - h1).toFixed(1)})\n` +
                `  first  edge ${prev.ei}: levelled=${p.levelled} eleTag=${p.eleTag} ` +
                `len=${p.lengthM.toFixed(0)} elev[${p.elev?.[0]?.toFixed(1)}…${p.elev?.[p.elev.length - 1]?.toFixed(1)}]\n` +
                `  second edge ${ei}: levelled=${e.levelled} eleTag=${e.eleTag} ` +
                `len=${e.lengthM.toFixed(0)} elev[${e.elev?.[0]?.toFixed(1)}…${e.elev?.[e.elev.length - 1]?.toFixed(1)}]\n` +
                `  at ${e.lats[mid]?.toFixed(5)},${e.lons[mid]?.toFixed(5)} same-edge=${prev.ei === ei}`,
            );
          }
        }
        seen.set(cell, { dist: d, ei });
      }
    }
    dist += e.lengthM;
  }
  if (reported.size === 0) say('no same-ground height disagreements > 2.5 m found');
}

void main();
