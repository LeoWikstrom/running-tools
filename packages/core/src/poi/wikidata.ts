import { cacheGet, cacheSet } from '../net/cache';
import type { PlaceCandidate } from './types';

export interface WikidataItem {
  id: string;
  label: string;
  lat: number;
  lon: number;
  sitelinks: number;
  heritage: boolean;
  types: string[];
  website?: string;
  image?: string;
}

interface SparqlBinding {
  [variable: string]: { value: string } | undefined;
}

export interface WikidataFetchOptions {
  fetchFn?: typeof fetch;
  languages?: string;
}

const ENDPOINT = 'https://query.wikidata.org/sparql';

function buildQuery(lat: number, lon: number, radiusKm: number, languages: string): string {
  return `
SELECT ?item ?itemLabel ?lat ?lon ?sitelinks
       (SAMPLE(?heritageV) AS ?heritage)
       (SAMPLE(?websiteV) AS ?website)
       (SAMPLE(?imageV) AS ?image)
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
  OPTIONAL { ?item wdt:P856 ?websiteV . }
  OPTIONAL { ?item wdt:P18 ?imageV . }
  BIND(geof:latitude(?coord) AS ?lat)
  BIND(geof:longitude(?coord) AS ?lon)
  SERVICE wikibase:label { bd:serviceParam wikibase:language "${languages}". }
}
GROUP BY ?item ?itemLabel ?lat ?lon ?sitelinks
LIMIT 2000`;
}

export function parseSparqlResults(json: {
  results?: { bindings?: SparqlBinding[] };
}): WikidataItem[] {
  const out: WikidataItem[] = [];
  for (const b of json.results?.bindings ?? []) {
    const id = b.item?.value.split('/entity/')[1];
    const lat = Number(b.lat?.value);
    const lon = Number(b.lon?.value);
    if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const label = b.itemLabel?.value ?? '';
    out.push({
      id,
      // An unlabelled item echoes its own id as the label; treat that as no name.
      label: label === id ? '' : label,
      lat,
      lon,
      sitelinks: Number(b.sitelinks?.value ?? 0),
      heritage: b.heritage !== undefined,
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
  const key = `wikidata:v1:${lat.toFixed(3)},${lon.toFixed(3)},${radiusKm.toFixed(1)}`;
  const cached = await cacheGet<WikidataItem[]>(key);
  if (cached) return cached;
  const fetchFn = options.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const query = buildQuery(lat, lon, radiusKm, options.languages ?? 'en,sv,mul');
  const res = await fetchFn(`${ENDPOINT}?query=${encodeURIComponent(query)}&format=json`, {
    headers: { Accept: 'application/sparql-results+json' },
  });
  if (!res.ok) throw new Error(`Wikidata query service returned ${res.status}`);
  const items = parseSparqlResults(
    (await res.json()) as { results?: { bindings?: SparqlBinding[] } },
  );
  await cacheSet(key, items);
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
      sitelinks: i.sitelinks,
      heritage: i.heritage || undefined,
      types: i.types,
      website: i.website,
      image: i.image,
      sources: [{ kind: 'wikidata' as const, url: `https://www.wikidata.org/wiki/${i.id}` }],
    }));
}
