export interface LatLon {
  lat: number;
  lon: number;
}

export interface ViaPoint {
  lat: number;
  lon: number;
  /** Optional km (decimals) near which the point should be reached. */
  km: number | null;
}

/** TargetProfile fields, structured-cloneable for postMessage. */
export interface TargetTransfer {
  totalDistance: number;
  samples: Float32Array;
  totalGain: number;
  totalLoss: number;
  gradientHistogram: Float32Array;
  turnsPerKm: number;
}

export interface CourseSegment {
  lats: Float64Array;
  lons: Float64Array;
  /** SurfaceClass of the edge this segment came from. */
  surface: number;
}

/**
 * The exact path a course was built from — edge indices into one graph, plus
 * the recipe for rebuilding that graph. An edit carries this instead of sending
 * the geometry back to be map-matched, because matching is lossy and rewrites
 * the course far outside any edit window. Structured-cloneable and persisted
 * with the course, so an edit still lands exactly after a reload.
 */
export interface CoursePathRef {
  edges: number[];
  /** 1 = traversed a→b, 0 = b→a. */
  dirs: number[];
  /** The four ensurePrepared arguments, plus the size of what they built. */
  graph: {
    start: LatLon;
    radiusMeters: number;
    targetLengthMeters: number;
    connectors: boolean;
    /** Fingerprint: a rebuild of a different size is not this graph. */
    edgeCount: number;
    nodeCount: number;
  };
}

export interface CourseResult {
  path: CoursePathRef;
  segments: CourseSegment[];
  /** Elevation every ~25 m relative to course start. */
  samples: Float32Array;
  exportPoints: { lat: number; lon: number; ele: number }[];
  lengthM: number;
  gain: number;
  loss: number;
  score: number;
  /** Per-term score contributions, for the breakdown line. */
  breakdown: Record<string, number>;
  surfaceSplit: [number, number, number, number];
  seed: number;
}

export interface AreaInfo {
  id: string;
  lat: number;
  lon: number;
  radiusMeters: number;
  savedAt: number;
  ways: number;
  nodes: number;
}

/** A stored GPS-trace download; `kept` of `points` were at a running pace. */
export interface TraceInfo {
  id: string;
  lat: number;
  lon: number;
  radiusMeters: number;
  savedAt: number;
  points: number;
  timed: number;
  kept: number;
  cells: number;
}

export type MainToWorker =
  | { type: 'ping' }
  | { type: 'elevate'; lats: Float64Array; lons: Float64Array }
  | { type: 'downloadArea'; center: LatLon; radiusMeters: number }
  | { type: 'listAreas' }
  | { type: 'deleteArea'; id: string }
  | { type: 'downloadTraces'; center: LatLon; radiusMeters: number }
  | { type: 'listTraces' }
  | { type: 'deleteTraces'; id: string }
  | {
      type: 'search';
      /**
       * Monotonic, set by the main thread. The worker treats a search whose
       * generation is no longer the latest as cancelled, and echoes `gen` in
       * every search-related reply so stale ones are dropped on arrival —
       * worker replies otherwise land after local state has moved on.
       */
      generation: number;
      start: LatLon;
      radiusMeters: number;
      target: TargetTransfer;
      targetLengthMeters: number;
      seed: number;
      algorithm: 'beam' | 'walk';
      desiredMix: [number, number, number, number] | null;
      returnToStart: boolean;
      /** Course must begin at the marker; otherwise anywhere inside the zone. */
      startAtPoint: boolean;
      /** Overrides merged over DEFAULT_WEIGHTS (advanced settings). */
      weights: Record<string, number> | null;
      /** Synthesize informal street crossings (experimental, slower). */
      connectors: boolean;
      /** Beam width (search effort); default 200. */
      beamWidth: number;
      /** Must-pass points, in order; each with an optional km. */
      viaPoints: ViaPoint[];
      /** Half-width of the km window around each via's km (km). */
      viaToleranceKm: number;
    }
  | {
      /** Map-match an uploaded course and score it against the target. */
      type: 'matchCourse';
      lats: Float64Array;
      lons: Float64Array;
      target: TargetTransfer;
      desiredMix: [number, number, number, number] | null;
      weights: Record<string, number> | null;
    }
  | {
      /** Reroute the current course so it passes through `to` near `atKm`. */
      type: 'editCourse';
      atKm: number;
      to: LatLon;
      /** The path to edit, and its points for when it cannot be rebuilt. */
      path: CoursePathRef;
      lats: Float64Array;
      lons: Float64Array;
      target: TargetTransfer;
      desiredMix: [number, number, number, number] | null;
      weights: Record<string, number> | null;
      /** Via points, which an edit may not reroute away from. */
      viaPoints?: ViaPoint[];
      /** Half-width of the stretch the edit may replace (m). */
      rerouteWindowM?: number;
    }
  | {
      /**
       * Node-level editing on the course node nearest `atKm`: move it to `to`,
       * delete it, or add `to` as a new node on that leg. Each only rewrites the
       * legs around that node, by shortest route, ignoring the score.
       */
      type: 'nodeEdit';
      op: 'move' | 'delete' | 'add';
      atKm: number;
      /** Every node a delete should take, when several are marked at once. */
      atKms?: number[];
      /** Where the node should sit; null for a delete. */
      to: LatLon | null;
      path: CoursePathRef;
      lats: Float64Array;
      lons: Float64Array;
      target: TargetTransfer;
      desiredMix: [number, number, number, number] | null;
      weights: Record<string, number> | null;
      viaPoints?: ViaPoint[];
    }
  | {
      /** Run the improvement pass on the current course. */
      type: 'improveCourse';
      path: CoursePathRef;
      lats: Float64Array;
      lons: Float64Array;
      target: TargetTransfer;
      desiredMix: [number, number, number, number] | null;
      weights: Record<string, number> | null;
    }
  | { type: 'cancel' };

export type WorkerToMain =
  | { type: 'pong' }
  | { type: 'elevated'; elevations: Float32Array }
  | {
      type: 'prepared';
      nodeCount: number;
      edgeCount: number;
      startNode: LatLon;
      startElevation: number;
    }
  | { type: 'areas'; areas: AreaInfo[] }
  | { type: 'traces'; traces: TraceInfo[] }
  | { type: 'progress'; stage: string; fraction: number; bestScore: number | null }
  /**
   * The search's best candidate so far — a live preview for the tab at
   * `index`. `score` is null while it is still a partial path rather than a
   * complete course.
   */
  | {
      type: 'bestSoFar';
      gen: number;
      index: number;
      segments: CourseSegment[];
      samples: Float32Array;
      score: number | null;
    }
  /**
   * Courses arrive one at a time: `courses` opens that many tabs, each filled
   * by a `course` of its own search, and `coursesDone` closes any the search
   * could not fill with a course worth offering.
   */
  | { type: 'courses'; gen: number; total: number }
  | { type: 'courseProgress'; gen: number; index: number; fraction: number }
  | { type: 'course'; gen: number; index: number; course: CourseResult }
  | { type: 'coursesDone'; gen: number; ready: number }
  | { type: 'matched'; course: CourseResult; snappedFraction: number; improvable: boolean }
  | { type: 'noCourse'; gen: number; message: string }
  | { type: 'error'; message: string };
