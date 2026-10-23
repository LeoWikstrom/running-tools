import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { OverpassResponse } from '../src/net/overpass';
import { buildQuery } from '../src/net/overpass';
import {
  buildGraph,
  classifySurface,
  edgePenalty,
  edgeSamplePositions,
  filterToComponent,
  snapToNode,
} from '../src/graph/build';
import { SURFACE_GRAVEL, SURFACE_PAVED, SURFACE_TRAIL, SURFACE_UNKNOWN } from '../src/graph/types';
import { dijkstra } from '../src/graph/dijkstra';

const skatas = JSON.parse(
  readFileSync('test/fixtures/overpass_skatas_250m.json', 'utf8'),
) as OverpassResponse;

describe('classifySurface', () => {
  it('maps surface tags first', () => {
    expect(classifySurface({ surface: 'asphalt', highway: 'track' })).toBe(SURFACE_PAVED);
    expect(classifySurface({ surface: 'gravel' })).toBe(SURFACE_GRAVEL);
    expect(classifySurface({ surface: 'grass' })).toBe(SURFACE_TRAIL);
  });

  it('falls back to highway type', () => {
    expect(classifySurface({ highway: 'path' })).toBe(SURFACE_TRAIL);
    expect(classifySurface({ highway: 'residential' })).toBe(SURFACE_PAVED);
    expect(classifySurface({ highway: 'track' })).toBe(SURFACE_GRAVEL);
    expect(classifySurface({ highway: 'bridleway' })).toBe(SURFACE_UNKNOWN);
  });
});

describe('edgePenalty', () => {
  it('penalises steps, rough tracks and tertiary roads', () => {
    expect(edgePenalty({ highway: 'steps' })).toBe(1);
    expect(edgePenalty({ highway: 'track', tracktype: 'grade5' })).toBe(0.5);
    expect(edgePenalty({ highway: 'tertiary' })).toBeGreaterThan(0);
    expect(edgePenalty({ highway: 'footway' })).toBe(0);
  });

  it('car roads without sidewalks or with high maxspeed are worse', () => {
    const bare = edgePenalty({ highway: 'residential' });
    const withSidewalk = edgePenalty({ highway: 'residential', sidewalk: 'both' });
    const fast = edgePenalty({ highway: 'residential', sidewalk: 'both', maxspeed: '70' });
    expect(bare).toBeGreaterThan(withSidewalk);
    expect(fast).toBeGreaterThan(withSidewalk);
  });

  it('a sidewalk on either side counts, including a separately mapped one', () => {
    const bare = edgePenalty({ highway: 'unclassified' });
    // Karl IX:s Väg (OSM way 24382790): left side has none, right side is its own way.
    const karl = edgePenalty({
      highway: 'unclassified',
      maxspeed: '40',
      surface: 'asphalt',
      'sidewalk:left': 'no',
      'sidewalk:right': 'separate',
    });
    expect(karl).toBeLessThan(bare);
    expect(edgePenalty({ highway: 'residential', 'sidewalk:left': 'no' })).toBe(bare);
  });

  it('cycleways, designated foot paths and lit ways get a bonus', () => {
    expect(edgePenalty({ highway: 'cycleway' })).toBeLessThan(0);
    expect(edgePenalty({ highway: 'footway', foot: 'designated' })).toBeLessThan(0);
    expect(edgePenalty({ highway: 'footway', lit: 'yes' })).toBeLessThan(0);
    expect(edgePenalty({ highway: 'cycleway', lit: 'yes' })).toBeGreaterThanOrEqual(-0.1);
  });
});

