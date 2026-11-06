/*
 * Headless course-quality verification on a real city graph — the lesson of
 * docs/course-quality-experiments.md: a clean synthetic result means nothing
 * until it holds under the app's real weight mix on real streets.
 *
 *   npx tsx scripts/verify-tour-quality.ts [lat lon [radiusM]]
 *
 * Default area is central Gothenburg (pre-baked network tiles; the first run
 * fetches tiles and the Wikipedia/Wikidata/OSM place pool, then caches both
 * under scripts/.cache). For every slider mix × target length it prints
 * length error, collected interest, node revisits, runtime — and the
 * unsanctioned out-and-back spur count, whose only acceptable value is 0.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGraph, snapToNode } from '../packages/core/src/graph/build';
import { otherNode } from '../packages/core/src/graph/types';
import { haversineMeters } from '../packages/core/src/geo';
import { getNetwork, type OverpassResponse } from '../packages/core/src/net/overpass';
import { dedupeCandidates } from '../packages/core/src/poi/pipeline';
import {
  interestScore,
  isEventPlace,
  isExcludedType,
  isStreetPlace,
} from '../packages/core/src/poi/score';
import type { PlaceCandidate } from '../packages/core/src/poi/types';
import { elementsToCandidates, fetchOsmPlaces } from '../packages/core/src/poi/osm';
import { geosearch, pagesToCandidates } from '../packages/core/src/poi/wikipedia';
import { fetchItemsAround, itemsToCandidates } from '../packages/core/src/poi/wikidata';
import { tourLoopSearch } from '../packages/core/src/search/tourLoop';
import {
  classifyCourseSpurs,
  improveTourCourse,
  snapPlacesToNodes,
  tourCoursePoints,
  type SnappedPlace,
  type TourCourse,
  type TourSearchPlace,
  type TourWeights,
} from '../packages/core/src/search/tourScore';

const [latArg, lonArg, radiusArg, langArg] = process.argv.slice(2);
const CENTER = { lat: Number(latArg ?? 57.7049), lon: Number(lonArg ?? 11.9675) };
const RADIUS_M = Number(radiusArg ?? 3000);
const PLACE_RADIUS_M = Math.min(RADIUS_M, 2500);
const LENGTHS = [4000, 6000, 8000];
const LOCAL_LANG = langArg ?? 'sv';
const MIN_PLACE_SCORE = 30;
const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), '.cache');

/** The app's sliderWeights (apps/runtour/src/generate.ts) — kept in sync by
    eye; it cannot be imported here because generate.ts pulls in a Vite
    `?worker` module. */
function sliderWeights(places: number, pedestrian: number, centre: number, twist: number) {
  return {
    interest: 0.5 + places / 100,
    lengthDiff: 0.02 + ((100 - places) / 100) * 0.08,
    repeat: 0.15,
    penalty: 0.02 + ((100 - pedestrian) / 100) * 0.12,
    centroid: ((100 - centre) / 100) * 0.06,
    turn: (twist / 100) * 6,
    crossing: (twist / 100) * 25,
  } satisfies Partial<TourWeights>;
}

/** apps/runtour OUTER_SPUR_MAX_FRAC × twisty share — keep in sync by eye. */
const spurBudget = (twist: number): number => ((100 - twist) / 100) * 0.08;

const MIXES: { name: string; weights: Partial<TourWeights>; budget: number }[] = [
  { name: 'defaults   ', weights: sliderWeights(50, 50, 50, 50), budget: spurBudget(50) },
  { name: 'places-max ', weights: sliderWeights(100, 50, 50, 50), budget: spurBudget(50) },
  { name: 'roads-ok   ', weights: sliderWeights(50, 0, 50, 50), budget: spurBudget(50) },
  { name: 'centre-max ', weights: sliderWeights(50, 50, 0, 50), budget: spurBudget(50) },
  { name: 'circular   ', weights: sliderWeights(50, 50, 50, 100), budget: spurBudget(100) },
  { name: 'twisty     ', weights: sliderWeights(50, 50, 50, 0), budget: spurBudget(0) },
];

/** WDQS/Wikipedia refuse Node's bare default agent. */
const fetchFn: typeof fetch = (input, init) =>
  fetch(input, {
    ...init,
    headers: {
      ...(init?.headers as Record<string, string> | undefined),
      'User-Agent': 'running-tools-verify/1.0 (https://github.com/LeoWikstrom/running-tools)',
    },
  });

async function cached<T>(name: string, make: () => Promise<T>): Promise<T> {
  const path = join(CACHE_DIR, name);
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    const value = await make();
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(path, JSON.stringify(value));
    return value;
  }
}

