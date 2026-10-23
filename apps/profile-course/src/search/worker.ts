import {
  buildGraph,
  edgeSamplePositions,
  filterToComponent,
  pruneDeadEnds,
  sampleEdgeElevations,
  snapToNode,
} from '../graph/build';
import { otherNode, type Graph } from '../graph/types';
import { deleteArea, listAreas, saveArea } from '../net/areaStore';
import { deleteTraces, listTraces, loadTraceCounts, saveTraces } from '../net/traceStore';
import { fetchTracePoints } from '../net/traces';
import { applyTraceCoverage } from '../graph/traces';
import { fetchNetwork, getNetwork } from '../net/overpass';
import { TerrainSampler } from '../net/terrain';
import { haversineMeters } from '../shared/geo';
import type { TargetProfile } from '../gpx/profile';
import type {
  CoursePathRef,
  CourseResult,
  CourseSegment,
  LatLon,
  MainToWorker,
  TargetTransfer,
  ViaPoint,
  WorkerToMain,
} from '../shared/messages';
import { dijkstra } from '../graph/dijkstra';
import { matchTrackToGraph } from '../graph/match';
import {
  DEFAULT_WINDOW_M,
  deleteNodesFromPath,
  insertNodeIntoPath,
  moveNodeInPath,
  pathRoot,
  reroutePath,
} from './edit';
import { pathNodes } from '../graph/ksp';
import { beamSearch } from './beam';
import { improveCandidates, sameRunAs } from './improve';
import { randomWalkSearch, type WalkCandidate } from './randomWalk';
import {
  assembleCourse,
  scoreBreakdown,
  scoreCourse,
  DEFAULT_WEIGHTS,
  MIX_ROAD,
  type CoursePath,
} from './score';

function post(msg: WorkerToMain): void {
  postMessage(msg);
}

/** The thrown message plus its top stack frame — a bare "cannot read X of
 * undefined" from a phone is undebuggable without knowing where. */
function errText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  console.error(err);
  const frame = err.stack?.split('\n').find((l) => l.includes('.ts'));
  return frame ? `${err.message} (${frame.trim()})` : err.message;
}

const sampler = new TerrainSampler();

function bytesProgress(stage: string, fraction: number): (bytes: number, endpoint: number) => void {
  let lastPosted = 0;
  return (bytes, endpoint) => {
    if (bytes - lastPosted < 512 * 1024) return;
    lastPosted = bytes;
    const mb = (bytes / 1048576).toFixed(1);
    const mirror = endpoint > 0 ? ', mirror' : '';
    post({ type: 'progress', stage: `${stage} (${mb} MB${mirror})`, fraction, bestScore: null });
  };
}

async function downloadArea(center: LatLon, radiusMeters: number): Promise<void> {
  post({ type: 'progress', stage: 'downloading area', fraction: 0.02, bestScore: null });
  // Overpass streams chunked without a length header; estimate the total from
  // the area (~0.3 MB/km² in a city, clamped) and cap the bar at 95 %.
  const km2 = Math.PI * (radiusMeters / 1000) ** 2;
  const estBytes = Math.max(2e6, km2 * 0.3e6);
  let lastPosted = 0;
  const response = await fetchNetwork(center, radiusMeters, {
    rounds: 4,
    // A deliberate download may wait as long as the query's own [timeout:180];
    // a big area takes the server that long to compute before headers arrive.
    headerTimeoutMs: 180_000,
    onBytes: (bytes, endpoint) => {
      if (bytes - lastPosted < 256 * 1024) return;
      lastPosted = bytes;
      const mb = (bytes / 1048576).toFixed(1);
      const mirror = endpoint > 0 ? ', mirror' : '';
      post({
        type: 'progress',
        stage: `downloading area (${mb} MB${mirror})`,
        fraction: Math.min(0.95, bytes / estBytes),
        bestScore: null,
      });
    },
  });
  post({ type: 'progress', stage: 'downloading area (saving)', fraction: 0.97, bestScore: null });
  await saveArea(center, radiusMeters, response);
  post({ type: 'areas', areas: await listAreas() });
}

async function downloadTraces(center: LatLon, radiusMeters: number): Promise<void> {
  cancelled = false;
  post({ type: 'progress', stage: 'GPS traces: 0 %', fraction: 0.01, bestScore: null });
  const found = await fetchTracePoints(center, radiusMeters, {
    shouldCancel: () => cancelled,
    onProgress: (done, total, kept) => {
      const pct = Math.round((done / total) * 100);
      post({
        type: 'progress',
        stage: `GPS traces: ${pct} % (${kept.toLocaleString()} run points)`,
        fraction: Math.min(0.97, done / total),
        bestScore: null,
      });
    },
  });
  // "Cancel stops it, and then nothing is saved" — the UI promises exactly that.
  if (cancelled) {
    post({ type: 'traces', traces: await listTraces() });
    return;
  }
  await saveTraces(center, radiusMeters, found);
  // Whatever graph is in hand was built without this coverage.
  preparedKey = '';
  post({ type: 'traces', traces: await listTraces() });
}