describe('bridge and tunnel handling', () => {
  it('flags bridges and tunnels as levelled', () => {
    const mkResponse = (tags: Record<string, string>): OverpassResponse => ({
      elements: [
        { type: 'node', id: 1, lat: 57.7, lon: 12.0 },
        { type: 'node', id: 2, lat: 57.701, lon: 12.0 },
        { type: 'way', id: 10, nodes: [1, 2], tags },
      ],
    });
    expect(buildGraph(mkResponse({ highway: 'footway', bridge: 'yes' })).edges[0]!.levelled).toBe(
      true,
    );
    expect(buildGraph(mkResponse({ highway: 'footway', tunnel: 'yes' })).edges[0]!.levelled).toBe(
      true,
    );
    expect(buildGraph(mkResponse({ highway: 'footway', bridge: 'no' })).edges[0]!.levelled).toBe(
      false,
    );
    expect(buildGraph(mkResponse({ highway: 'footway' })).edges[0]!.levelled).toBe(false);
  });

  it('levelled edges get linearly interpolated elevation', async () => {
    const { sampleEdgeElevations } = await import('../src/graph/build');
    const response: OverpassResponse = {
      elements: [
        { type: 'node', id: 1, lat: 57.7, lon: 12.03 },
        { type: 'node', id: 2, lat: 57.703, lon: 12.03 }, // ~330 m, many samples
        { type: 'way', id: 10, nodes: [1, 2], tags: { highway: 'footway', bridge: 'yes' } },
      ],
    };
    const graph = buildGraph(response);
    // A sampler pretending there is a deep valley everywhere except endpoints.
    const { TerrainSampler } = await import('../src/net/terrain');
    class ValleySampler extends TerrainSampler {
      constructor() {
        super(13, () => {
          throw new Error('no network');
        });
      }
      override async elevations(lats: ArrayLike<number>): Promise<Float32Array> {
        const out = new Float32Array(lats.length).fill(-40);
        out[0] = 20;
        out[lats.length - 1] = 24;
        return out;
      }
    }
    await sampleEdgeElevations(graph, new ValleySampler());
    const elev = graph.edges[0]!.elev!;
    expect(elev[0]).toBeCloseTo(20);
    expect(elev[elev.length - 1]).toBeCloseTo(24);
    const mid = elev[Math.floor(elev.length / 2)]!;
    expect(mid).toBeGreaterThan(20); // no valley dip
    expect(mid).toBeLessThan(24);
  });

  it('an ele-tagged bridge chain becomes a trapezoid: ground, crest, ground', async () => {
    const { sampleEdgeElevations } = await import('../src/graph/build');
    const { TerrainSampler } = await import('../src/net/terrain');
    const response: OverpassResponse = {
      elements: [
        { type: 'node', id: 1, lat: 57.697, lon: 12.03 }, // approach street end
        { type: 'node', id: 2, lat: 57.7, lon: 12.03 }, // bridgehead A
        { type: 'node', id: 3, lat: 57.704, lon: 12.03 }, // mid-chain junction
        { type: 'node', id: 4, lat: 57.708, lon: 12.03 }, // bridgehead B
        { type: 'way', id: 9, nodes: [1, 2], tags: { highway: 'path' } },
        { type: 'way', id: 10, nodes: [2, 3], tags: { highway: 'path', bridge: 'yes', ele: '50' } },
        { type: 'way', id: 11, nodes: [3, 4], tags: { highway: 'path', bridge: 'yes', ele: '50' } },
      ],
    };
    const graph = buildGraph(response);
    class GroundSampler extends TerrainSampler {
      constructor() {
        super(13, () => {
          throw new Error('no network');
        });
      }
      override async elevations(lats: ArrayLike<number>): Promise<Float32Array> {
        return new Float32Array(lats.length).fill(5);
      }
    }
    await sampleEdgeElevations(graph, new GroundSampler());

    const decks = graph.edges.filter((e) => e.eleTag !== null);
    expect(decks.length).toBe(2);
    const all: number[] = [];
    for (const d of decks) all.push(...d.elev!);
    const maxElev = Math.max(...all);
    expect(maxElev).toBeCloseTo(50, 1); // crest at the ele tag

    // Chain ends sit at ground, so there is no cliff at the bridgeheads.
    const first = decks[0]!;
    const endsAtGround =
      Math.abs(first.elev![0]! - 5) < 6 || Math.abs(first.elev![first.elev!.length - 1]! - 5) < 6;
    expect(endsAtGround).toBe(true);

    // No step anywhere along the chain steeper than ~25 % per sample.
    for (const d of decks) {
      for (let i = 1; i < d.elev!.length; i++) {
        expect(Math.abs(d.elev![i]! - d.elev![i - 1]!)).toBeLessThan(7);
      }
    }

    // Approach street outside the chain is untouched.
    const approach = graph.edges.find((e) => !e.levelled)!;
    for (const v of approach.elev!) expect(v).toBeCloseTo(5, 3);
  });
});

