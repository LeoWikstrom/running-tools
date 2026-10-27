import { cacheGet, cacheSet } from '../net/cache';
import { haversineMeters } from '../geo';
import type { PlaceCandidate } from './types';

export interface WikiGeoPage {
  pageid: number;
  title: string;
  /** Page length in bytes. */
  length: number;
  lat: number;
  lon: number;
  wikidataId?: string;
}

interface QueryPage {
  pageid: number;
  title: string;
  length?: number;
  coordinates?: { lat: number; lon: number }[];
  pageprops?: { wikibase_item?: string };
}

export interface WikiQueryResponse {
  query?: { pages?: Record<string, QueryPage> };
  continue?: Record<string, string>;
}

/** Pages with coordinates out of a raw API query response. */
export function geoPagesFromResponse(json: WikiQueryResponse): WikiGeoPage[] {
  return toGeoPages(Object.values(json.query?.pages ?? {}));
}

export interface WikiFetchOptions {
  fetchFn?: typeof fetch;
}

const GEOSEARCH_MAX_RADIUS = 10_000;

async function runQuery(
  lang: string,
  params: Record<string, string>,
  key: string | null,
  options: WikiFetchOptions,
): Promise<QueryPage[]> {
  if (key) {
    const cached = await cacheGet<QueryPage[]>(key);
    if (cached) return cached;
  }
  const fetchFn = options.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  // With a generator plus several props the API answers in instalments: a page
  // can arrive without its coordinates and get them in a later round, and a
  // dense area (central Gothenburg on sv.wikipedia) overflows one answer
  // entirely. Follow `continue` and merge per pageid, or places silently vanish.
  const byId = new Map<number, QueryPage>();
  let cont: Record<string, string> = {};
  for (let round = 0; round < 12; round++) {
    const search = new URLSearchParams({
      action: 'query',
      format: 'json',
      origin: '*',
      prop: 'info|coordinates|pageprops',
      ppprop: 'wikibase_item',
      colimit: 'max',
      ...params,
      ...cont,
    });
    const res = await fetchFn(`https://${lang}.wikipedia.org/w/api.php?${search.toString()}`);
    if (!res.ok) throw new Error(`Wikipedia ${lang} returned ${res.status}`);
    const json = (await res.json()) as WikiQueryResponse;
    for (const p of Object.values(json.query?.pages ?? {})) {
      const seen = byId.get(p.pageid);
      if (!seen) byId.set(p.pageid, { ...p });
      else {
        seen.coordinates ??= p.coordinates;
        seen.pageprops ??= p.pageprops;
        seen.length ??= p.length;
      }
    }
    if (!json.continue) break;
    cont = json.continue;
  }
  const pages = [...byId.values()];
  if (key) await cacheSet(key, pages);
  return pages;
}

function toGeoPages(pages: QueryPage[]): WikiGeoPage[] {
  const out: WikiGeoPage[] = [];
  for (const p of pages) {
    const coord = p.coordinates?.[0];
    if (!coord) continue;
    out.push({
      pageid: p.pageid,
      title: p.title,
      length: p.length ?? 0,
      lat: coord.lat,
      lon: coord.lon,
      wikidataId: p.pageprops?.wikibase_item,
    });
  }
  return out;
}

/** Pages with coordinates within radiusMeters of the centre, with page length and Wikidata id. */
export async function geosearch(
  lang: string,
  lat: number,
  lon: number,
  radiusMeters: number,
  options: WikiFetchOptions = {},
): Promise<WikiGeoPage[]> {
  const radius = Math.min(Math.round(radiusMeters), GEOSEARCH_MAX_RADIUS);
  // v2: v1 entries predate continuation and are truncated.
  const key = `wikigeo:v2:${lang}:${lat.toFixed(3)},${lon.toFixed(3)},${Math.round(radius / 100)}`;
  const pages = await runQuery(
    lang,
    {
      generator: 'geosearch',
      ggscoord: `${lat}|${lon}`,
      ggsradius: String(radius),
      ggslimit: '500',
    },
    key,
    options,
  );
  return toGeoPages(pages);
}

/** Full-text title search; only pages with coordinates come back. Not cached. */
export async function searchByName(
  lang: string,
  text: string,
  options: WikiFetchOptions = {},
): Promise<WikiGeoPage[]> {
  const pages = await runQuery(
    lang,
    { generator: 'search', gsrsearch: text, gsrlimit: '10' },
    null,
    options,
  );
  return toGeoPages(pages);
}

/**
 * Centres spaced along the course so that circles of `radiusMeters` cover a
 * corridor around every point of it.
 */
export function sampleCenters(
  lats: ArrayLike<number>,
  lons: ArrayLike<number>,
  radiusMeters: number,
): { lat: number; lon: number }[] {
  const n = lats.length;
  if (n === 0) return [];
  const spacing = radiusMeters * 1.2;
  const centers = [{ lat: lats[0]!, lon: lons[0]! }];
  let sinceLast = 0;
  for (let i = 1; i < n; i++) {
    sinceLast += haversineMeters(lats[i - 1]!, lons[i - 1]!, lats[i]!, lons[i]!);
    if (sinceLast >= spacing) {
      centers.push({ lat: lats[i]!, lon: lons[i]! });
      sinceLast = 0;
    }
  }
  return centers;
}

export function pageUrl(lang: string, title: string): string {
  return `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replaceAll(' ', '_'))}`;
}

/** Geosearch pages from one language edition as place candidates. */
export function pagesToCandidates(lang: string, pages: WikiGeoPage[]): PlaceCandidate[] {
  return pages.map((p) => ({
    name: p.title,
    lat: p.lat,
    lon: p.lon,
    wikidataId: p.wikidataId,
    wikipedia: { lang, title: p.title },
    pageLength: p.length,
    types: [],
    sources: [{ kind: 'wikipedia', url: pageUrl(lang, p.title) }],
  }));
}