let graph: Graph | null = null;
let startNode = -1;
let validEnd: Uint8Array | null = null;
let preparedKey = '';
let cancelled = false;
/**
 * The latest search's generation (set by the main thread). A search whose
 * generation is no longer this one is stale: a new `search` message must not
 * revive a cancelled run or let two searches share graph/startNode/validEnd.
 */
let searchGen = 0;

/** What the graph in hand was built from, so a course can name its own. */
let preparedArgs: CoursePathRef['graph'] | null = null;

/** The course may leave the radius; cap how wide a network we are willing to pull. */
const MAX_GRAPH_RADIUS_M = 15_000;

/** Two prepares with the same key build the same graph, from the same cache. */
function prepareKey(
  start: LatLon,
  radiusMeters: number,
  targetLengthMeters: number,
  connectors: boolean,
): string {
  // The radius is only the start/finish zone. A course of length L can reach
  // about L/2 out before it has to head back.
  const graphRadius = Math.min(radiusMeters + targetLengthMeters / 2, MAX_GRAPH_RADIUS_M);
  return `${start.lat.toFixed(5)},${start.lon.toFixed(5)},${Math.round(radiusMeters)},${Math.round(graphRadius)},${connectors ? 'c' : ''}`;
}

async function ensurePrepared(
  start: LatLon,
  radiusMeters: number,
  targetLengthMeters: number,
  connectors = false,
): Promise<void> {
  const graphRadius = Math.min(radiusMeters + targetLengthMeters / 2, MAX_GRAPH_RADIUS_M);
  const key = prepareKey(start, radiusMeters, targetLengthMeters, connectors);
  if (graph && preparedKey === key) return;

  post({ type: 'progress', stage: 'fetching network', fraction: 0.05, bestScore: null });
  let result;
  try {
    result = await getNetwork(start, graphRadius, {
      onBytes: bytesProgress('fetching network', 0.05),
    });
  } catch (err) {
    if (!navigator.onLine) {
      throw new Error(
        'You are offline and no downloaded area covers this search. ' +
          'Download an offline area first, or reconnect.',
        { cause: err },
      );
    }
    throw err;
  }
  const { response, source } = result;
  if (source === 'offline-area') {
    post({ type: 'progress', stage: 'using offline area', fraction: 0.1, bestScore: null });
  }
  post({ type: 'progress', stage: 'building graph', fraction: 0.15, bestScore: null });
  const full = buildGraph(response, { connectors });
  const snapped = snapToNode(full, start.lat, start.lon);
  if (snapped < 0) {
    throw new Error('No path or road found within 100 m of the start point');
  }
  const filtered = filterToComponent(full, snapped);
  const pruned = pruneDeadEnds(filtered.graph, filtered.startNode);
  graph = pruned.graph;
  startNode = pruned.keepNode;

  validEnd = new Uint8Array(graph.nodeLat.length);
  for (let i = 0; i < validEnd.length; i++) {
    if (
      haversineMeters(start.lat, start.lon, graph.nodeLat[i]!, graph.nodeLon[i]!) <= radiusMeters
    ) {
      validEnd[i] = 1;
    }
  }

  post({ type: 'progress', stage: 'sampling elevation', fraction: 0.25, bestScore: null });
  await sampleEdgeElevations(graph, sampler);
  // Coverage rides along with every graph whether or not the user has asked
  // for it; what the checkbox turns on is the weight, which costs nothing when
  // it is zero. The cells are only known after the elevation pass, which is
  // what fills them in.
  applyTraceCoverage(graph, await loadTraceCounts());
  preparedKey = key;
  preparedArgs = {
    start,
    radiusMeters,
    targetLengthMeters,
    connectors,
    edgeCount: graph.edges.length,
    nodeCount: graph.nodeLat.length,
  };

  const lat = graph.nodeLat[startNode]!;
  const lon = graph.nodeLon[startNode]!;
  post({
    type: 'prepared',
    nodeCount: graph.nodeLat.length,
    edgeCount: graph.edges.length,
    startNode: { lat, lon },
    startElevation: await sampler.elevationAt(lat, lon),
  });
}

