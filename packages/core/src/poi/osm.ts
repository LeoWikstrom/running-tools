import { haversineMeters } from '../geo';
import { fetchOverpass, type FetchNetworkOptions } from '../net/overpass';
import type { PlaceCandidate } from './types';

/** Overpass element from an `out center tags` places query. */
export interface OsmPlaceElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

const TOURISM_VALUES = '^(attraction|museum|gallery|artwork|viewpoint)$';

/**
 * Historic and tourist POIs within `widthMeters` of the course, queried with
 * Overpass's linestring `around`. The course is thinned to keep the query
 * body reasonable.
 */
export function buildPlacesQuery(
  lats: ArrayLike<number>,
  lons: ArrayLike<number>,
  widthMeters: number,
): string {
  const coords: string[] = [];
  const n = lats.length;
  let lastLat = Infinity;
  let lastLon = Infinity;
  for (let i = 0; i < n; i++) {
    if (i > 0 && i < n - 1 && haversineMeters(lastLat, lastLon, lats[i]!, lons[i]!) < 100) {
      continue;
    }
    lastLat = lats[i]!;
    lastLon = lons[i]!;
    coords.push(lats[i]!.toFixed(5), lons[i]!.toFixed(5));
  }
  const around = `(around:${Math.round(widthMeters)},${coords.join(',')})`;
  return (
    `[out:json][timeout:60];(` +
    `node[historic]${around};` +
    `way[historic]${around};` +
    `node[tourism~"${TOURISM_VALUES}"]${around};` +
    `way[tourism~"${TOURISM_VALUES}"]${around};` +
    `);out center tags;`
  );
}

export async function fetchOsmPlaces(
  lats: ArrayLike<number>,
  lons: ArrayLike<number>,
  widthMeters: number,
  options: FetchNetworkOptions = {},
): Promise<OsmPlaceElement[]> {
  const mid = Math.floor(lats.length / 2);
  const key = `osmplaces:v1:${lats[0]?.toFixed(4)},${lons[0]?.toFixed(4)}:${lats[mid]?.toFixed(4)},${lons[mid]?.toFixed(4)}:${lats.length}:${Math.round(widthMeters)}`;
  const response = await fetchOverpass(buildPlacesQuery(lats, lons, widthMeters), key, options);
  return response.elements as unknown as OsmPlaceElement[];
}

export function elementsToCandidates(elements: OsmPlaceElement[]): PlaceCandidate[] {
  const out: PlaceCandidate[] = [];
  for (const el of elements) {
    const tags = el.tags;
    if (!tags) continue;
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat === undefined || lon === undefined) continue;
    const name = tags['name:en'] ?? tags.name;
    if (!name) continue;
    const types: string[] = [];
    if (tags.historic) types.push(tags.historic);
    if (tags.tourism) types.push(tags.tourism);
    let wikipedia: { lang: string; title: string } | undefined;
    const wp = tags.wikipedia;
    if (wp && wp.includes(':')) {
      const i = wp.indexOf(':');
      wikipedia = { lang: wp.slice(0, i), title: wp.slice(i + 1) };
    }
    out.push({
      name,
      lat,
      lon,
      wikidataId: tags.wikidata,
      wikipedia,
      heritage: tags.heritage !== undefined && tags.heritage !== 'no' ? true : undefined,
      types,
      website: tags.website,
      sources: [{ kind: 'osm', url: `https://www.openstreetmap.org/${el.type}/${el.id}` }],
    });
  }
  return out;
}
