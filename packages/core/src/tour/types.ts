import type { PlaceSource } from '../poi/types';

export interface TourRoute {
  /** [lat, lon] or [lat, lon, ele]. */
  points: number[][];
  /** Total course length, metres. */
  distance: number;
}

export interface TourSettings {
  corridorWidth: number;
  minSpacing: number;
  leadDistance: number;
  paceSecPerKm: number;
  targetSeconds: number;
  /** Player trigger window; absent on older tours, the player uses its default. */
  triggerWindowM?: number;
  /** Player queue-drop distance; absent on older tours, the player defaults. */
  dropAfterM?: number;
}

/** A historical photo of the place, shown while its clip plays. */
export interface TourPlaceImage {
  /** Direct (thumb) image URL. */
  url: string;
  /** The Commons file page, for the licence trail. */
  pageUrl: string;
  /** "Artist · licence · Wikimedia Commons" — Commons licences require it. */
  attribution: string;
  year?: number;
}

export interface TourPlace {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** Distance along the course, metres. */
  d: number;
  /** Where the audio starts, metres along the course. */
  triggerD: number;
  score: number;
  sources: PlaceSource[];
  text: string;
  /** Audio file name inside the tour's directory, when synthesised. */
  audio?: string;
  /** The text needs a human eye: wrong language, or hand-written. */
  needsReview?: boolean;
  image?: TourPlaceImage;
}

export interface Tour {
  version: 1;
  id: string;
  name: string;
  /** Narration language (BCP-47-ish, e.g. "en"). */
  lang: string;
  createdAt: string;
  route: TourRoute;
  settings: TourSettings;
  places: TourPlace[];
}

export const DEFAULT_TOUR_SETTINGS: TourSettings = {
  corridorWidth: 80,
  minSpacing: 200,
  leadDistance: 30,
  paceSecPerKm: 330,
  targetSeconds: 40,
};

function fail(msg: string): never {
  throw new Error(`Not a valid tour.json: ${msg}`);
}

/** Validate a parsed tour.json; throws with a readable reason. */
export function validateTour(json: unknown): Tour {
  if (typeof json !== 'object' || json === null) fail('not an object');
  const t = json as Record<string, unknown>;
  if (t.version !== 1) fail(`unsupported version ${String(t.version)}`);
  if (typeof t.id !== 'string' || t.id.length === 0) fail('missing id');
  if (typeof t.name !== 'string') fail('missing name');
  if (typeof t.lang !== 'string') fail('missing lang');
  if (typeof t.createdAt !== 'string') fail('missing createdAt');

  const route = t.route as Record<string, unknown> | undefined;
  if (!route || !Array.isArray(route.points) || route.points.length < 2) {
    fail('route needs at least two points');
  }
  for (const p of route.points as unknown[]) {
    if (
      !Array.isArray(p) ||
      p.length < 2 ||
      typeof p[0] !== 'number' ||
      typeof p[1] !== 'number'
    ) {
      fail('route points must be [lat, lon] arrays');
    }
  }
  if (typeof route.distance !== 'number' || route.distance <= 0) fail('bad route distance');

  const s = t.settings as Record<string, unknown> | undefined;
  if (!s) fail('missing settings');
  for (const field of [
    'corridorWidth',
    'minSpacing',
    'leadDistance',
    'paceSecPerKm',
    'targetSeconds',
  ]) {
    if (typeof s[field] !== 'number') fail(`settings.${field} missing`);
  }
  for (const field of ['triggerWindowM', 'dropAfterM']) {
    if (s[field] !== undefined && typeof s[field] !== 'number') {
      fail(`settings.${field} must be a number`);
    }
  }

  if (!Array.isArray(t.places)) fail('missing places');
  for (const raw of t.places as unknown[]) {
    const p = raw as Record<string, unknown>;
    if (typeof p.id !== 'string' || typeof p.name !== 'string') fail('place needs id and name');
    for (const field of ['lat', 'lon', 'd', 'triggerD', 'score']) {
      if (typeof p[field] !== 'number') fail(`place ${String(p.name)}: ${field} missing`);
    }
    if (typeof p.text !== 'string') fail(`place ${String(p.name)}: text missing`);
    if (!Array.isArray(p.sources)) fail(`place ${String(p.name)}: sources missing`);
    if (p.image !== undefined) {
      const img = p.image as Record<string, unknown>;
      for (const field of ['url', 'pageUrl', 'attribution']) {
        if (typeof img[field] !== 'string') fail(`place ${String(p.name)}: image.${field} bad`);
      }
    }
  }
  return json as Tour;
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The tour as GPX: the course as a track, the places as waypoints. */
export function tourToGpx(tour: Tour): string {
  const wpts = tour.places
    .map(
      (p) =>
        `  <wpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">\n` +
        `    <name>${esc(p.name)}</name>\n` +
        `    <desc>${esc(p.text)}</desc>\n` +
        `  </wpt>`,
    )
    .join('\n');
  const trkpts = tour.route.points
    .map((p) => {
      const ele = p.length > 2 ? `<ele>${p[2]!.toFixed(1)}</ele>` : '';
      return `      <trkpt lat="${p[0]!.toFixed(7)}" lon="${p[1]!.toFixed(7)}">${ele}</trkpt>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="runtour" xmlns="http://www.topografix.com/GPX/1/1">
${wpts}
  <trk>
    <name>${esc(tour.name)}</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>
`;
}