function pathSegments(g: Graph, path: CoursePath): CourseSegment[] {
  return path.edges.map((ei, i) => {
    const e = g.edges[ei]!;
    if (path.dirs[i] === 1) return { lats: e.lats, lons: e.lons, surface: e.surface };
    return {
      lats: Float64Array.from(e.lats).reverse(),
      lons: Float64Array.from(e.lons).reverse(),
      surface: e.surface,
    };
  });
}

function toResult(
  g: Graph,
  candidate: WalkCandidate,
  seed: number,
  breakdown: Record<string, number>,
): CourseResult {
  const exportPoints: CourseResult['exportPoints'] = [];
  for (let i = 0; i < candidate.path.edges.length; i++) {
    const e = g.edges[candidate.path.edges[i]!]!;
    const { lats, lons } = edgeSamplePositions(e);
    const elev = e.elev!;
    const n = lats.length;
    const forward = candidate.path.dirs[i] === 1;
    for (let k = exportPoints.length === 0 ? 0 : 1; k < n; k++) {
      const j = forward ? k : n - 1 - k;
      exportPoints.push({ lat: lats[j]!, lon: lons[j]!, ele: elev[Math.min(j, elev.length - 1)]! });
    }
  }
  return {
    path: {
      edges: Array.from(candidate.path.edges),
      dirs: Array.from(candidate.path.dirs),
      graph: preparedArgs!,
    },
    segments: pathSegments(g, candidate.path),
    samples: candidate.course.samples,
    exportPoints,
    lengthM: candidate.course.lengthM,
    gain: candidate.course.gain,
    loss: candidate.course.loss,
    score: candidate.score,
    breakdown,
    surfaceSplit: candidate.course.surfaceSplit,
    seed,
  };
}

/** How many courses one search offers as tabs. */
const MAX_COURSES = 4;

/**
 * How far apart two courses must begin when the start may be anywhere in the
 * zone. Roughly a block: near enough to still be "at the start", far enough
 * that the alternative does not simply retrace the first course's opening.
 */
const ALT_START_APART_M = 300;

interface SearchOptionsIn {
  desiredMix: [number, number, number, number] | null;
  returnToStart: boolean;
  startAtPoint: boolean;
  weights: Record<string, number> | null;
  connectors: boolean;
  beamWidth: number;
  viaPoints: ViaPoint[];
  viaToleranceKm: number;
}

// 25 m: tight enough that a tap on one of two parallel bridge footpaths
// (~25-30 m apart) selects that one specifically.
const VIA_NEAR_M = 25;

/** How far an edit's destination tap may be from a path before it is rejected. */
const EDIT_SNAP_M = 60;

/**
 * A via matches graph nodes within VIA_NEAR_M and edges whose geometry passes
 * within it — measured to the segments themselves, not just their vertices:
 * long straight spans (Älvsborgsbron) have vertices hundreds of metres apart.
 */
function matchVia(g: Graph, v: LatLon, index: number): { nodes: Set<number>; edges: Set<number> } {
  const cosLat = Math.cos((v.lat * Math.PI) / 180);
  const vx = v.lon * 111320 * cosLat;
  const vy = v.lat * 111320;
  const segDist = (aLat: number, aLon: number, bLat: number, bLon: number): number => {
    const ax = aLon * 111320 * cosLat;
    const ay = aLat * 111320;
    const bx = bLon * 111320 * cosLat;
    const by = bLat * 111320;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((vx - ax) * dx + (vy - ay) * dy) / len2)) : 0;
    return Math.hypot(vx - (ax + t * dx), vy - (ay + t * dy));
  };

  const nodes = new Set<number>();
  const edges = new Set<number>();
  for (let n = 0; n < g.nodeLat.length; n++) {
    if (haversineMeters(v.lat, v.lon, g.nodeLat[n]!, g.nodeLon[n]!) <= VIA_NEAR_M) nodes.add(n);
  }
  for (let ei = 0; ei < g.edges.length; ei++) {
    const e = g.edges[ei]!;
    // Cheap bbox reject before exact segment distances.
    if (haversineMeters(v.lat, v.lon, e.lats[0]!, e.lons[0]!) > e.lengthM + VIA_NEAR_M) continue;
    for (let j = 1; j < e.lats.length; j++) {
      if (segDist(e.lats[j - 1]!, e.lons[j - 1]!, e.lats[j]!, e.lons[j]!) <= VIA_NEAR_M) {
        edges.add(ei);
        nodes.add(e.a);
        nodes.add(e.b);
        break;
      }
    }
  }
  if (nodes.size === 0) {
    throw new Error(`Via point ${index + 1} is more than ${VIA_NEAR_M} m from any path`);
  }
  return { nodes, edges };
}

