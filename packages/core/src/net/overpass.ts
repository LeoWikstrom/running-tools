import { haversineMeters } from '../geo';
import { findCoveringArea, loadArea } from './areaStore';
import { cacheGet, cacheSet } from './cache';
import { createElementScanner } from './overpassStream';
import type { LatLon } from '../geo';

export interface OverpassNode {
  type: 'node';
  id: number;
  lat: number;
  lon: number;
  /** Present when the node carries tags (e.g. crossing=traffic_signals). */
  tags?: Record<string, string>;
}

export interface OverpassWay {
  type: 'way';
  id: number;
  nodes: number[];
  tags?: Record<string, string>;
}

export interface OverpassResponse {
  elements: (OverpassNode | OverpassWay)[];
}

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const RUNNABLE_HIGHWAYS =
  'footway|path|track|cycleway|residential|living_street|unclassified|tertiary|service|pedestrian|steps|bridleway';

// Driveways and parking aisles are filtered client-side in buildGraph; a
// single query clause keeps the server-side cost down.
export function buildQuery(center: LatLon, radiusMeters: number): string {
  const around = `(around:${Math.round(radiusMeters)},${center.lat.toFixed(6)},${center.lon.toFixed(6)})`;
  // `out body qt` (not skel) on the recursed nodes so node tags like
  // crossing=traffic_signals survive; untagged nodes serialize the same.
  // Barrier/rail/water ways are fetched as "separators": they never become
  // edges, but they block the synthetic crossing connectors.
  return (
    `[out:json][timeout:180];(` +
    `way[highway~"^(${RUNNABLE_HIGHWAYS})$"][access!~"private|no"][foot!=no]${around};` +
    `way[barrier]${around};` +
    `way[railway~"^(rail|tram|light_rail)$"]${around};` +
    `way[waterway~"^(river|stream|canal|ditch)$"]${around};` +
    `);out body;>;out body qt;`
  );
}

export interface QueryBBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** The same clauses and filters as buildQuery, over a bbox instead of a
    circle — the unit of the quadrant-parallel area download. */
export function buildQueryBBox(bbox: QueryBBox): string {
  const b = `(${bbox.south.toFixed(6)},${bbox.west.toFixed(6)},${bbox.north.toFixed(6)},${bbox.east.toFixed(6)})`;
  return (
    `[out:json][timeout:180];(` +
    `way[highway~"^(${RUNNABLE_HIGHWAYS})$"][access!~"private|no"][foot!=no]${b};` +
    `way[barrier]${b};` +
    `way[railway~"^(rail|tram|light_rail)$"]${b};` +
    `way[waterway~"^(river|stream|canal|ditch)$"]${b};` +
    `);out body;>;out body qt;`
  );
}

/** The circle's bounding box split at the center into NE/NW/SE/SW. */
export function quadrantBoxes(center: LatLon, radiusMeters: number): QueryBBox[] {
  const latPad = radiusMeters / 111_320;
  const lonPad = latPad / Math.cos((center.lat * Math.PI) / 180);
  const { lat, lon } = center;
  return [
    { south: lat, west: lon, north: lat + latPad, east: lon + lonPad },
    { south: lat, west: lon - lonPad, north: lat + latPad, east: lon },
    { south: lat - latPad, west: lon, north: lat, east: lon + lonPad },
    { south: lat - latPad, west: lon - lonPad, north: lat, east: lon },
  ];
}

/** Union of responses with elements deduped by type+id, first wins. A way
    matched in two quadrants arrives complete (with all its nodes) in both,
    so dropping the second copy loses nothing. */