describe('traffic signals and corridor cells', () => {
  it('counts signalized crossings per edge', () => {
    const response: OverpassResponse = {
      elements: [
        { type: 'node', id: 1, lat: 57.7, lon: 12.03 },
        { type: 'node', id: 2, lat: 57.701, lon: 12.03, tags: { crossing: 'traffic_signals' } },
        { type: 'node', id: 3, lat: 57.702, lon: 12.03 },
        { type: 'way', id: 10, nodes: [1, 2, 3], tags: { highway: 'footway' } },
      ],
    };
    const graph = buildGraph(response);
    expect(graph.edges[0]!.signals).toBe(1);
  });

  it('reversing along a parallel twin path counts as oscillation', async () => {
    const { sampleEdgeElevations } = await import('../src/graph/build');
    const { assembleCourse } = await import('../src/search/score');
    const { TerrainSampler } = await import('../src/net/terrain');
    // Two ~330 m paths, 3 m apart (bike + foot), sharing endpoints via
    // connector nodes; up one and back down the other.
    const response: OverpassResponse = {
      elements: [
        { type: 'node', id: 1, lat: 57.7, lon: 12.03 },
        { type: 'node', id: 2, lat: 57.703, lon: 12.03 },
        { type: 'node', id: 3, lat: 57.7, lon: 12.03005 }, // ~3 m east
        { type: 'node', id: 4, lat: 57.703, lon: 12.03005 },
        { type: 'way', id: 10, nodes: [1, 2], tags: { highway: 'cycleway' } },
        { type: 'way', id: 11, nodes: [3, 4], tags: { highway: 'footway' } },
        { type: 'way', id: 12, nodes: [1, 3], tags: { highway: 'footway' } },
        { type: 'way', id: 13, nodes: [2, 4], tags: { highway: 'footway' } },
      ],
    };
    class Flat extends TerrainSampler {
      constructor() {
        super(13, () => {
          throw new Error('no network');
        });
      }
      override async elevations(lats: ArrayLike<number>): Promise<Float32Array> {
        return new Float32Array(lats.length).fill(5);
      }
    }
    const graph = buildGraph(response);
    await sampleEdgeElevations(graph, new Flat());
    const up = graph.edges.findIndex(
      (e) => e.surface === 0 && e.lengthM > 200 && e.lats[0] !== e.lats[1],
    );
    const bike = graph.edges.findIndex((e) => e.lengthM > 200);
    const foot = graph.edges.findIndex((e, i) => e.lengthM > 200 && i !== bike);
    const link = graph.edges.findIndex((e) => e.lengthM < 50);
    expect(bike).toBeGreaterThanOrEqual(0);
    expect(foot).toBeGreaterThanOrEqual(0);
    expect(link).toBeGreaterThanOrEqual(0);
    void up;

    // Orient: bike a->b, cross the link, foot back.
    const eBike = graph.edges[bike]!;
    const eFoot = graph.edges[foot]!;
    const eLink = graph.edges.find((e) => e.lengthM < 50 && (e.a === eBike.b || e.b === eBike.b))!;
    const linkIdx = graph.edges.indexOf(eLink);
    const bikeDir = 1; // a->b
    const linkDir = eLink.a === eBike.b ? 1 : 0;
    const footEntry = eLink.a === eBike.b ? eLink.b : eLink.a;
    const footDir = eFoot.a === footEntry ? 1 : 0;
    const course = assembleCourse(graph, {
      edges: [bike, linkIdx, foot],
      dirs: [bikeDir, linkDir, footDir],
    });
    expect(course.oscillationFraction).toBeGreaterThan(0.5);
  });

  it('opposite sidewalks ~18 m apart are not the same corridor', async () => {
    const { sampleEdgeElevations } = await import('../src/graph/build');
    const { assembleCourse } = await import('../src/search/score');
    const { TerrainSampler } = await import('../src/net/terrain');
    const response: OverpassResponse = {
      elements: [
        { type: 'node', id: 1, lat: 57.7, lon: 12.03 },
        { type: 'node', id: 2, lat: 57.703, lon: 12.03 },
        { type: 'node', id: 3, lat: 57.7, lon: 12.0303 }, // ~18 m east
        { type: 'node', id: 4, lat: 57.703, lon: 12.0303 },
        { type: 'way', id: 10, nodes: [1, 2], tags: { highway: 'footway' } },
        { type: 'way', id: 11, nodes: [3, 4], tags: { highway: 'footway' } },
        { type: 'way', id: 12, nodes: [1, 3], tags: { highway: 'footway' } },
        { type: 'way', id: 13, nodes: [2, 4], tags: { highway: 'footway' } },
      ],
    };
    class Flat extends TerrainSampler {
      constructor() {
        super(13, () => {
          throw new Error('no network');
        });
      }
      override async elevations(lats: ArrayLike<number>): Promise<Float32Array> {
        return new Float32Array(lats.length).fill(5);
      }
    }
    const graph = buildGraph(response);
    await sampleEdgeElevations(graph, new Flat());
    const sides = graph.edges.map((e, i) => ({ e, i })).filter(({ e }) => e.lengthM > 200);
    const links = graph.edges.map((e, i) => ({ e, i })).filter(({ e }) => e.lengthM < 50);
    const first = sides[0]!;
    const eLink = links.find(({ e }) => e.a === first.e.b || e.b === first.e.b)!;
    const second = sides[1]!;
    const linkDir = eLink.e.a === first.e.b ? 1 : 0;
    const entry = eLink.e.a === first.e.b ? eLink.e.b : eLink.e.a;
    const course = assembleCourse(graph, {
      edges: [first.i, eLink.i, second.i],
      dirs: [1, linkDir, second.e.a === entry ? 1 : 0],
    });
    expect(course.oscillationFraction).toBeLessThan(0.1);
  });
});