function resolveVias(
  g: Graph,
  viaPoints: ViaPoint[],
): { nodes: Set<number>; edges: Set<number>; dist: Float64Array; kmM: number | null }[] {
  return viaPoints.map((v, i) => {
    const { nodes, edges } = matchVia(g, v, i);
    return {
      nodes,
      edges,
      dist: dijkstra(g, [...nodes]).dist,
      kmM: v.km !== null ? v.km * 1000 : null,
    };
  });
}

/** Nodes and edges an edit must not cut out of the course. */
function viaKeepSets(g: Graph, viaPoints: ViaPoint[]): { nodes: Set<number>; edges: Set<number> } {
  const nodes = new Set<number>();
  const edges = new Set<number>();
  viaPoints.forEach((v, i) => {
    const m = matchVia(g, v, i);
    for (const n of m.nodes) nodes.add(n);
    for (const e of m.edges) edges.add(e);
  });
  return { nodes, edges };
}

/** True when the path visits every via (node or traversed edge) in order. */
function pathVisitsVias(
  g: Graph,
  path: CoursePath,
  vias: { nodes: Set<number>; edges: Set<number> }[],
  root: number,
): boolean {
  let vi = 0;
  let node = root;
  if (vias.length === 0) return true;
  if (vias[0]!.nodes.has(node)) vi++;
  for (let i = 0; i < path.edges.length && vi < vias.length; i++) {
    const ei = path.edges[i]!;
    node = otherNode(g.edges[ei]!, node);
    if (vias[vi]!.edges.has(ei) || vias[vi]!.nodes.has(node)) vi++;
  }
  return vi >= vias.length;
}