export function mergeOverpassResponses(responses: readonly OverpassResponse[]): OverpassResponse {
  const seen = new Set<string>();
  const elements: (OverpassNode | OverpassWay)[] = [];
  for (const r of responses) {
    for (const el of r.elements) {
      const key = `${el.type}:${el.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      elements.push(el);
    }
  }
  return { elements };
}

function cacheKey(center: LatLon, radiusMeters: number): string {
  return `overpass:v4:${center.lat.toFixed(3)},${center.lon.toFixed(3)},${Math.round(radiusMeters / 100)}`;
}

export interface FetchNetworkOptions {
  fetchFn?: typeof fetch;
  /** Called with (bytesReceived, endpointIndex) while the response streams in. */
  onBytes?: (bytes: number, endpoint: number) => void;
  /** Rounds over all endpoints before giving up (default 2). */
  rounds?: number;
  /**
   * How long to wait for response headers (default 25 s). Overpass computes
   * the whole result before sending headers, so a deliberate area download
   * should allow up to the query's own [timeout:180].
   */
  headerTimeoutMs?: number;
  /** Go to the network even when the key is cached (the fresh result still
      overwrites the cache) — for stale-while-revalidate refreshes. */
  skipCacheRead?: boolean;
  /** Don't store the response either — for quadrant sub-fetches whose merged
      whole is cached under the real key instead. */
  skipCacheWrite?: boolean;
  /**
   * Called with each response element as it arrives, so the caller can use
   * the first lines of a big answer while the rest still downloads. With
   * racing mirrors only the first body to start streaming emits; if that
   * mirror then dies mid-body, onStreamRestart fires and a later attempt
   * emits from the top — the caller must drop its partial state.
   */
  onElement?: (el: Record<string, unknown>) => void;
  onStreamRestart?: () => void;
  /** Endpoint indices to try, in order (default: all). The quadrant-parallel
      download hands each quadrant a different rotation so concurrent
      quadrants never queue on the same mirror. */
  endpoints?: number[];
  /** Concurrent attempts per group (default 2). 1 = no racing. */
  race?: number;
}

const HEADER_TIMEOUT_MS = 25_000;
/** Abort the body read only when the stream stalls, never on total time. */
const BODY_STALL_MS = 30_000;

/** Keep only ways with at least one node inside the circle (plus their nodes). */
export function filterByRadius(
  response: OverpassResponse,
  center: LatLon,
  radiusMeters: number,
): OverpassResponse {
  const nodePos = new Map<number, { lat: number; lon: number }>();
  for (const el of response.elements) {
    if (el.type === 'node') nodePos.set(el.id, { lat: el.lat, lon: el.lon });
  }
  // Cheap bounding-box prefilter, then exact haversine.
  const latPad = (radiusMeters / 111_320) * 1.05;
  const lonPad = latPad / Math.cos((center.lat * Math.PI) / 180);
  const inside = (id: number): boolean => {
    const p = nodePos.get(id);
    if (!p) return false;
    if (Math.abs(p.lat - center.lat) > latPad || Math.abs(p.lon - center.lon) > lonPad)
      return false;
    return haversineMeters(center.lat, center.lon, p.lat, p.lon) <= radiusMeters;
  };

  const keptWays: OverpassWay[] = [];
  const keptNodeIds = new Set<number>();
  for (const el of response.elements) {
    if (el.type !== 'way') continue;
    if (el.nodes.some(inside)) {
      keptWays.push(el);
      for (const id of el.nodes) keptNodeIds.add(id);
    }
  }
  const elements: (OverpassNode | OverpassWay)[] = [...keptWays];
  for (const el of response.elements) {
    if (el.type === 'node' && keptNodeIds.has(el.id)) elements.push(el);
  }
  return { elements };
}

async function readWithProgress(
  res: Response,
  controller: AbortController,
  onBytes: ((bytes: number, endpoint: number) => void) | undefined,
  endpoint: number,
  onElement?: (el: Record<string, unknown>) => void,
): Promise<OverpassResponse> {
  if (!res.body) return (await res.json()) as OverpassResponse;
  // A big area on a slow link can legitimately stream for many minutes, so
  // the timer resets on every chunk: only a stalled stream is abandoned.
  const stall = (): void =>
    controller.abort(
      new Error(`Overpass response stalled (no data for ${BODY_STALL_MS / 1000} s)`),
    );
  let timer = setTimeout(stall, BODY_STALL_MS);
  try {
    const reader = res.body.getReader();
    const scanner = onElement ? createElementScanner(onElement) : null;
    const decoder = scanner ? new TextDecoder() : null;
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      clearTimeout(timer);
      timer = setTimeout(stall, BODY_STALL_MS);
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      onBytes?.(received, endpoint);
      scanner?.push(decoder!.decode(value, { stream: true }));
    }
    const all = new Uint8Array(received);
    let offset = 0;
    for (const c of chunks) {
      all.set(c, offset);
      offset += c.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(all)) as OverpassResponse;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchNetwork(
  center: LatLon,
  radiusMeters: number,
  options: FetchNetworkOptions = {},
): Promise<OverpassResponse> {
  return fetchOverpass(buildQuery(center, radiusMeters), cacheKey(center, radiusMeters), options);
}

/**
 * The deliberate area download, four quadrants fetched concurrently with a
 * different mirror rotation each — four queue tickets on four servers, all of
 * them useful work, same instantaneous load as a pair-raced single query.
 * Mirrors can hold slightly different OSM versions, so quadrants may mix
 * versions; the union of all nodes keeps every way reference resolvable.
 * One quadrant exhausting its rounds fails the whole download — a partial
 * network would silently corrupt the graph.
 */
export async function fetchNetworkParallel(
  center: LatLon,
  radiusMeters: number,
  options: FetchNetworkOptions = {},
): Promise<OverpassResponse> {
  const cached = options.skipCacheRead
    ? null
    : await cacheGet<OverpassResponse>(cacheKey(center, radiusMeters));
  if (cached) return cached;

  const boxes = quadrantBoxes(center, radiusMeters);
  const bytes = [0, 0, 0, 0];
  const responses = await Promise.all(
    boxes.map((box, q) =>
      fetchOverpass(buildQueryBBox(box), `overpass:quadrant:${q}`, {
        ...options,
        skipCacheRead: true,
        skipCacheWrite: true,
        endpoints: ENDPOINTS.map((_, i) => (q + i) % ENDPOINTS.length),
        race: 1,
        onBytes: options.onBytes
          ? (b, endpoint) => {
              bytes[q] = b;
              options.onBytes!(bytes.reduce((a, x) => a + x, 0), endpoint);
            }
          : undefined,
        onElement: undefined,
        onStreamRestart: undefined,
      }),
    ),
  );
  const merged = filterByRadius(mergeOverpassResponses(responses), center, radiusMeters);
  await cacheSet(cacheKey(center, radiusMeters), merged);
  return merged;
}

/** Run any Overpass query through the cache, mirror and retry machinery. */
export async function fetchOverpass(
  query: string,
  key: string,
  options: FetchNetworkOptions = {},
): Promise<OverpassResponse> {
  const fetchFn = options.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  if (!options.skipCacheRead) {
    const cached = await cacheGet<OverpassResponse>(key);
    if (cached) return cached;
  }

  let lastError: unknown = null;
  // The public servers reject or hang individually and intermittently (quick
  // 504s under load, dead mirrors), so fail fast per endpoint and make a few
  // rounds over all of them before giving up. A guest keeps its manners:
  // the pause between rounds backs off, a server's Retry-After is honoured,
  // and nothing sleeps after the final round.
  const rounds = options.rounds ?? 2;
  let retryAfterMs = 0;

  // With racing mirrors, only the first body to start streaming emits
  // elements — a second concurrent body would interleave duplicates.
  let streamOwner: number | null = null;
  // Once a result is in, an aborted loser's death must not read as a restart.
  let settled = false;

  const attempt = async (i: number, controller: AbortController): Promise<OverpassResponse> => {
    // Fast-fail if no response headers arrive; dead mirrors otherwise
    // stall the whole search. Overpass computes the full result before
    // sending headers, so callers may widen this for heavy queries.
    const headerTimeout = options.headerTimeoutMs ?? HEADER_TIMEOUT_MS;
    const timer = setTimeout(
      () =>
        controller.abort(
          new Error(`Overpass sent no response headers within ${headerTimeout / 1000} s`),
        ),
      headerTimeout,
    );
    let res;
    try {
      res = await fetchFn(ENDPOINTS[i]!, {
        method: 'POST',
        body: `data=${encodeURIComponent(query)}`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const after = Number(res.headers.get('retry-after'));
      if (Number.isFinite(after) && after > 0) {
        retryAfterMs = Math.max(retryAfterMs, Math.min(after, 60) * 1000);
      }
      throw new Error(`Overpass ${ENDPOINTS[i]} returned ${res.status}`);
    }
    const emits = options.onElement !== undefined && streamOwner === null;
    if (emits) streamOwner = i;
    try {
      const json = await readWithProgress(
        res,
        controller,
        options.onBytes,
        i,
        emits ? options.onElement : undefined,
      );
      if (!Array.isArray(json.elements)) {
        throw new Error(`Overpass ${ENDPOINTS[i]} returned no elements`);
      }
      return json;
    } catch (err) {
      if (emits && !settled) {
        // The emitting body died partway; whoever answers next starts over.
        streamOwner = null;
        options.onStreamRestart?.();
      }
      throw err;
    }
  };

  // Mirrors race in pairs: the dispatcher queue is a per-server lottery
  // (measured 50–80 s on an idle-payload query), so two tickets roughly
  // halve the expected wait. Pairs, not all four at once — we are a guest.
  const order = options.endpoints ?? ENDPOINTS.map((_, i) => i);
  const race = options.race ?? 2;
  for (let round = 0; round < rounds; round++) {
    if (round > 0) {
      const backoff = 2_000 * 2 ** (round - 1);
      await new Promise((resolve) => setTimeout(resolve, Math.max(backoff, retryAfterMs)));
      retryAfterMs = 0;
    }
    for (let i = 0; i < order.length; i += race) {
      const group = order.slice(i, i + race);
      const controllers = group.map(() => new AbortController());
      try {
        const json = await Promise.any(group.map((j, g) => attempt(j, controllers[g]!)));
        settled = true;
        for (const c of controllers) c.abort(new Error('another mirror answered first'));
        if (!options.skipCacheWrite) await cacheSet(key, json);
        return json;
      } catch (err) {
        lastError = err instanceof AggregateError ? (err.errors[err.errors.length - 1] ?? err) : err;
      }
    }
  }
  throw new Error(`All Overpass endpoints failed ${rounds} times over: ${String(lastError)}`);
}

export interface NetworkResult {
  response: OverpassResponse;
  source: 'offline-area' | 'cache-or-network';
}

/**
 * Preferred entry point: serve from a stored offline area when one covers the
 * requested circle, otherwise fall back to cache/network.
 */
export async function getNetwork(
  center: LatLon,
  radiusMeters: number,
  options: FetchNetworkOptions = {},
): Promise<NetworkResult> {
  const area = await findCoveringArea(center, radiusMeters);
  if (area) {
    const stored = await loadArea(area.id);
    if (stored) {
      return { response: filterByRadius(stored, center, radiusMeters), source: 'offline-area' };
    }
  }
  return {
    response: await fetchNetwork(center, radiusMeters, options),
    source: 'cache-or-network',
  };
}
