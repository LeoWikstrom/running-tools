import { describe, expect, it } from 'vitest';
import { buildPlaces } from '../src/poi/pipeline';
import { isSquarePlace, isStreetPlace } from '../src/poi/score';
import { stripLocationSentences } from '../src/text/trim';
import type { PlaceCandidate } from '../src/poi/types';

function candidate(over: Partial<PlaceCandidate>): PlaceCandidate {
  return {
    name: 'Place',
    lat: 57.7,
    lon: 11.975,
    wikidataId: 'Q1',
    sitelinks: 20,
    types: [],
    sources: [{ kind: 'wikidata', url: 'https://www.wikidata.org/wiki/Q1' }],
    ...over,
  };
}

describe('street and square detection', () => {
  it('recognises streets by P31 and by name', () => {
    expect(isStreetPlace(candidate({ types: ['Q79007'] }))).toBe(true);
    expect(isStreetPlace(candidate({ name: 'Kristinelundsgatan' }))).toBe(true);
    expect(isStreetPlace(candidate({ name: 'Kungsportsavenyn' }))).toBe(true);
    expect(isStreetPlace(candidate({ name: 'Baker Street' }))).toBe(true);
    expect(isStreetPlace(candidate({ name: 'Skansen Kronan' }))).toBe(false);
  });

  it('recognises squares by P31 and by name', () => {
    expect(isSquarePlace(candidate({ types: ['Q174782'] }))).toBe(true);
    expect(isSquarePlace(candidate({ name: 'Järntorget' }))).toBe(true);
    expect(isSquarePlace(candidate({ name: 'Olof Palmes plats' }))).toBe(true);
    expect(isSquarePlace(candidate({ name: 'Domkyrkan' }))).toBe(false);
  });
});

describe('buildPlaces exclusion flags', () => {
  const lats = [57.7, 57.7];
  const lons = [11.97, 11.98];
  const street = candidate({ name: 'Storgatan', wikidataId: 'Q2' });
  const square = candidate({ name: 'Stora torget', wikidataId: 'Q3', lon: 11.976 });

  it('keeps both by default, drops each behind its flag', () => {
    expect(buildPlaces(lats, lons, [street, square], { minSpacing: 0 })).toHaveLength(2);
    const noStreets = buildPlaces(lats, lons, [street, square], {
      minSpacing: 0,
      excludeStreets: true,
    });
    expect(noStreets.map((p) => p.name)).toEqual(['Stora torget']);
    const neither = buildPlaces(lats, lons, [street, square], {
      excludeStreets: true,
      excludeSquares: true,
    });
    expect(neither).toHaveLength(0);
  });
});

describe('stripLocationSentences', () => {
  it('drops the where-it-is sentences, keeps the history', () => {
    const text =
      'Storgatan är en gata i centrala Göteborg. Den sträcker sig från Järntorget till ' +
      'Stigbergstorget. Gatan fick sitt namn år 1666. Här bodde många av stadens köpmän.';
    const out = stripLocationSentences(text);
    expect(out).toContain('namn år 1666');
    expect(out).toContain('köpmän');
    expect(out).not.toContain('sträcker sig');
  });

  it('keeps the text whole when every sentence is location', () => {
    const text = 'The street runs from A to B. It is located in the old town.';
    expect(stripLocationSentences(text)).toBe(text);
  });
});
