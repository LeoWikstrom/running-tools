import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildProfileFromSamples } from '../src/gpx/profile';
import {
  buildGraph,
  filterToComponent,
  sampleEdgeElevations,
  snapToNode,
} from '../src/graph/build';
import type { Graph } from '../src/graph/types';
import type { OverpassResponse } from '../src/net/overpass';
import { assembleCourse } from '../src/search/score';
import { mulberry32, randomWalkSearch } from '../src/search/randomWalk';
import { FixtureSampler } from './helpers/fixtureSampler';

describe('mulberry32', () => {
  it('is deterministic and in [0, 1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 100; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('randomWalkSearch on the Skatås fixture', () => {
  let graph: Graph;
  let startNode: number;

  beforeAll(async () => {
    const response = JSON.parse(
      readFileSync('test/fixtures/overpass_skatas_250m.json', 'utf8'),
    ) as OverpassResponse;
    const full = buildGraph(response);
    const snapped = snapToNode(full, 57.7046, 12.0381);
    const filtered = filterToComponent(full, snapped);
    graph = filtered.graph;
    startNode = filtered.startNode;
    await sampleEdgeElevations(graph, new FixtureSampler());
  });

  it('finds courses of roughly the target length, deterministically', async () => {
    const targetLength = 1000;
    const target = buildProfileFromSamples(new Float32Array(41), targetLength);
    const run = () =>
      randomWalkSearch(graph, startNode, target, targetLength, { seed: 7, walks: 300 });
    const [a, b] = await Promise.all([run(), run()]);
    expect(a.length).toBeGreaterThan(0);
    expect(a[0]!.score).toBe(b[0]!.score);
    for (const c of a) {
      expect(c.course.lengthM).toBeGreaterThanOrEqual(targetLength * 0.97);
      expect(c.course.lengthM).toBeLessThanOrEqual(targetLength * 1.03);
    }
  });

  it('results are sorted by score and assemble consistently', async () => {
    const targetLength = 800;
    const target = buildProfileFromSamples(new Float32Array(33), targetLength);
    const results = await randomWalkSearch(graph, startNode, target, targetLength, {
      seed: 3,
      walks: 300,
    });
    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.score).toBeGreaterThanOrEqual(results[i - 1]!.score);
    }
    const re = assembleCourse(graph, results[0]!.path);
    expect(re.lengthM).toBeCloseTo(results[0]!.course.lengthM, 5);
  });
});
