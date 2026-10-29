import { describe, expect, it } from 'vitest';
import {
  buildBuildingIndex,
  pointInPolygon,
  segmentsIntersect,
  type BuildingPoly,
} from '../src/geo/los';
import { buildPlaces } from '../src/poi/pipeline';
import type { PlaceCandidate } from '../src/poi/types';

describe('segmentsIntersect', () => {
  it('finds a plain crossing', () => {
    expect(segmentsIntersect(0, 0, 10, 10, 0, 10, 10, 0)).toBe(true);
  });

  it('rejects parallel and separated segments', () => {
    expect(segmentsIntersect(0, 0, 10, 0, 0, 5, 10, 5)).toBe(false);
    expect(segmentsIntersect(0, 0, 10, 0, 11, 1, 20, 5)).toBe(false);
  });

  it('treats touching endpoints and collinear overlap as intersecting', () => {
    expect(segmentsIntersect(0, 0, 10, 0, 10, 0, 10, 10)).toBe(true);
    expect(segmentsIntersect(0, 0, 10, 0, 5, 0, 15, 0)).toBe(true);
  });

  it('rejects collinear but disjoint segments', () => {
    expect(segmentsIntersect(0, 0, 10, 0, 11, 0, 20, 0)).toBe(false);
  });
});

describe('pointInPolygon', () => {
  const squareX = [0, 10, 10, 0];
  const squareY = [0, 0, 10, 10];

  it('handles a convex polygon', () => {
    expect(pointInPolygon(5, 5, squareX, squareY)).toBe(true);
    expect(pointInPolygon(15, 5, squareX, squareY)).toBe(false);
  });

  it('handles a concave polygon', () => {
    // A "C" opening to the right: the notch is outside.
    const xs = [0, 10, 10, 4, 4, 10, 10, 0];
    const ys = [0, 0, 3, 3, 7, 7, 10, 10];
    expect(pointInPolygon(2, 5, xs, ys)).toBe(true);
    expect(pointInPolygon(7, 5, xs, ys)).toBe(false);
  });
});

// A straight ~1.2 km west-to-east course at Gothenburg's latitude.
const lats = [57.7, 57.7, 57.7];
const lons = [11.97, 11.98, 11.99];
// ~0.0001° lat ≈ 11 m; 0.0001° lon ≈ 6 m here.

/** A wall just north of the course, long enough to shade the whole window. */
const wall: BuildingPoly = {
  id: 900,
  lats: [57.70015, 57.70025, 57.70025, 57.70015],
  lons: [11.9755, 11.9755, 11.9845, 11.9845],
};

/** A small hut at the same offset — easy to see past from along the course. */
const hut: BuildingPoly = {
  id: 901,
  lats: [57.70015, 57.70025, 57.70025, 57.70015],
  lons: [11.9797, 11.9797, 11.9803, 11.9803],
};

describe('BuildingIndex.blocked', () => {
  it('blocks a sightline through a wall, not one beside it', () => {
    const index = buildBuildingIndex([wall]);
    expect(index.blocked(57.7, 11.98, 57.7004, 11.98)).toBe(true);
    expect(index.blocked(57.7, 11.99, 57.7004, 11.99)).toBe(false);
  });

  it('never lets a footprint block its own place', () => {
    const index = buildBuildingIndex([wall]);
    expect(index.blocked(57.7, 11.98, 57.7004, 11.98, 900)).toBe(false);
  });

  it('never blocks a target inside a footprint', () => {
    const index = buildBuildingIndex([wall]);
    expect(index.blocked(57.7, 11.98, 57.7002, 11.98)).toBe(false);
  });
});

function candidate(over: Partial<PlaceCandidate>): PlaceCandidate {
  return {
    name: 'Place',
    lat: 57.7004,
    lon: 11.98,
    wikidataId: 'Q1',
    sitelinks: 20,
    types: [],
    sources: [{ kind: 'wikidata', url: 'https://www.wikidata.org/wiki/Q1' }],
    ...over,
  };
}

describe('buildPlaces line of sight', () => {
  it('keeps everything when no buildings are passed', () => {
    const places = buildPlaces(lats, lons, [candidate({})]);
    expect(places).toHaveLength(1);
  });

  it('drops a place hidden from the whole sight window', () => {
    const places = buildPlaces(lats, lons, [candidate({})], {}, undefined, [wall]);
    expect(places).toHaveLength(0);
  });

  it('keeps a place that only a short building hides from straight on', () => {
    const places = buildPlaces(lats, lons, [candidate({})], {}, undefined, [hut]);
    expect(places).toHaveLength(1);
  });

  it('drops a place visible only through one narrow street gap', () => {
    // The wall, with a ~24 m slot straight across from the place: exactly one
    // sample sees it down the canyon — not enough to be worth telling.
    const westWall: BuildingPoly = {
      id: 902,
      lats: [57.70015, 57.70025, 57.70025, 57.70015],
      lons: [11.9755, 11.9755, 11.9798, 11.9798],
    };
    const eastWall: BuildingPoly = {
      id: 903,
      lats: [57.70015, 57.70025, 57.70025, 57.70015],
      lons: [11.9802, 11.9802, 11.9845, 11.9845],
    };
    const places = buildPlaces(lats, lons, [candidate({})], {}, undefined, [westWall, eastWall]);
    expect(places).toHaveLength(0);
  });

  it('keeps a place that is its own building', () => {
    const church = candidate({
      lat: 57.7002,
      lon: 11.98,
      sources: [{ kind: 'osm', url: 'https://www.openstreetmap.org/way/900' }],
    });
    const places = buildPlaces(lats, lons, [church], {}, undefined, [wall]);
    expect(places).toHaveLength(1);
  });
});
