import { describe, expect, it } from 'vitest';
import {
  assembleGtfsLines,
  chooseRepresentatives,
  decodePolyline,
  encodePolyline,
  gtfsKind,
  gtfsLineToBusLineData,
  parseCsvLine,
  type GtfsRoute,
  type GtfsTrip,
} from '../src/net/gtfsLines';

describe('polyline codec', () => {
  it('round-trips coordinates at 1e-5 precision', () => {
    const points = [
      { lat: 57.70887, lon: 11.97456 },
      { lat: 57.70901, lon: 11.97502 },
      { lat: 57.70774, lon: 11.98033 },
      { lat: -0.00001, lon: -179.99999 },
    ];
    const decoded = decodePolyline(encodePolyline(points));
    expect(decoded).toHaveLength(points.length);
    for (let i = 0; i < points.length; i++) {
      expect(decoded[i]!.lat).toBeCloseTo(points[i]!.lat, 5);
      expect(decoded[i]!.lon).toBeCloseTo(points[i]!.lon, 5);
    }
  });

  it('matches the reference encoding from the Google example', () => {
    // developers.google.com/maps/documentation/utilities/polylinealgorithm
    const points = [
      { lat: 38.5, lon: -120.2 },
      { lat: 40.7, lon: -120.95 },
      { lat: 43.252, lon: -126.453 },
    ];
    expect(encodePolyline(points)).toBe('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  });
});

describe('parseCsvLine', () => {
  it('splits plain fields and strips CR', () => {
    expect(parseCsvLine('a,b,c\r')).toEqual(['a', 'b', 'c']);
  });

  it('handles quoted commas and doubled quotes', () => {
    expect(parseCsvLine('1,"Nils Ericson, läge A","He said ""hej"""')).toEqual([
      '1',
      'Nils Ericson, läge A',
      'He said "hej"',
    ]);
  });

  it('keeps empty trailing fields', () => {
    expect(parseCsvLine('a,,')).toEqual(['a', '', '']);
  });
});

describe('gtfsKind', () => {
  it('maps route types', () => {
    expect(gtfsKind(3)).toBe('bus');
    expect(gtfsKind(700)).toBe('bus');
    expect(gtfsKind(715)).toBe('bus');
    expect(gtfsKind(0)).toBe('tram');
    expect(gtfsKind(900)).toBe('tram');
    expect(gtfsKind(2)).toBeNull(); // rail
    expect(gtfsKind(1000)).toBeNull(); // ferry
  });
});

const routes: GtfsRoute[] = [
  { routeId: 'r16', shortName: '16', longName: '', routeType: 700 },
  { routeId: 'r3', shortName: '3', longName: 'Spårvagn 3', routeType: 900 },
  { routeId: 'train', shortName: 'RE1', longName: '', routeType: 100 },
];

const trips: GtfsTrip[] = [
  { routeId: 'r16', tripId: 't1', directionId: '0', shapeId: 's-a', headsign: 'Eketrägatan' },
  { routeId: 'r16', tripId: 't2', directionId: '0', shapeId: 's-a', headsign: 'Eketrägatan' },
  { routeId: 'r16', tripId: 't3', directionId: '0', shapeId: 's-rare', headsign: 'Depån' },
  { routeId: 'r16', tripId: 't4', directionId: '1', shapeId: 's-b', headsign: 'Högsbohöjd' },
  { routeId: 'r3', tripId: 't5', directionId: '0', shapeId: 's-c', headsign: 'Marklandsgatan' },
  { routeId: 'train', tripId: 't6', directionId: '0', shapeId: 's-d', headsign: 'Alingsås' },
];

describe('chooseRepresentatives', () => {
  it('picks the most common shape per route and direction, skipping non-bus/tram', () => {
    const reps = chooseRepresentatives(routes, trips);
    const keys = reps.map((r) => `${r.route.routeId}/${r.shapeId}/${r.headsign}`).sort();
    expect(keys).toEqual([
      'r16/s-a/Eketrägatan',
      'r16/s-b/Högsbohöjd',
      'r3/s-c/Marklandsgatan',
    ]);
  });
});

describe('assembleGtfsLines + gtfsLineToBusLineData', () => {
  it('builds sorted, decodable lines with ordered stops and a covering bbox', () => {
    const reps = chooseRepresentatives(routes, trips);
    const shapes = new Map([
      ['s-a', [{ lat: 57.7, lon: 11.95 }, { lat: 57.71, lon: 11.97 }]],
      ['s-b', [{ lat: 57.71, lon: 11.97 }, { lat: 57.7, lon: 11.95 }]],
      ['s-c', [{ lat: 57.69, lon: 11.96 }, { lat: 57.72, lon: 11.99 }]],
    ]);
    const stops = new Map([
      ['st1', { name: 'Första', lat: 57.7, lon: 11.95 }],
      ['st2', { name: 'Sista', lat: 57.71, lon: 11.97 }],
    ]);
    const stopIdsByTrip = new Map([
      ['t1', ['st1', 'st2']],
      ['t4', ['st2', 'st1']],
      ['t5', ['st1', 'st2']],
    ]);
    const feed = assembleGtfsLines('vt', reps, stopIdsByTrip, stops, shapes);
    expect(feed.lines.map((l) => l.ref)).toEqual(['3', '16', '16']);
    expect(feed.bbox.south).toBeCloseTo(57.69, 5);
    expect(feed.bbox.east).toBeCloseTo(11.99, 5);

    const bus = gtfsLineToBusLineData(feed.lines[1]!, 1);
    expect(bus.id).toBe(-2);
    expect(bus.kind).toBe('bus');
    expect(bus.points).toHaveLength(2);
    expect(bus.stops.map((s) => s.name)).toEqual(['Första', 'Sista']);
    expect(bus.gaps).toBe(0);
  });

  it('falls back to the last stop as destination when the headsign is empty', () => {
    const reps = chooseRepresentatives(
      [{ routeId: 'r', shortName: '25', longName: '', routeType: 700 }],
      [{ routeId: 'r', tripId: 't', directionId: '0', shapeId: 's', headsign: '' }],
    );
    const feed = assembleGtfsLines(
      'vt',
      reps,
      new Map([['t', ['a', 'b']]]),
      new Map([
        ['a', { name: 'Start', lat: 57.7, lon: 11.9 }],
        ['b', { name: 'Länsmansgården', lat: 57.72, lon: 11.92 }],
      ]),
      new Map([['s', [{ lat: 57.7, lon: 11.9 }, { lat: 57.72, lon: 11.92 }]]]),
    );
    expect(feed.lines[0]!.to).toBe('Länsmansgården');
  });

  it('drops a rep whose shape or stops are missing', () => {
    const reps = chooseRepresentatives(routes, trips);
    const feed = assembleGtfsLines('vt', reps, new Map(), new Map(), new Map());
    expect(feed.lines).toHaveLength(0);
  });
});