async function fetchPlaces(): Promise<TourSearchPlace[]> {
  const candidates = await cached<PlaceCandidate[]>(
    `places_${CENTER.lat}_${CENTER.lon}_${PLACE_RADIUS_M}.json`,
    async () => {
      // One ~1 km chunk at a time, like the app: WDQS rate-limits bursts.
      const centers: { lat: number; lon: number }[] = [];
      const step = 1200 / 111_320;
      const lonStep = step / Math.cos((CENTER.lat * Math.PI) / 180);
      const n = Math.ceil(PLACE_RADIUS_M / 1200);
      for (let i = -n; i <= n; i++) {
        for (let j = -n; j <= n; j++) {
          const lat = CENTER.lat + i * step;
          const lon = CENTER.lon + j * lonStep;
          if (haversineMeters(CENTER.lat, CENTER.lon, lat, lon) <= PLACE_RADIUS_M + 600) {
            centers.push({ lat, lon });
          }
        }
      }
      // A chunk may time out or get rate-limited; the app settles per chunk
      // too. One retry, then move on — a thin pool still verifies topology.
      const tryTwice = async (fn: () => Promise<PlaceCandidate[]>): Promise<PlaceCandidate[]> => {
        try {
          return await fn();
        } catch {
          await new Promise((r) => setTimeout(r, 5000));
          try {
            return await fn();
          } catch (err) {
            process.stderr.write(`\nchunk failed: ${String(err)}\n`);
            return [];
          }
        }
      };
      const all: PlaceCandidate[] = [];
      for (const c of centers) {
        for (const lang of ['en', LOCAL_LANG]) {
          all.push(
            ...(await tryTwice(async () =>
              pagesToCandidates(lang, await geosearch(lang, c.lat, c.lon, 1000, { fetchFn })),
            )),
          );
        }
        all.push(
          ...(await tryTwice(async () =>
            itemsToCandidates(
              await fetchItemsAround(c.lat, c.lon, 1, { wikiLangs: ['en', LOCAL_LANG], fetchFn }),
            ),
          )),
        );
        process.stderr.write('.');
      }
      all.push(
        ...(await tryTwice(async () =>
          elementsToCandidates(
            await fetchOsmPlaces([CENTER.lat], [CENTER.lon], PLACE_RADIUS_M, { fetchFn }),
          ),
        )),
      );
      process.stderr.write('\n');
      return dedupeCandidates(all);
    },
  );
  return candidates
    .filter((c) => !isExcludedType(c) && !isStreetPlace(c) && !isEventPlace(c))
    .map((c) => ({
      id: c.wikidataId ?? `name:${c.name.toLowerCase()}`,
      name: c.name,
      lat: c.lat,
      lon: c.lon,
      score: interestScore(c),
    }))
    .filter((c) => c.score >= MIN_PLACE_SCORE);
}

function nodeRevisits(graphEdges: number[], graph: ReturnType<typeof buildGraph>, startNode: number): number {
  const seen = new Set<number>([startNode]);
  let node = startNode;
  let revisits = 0;
  for (let i = 0; i < graphEdges.length; i++) {
    node = otherNode(graph.edges[graphEdges[i]!]!, node);
    if (i < graphEdges.length - 1) {
      if (seen.has(node)) revisits++;
      seen.add(node);
    }
  }
  return revisits;
}

function spursOf(
  graph: ReturnType<typeof buildGraph>,
  course: TourCourse,
  startNode: number,
  snapped: SnappedPlace[],
): ReturnType<typeof classifyCourseSpurs> {
  const ids = new Set(course.collected.map((c) => c.id));
  const sanction = snapped
    .filter((p) => p.required || ids.has(p.id))
    .map((p) => ({ lat: graph.nodeLat[p.node]!, lon: graph.nodeLon[p.node]! }));
  return classifyCourseSpurs(tourCoursePoints(graph, course, startNode), sanction);
}

const response = await cached<OverpassResponse>(
  `net_${CENTER.lat}_${CENTER.lon}_${RADIUS_M}.json`,
  async () => (await getNetwork(CENTER, RADIUS_M, { fetchFn })).response,
);
const graph = buildGraph(response, { connectors: true });
const startNode = snapToNode(graph, CENTER.lat, CENTER.lon, 150);
if (startNode < 0) throw new Error('No runnable way near the start.');
const places = await fetchPlaces();
const snapped = snapPlacesToNodes(graph, places);
console.log(
  `graph: ${graph.nodeLat.length} nodes, ${graph.edges.length} edges; ` +
    `pool: ${places.length} places (${snapped.length} snapped)`,
);

let failures = 0;
console.log(
  'mix          length  got     err     internal  outerM(budget)  revisits  collected  interest  ms(gen+improve)',
);
for (const mix of MIXES) {
  for (const target of LENGTHS) {
    const options = {
      targetLengthM: target,
      weights: mix.weights,
      outerSpurBudgetFrac: mix.budget,
      improveTimeMs: 5000,
    };
    const t0 = Date.now();
    const courses = tourLoopSearch(graph, startNode, snapped, options);
    const t1 = Date.now();
    if (courses.length === 0) {
      failures++;
      console.log(`${mix.name} ${target}  — no course found`);
      continue;
    }
    const improved = improveTourCourse(graph, courses[0]!, startNode, snapped, options);
    const t2 = Date.now();
    const spurs = spursOf(graph, improved, startNode, snapped);
    const budgetM = mix.budget * improved.lengthM;
    if (spurs.internal > 0 || spurs.outerLenM > budgetM) failures++;
    const err = (((improved.lengthM - target) / target) * 100).toFixed(1);
    const interest = improved.collected.reduce((s, c) => s + c.score, 0);
    console.log(
      `${mix.name} ${target}  ${Math.round(improved.lengthM)}  ${err.padStart(5)}%  ` +
        `${spurs.internal}         ${Math.round(spurs.outerLenM)}(${Math.round(budgetM)})          ` +
        `${nodeRevisits(improved.edges, graph, startNode)}         ` +
        `${improved.collected.length}         ${Math.round(interest)}       ${t1 - t0}+${t2 - t1}`,
    );
  }
}
console.log(
  failures === 0
    ? 'OK: zero internal spurs everywhere, outer spurs within budget'
    : `FAILURES: ${failures}`,
);
process.exit(failures === 0 ? 0 : 1);
