import { fetchOsmPlaces, elementsToCandidates } from '@running/core/poi/osm';
import {
  geosearch,
  pagesToCandidates,
  sampleCenters,
  searchByName,
} from '@running/core/poi/wikipedia';
import { fetchItemsAround, itemsToCandidates } from '@running/core/poi/wikidata';
import type { PlaceCandidate } from '@running/core/poi/types';

const CENTER_RADIUS_M = 2500;
/** OSM corridor is wider than the place corridor: squares and parks are big. */
const OSM_CORRIDOR_M = 150;

export interface FetchReport {
  candidates: PlaceCandidate[];
  failures: string[];
}

/** Fetch place candidates from all three sources along the course. */
export async function fetchCandidates(
  lats: number[],
  lons: number[],
  localLang: string,
  onProgress: (text: string) => void,
): Promise<FetchReport> {
  const centers = sampleCenters(lats, lons, CENTER_RADIUS_M);
  const langs = localLang && localLang !== 'en' ? ['en', localLang] : ['en'];
  const jobs: { name: string; run: () => Promise<PlaceCandidate[]> }[] = [];

  for (const lang of langs) {
    for (const c of centers) {
      jobs.push({
        name: `Wikipedia (${lang})`,
        run: async () => pagesToCandidates(lang, await geosearch(lang, c.lat, c.lon, CENTER_RADIUS_M)),
      });
    }
  }
  for (const c of centers) {
    jobs.push({
      name: 'Wikidata',
      run: async () =>
        itemsToCandidates(await fetchItemsAround(c.lat, c.lon, CENTER_RADIUS_M / 1000)),
    });
  }
  jobs.push({
    name: 'OpenStreetMap',
    run: async () => elementsToCandidates(await fetchOsmPlaces(lats, lons, OSM_CORRIDOR_M)),
  });

  const candidates: PlaceCandidate[] = [];
  const failed = new Set<string>();
  let done = 0;
  await Promise.all(
    jobs.map(async (job) => {
      try {
        candidates.push(...(await job.run()));
      } catch {
        failed.add(job.name);
      }
      done++;
      onProgress(`Fetching places ${done}/${jobs.length}…`);
    }),
  );
  if (candidates.length === 0) {
    throw new Error(`Every source failed (${[...failed].join(', ')}). Are you online?`);
  }
  return { candidates, failures: [...failed] };
}

/** Name search on English plus the local Wikipedia. */
export async function searchPlacesByName(
  text: string,
  localLang: string,
): Promise<PlaceCandidate[]> {
  const langs = localLang && localLang !== 'en' ? ['en', localLang] : ['en'];
  const results = await Promise.allSettled(
    langs.map(async (lang) => pagesToCandidates(lang, await searchByName(lang, text))),
  );
  const out: PlaceCandidate[] = [];
  for (const r of results) if (r.status === 'fulfilled') out.push(...r.value);
  return out;
}
