import { dedupeCandidates } from '@running/core/poi/pipeline';
import { interestScore, isExcludedType } from '@running/core/poi/score';
import type { PlaceCandidate } from '@running/core/poi/types';
import { findCoveringArea, loadAreaPlaces } from '@running/core/net/areaStore';
import { fetchOsmPlaces, elementsToCandidates } from '@running/core/poi/osm';
import { geosearch, pagesToCandidates } from '@running/core/poi/wikipedia';
import { fetchItemsAround, itemsToCandidates } from '@running/core/poi/wikidata';
import { getNetwork, type OverpassResponse } from '@running/core/net/overpass';
import { haversineMeters } from '@running/core/geo';
import type { TourSearchPlace, TourWeights } from '@running/core/search/tourBeam';
import type { GenerateReply, GenerateRequest } from './generate.worker';
import GenerateWorker from './generate.worker?worker';

/** Places with interest ≥ 30 qualify as collection targets (plan section 6). */
const MIN_PLACE_SCORE = 30;
const GEOSEARCH_MAX_M = 10_000;

export interface GenerateParams {
  start: { lat: number; lon: number };
  /** A finish point makes the course point-to-point; null means a loop. */
  end: { lat: number; lon: number } | null;
  /** Null (needs a finish): the shortest course that still collects places. */
  targetLengthM: number | null;
  localLang: string;
  /** 0..100 each: more places↔direct, pedestrian↔roads too, centre↔outskirts, twisty↔circular. */
  placesSlider: number;
  pedestrianSlider: number;
  centreSlider: number;
  twistSlider: number;
  /** Only route over places with a Wikipedia page in this language. */
  requireLang: string | null;
  /** Places already narrated by saved tours: still allowed, but cheap enough
      that the beam prefers fresh ground. */
  visited: { lat: number; lon: number; id?: string }[];
  /** Must-pass places: the course is required to collect each of these. */
  vias: TourSearchPlace[];
}

/** How much interest a place keeps after a saved tour already told it. */
const VISITED_SCORE_FACTOR = 0.3;
/** A visited entry this close to a candidate marks it as the same place. */
const VISITED_MATCH_M = 60;

export interface GeneratedCourse {
  points: [number, number][];
  lengthM: number;
  score: number;
  edges: number[];
  collected: { id: string; name: string; d: number; score: number }[];
  /** Set on a fresh generation; refineCourse keeps the caller's own. */
  context?: GenerationContext;
}

/** Everything needed to re-improve the generated course later (same graph). */
export interface GenerationContext {
  response: OverpassResponse;
  start: { lat: number; lon: number };
  end: { lat: number; lon: number } | null;
  places: TourSearchPlace[];
  targetLengthM: number | null;
  weights: Partial<TourWeights>;
  edges: number[];
}

function sliderWeights(p: GenerateParams): Partial<TourWeights> {
  return {
    // More places: interest counts double; more direct: length matters more.
    interest: 0.5 + p.placesSlider / 100,
    lengthDiff: 0.02 + ((100 - p.placesSlider) / 100) * 0.08,
    // Nearly double the core default: a 150 m out-and-back costs ~22 points,
    // so only a spur that actually collects a decent place pays for itself.
    repeat: 0.15,
    // Pedestrian only: safety penalties bite hard.
    penalty: 0.02 + ((100 - p.pedestrianSlider) / 100) * 0.12,
    // Historic centre: ground far from the places' centroid costs.
    centroid: ((100 - p.centreSlider) / 100) * 0.06,
    // Circular: every junction direction change costs, so the loop comes out
    // rounder with fewer street changes — and crossing its own path (a little
    // loop around a block) costs like half a decent place.
    turn: (p.twistSlider / 100) * 6,
    crossing: (p.twistSlider / 100) * 25,
  };
}

