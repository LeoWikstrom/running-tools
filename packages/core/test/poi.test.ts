import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseGpx } from '../src/gpx/parse';
import {
  buildPlaces,
  dedupeCandidates,
  firstPassProjection,
} from '../src/poi/pipeline';
import { interestScore, hasSignal } from '../src/poi/score';
import { elementsToCandidates, type OsmPlaceElement } from '../src/poi/osm';
import {
  geoPagesFromResponse,
  pagesToCandidates,
  sampleCenters,
  type WikiQueryResponse,
} from '../src/poi/wikipedia';
import { itemsToCandidates, parseSparqlResults } from '../src/poi/wikidata';
import type { PlaceCandidate } from '../src/poi/types';

const FIXTURES = join(__dirname, 'fixtures');
const load = <T>(name: string): T => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T;

const course = parseGpx(readFileSync(join(FIXTURES, 'gbg_loop.gpx'), 'utf8'));
const lats = course.points.map((p) => p.lat);
const lons = course.points.map((p) => p.lon);

function candidate(over: Partial<PlaceCandidate>): PlaceCandidate {
  return {
    name: 'Place',
    lat: 57.7,
    lon: 11.97,
    types: [],
    sources: [{ kind: 'osm', url: 'https://example.org' }],
    ...over,
  };
}

describe('firstPassProjection', () => {
  // Straight west-to-east line, ~600 m per segment.
  const lineLats = [57.7, 57.7, 57.7];
  const lineLons = [11.97, 11.98, 11.99];

  it('finds the projection inside the corridor', () => {
    const p = firstPassProjection(lineLats, lineLons, 57.7005, 11.975, 80)!;
    expect(p).not.toBeNull();
    expect(p.offset).toBeGreaterThan(45);
    expect(p.offset).toBeLessThan(65);
  });

  it('returns null outside the corridor', () => {
    expect(firstPassProjection(lineLats, lineLons, 57.703, 11.975, 80)).toBeNull();
  });

  it('keeps the first pass of an out-and-back', () => {
    // Out along the line and straight back.
    const la = [57.7, 57.7, 57.7];
    const lo = [11.97, 11.99, 11.97];
    // Beside the line near the far end: passed once going out, once coming back.
    const p = firstPassProjection(la, lo, 57.7003, 11.985, 80)!;
    const outLegLen = 2 * 597; // ~597 m per 0.01 deg lon at this latitude
    expect(p.along).toBeLessThan(outLegLen); // first pass, not the return
  });
});