describe('crossing connectors (the Virginsgatan case)', () => {
  // Sidewalk heading south, ending ~8 m north of an east-west street.
  const base = (extra: OverpassResponse['elements']): OverpassResponse => ({
    elements: [
      { type: 'node', id: 1, lat: 57.701, lon: 12.03 }, // sidewalk north end
      { type: 'node', id: 2, lat: 57.70008, lon: 12.03 }, // sidewalk south end (~8 m from street)
      { type: 'node', id: 3, lat: 57.7, lon: 12.028 }, // street west
      { type: 'node', id: 4, lat: 57.7, lon: 12.032 }, // street east
      { type: 'way', id: 10, nodes: [1, 2], tags: { highway: 'footway' } },
      { type: 'way', id: 11, nodes: [3, 4], tags: { highway: 'residential' } },
      ...extra,
    ],
  });

  it('connects a dead-end sidewalk across to the street', () => {
    const graph = buildGraph(base([]));
    const sidewalkEnd = snapToNode(graph, 57.70008, 12.03, 20);
    const streetWest = snapToNode(graph, 57.7, 12.028, 30);
    expect(sidewalkEnd).toBeGreaterThanOrEqual(0);
    expect(streetWest).toBeGreaterThanOrEqual(0);
    const { dist } = dijkstra(graph, [sidewalkEnd]);
    expect(dist[streetWest]).toBeLessThan(300); // reachable via the connector
  });

  it('a fence between blocks the connector', () => {
    const graph = buildGraph(
      base([
        { type: 'node', id: 5, lat: 57.70004, lon: 12.028 },
        { type: 'node', id: 6, lat: 57.70004, lon: 12.032 },
        { type: 'way', id: 12, nodes: [5, 6], tags: { barrier: 'fence' } },
      ]),
    );
    const sidewalkEnd = snapToNode(graph, 57.70008, 12.03, 20);
    const streetWest = snapToNode(graph, 57.7, 12.028, 30);
    if (sidewalkEnd >= 0 && streetWest >= 0) {
      const { dist } = dijkstra(graph, [sidewalkEnd]);
      expect(dist[streetWest]).toBe(Infinity);
    }
  });

  it('a 30 m gap is too far to connect', () => {
    const far: OverpassResponse = {
      elements: [
        { type: 'node', id: 1, lat: 57.7013, lon: 12.03 },
        { type: 'node', id: 2, lat: 57.70027, lon: 12.03 }, // ~30 m from street
        { type: 'node', id: 3, lat: 57.7, lon: 12.028 },
        { type: 'node', id: 4, lat: 57.7, lon: 12.032 },
        { type: 'way', id: 10, nodes: [1, 2], tags: { highway: 'footway' } },
        { type: 'way', id: 11, nodes: [3, 4], tags: { highway: 'residential' } },
      ],
    };
    const graph = buildGraph(far);
    const sidewalkEnd = snapToNode(graph, 57.70027, 12.03, 20);
    const streetWest = snapToNode(graph, 57.7, 12.028, 30);
    if (sidewalkEnd >= 0 && streetWest >= 0) {
      const { dist } = dijkstra(graph, [sidewalkEnd]);
      expect(dist[streetWest]).toBe(Infinity);
    }
  });
});