async function search(
  start: LatLon,
  radiusMeters: number,
  target: TargetTransfer,
  targetLengthMeters: number,
  seed: number,
  algorithm: 'beam' | 'walk',
  opts: SearchOptionsIn,
  gen: number,
): Promise<void> {
  const stale = (): boolean => cancelled || gen !== searchGen;
  const t0 = performance.now();
  await ensurePrepared(start, radiusMeters, targetLengthMeters, opts.connectors);
  if (stale()) return;
  // Locals, not the module state: a newer search's ensurePrepared may replace
  // graph/startNode/validEnd under this one before it next checks stale().
  const g = graph!;
  const gStart = startNode;
  const gValidEnd = validEnd;
  const profile: TargetProfile = target;
  const tGraph = performance.now();

  // A loop (return-to-start) needs a fixed anchor; otherwise the course may
  // begin anywhere inside the start/finish zone unless pinned to the marker.
  let startNodes: number[] | null = null;
  if (!opts.startAtPoint && !opts.returnToStart && gValidEnd) {
    startNodes = [];
    for (let i = 0; i < gValidEnd.length; i++) if (gValidEnd[i]) startNodes.push(i);
  }

  const weights = { ...DEFAULT_WEIGHTS, ...(opts.weights ?? {}) };
  const vias = resolveVias(g, opts.viaPoints);
  if (vias.length > 0 && algorithm === 'walk') {
    throw new Error('Via points require the beam search algorithm');
  }
  const validatePath =
    vias.length > 0
      ? (path: CoursePath) => {
          const first = g.edges[path.edges[0]!];
          if (!first) return false;
          const root = path.dirs[0] === 1 ? first.a : first.b;
          return pathVisitsVias(g, path, vias, root);
        }
      : undefined;

  post({ type: 'progress', stage: 'searching', fraction: 0.3, bestScore: null });
  post({ type: 'courses', gen, total: MAX_COURSES });

  // Each tab gets a search of its own, steered off the ground the courses
  // before it took — picking alternatives out of one search's runners-up gave
  // four near-copies of the winner, all leaving by the same street.
  const picked: WalkCandidate[] = [];
  const avoidEdges = new Set<number>();
  const usedRoots: number[] = [];

  for (let run = 0; run < MAX_COURSES && !stale(); run++) {
    const first = run === 0;
    // A discarded run re-fills the same tab, so the tab index is how many
    // courses have landed — `run` drifts past it after any discard.
    const tab = picked.length;
    // Starting anywhere means the alternatives can also start elsewhere.
    const runStarts =
      startNodes && !first
        ? startNodes.filter((n) =>
            usedRoots.every(
              (r) =>
                haversineMeters(g.nodeLat[n]!, g.nodeLon[n]!, g.nodeLat[r]!, g.nodeLon[r]!) >
                ALT_START_APART_M,
            ),
          )
        : startNodes;
    // Every run streams its best-so-far as a live preview for its tab; the
    // main thread only draws the tab on screen. A complete candidate beats
    // any partial, and between its improvements there is nothing new to show.
    let bestStreamed = Infinity;
    let lastPreviewAt = 0;
    const streamPreview = (best: WalkCandidate | null, leader: CoursePath | null): void => {
      if (best) {
        if (best.score >= bestStreamed) return;
        bestStreamed = best.score;
        post({
          type: 'bestSoFar',
          gen,
          index: tab,
          segments: pathSegments(g, best.path),
          samples: best.course.samples,
          score: best.score,
        });
        return;
      }
      const now = performance.now();
      if (!leader || now - lastPreviewAt < 200) return;
      lastPreviewAt = now;
      post({
        type: 'bestSoFar',
        gen,
        index: tab,
        segments: pathSegments(g, leader),
        samples: assembleCourse(g, leader).samples,
        score: null,
      });
    };
    const onProgress = (
      done: number,
      total: number,
      best: WalkCandidate | null,
      leader?: CoursePath | null,
    ): void => {
      post({ type: 'courseProgress', gen, index: tab, fraction: (0.9 * done) / total });
      post({
        type: 'progress',
        stage: first ? 'searching' : `alternative ${run + 1}`,
        fraction: 0.3 + 0.6 * (done / total),
        bestScore: first ? (best?.score ?? null) : null,
      });
      streamPreview(best, leader ?? null);
    };

    const candidates =
      algorithm === 'walk'
        ? await randomWalkSearch(g, gStart, profile, targetLengthMeters, {
            seed: seed + run * 101,
            desiredMix: opts.desiredMix,
            returnToStart: opts.returnToStart,
            weights,
            validEnd: gValidEnd,
            startNodes: runStarts,
            onProgress,
            shouldCancel: stale,
          })
        : await beamSearch(g, gStart, profile, targetLengthMeters, {
            seed: seed + run * 101,
            beamWidth: Math.max(50, Math.min(800, opts.beamWidth || 200)),
            vias,
            viaSlackM: Math.max(100, (opts.viaToleranceKm || 1) * 1000),
            desiredMix: opts.desiredMix,
            returnToStart: opts.returnToStart,
            weights,
            validEnd: gValidEnd,
            startNodes: runStarts,
            avoidEdges: first ? null : avoidEdges,
            onProgress,
            shouldCancel: stale,
          });

    if (stale()) break;
    if (candidates.length === 0) {
      if (first) {
        post({
          type: 'noCourse',
          gen,
          message: 'No course found within ±3 % of the target length. Try a larger radius.',
        });
        return;
      }
      continue;
    }

    const tSearch = performance.now();
    if (first) {
      post({
        type: 'progress',
        stage: 'improving',
        fraction: 0.92,
        bestScore: candidates[0]!.score,
      });
    }
    const improved = await improveCandidates(g, gStart, candidates, profile, targetLengthMeters, {
      desiredMix: opts.desiredMix,
      weights,
      validatePath,
      shouldCancel: stale,
      // The pass polishes each runner-up in turn; streaming the one in hand
      // keeps the preview moving after "searching" reaches 90 %, and shows
      // the runners-up being tried.
      onProgress: (fraction, current) => {
        post({ type: 'courseProgress', gen, index: tab, fraction: 0.9 + 0.1 * fraction });
        if (first) {
          post({
            type: 'progress',
            stage: 'improving',
            fraction: 0.92 + 0.07 * fraction,
            bestScore: current.score,
          });
        }
        const now = performance.now();
        if (now - lastPreviewAt < 200) return;
        lastPreviewAt = now;
        post({
          type: 'bestSoFar',
          gen,
          index: tab,
          segments: pathSegments(g, current.path),
          samples: current.course.samples,
          score: current.score,
        });
      },
    });
    if (stale()) break;
    post({ type: 'courseProgress', gen, index: tab, fraction: 1 });

    const winner = improved[0]!;
    // Steering can fail — a corridor with one way through has to stay usable.
    if (sameRunAs(winner, picked)) continue;
    for (const ei of winner.path.edges) avoidEdges.add(ei);
    usedRoots.push(pathRoot(g, winner.path));

    if (first) {
      const tDone = performance.now();
      console.log(
        `search timings (${algorithm}): prepare ${(tGraph - t0).toFixed(0)} ms, ` +
          `search ${(tSearch - tGraph).toFixed(0)} ms, improve ${(tDone - tSearch).toFixed(0)} ms, ` +
          `score ${candidates[0]!.score.toFixed(2)} -> ${winner.score.toFixed(2)}`,
      );
    }
    post({
      type: 'course',
      gen,
      index: tab,
      course: toResult(
        g,
        winner,
        seed,
        scoreBreakdown(winner.course, profile, opts.desiredMix ?? MIX_ROAD, weights),
      ),
    });
    picked.push(winner);
  }

  post({ type: 'coursesDone', gen, ready: picked.length });
}

