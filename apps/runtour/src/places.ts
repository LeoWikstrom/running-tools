import { findCoveringArea, loadAreaBuildings, loadAreaPlaces } from '@running/core/net/areaStore';
import { haversineMeters } from '@running/core/geo';
import type { BuildingPoly } from '@running/core/geo/los';
import { fetchBuildings } from '@running/core/poi/buildings';
import { fetchOsmPlaces, elementsToCandidates } from '@running/core/poi/osm';
import {
  geosearch,
  pagesToCandidates,
  sampleCenters,
  searchByName,
} from '@running/core/poi/wikipedia';
import { fetchItemsAround, itemsToCandidates } from '@running/core/poi/wikidata';
import type { PlaceCandidate } from '@running/core/poi/types';
import { VARIANT_DEFAULTS } from './variant';

const CENTER_RADIUS_M = 2500;
/** OSM corridor is wider than the place corridor: squares and parks are big. */
const OSM_CORRIDOR_M = Math.max(150, VARIANT_DEFAULTS.corridorWidth);
/** Buildings must cover every sightline, which can angle a bit beyond the
    place corridor from the samples along the sight window. */
const BUILDINGS_CORRIDOR_M = VARIANT_DEFAULTS.corridorWidth + 100;

export interface FetchReport {
  candidates: PlaceCandidate[];
  /** Footprints for line-of-sight; empty when unknown (old areas, fetch failure). */
  buildings: BuildingPoly[];
  failures: string[];
}

/** The smallest circle around the course, for matching against stored areas. */
function boundingCircle(lats: number[], lons: number[]): { lat: number; lon: number; r: number } {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (let i = 0; i < lats.length; i++) {
    if (lats[i]! < minLat) minLat = lats[i]!;
    if (lats[i]! > maxLat) maxLat = lats[i]!;
    if (lons[i]! < minLon) minLon = lons[i]!;
    if (lons[i]! > maxLon) maxLon = lons[i]!;
  }
  const lat = (minLat + maxLat) / 2;
  const lon = (minLon + maxLon) / 2;
  return { lat, lon, r: haversineMeters(lat, lon, maxLat, maxLon) };
}

/** Fetch place candidates from all three sources along the course. */
export async function fetchCandidates(
  lats: number[],
  lons: number[],
  localLang: string,
  onProgress: (text: string) => void,
): Promise<FetchReport> {
  // A downloaded area that covers the whole course serves its stored places.
  const circle = boundingCircle(lats, lons);
  const area = await findCoveringArea(circle, circle.r + OSM_CORRIDOR_M);
  if (area) {
    const stored = await loadAreaPlaces(area.id);
    if (stored && stored.length > 0) {
      onProgress('Places from the downloaded area.');
      let buildings = await loadAreaBuildings(area.id);
      if (!buildings) {
        // The area predates footprints. The corridor's buildings are a small
        // fetch, so get them live rather than running without line of sight;
        // actually offline right now, it just stays off for this course.
        onProgress('Fetching the buildings for line of sight…');
        buildings = await fetchBuildings(lats, lons, BUILDINGS_CORRIDOR_M).catch(
          () => [] as BuildingPoly[],
        );
      }
      return { candidates: stored, buildings, failures: [] };
    }
  }

  // Footprints ride along with the sources; losing them only loses the
  // line-of-sight filter, so a failure is reported but not fatal.
  const buildingsPromise = fetchBuildings(lats, lons, BUILDINGS_CORRIDOR_M).catch(() => null);

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
        itemsToCandidates(
          await fetchItemsAround(c.lat, c.lon, CENTER_RADIUS_M / 1000, { wikiLangs: langs }),
        ),
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
  const buildings = await buildingsPromise;
  if (buildings === null) failed.add('buildings');
  return { candidates, buildings: buildings ?? [], failures: [...failed] };
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