describe('dedupeCandidates', () => {
  it('merges by wikidata id across sources', () => {
    const merged = dedupeCandidates([
      candidate({ name: 'Domkyrkan', wikidataId: 'Q1', sitelinks: 12 }),
      candidate({
        name: 'Gothenburg Cathedral',
        wikidataId: 'Q1',
        wikipedia: { lang: 'en', title: 'Gothenburg Cathedral' },
        pageLength: 9000,
        sources: [{ kind: 'wikipedia', url: 'https://en.wikipedia.org/wiki/Gothenburg_Cathedral' }],
      }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.sitelinks).toBe(12);
    expect(merged[0]!.pageLength).toBe(9000);
    expect(merged[0]!.wikipedia?.lang).toBe('en');
    expect(merged[0]!.sources).toHaveLength(2);
  });

  it('merges by normalised name within 50 m, keeps separate beyond', () => {
    const near = dedupeCandidates([
      candidate({ name: 'Skansen Kronan' }),
      candidate({ name: 'skansen kronan', lat: 57.7002, lon: 11.97 }),
    ]);
    expect(near).toHaveLength(1);
    const far = dedupeCandidates([
      candidate({ name: 'Skansen Kronan' }),
      candidate({ name: 'Skansen Kronan', lat: 57.705, lon: 11.97 }),
    ]);
    expect(far).toHaveLength(2);
  });

  it('prefers the English page when both languages carry one', () => {
    const merged = dedupeCandidates([
      candidate({ name: 'Domkyrkan', wikidataId: 'Q1', wikipedia: { lang: 'sv', title: 'Göteborgs domkyrka' } }),
      candidate({ name: 'Gothenburg Cathedral', wikidataId: 'Q1', wikipedia: { lang: 'en', title: 'Gothenburg Cathedral' } }),
    ]);
    expect(merged[0]!.wikipedia?.lang).toBe('en');
  });
});

describe('interestScore and signals', () => {
  it('weights sitelinks 0.4, length 0.2, heritage 0.2, type 0.2', () => {
    expect(interestScore(candidate({ sitelinks: 30 }))).toBe(40);
    expect(interestScore(candidate({ pageLength: 20000 }))).toBe(20);
    expect(interestScore(candidate({ heritage: true }))).toBe(20);
    expect(interestScore(candidate({ types: ['Q16970'] }))).toBe(20);
    expect(
      interestScore(candidate({ sitelinks: 60, pageLength: 50000, heritage: true, types: ['museum'] })),
    ).toBe(100);
  });

  it('drops unnamed and signal-less OSM candidates', () => {
    expect(hasSignal(candidate({ name: '' }))).toBe(false);
    expect(hasSignal(candidate({ types: ['milestone'] }))).toBe(false);
    expect(hasSignal(candidate({ types: ['castle'] }))).toBe(true);
    expect(hasSignal(candidate({ wikidataId: 'Q1' }))).toBe(true);
  });
});

describe('source adapters on saved Gothenburg responses', () => {
  it('reads Wikipedia geosearch pages with length and wikidata id', () => {
    const pages = geoPagesFromResponse(load<WikiQueryResponse>('wiki_geosearch_gbg_en.json'));
    expect(pages.length).toBeGreaterThan(50);
    const gothenburg = pages.find((p) => p.title === 'Gothenburg')!;
    expect(gothenburg.length).toBeGreaterThan(100_000);
    expect(gothenburg.wikidataId).toMatch(/^Q\d+$/);
    const candidates = pagesToCandidates('en', pages);
    expect(candidates[0]!.wikipedia?.lang).toBe('en');
  });

  it('reads Wikidata items with sitelinks, heritage and types', () => {
    const items = parseSparqlResults(load('wikidata_around_gbg.json'));
    expect(items.length).toBeGreaterThan(300);
    expect(items.some((i) => i.heritage)).toBe(true);
    expect(items.every((i) => i.id.startsWith('Q'))).toBe(true);
    const candidates = itemsToCandidates(items);
    expect(candidates.every((c) => c.name.length > 0)).toBe(true);
  });

  it('reads OSM elements with centre fallback and wikipedia tags', () => {
    const json = load<{ elements: OsmPlaceElement[] }>('osm_places_gbg.json');
    const candidates = elementsToCandidates(json.elements);
    expect(candidates.length).toBeGreaterThan(20);
    expect(candidates.every((c) => Number.isFinite(c.lat) && Number.isFinite(c.lon))).toBe(true);
    expect(candidates.some((c) => c.wikidataId)).toBe(true);
  });
});

describe('buildPlaces on the central Gothenburg loop', () => {
  const candidates = [
    ...pagesToCandidates('en', geoPagesFromResponse(load('wiki_geosearch_gbg_en.json'))),
    ...pagesToCandidates('sv', geoPagesFromResponse(load('wiki_geosearch_gbg_sv.json'))),
    ...itemsToCandidates(parseSparqlResults(load('wikidata_around_gbg.json'))),
    ...elementsToCandidates(load<{ elements: OsmPlaceElement[] }>('osm_places_gbg.json').elements),
  ];

  it('yields a sensible list of 10–25 places ordered by distance', () => {
    const places = buildPlaces(lats, lons, candidates);
    expect(places.length).toBeGreaterThanOrEqual(10);
    expect(places.length).toBeLessThanOrEqual(25);
    for (let i = 1; i < places.length; i++) {
      expect(places[i]!.d).toBeGreaterThan(places[i - 1]!.d);
    }
    // No two closer than minSpacing along the course.
    for (let i = 1; i < places.length; i++) {
      expect(places[i]!.d - places[i - 1]!.d).toBeGreaterThanOrEqual(200);
    }
    // Every place sits inside the corridor and has a positive score.
    for (const p of places) {
      expect(p.offset).toBeLessThanOrEqual(80);
      expect(p.score).toBeGreaterThan(0);
      expect(p.triggerD).toBeLessThanOrEqual(p.d);
    }
  });

  it('excludes the city item itself and keeps named landmarks', () => {
    const places = buildPlaces(lats, lons, candidates);
    expect(places.some((p) => p.name === 'Gothenburg')).toBe(false);
    expect(places.some((p) => p.score >= 40)).toBe(true);
  });

  it('merges the same landmark arriving from several sources', () => {
    const places = buildPlaces(lats, lons, candidates);
    const multiSource = places.filter((p) => new Set(p.sources.map((s) => s.kind)).size >= 2);
    expect(multiSource.length).toBeGreaterThan(0);
  });
});

describe('sampleCenters', () => {
  it('covers the course with centres spaced by ~1.2 radii', () => {
    const centers = sampleCenters(lats, lons, 1000);
    expect(centers.length).toBeGreaterThanOrEqual(3);
    expect(centers[0]!.lat).toBe(lats[0]!);
  });
});
