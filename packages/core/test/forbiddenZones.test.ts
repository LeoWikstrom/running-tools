import { describe, expect, it } from 'vitest';
import type { OverpassElement, OverpassResponse } from '../src/net/overpass';
import { filterByRadius } from '../src/net/overpass';
import { buildGraph } from '../src/graph/build';
import {
  collectForbiddenZones,
  pointInForbiddenZone,
} from '../src/graph/forbiddenZones';

// A ~400x400 m square area around 57.70, 11.97: node grid where 0.001 deg
// lat ≈ 111 m. Ids: corners 1-4, path nodes 100+.
const n = (id: number, lat: number, lon: number): OverpassElement => ({
  type: 'node',
  id,
  lat,
  lon,
});

const squareNodes: OverpassElement[] = [
  n(1, 57.7, 11.97),
  n(2, 57.704, 11.97),
  n(3, 57.704, 11.976),
  n(4, 57.7, 11.976),
];

describe('collectForbiddenZones', () => {
  it('builds a ring from a closed military way', () => {
    const rings = collectForbiddenZones([
      ...squareNodes,
      { type: 'way', id: 10, nodes: [1, 2, 3, 4, 1], tags: { landuse: 'military' } },
    ]);
    expect(rings).toHaveLength(1);
    expect(pointInForbiddenZone(rings, 57.702, 11.973)).toBe(true);
    expect(pointInForbiddenZone(rings, 57.706, 11.973)).toBe(false);
  });

  it('assembles a multipolygon relation from unordered, part-reversed members', () => {
    const rings = collectForbiddenZones([
      ...squareNodes,
      { type: 'way', id: 11, nodes: [1, 2], tags: {} },
      { type: 'way', id: 12, nodes: [3, 2], tags: {} }, // reversed
      { type: 'way', id: 13, nodes: [3, 4, 1], tags: {} },
      {
        type: 'relation',
        id: 20,
        members: [
          { type: 'way', ref: 13, role: 'outer' },
          { type: 'way', ref: 11, role: 'outer' },
          { type: 'way', ref: 12, role: 'outer' },
        ],
        tags: { landuse: 'military' },
      },
    ]);
    expect(rings).toHaveLength(1);
    expect(pointInForbiddenZone(rings, 57.702, 11.973)).toBe(true);
    expect(pointInForbiddenZone(rings, 57.699, 11.973)).toBe(false);
  });

  it('ignores untagged areas', () => {
    const rings = collectForbiddenZones([
      ...squareNodes,
      { type: 'way', id: 10, nodes: [1, 2, 3, 4, 1], tags: { landuse: 'meadow' } },
    ]);
    expect(rings).toHaveLength(0);
  });
});

describe('buildGraph with forbidden zones', () => {
  // A service road through the square and a residential street outside it.
  const response: OverpassResponse = {
    elements: [
      ...squareNodes,
      n(100, 57.701, 11.971),
      n(101, 57.702, 11.973),
      n(102, 57.703, 11.975),
      n(200, 57.706, 11.971),
      n(201, 57.706, 11.975),
      { type: 'way', id: 10, nodes: [1, 2, 3, 4, 1], tags: { landuse: 'military' } },
      { type: 'way', id: 30, nodes: [100, 101, 102], tags: { highway: 'service' } },
      { type: 'way', id: 31, nodes: [200, 201], tags: { highway: 'residential' } },
    ],
  };

  it('drops edges inside the area and keeps the street outside', () => {
    const graph = buildGraph(response);
    expect(graph.edges.length).toBe(1);
    expect(graph.edges[0]!.lats[0]).toBeCloseTo(57.706);
  });

  it('keeps the inside road when no zone is declared', () => {
    const open: OverpassResponse = {
      elements: response.elements.filter((el) => !(el.type === 'way' && el.id === 10)),
    };
    expect(buildGraph(open).edges.length).toBe(2);
  });
});

describe('filterByRadius with forbidden zones', () => {
  it('keeps zone geometry whole even outside the radius', () => {
    const response: OverpassResponse = {
      elements: [
        ...squareNodes,
        n(200, 57.74, 11.97),
        n(201, 57.7405, 11.97),
        { type: 'way', id: 10, nodes: [1, 2, 3, 4, 1], tags: { landuse: 'military' } },
        { type: 'way', id: 31, nodes: [200, 201], tags: { highway: 'residential' } },
      ],
    };
    // Radius around the street, 4+ km north of the square.
    const kept = filterByRadius(response, { lat: 57.74, lon: 11.97 }, 500);
    const ways = kept.elements.filter((el) => el.type === 'way').map((el) => el.id);
    expect(ways).toContain(10);
    expect(ways).toContain(31);
  });
});
