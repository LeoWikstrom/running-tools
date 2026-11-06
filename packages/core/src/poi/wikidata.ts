import { cacheGetFresh, cacheSetStamped } from '../net/cache';
import { fetchWithTimeout } from '../net/fetchWithTimeout';
import type { PlaceCandidate } from './types';

/** Wikipedia/Wikidata data lives; a month-old answer is worth refetching. */
const POI_TTL_MS = 30 * 24 * 3600 * 1000;

export interface WikidataItem {
  id: string;
  label: string;
  lat: number;
  lon: number;
  sitelinks: number;
  heritage: boolean;
  /** Carries a Wikidata dissolution/demolition (P576) or closure (P3999)
      date — the place no longer exists. */
  defunct: boolean;
  types: string[];
  website?: string;
  image?: string;
  /** Wikipedia article titles by language, from the item's sitelinks — the
      only road to a local-language page that carries no coordinates itself. */
  articles?: { lang: string; title: string }[];
}

interface SparqlBinding {
  [variable: string]: { value: string } | undefined;
}

export interface WikidataFetchOptions {
  fetchFn?: typeof fetch;
  languages?: string;
  /** Wikipedias whose article titles to fetch via sitelinks. */
  wikiLangs?: string[];
}

const ENDPOINT = 'https://query.wikidata.org/sparql';

function buildQuery(
  lat: number,
  lon: number,
  radiusKm: number,
  languages: string,
  wikiLangs: string[],
): string {
  const articleSelect = wikiLangs
    .map((_, i) => `(SAMPLE(?articleV${i}) AS ?article${i})`)
    .join('\n       ');
  const articleWhere = wikiLangs
    .map(
      (l, i) =>
        `OPTIONAL { ?articleV${i} schema:about ?item ; schema:isPartOf <https://${l}.wikipedia.org/> . }`,
    )
    .join('\n  ');
  return `
SELECT ?item ?itemLabel ?lat ?lon ?sitelinks
       (SAMPLE(?heritageV) AS ?heritage)
       (SAMPLE(?defunctV) AS ?defunct)
       (SAMPLE(?websiteV) AS ?website)
       (SAMPLE(?imageV) AS ?image)
       ${articleSelect}
       (GROUP_CONCAT(DISTINCT STRAFTER(STR(?typeV), "entity/"); separator=",") AS ?types)
WHERE {
  SERVICE wikibase:around {
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:center "Point(${lon.toFixed(5)} ${lat.toFixed(5)})"^^geo:wktLiteral .
    bd:serviceParam wikibase:radius "${radiusKm.toFixed(2)}" .
  }
  ?item wikibase:sitelinks ?sitelinks .
  FILTER(?sitelinks > 0)
  OPTIONAL { ?item wdt:P31 ?typeV . }
  OPTIONAL { ?item wdt:P1435 ?heritageV . }
  OPTIONAL { ?item wdt:P576 ?defunctV . }
  OPTIONAL { ?item wdt:P3999 ?defunctV . }
  OPTIONAL { ?item wdt:P856 ?websiteV . }
  OPTIONAL { ?item wdt:P18 ?imageV . }
  ${articleWhere}
  BIND(geof:latitude(?coord) AS ?lat)
  BIND(geof:longitude(?coord) AS ?lon)
  SERVICE wikibase:label { bd:serviceParam wikibase:language "${languages}". }
}
GROUP BY ?item ?itemLabel ?lat ?lon ?sitelinks
LIMIT 2000`;
}

function articleTitle(url: string): string | null {
  const path = url.split('/wiki/')[1];
  if (!path) return null;
  try {
    return decodeURIComponent(path).replace(/_/g, ' ');
  } catch {
    return null;
  }
}

export function parseSparqlResults(
  json: {
    results?: { bindings?: SparqlBinding[] };
  },
  wikiLangs: string[] = [],
): WikidataItem[] {
  const out: WikidataItem[] = [];
  for (const b of json.results?.bindings ?? []) {
    const id = b.item?.value.split('/entity/')[1];
    const lat = Number(b.lat?.value);
    const lon = Number(b.lon?.value);
    if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const label = b.itemLabel?.value ?? '';
    const articles: { lang: string; title: string }[] = [];
    wikiLangs.forEach((lang, i) => {
      const url = b[`article${i}`]?.value;
      const title = url ? articleTitle(url) : null;
      if (title) articles.push({ lang, title });
    });
    out.push({
      articles: articles.length > 0 ? articles : undefined,
      id,
      // An unlabelled item echoes its own id as the label; treat that as no name.
      label: label === id ? '' : label,
      lat,
      lon,
      sitelinks: Number(b.sitelinks?.value ?? 0),
      heritage: b.heritage !== undefined,
      defunct: b.defunct !== undefined,
      types: (b.types?.value ?? '').split(',').filter((t) => t.length > 0),
      website: b.website?.value,
      image: b.image?.value,
    });
  }
  return out;
}

/** Wikidata items with coordinates within radiusKm of the centre. */
export async function fetchItemsAround(
  lat: number,
  lon: number,
  radiusKm: number,
  options: WikidataFetchOptions = {},
): Promise<WikidataItem[]> {
  const wikiLangs = options.wikiLangs ?? ['en'];
  const key = `wikidata:v2:${lat.toFixed(3)},${lon.toFixed(3)},${radiusKm.toFixed(1)},${wikiLangs.join('+')}`;
  const cached = await cacheGetFresh<WikidataItem[]>(key, POI_TTL_MS);
  if (cached) return cached;
  const fetchFn = options.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const query = buildQuery(lat, lon, radiusKm, options.languages ?? 'en,sv,mul', wikiLangs);
  const url = `${ENDPOINT}?query=${encodeURIComponent(query)}&format=json`;
  const init = { headers: { Accept: 'application/sparql-results+json' } };
  let res = await fetchWithTimeout(fetchFn, url, init, 30_000);
  if (res.status === 429) {
    // The query service rate-limits; wait what it asks (capped) and retry once.
    const retryAfter = Number(res.headers.get('Retry-After') ?? '5');
    const waitS = Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 5, 60);
    await new Promise((r) => setTimeout(r, waitS * 1000));
    res = await fetchWithTimeout(fetchFn, url, init, 30_000);
  }
  if (!res.ok) throw new Error(`Wikidata query service returned ${res.status}`);
  const items = parseSparqlResults(
    (await res.json()) as { results?: { bindings?: SparqlBinding[] } },
    wikiLangs,
  );
  await cacheSetStamped(key, items);
  return items;
}

export function itemsToCandidates(items: WikidataItem[]): PlaceCandidate[] {
  return items
    .filter((i) => i.label.length > 0)
    .map((i) => ({
      name: i.label,
      lat: i.lat,
      lon: i.lon,
      wikidataId: i.id,
      wikipedia: i.articles?.find((a) => a.lang === 'en') ?? i.articles?.[0],
      wikipedias: i.articles,
      sitelinks: i.sitelinks,
      heritage: i.heritage || undefined,
      defunct: i.defunct || undefined,
      types: i.types,
      website: i.website,
      image: i.image,
      sources: [{ kind: 'wikidata' as const, url: `https://www.wikidata.org/wiki/${i.id}` }],
    }));
}