/** The three sources around one point, deduped — also what an area download stores. */
export async function fetchAreaCandidates(
  center: { lat: number; lon: number },
  radiusM: number,
  localLang: string,
): Promise<PlaceCandidate[]> {
  const r = Math.min(radiusM, GEOSEARCH_MAX_M);
  const langs = localLang && localLang !== 'en' ? ['en', localLang] : ['en'];
  const batches = await Promise.allSettled([
    ...langs.map(async (lang) =>
      pagesToCandidates(lang, await geosearch(lang, center.lat, center.lon, r)),
    ),
    (async () =>
      itemsToCandidates(await fetchItemsAround(center.lat, center.lon, r / 1000, { wikiLangs: langs })))(),
    (async () => elementsToCandidates(await fetchOsmPlaces([center.lat], [center.lon], r)))(),
  ]);
  const all = batches.flatMap((b) => (b.status === 'fulfilled' ? b.value : []));
  if (all.length === 0) throw new Error('No place source reachable. Are you online?');
  return dedupeCandidates(all);
}

async function placesAround(
  p: GenerateParams,
  center: { lat: number; lon: number },
  radiusM: number,
): Promise<TourSearchPlace[]> {
  const area = await findCoveringArea(center, radiusM);
  const stored = area ? await loadAreaPlaces(area.id) : undefined;
  const candidates =
    stored && stored.length > 0
      ? stored.filter((c) => haversineMeters(center.lat, center.lon, c.lat, c.lon) <= radiusM)
      : await fetchAreaCandidates(center, radiusM, p.localLang);
  const out: TourSearchPlace[] = candidates
    .filter((c) => !isExcludedType(c))
    .filter(
      (c) =>
        !p.requireLang ||
        [c.wikipedia, ...(c.wikipedias ?? [])].some((w) => w?.lang === p.requireLang),
    )
    .map((c) => ({
      id: c.wikidataId ?? `name:${c.name.toLowerCase()}`,
      name: c.name,
      lat: c.lat,
      lon: c.lon,
      score: interestScore(c),
    }))
    .filter((c) => c.score >= MIN_PLACE_SCORE)
    .map((c) => {
      const seen = p.visited.some(
        (v) => v.id === c.id || haversineMeters(v.lat, v.lon, c.lat, c.lon) <= VISITED_MATCH_M,
      );
      return seen ? { ...c, score: Math.max(1, Math.round(c.score * VISITED_SCORE_FACTOR)) } : c;
    });
  // Vias join the pool as required — a via already in it is simply marked.
  for (const via of p.vias) {
    const near = out.find(
      (c) => c.id === via.id || haversineMeters(c.lat, c.lon, via.lat, via.lon) < 60,
    );
    if (near) near.required = true;
    else out.push({ ...via, required: true });
  }
  return out;
}

/**
 * The circle generation works in — the plan's start/finish radius of
 * length/2 × 0.6; point-to-point centres on the midpoint and also has to
 * cover both endpoints. The network is fetched at radiusM + 300, places at
 * radiusM + 500.
 */
export function generationCircle(
  start: { lat: number; lon: number },
  end: { lat: number; lon: number } | null,
  targetLengthM: number | null,
): { center: { lat: number; lon: number }; radiusM: number } {
  const separation = end ? haversineMeters(start.lat, start.lon, end.lat, end.lon) : 0;
  const center = end
    ? { lat: (start.lat + end.lat) / 2, lon: (start.lon + end.lon) / 2 }
    : start;
  // Shortest-course mode: the course stays near the straight line, with the
  // same detour budget the worker will allow (×1.5 plus a kilometre).
  const length = targetLengthM ?? separation * 1.5 + 1000;
  return { center, radiusM: (length / 2) * 0.6 + separation / 2 };
}

