import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findCoveringArea, listAreas, saveArea, deleteArea, loadArea } from '../src/net/areaStore';
import { filterByRadius, type OverpassResponse } from '../src/net/overpass';
import { buildGraph, snapToNode } from '../src/graph/build';

const skatas = JSON.parse(
  readFileSync('test/fixtures/overpass_skatas_250m.json', 'utf8'),
) as OverpassResponse;

describe('areaStore (in-memory cache in node)', () => {
  it('saves, lists, covers and deletes areas', async () => {
    const area = await saveArea({ lat: 57.7046, lon: 12.0381 }, 8000, skatas);
    expect((await listAreas()).some((a) => a.id === area.id)).toBe(true);
    expect(area.ways).toBeGreaterThan(10);

    // Fully inside: 2 km search 1 km east of the centre.
    const covering = await findCoveringArea({ lat: 57.7046, lon: 12.055 }, 2000);
    expect(covering?.id).toBe(area.id);

    // Not covered: circle pokes out of the stored area.
    expect(await findCoveringArea({ lat: 57.7046, lon: 12.15 }, 5000)).toBeNull();

    expect(await loadArea(area.id)).toBeDefined();
    await deleteArea(area.id);
    expect((await listAreas()).some((a) => a.id === area.id)).toBe(false);
  });
});

describe('filterByRadius', () => {
  it('a tight filter keeps a smaller, still-buildable graph', () => {
    const filtered = filterByRadius(skatas, { lat: 57.7046, lon: 12.0381 }, 120);
    const fullWays = skatas.elements.filter((e) => e.type === 'way').length;
    const keptWays = filtered.elements.filter((e) => e.type === 'way').length;
    expect(keptWays).toBeGreaterThan(0);
    expect(keptWays).toBeLessThan(fullWays);

    const graph = buildGraph(filtered);
    expect(snapToNode(graph, 57.7046, 12.0381)).toBeGreaterThanOrEqual(0);
  });

  it('a covering filter keeps everything', () => {
    const filtered = filterByRadius(skatas, { lat: 57.7046, lon: 12.0381 }, 10_000);
    expect(filtered.elements.length).toBe(skatas.elements.length);
  });
});