async function matchCourse(
  lats: Float64Array,
  lons: Float64Array,
  target: TargetTransfer,
  desiredMix: [number, number, number, number] | null,
  weightsIn: Record<string, number> | null,
): Promise<void> {
  // Graph area from the course's own bounding box.
  let minLat = Infinity,
    maxLat = -Infinity,
    minLon = Infinity,
    maxLon = -Infinity;
  for (let i = 0; i < lats.length; i++) {
    minLat = Math.min(minLat, lats[i]!);
    maxLat = Math.max(maxLat, lats[i]!);
    minLon = Math.min(minLon, lons[i]!);
    maxLon = Math.max(maxLon, lons[i]!);
  }
  const center = { lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2 };
  const halfDiag = haversineMeters(minLat, minLon, maxLat, maxLon) / 2 + 500;
  // Matching follows the user's own route, which may well cross streets
  // informally — always build this graph with connectors enabled.
  await ensurePrepared(center, Math.min(halfDiag, MAX_GRAPH_RADIUS_M), 0, true);
  const g = graph!;

  post({ type: 'progress', stage: 'matching course', fraction: 0.8, bestScore: null });
  const { path, snappedFraction } = matchTrackToGraph(g, lats, lons);
  const weights = { ...DEFAULT_WEIGHTS, ...(weightsIn ?? {}) };
  const course = assembleCourse(g, path);
  const score = scoreCourse(course, target, desiredMix ?? MIX_ROAD, weights);
  post({
    type: 'matched',
    course: toResult(
      g,
      { path, course, score },
      0,
      scoreBreakdown(course, target, desiredMix ?? MIX_ROAD, weights),
    ),
    snappedFraction,
    improvable: true,
  });
}

/** True when the graph in hand is the one `ref` indexes into. */
function refGraphInHand(ref: CoursePathRef): boolean {
  const r = ref.graph;
  return (
    graph !== null &&
    preparedKey === prepareKey(r.start, r.radiusMeters, r.targetLengthMeters, r.connectors) &&
    graph.edges.length === r.edgeCount &&
    graph.nodeLat.length === r.nodeCount
  );
}

/**
 * Returns the path the course was built from: its own edge indices whenever the
 * graph they index into is in hand or can be rebuilt, otherwise a map-match of
 * the points. The course carries the recipe for its graph, and a graph is
 * deterministic given the network response (cached in IndexedDB), so a course
 * stays exactly editable across tab switches, undo and a reload — matching is
 * lossy and rewrites the course wherever it prefers another way through, far
 * outside any edit window. Matching is the fallback: geometry we never produced
 * (an uploaded course), or a rebuild that is unavailable or comes out a
 * different size (the network has since changed under us).
 */
async function ensureCurrentPath(
  ref: CoursePathRef | undefined,
  lats: Float64Array,
  lons: Float64Array,
): Promise<{ path: CoursePath; exact: boolean }> {
  if (ref && ref.edges.length > 0) {
    if (!refGraphInHand(ref)) {
      const r = ref.graph;
      try {
        await ensurePrepared(r.start, r.radiusMeters, r.targetLengthMeters, r.connectors);
      } catch {
        // Offline, or Overpass is down. Matching against whatever graph we have
        // beats refusing the edit outright; with no graph at all, fall through.
      }
    }
    if (refGraphInHand(ref)) {
      return { path: { edges: ref.edges, dirs: ref.dirs }, exact: true };
    }
  }
  if (graph) return { path: matchTrackToGraph(graph, lats, lons).path, exact: false };
  let minLat = Infinity,
    maxLat = -Infinity,
    minLon = Infinity,
    maxLon = -Infinity;
  for (let i = 0; i < lats.length; i++) {
    minLat = Math.min(minLat, lats[i]!);
    maxLat = Math.max(maxLat, lats[i]!);
    minLon = Math.min(minLon, lons[i]!);
    maxLon = Math.max(maxLon, lons[i]!);
  }
  const center = { lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2 };
  const halfDiag = haversineMeters(minLat, minLon, maxLat, maxLon) / 2 + 500;
  await ensurePrepared(center, Math.min(halfDiag, MAX_GRAPH_RADIUS_M), 0, true);
  const { path } = matchTrackToGraph(graph!, lats, lons);
  return { path, exact: false };
}

/**
 * Said after a refused edit. A course whose graph could not be rebuilt had to be
 * matched back to the network to be edited at all, and a match that went badly
 * is a likelier reason for the refusal than the window being too tight.
 */