describe('buildGraph on the Skatås fixture', () => {
  const graph = buildGraph(skatas);

  it('produces a connected-looking graph', () => {
    expect(graph.nodeLat.length).toBeGreaterThan(20);
    expect(graph.edges.length).toBeGreaterThan(20);
    expect(graph.adjOffset.length).toBe(graph.nodeLat.length + 1);
    expect(graph.adjEdge.length).toBe(graph.edges.length * 2);
  });

  it('edge lengths are positive and sane', () => {
    for (const e of graph.edges) {
      expect(e.lengthM).toBeGreaterThan(0);
      expect(e.lengthM).toBeLessThan(3000);
    }
  });

  it('snaps a point near Skatås to a node within 100 m', () => {
    const node = snapToNode(graph, 57.7046, 12.0381);
    expect(node).toBeGreaterThanOrEqual(0);
  });

  it('returns -1 when nothing is within 100 m', () => {
    expect(snapToNode(graph, 58.5, 13.0)).toBe(-1);
  });

  it('filterToComponent keeps the start and drops nothing vital', () => {
    const start = snapToNode(graph, 57.7046, 12.0381);
    const { graph: sub, startNode } = filterToComponent(graph, start);
    expect(startNode).toBeGreaterThanOrEqual(0);
    expect(sub.nodeLat.length).toBeGreaterThan(10);
    expect(sub.nodeLat.length).toBeLessThanOrEqual(graph.nodeLat.length);
    expect(sub.adjEdge.length).toBe(sub.edges.length * 2);
  });

  it('edgeSamplePositions covers the edge endpoints', () => {
    const edge = graph.edges.find((e) => e.lengthM > 100)!;
    const { lats, lons } = edgeSamplePositions(edge);
    expect(lats.length).toBeGreaterThanOrEqual(2);
    expect(lats[0]).toBeCloseTo(edge.lats[0]!, 6);
    expect(lons[lons.length - 1]).toBeCloseTo(edge.lons[edge.lons.length - 1]!, 6);
  });
});

describe('buildQuery', () => {
  it('includes radius, centre and highway filter', () => {
    const q = buildQuery({ lat: 57.7, lon: 11.97 }, 5000);
    expect(q).toContain('around:5000,57.700000,11.970000');
    expect(q).toContain('footway|path');
    expect(q).toContain('out:json');
  });
});