export function generateCourse(
  params: GenerateParams,
  onProgress: (text: string, fraction: number) => void,
): { promise: Promise<GeneratedCourse>; cancel: () => void } {
  let worker: Worker | null = null;
  let cancelled = false;
  let cancelNow: ((e: Error) => void) | null = null;

  const work = (async (): Promise<GeneratedCourse> => {
    const separation = params.end
      ? haversineMeters(params.start.lat, params.start.lon, params.end.lat, params.end.lon)
      : 0;
    if (params.targetLengthM !== null && separation > params.targetLengthM * 1.05) {
      throw new Error('Start and finish are further apart than the course length.');
    }
    if (params.targetLengthM === null && !params.end) {
      throw new Error('Without a length the course needs a finish — set one or give a length.');
    }
    const { center, radiusM: radius } = generationCircle(
      params.start,
      params.end,
      params.targetLengthM,
    );
    onProgress('Fetching places…', 0.05);
    const places = await placesAround(params, center, radius + 500);
    if (places.length === 0) {
      throw new Error('No places with interest ≥ 30 around here.');
    }
    if (cancelled) throw new Error('cancelled');
    onProgress(`Fetching the street network (${places.length} places found)…`, 0.15);
    const network = await getNetwork(center, radius + 300, { headerTimeoutMs: 120_000 });
    if (cancelled) throw new Error('cancelled');
    onProgress('Searching for a loop…', 0.2);

    const request: GenerateRequest = {
      response: network.response,
      start: params.start,
      end: params.end,
      places,
      targetLengthM: params.targetLengthM,
      weights: sliderWeights(params),
    };
    const result = await runWorker(request, (w) => (worker = w), onProgress);
    return { ...result, context: { ...request, edges: result.edges } };
  })();

  // Cancel settles the caller's promise at once — a places or network fetch
  // in flight cannot be interrupted, so it finishes in the background (into
  // the cache) while the UI is already back.
  const cancelGate = new Promise<never>((_, reject) => (cancelNow = reject));
  work.catch(() => {}); // the race may already be settled when work loses
  cancelGate.catch(() => {});

  return {
    promise: Promise.race([work, cancelGate]),
    cancel(): void {
      cancelled = true;
      worker?.terminate();
      cancelNow?.(new Error('cancelled'));
    },
  };
}

function runWorker(
  request: GenerateRequest,
  onWorker: (w: Worker) => void,
  onProgress: (text: string, fraction: number) => void,
): Promise<GeneratedCourse> {
  return new Promise<GeneratedCourse>((resolve, reject) => {
    const worker = new GenerateWorker();
    onWorker(worker);
    worker.onmessage = (e: MessageEvent<GenerateReply>) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        const text = msg.fraction >= 0.85 ? 'Polishing the loop…' : 'Searching for a loop…';
        onProgress(text, 0.2 + msg.fraction * 0.8);
      } else if (msg.type === 'result') {
        worker.terminate();
        resolve(msg);
      } else {
        worker.terminate();
        reject(new Error(msg.message));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message));
    };
    worker.postMessage(request);
  });
}

/** Re-improve an existing generated course — e.g. after a place was removed,
    so a detour that only existed for it can straighten. */
export async function refineCourse(
  context: GenerationContext,
  onProgress: (text: string, fraction: number) => void,
): Promise<GeneratedCourse> {
  return runWorker(
    {
      response: context.response,
      start: context.start,
      end: context.end,
      places: context.places,
      targetLengthM: context.targetLengthM,
      weights: context.weights,
      refineEdges: context.edges,
      // Dropping a detour shortens the course; the search tolerance of ±5 %
      // would veto exactly the straightening the refinement is for.
      lengthToleranceFrac: 0.15,
    },
    () => {},
    onProgress,
  );
}

/** Full re-search on the stored network — for when local improvement cannot
    restructure the course after a removal. */
export async function regenerateCourse(
  context: GenerationContext,
  onProgress: (text: string, fraction: number) => void,
): Promise<GeneratedCourse> {
  return runWorker(
    {
      response: context.response,
      start: context.start,
      end: context.end,
      places: context.places,
      targetLengthM: context.targetLengthM,
      weights: context.weights,
    },
    () => {},
    onProgress,
  );
}