function matchedNote(exact: boolean): string {
  return exact ? '' : ' (this course had to be matched back to the path network first)';
}

async function editCourse(
  atKm: number,
  to: LatLon,
  ref: CoursePathRef,
  lats: Float64Array,
  lons: Float64Array,
  target: TargetTransfer,
  desiredMix: [number, number, number, number] | null,
  weightsIn: Record<string, number> | null,
  viaPoints: ViaPoint[],
  windowM: number,
): Promise<void> {
  const { path: currentPath, exact } = await ensureCurrentPath(ref, lats, lons);
  const g = graph!;
  const targetNode = snapToNode(g, to.lat, to.lon, EDIT_SNAP_M);
  if (targetNode < 0) {
    throw new Error(`No path within ${EDIT_SNAP_M} m of the tapped point`);
  }
  const keep = viaKeepSets(g, viaPoints);
  const newPath = reroutePath(g, currentPath, atKm * 1000, targetNode, {
    windowM,
    keepNodes: keep.nodes,
    keepEdges: keep.edges,
  });
  if (!newPath) {
    throw new Error(
      (keep.nodes.size > 0
        ? 'Could not route through that point without dropping a via point'
        : `Nothing within ±${Math.round(windowM)} m of km ${atKm.toFixed(1)} can reach that point — pick somewhere nearer the course, or widen the edit window`) +
        matchedNote(exact),
    );
  }
  postEdited(g, newPath, target, desiredMix, weightsIn);
}

async function nodeEdit(
  op: 'move' | 'delete' | 'add',
  atKm: number,
  atKms: number[] | undefined,
  to: LatLon | null,
  ref: CoursePathRef,
  lats: Float64Array,
  lons: Float64Array,
  target: TargetTransfer,
  desiredMix: [number, number, number, number] | null,
  weightsIn: Record<string, number> | null,
  viaPoints: ViaPoint[],
): Promise<void> {
  const { path: currentPath, exact } = await ensureCurrentPath(ref, lats, lons);
  const g = graph!;
  const keep = viaKeepSets(g, viaPoints);
  const atM = atKm * 1000;
  const options = { keepNodes: keep.nodes, keepEdges: keep.edges };

  if (op === 'delete') {
    const atMs = (atKms && atKms.length > 0 ? atKms : [atKm]).map((km) => km * 1000);
    const newPath = deleteNodesFromPath(g, currentPath, atMs, options);
    if (!newPath) {
      throw new Error(
        (atMs.length > 1
          ? 'Those points stay: one of them is a via point, an end of the course, or the only way through'
          : 'That point stays: it is a via point, an end of the course, or the only way through') +
          matchedNote(exact),
      );
    }
    postEdited(g, newPath, target, desiredMix, weightsIn);
    return;
  }

  if (!to) throw new Error('No destination for that node edit');
  const node = snapToNode(g, to.lat, to.lon, EDIT_SNAP_M);
  if (node < 0) throw new Error(`No path within ${EDIT_SNAP_M} m of that point`);
  if (op === 'add' && pathNodes(g, currentPath, pathRoot(g, currentPath)).includes(node)) {
    throw new Error('The course already has a point there');
  }
  const newPath =
    op === 'move'
      ? moveNodeInPath(g, currentPath, atM, node, options)
      : insertNodeIntoPath(g, currentPath, atM, node, options);
  if (!newPath) {
    throw new Error(
      (op === 'move'
        ? 'Could not connect the neighbouring points to there (or it is a via point)'
        : 'Could not add a course point there') + matchedNote(exact),
    );
  }
  postEdited(g, newPath, target, desiredMix, weightsIn);
}

/** Score an edited path and send it back as the current course. */
function postEdited(
  g: Graph,
  newPath: CoursePath,
  target: TargetTransfer,
  desiredMix: [number, number, number, number] | null,
  weightsIn: Record<string, number> | null,
): void {
  const weights = { ...DEFAULT_WEIGHTS, ...(weightsIn ?? {}) };
  const course = assembleCourse(g, newPath);
  const score = scoreCourse(course, target, desiredMix ?? MIX_ROAD, weights);
  post({
    type: 'matched',
    course: toResult(
      g,
      { path: newPath, course, score },
      0,
      scoreBreakdown(course, target, desiredMix ?? MIX_ROAD, weights),
    ),
    snappedFraction: 1,
    improvable: true,
  });
}

