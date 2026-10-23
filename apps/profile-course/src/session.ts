import type { TargetProfile } from './gpx/profile';
import { cacheGet, cacheSet } from './net/cache';
import type { CourseResult, LatLon } from './shared/messages';

export interface SessionSettings {
  start: LatLon | null;
  radiusKm: string;
  distanceKm: string;
  rangeFromKm: string;
  rangeToKm: string;
  surface: string;
  returnToStart: boolean;
  startAnywhere?: boolean;
  /** Weight the search towards paths public GPS traces have been run along. */
  useTraces?: boolean;
  /** Search effort (beam width), which is a per-machine taste, not per course. */
  beamWidth?: number;
  viaPoints?: { lat: number; lon: number; km: number | null }[];
  seed: number;
}

export interface SessionState {
  profile: TargetProfile | null;
  gpxLabel: string | null;
  settings: SessionSettings;
  /**
   * The search's courses, one per tab, each with the exact profile it was
   * scored against. Written by a version that only kept the shown one, so it
   * may be missing.
   */
  results?: { course: CourseResult; profile: TargetProfile }[];
  /** Which of `results` was on screen. */
  shown?: number;
}

const KEY = 'session:v1';

let pending: SessionState | null = null;
let writing = false;

/** Coalesces rapid saves; IndexedDB writes are fire-and-forget. */
export function saveSession(state: SessionState): void {
  pending = state;
  if (writing) return;
  writing = true;
  queueMicrotask(async () => {
    try {
      while (pending) {
        const next = pending;
        pending = null;
        await cacheSet(KEY, next);
      }
    } finally {
      writing = false;
    }
  });
}

export async function loadSession(): Promise<SessionState | null> {
  const state = await cacheGet<SessionState>(KEY);
  if (!state) return null;
  // Courses saved before they carried their own path cannot be edited: the id
  // they carry instead belonged to a worker that no longer exists, so every
  // edit falls back to a map-match, which rewrites or refuses the course. The
  // GPX and the settings are still good, so only the tabs go.
  if (state.results?.some((r) => !r.course.path)) {
    return { ...state, results: undefined, shown: undefined };
  }
  return state;
}

/** Ask the browser not to evict our origin's storage under disk pressure. */
export async function requestPersistentStorage(): Promise<string> {
  try {
    if (!navigator.storage?.persist) return '';
    const persisted = (await navigator.storage.persisted()) || (await navigator.storage.persist());
    const estimate = await navigator.storage.estimate();
    const used = ((estimate.usage ?? 0) / 1048576).toFixed(1);
    const quota = ((estimate.quota ?? 0) / 1073741824).toFixed(1);
    return `Storage: ${used} MB used of ${quota} GB${persisted ? ', protected from eviction' : ''}`;
  } catch {
    return '';
  }
}
