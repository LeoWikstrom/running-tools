import { dedupeCandidates } from '@running/core/poi/pipeline';
import { interestScore, isExcludedType } from '@running/core/poi/score';
import { fetchOsmPlaces, elementsToCandidates } from '@running/core/poi/osm';
import { geosearch, pagesToCandidates } from '@running/core/poi/wikipedia';
import { fetchItemsAround, itemsToCandidates } from '@running/core/poi/wikidata';
import { getNetwork } from '@running/core/net/overpass';
import type { TourSearchPlace, TourWeights } from '@running/core/search/tourBeam';
import type { GenerateReply, GenerateRequest } from './generate.worker';
import GenerateWorker from './generate.worker?worker';

/** Places with interest ≥ 30 qualify as collection targets (plan section 6). */
const MIN_PLACE_SCORE = 30;
const GEOSEARCH_MAX_M = 10_000;

export interface GenerateParams {
  start: { lat: number; lon: number };
  targetLengthM: number;
  localLang: string;
  /** 0..100 each: more places↔direct, pedestrian↔roads too, centre↔outskirts. */
  placesSlider: number;
  pedestrianSlider: number;
  centreSlider: number;
}

export interface GeneratedCourse {
  points: [number, number][];
  lengthM: number;
  score: number;
  collected: { id: string; name: string; d: number; score: number }[];
}

function sliderWeights(p: GenerateParams): Partial<TourWeights> {
  return {
    // More places: interest counts double; more direct: length matters more.
    interest: 0.5 + p.placesSlider / 100,
    lengthDiff: 0.02 + ((100 - p.placesSlider) / 100) * 0.08,
    // Pedestrian only: safety penalties bite hard.
    penalty: 0.02 + ((100 - p.pedestrianSlider) / 100) * 0.12,
    // Historic centre: ground far from the places' centroid costs.
    centroid: ((100 - p.centreSlider) / 100) * 0.06,
  };
}

async function placesAround(p: GenerateParams, radiusM: number): Promise<TourSearchPlace[]> {
  const r = Math.min(radiusM, GEOSEARCH_MAX_M);
  const langs = p.localLang && p.localLang !== 'en' ? ['en', p.localLang] : ['en'];
  const batches = await Promise.allSettled([
    ...langs.map(async (lang) =>
      pagesToCandidates(lang, await geosearch(lang, p.start.lat, p.start.lon, r)),
    ),
    (async () => itemsToCandidates(await fetchItemsAround(p.start.lat, p.start.lon, r / 1000)))(),
    (async () =>
      elementsToCandidates(await fetchOsmPlaces([p.start.lat], [p.start.lon], r)))(),
  ]);
  const all = batches.flatMap((b) => (b.status === 'fulfilled' ? b.value : []));
  if (all.length === 0) throw new Error('No place source reachable. Are you online?');
  return dedupeCandidates(all)
    .filter((c) => !isExcludedType(c))
    .map((c) => ({
      id: c.wikidataId ?? `name:${c.name.toLowerCase()}`,
      name: c.name,
      lat: c.lat,
      lon: c.lon,
      score: interestScore(c),
    }))
    .filter((c) => c.score >= MIN_PLACE_SCORE);
}

export function generateCourse(
  params: GenerateParams,
  onProgress: (text: string, fraction: number) => void,
): { promise: Promise<GeneratedCourse>; cancel: () => void } {
  let worker: Worker | null = null;
  let cancelled = false;

  const promise = (async (): Promise<GeneratedCourse> => {
    // The start/finish radius of the plan: length/2 × 0.6, places a bit wider.
    const radius = (params.targetLengthM / 2) * 0.6;
    onProgress('Fetching places…', 0.05);
    const places = await placesAround(params, radius + 500);
    if (places.length === 0) {
      throw new Error('No places with interest ≥ 30 around here.');
    }
    if (cancelled) throw new Error('cancelled');
    onProgress(`Fetching the street network (${places.length} places found)…`, 0.15);
    const network = await getNetwork(params.start, radius + 300, { headerTimeoutMs: 120_000 });
    if (cancelled) throw new Error('cancelled');
    onProgress('Searching for a loop…', 0.2);

    return await new Promise<GeneratedCourse>((resolve, reject) => {
      worker = new GenerateWorker();
      worker.onmessage = (e: MessageEvent<GenerateReply>) => {
        const msg = e.data;
        if (msg.type === 'progress') {
          onProgress('Searching for a loop…', 0.2 + msg.fraction * 0.8);
        } else if (msg.type === 'result') {
          resolve(msg);
        } else {
          reject(new Error(msg.message));
        }
      };
      worker.onerror = (e) => reject(new Error(e.message));
      const request: GenerateRequest = {
        response: network.response,
        start: params.start,
        places,
        targetLengthM: params.targetLengthM,
        weights: sliderWeights(params),
      };
      worker.postMessage(request);
    });
  })();

  return {
    promise,
    cancel(): void {
      cancelled = true;
      worker?.terminate();
    },
  };
}