async function improveMatched(
  ref: CoursePathRef,
  lats: Float64Array,
  lons: Float64Array,
  target: TargetTransfer,
  desiredMix: [number, number, number, number] | null,
  weightsIn: Record<string, number> | null,
): Promise<void> {
  const { path: currentPath } = await ensureCurrentPath(ref, lats, lons);
  cancelled = false;
  const g = graph!;
  const weights = { ...DEFAULT_WEIGHTS, ...(weightsIn ?? {}) };
  const course = assembleCourse(g, currentPath);
  const score = scoreCourse(course, target, desiredMix ?? MIX_ROAD, weights);
  post({ type: 'progress', stage: 'improving', fraction: 0.5, bestScore: score });
  const improved = await improveCandidates(
    g,
    startNode,
    [{ path: currentPath, course, score }],
    target,
    course.lengthM,
    {
      desiredMix: desiredMix ?? MIX_ROAD,
      weights,
      maxCandidates: 1,
      passes: 6,
      shouldCancel: () => cancelled,
    },
  );
  post({
    type: 'matched',
    course: toResult(
      g,
      improved[0]!,
      0,
      scoreBreakdown(improved[0]!.course, target, desiredMix ?? MIX_ROAD, weights),
    ),
    snappedFraction: 1,
    improvable: true,
  });
}

onmessage = (event: MessageEvent<MainToWorker>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'ping':
      post({ type: 'pong' });
      break;
    case 'elevate':
      sampler
        .elevations(msg.lats, msg.lons)
        .then((elevations) => post({ type: 'elevated', elevations }))
        .catch((err: unknown) => post({ type: 'error', message: String(err) }));
      break;
    case 'search':
      // Adopting the new generation is what cancels a still-running search.
      searchGen = msg.generation;
      cancelled = false;
      search(
        msg.start,
        msg.radiusMeters,
        msg.target,
        msg.targetLengthMeters,
        msg.seed,
        msg.algorithm,
        {
          desiredMix: msg.desiredMix,
          returnToStart: msg.returnToStart,
          startAtPoint: msg.startAtPoint,
          weights: msg.weights,
          connectors: msg.connectors,
          beamWidth: msg.beamWidth,
          viaPoints: msg.viaPoints,
          viaToleranceKm: msg.viaToleranceKm,
        },
        msg.generation,
      ).catch((err: unknown) => post({ type: 'error', message: errText(err) }));
      break;
    case 'downloadArea':
      downloadArea(msg.center, msg.radiusMeters).catch((err: unknown) =>
        post({ type: 'error', message: errText(err) }),
      );
      break;
    case 'listAreas':
      listAreas()
        .then((areas) => post({ type: 'areas', areas }))
        .catch((err: unknown) => post({ type: 'error', message: String(err) }));
      break;
    case 'deleteArea':
      deleteArea(msg.id)
        .then((areas) => post({ type: 'areas', areas }))
        .catch((err: unknown) => post({ type: 'error', message: String(err) }));
      break;
    case 'downloadTraces':
      downloadTraces(msg.center, msg.radiusMeters).catch((err: unknown) =>
        post({ type: 'error', message: errText(err) }),
      );
      break;
    case 'listTraces':
      listTraces()
        .then((traces) => post({ type: 'traces', traces }))
        .catch((err: unknown) => post({ type: 'error', message: String(err) }));
      break;
    case 'deleteTraces':
      deleteTraces(msg.id)
        .then((traces) => {
          // The graph in hand still carries the coverage this download gave it.
          preparedKey = '';
          post({ type: 'traces', traces });
        })
        .catch((err: unknown) => post({ type: 'error', message: String(err) }));
      break;
    case 'matchCourse':
      matchCourse(msg.lats, msg.lons, msg.target, msg.desiredMix, msg.weights).catch(
        (err: unknown) => post({ type: 'error', message: errText(err) }),
      );
      break;
    case 'editCourse':
      editCourse(
        msg.atKm,
        msg.to,
        msg.path,
        msg.lats,
        msg.lons,
        msg.target,
        msg.desiredMix,
        msg.weights,
        msg.viaPoints ?? [],
        msg.rerouteWindowM ?? DEFAULT_WINDOW_M,
      ).catch((err: unknown) => post({ type: 'error', message: errText(err) }));
      break;
    case 'nodeEdit':
      nodeEdit(
        msg.op,
        msg.atKm,
        msg.atKms,
        msg.to,
        msg.path,
        msg.lats,
        msg.lons,
        msg.target,
        msg.desiredMix,
        msg.weights,
        msg.viaPoints ?? [],
      ).catch((err: unknown) => post({ type: 'error', message: errText(err) }));
      break;
    case 'improveCourse':
      improveMatched(msg.path, msg.lats, msg.lons, msg.target, msg.desiredMix, msg.weights).catch(
        (err: unknown) => post({ type: 'error', message: errText(err) }),
      );
      break;
    case 'cancel':
      cancelled = true;
      break;
  }
};
