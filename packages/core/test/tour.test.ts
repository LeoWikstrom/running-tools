import { describe, expect, it } from 'vitest';
import { DEFAULT_TOUR_SETTINGS, tourToGpx, validateTour, type Tour } from '../src/tour/types';

const tour: Tour = {
  version: 1,
  id: 'abc123',
  name: 'Central Gothenburg loop',
  lang: 'en',
  createdAt: '2026-10-23T12:00:00Z',
  route: {
    points: [
      [57.7072, 11.9668],
      [57.704, 11.965, 12.5],
      [57.7072, 11.9668],
    ],
    distance: 5100,
  },
  settings: { ...DEFAULT_TOUR_SETTINGS },
  places: [
    {
      id: 'Q1',
      name: 'Gothenburg Cathedral',
      lat: 57.704,
      lon: 11.9653,
      d: 810,
      triggerD: 780,
      score: 63,
      sources: [{ kind: 'wikipedia', url: 'https://en.wikipedia.org/wiki/Gothenburg_Cathedral' }],
      text: 'You are passing Gothenburg Cathedral. It was consecrated in 1815.',
    },
  ],
};

describe('validateTour', () => {
  it('accepts a round-tripped tour', () => {
    const back = validateTour(JSON.parse(JSON.stringify(tour)));
    expect(back.places[0]!.name).toBe('Gothenburg Cathedral');
  });

  it('rejects wrong versions, missing routes and broken places', () => {
    expect(() => validateTour({ ...tour, version: 2 })).toThrow(/version/);
    expect(() => validateTour({ ...tour, route: { points: [], distance: 1 } })).toThrow(/points/);
    expect(() =>
      validateTour({ ...tour, places: [{ ...tour.places[0], text: undefined }] }),
    ).toThrow(/text/);
    expect(() => validateTour('nope')).toThrow(/object/);
  });
});

describe('tourToGpx', () => {
  it('writes places as waypoints and the course as a track', () => {
    const gpx = tourToGpx(tour);
    expect(gpx).toContain('<wpt lat="57.7040000"');
    expect(gpx).toContain('<name>Gothenburg Cathedral</name>');
    expect(gpx).toContain('<trkpt lat="57.7072000"');
    expect(gpx).toContain('<ele>12.5</ele>');
    // XML-escapes text content.
    const withAmp = {
      ...tour,
      places: [{ ...tour.places[0]!, name: 'Fish & Chips', text: 'a < b' }],
    };
    const escaped = tourToGpx(withAmp);
    expect(escaped).toContain('Fish &amp; Chips');
    expect(escaped).toContain('a &lt; b');
  });
});
