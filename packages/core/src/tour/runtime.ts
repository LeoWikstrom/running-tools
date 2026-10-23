/**
 * The trigger logic of the run player. This file is re-implemented in Java
 * (android/runtour RunRuntime.java) with the same algorithm; the TypeScript
 * tests export their cases and the Java build replays them, so keep the two
 * in step.
 */

export interface RuntimeSettings {
  /** Lateral distance that counts as off course, metres. */
  offCourseM: number;
  /** Seconds off before the state flips (one beep, no triggers). */
  offCourseSec: number;
  /** A place triggers in [triggerD, triggerD + window). */
  triggerWindowM: number;
  /** A queued clip that waited this far past its point is dropped. */
  dropAfterM: number;
  /** dNow follows the nearest point forward, never further back than this. */
  maxBackwardM: number;
}

export const DEFAULT_RUNTIME_SETTINGS: RuntimeSettings = {
  offCourseM: 60,
  offCourseSec: 20,
  triggerWindowM: 150,
  dropAfterM: 200,
  maxBackwardM: 100,
};

export interface RuntimePlace {
  id: string;
  triggerD: number;
}

export interface Fix {
  /** Seconds, any zero point. */
  t: number;
  lat: number;
  lon: number;
}

export type RuntimeEvent =
  | { type: 'play'; placeId: string }
  | { type: 'drop'; placeId: string }
  | { type: 'offCourse' }
  | { type: 'onCourse' };

const M_PER_DEG_LAT = 111_195;

export type PlaceOutcome = 'played' | 'dropped' | 'missed' | 'pending';

/**
 * Feed GPS fixes in, get play/drop/off-course events out. The host owns the
 * audio: on 'play' it starts the clip and calls clipEnded() when it finishes
 * (or is skipped), which may hand back the next queued clip.
 */
export class TourRuntime {
  private readonly lats: ArrayLike<number>;
  private readonly lons: ArrayLike<number>;
  /** Cumulative distance at each vertex, metres. */
  private readonly cum: Float64Array;
  private readonly places: RuntimePlace[];
  private readonly s: RuntimeSettings;

  private d = 0;
  private hasFix = false;
  private off = false;
  private offSince = Number.NaN;
  private playing = false;
  private readonly outcomes = new Map<string, PlaceOutcome>();
  private readonly queue: string[] = [];

  constructor(
    lats: ArrayLike<number>,
    lons: ArrayLike<number>,
    places: RuntimePlace[],
    settings: RuntimeSettings = DEFAULT_RUNTIME_SETTINGS,
  ) {
    this.lats = lats;
    this.lons = lons;
    this.places = [...places].sort((a, b) => a.triggerD - b.triggerD);
    this.s = settings;
    this.cum = new Float64Array(lats.length);
    for (let i = 1; i < lats.length; i++) {
      this.cum[i] =
        this.cum[i - 1]! + haversine(lats[i - 1]!, lons[i - 1]!, lats[i]!, lons[i]!);
    }
    for (const p of places) this.outcomes.set(p.id, 'pending');
  }

  /** Distance along the course at the last fix, metres. */
  dNow(): number {
    return this.d;
  }

  isOffCourse(): boolean {
    return this.off;
  }

  /** The next pending place at or ahead of dNow, for the run screen. */
  nextPlace(): RuntimePlace | null {
    for (const p of this.places) {
      if (this.outcomes.get(p.id) === 'pending' && p.triggerD + this.s.triggerWindowM > this.d) {
        return p;
      }
    }
    return null;
  }

  outcome(placeId: string): PlaceOutcome {
    return this.outcomes.get(placeId) ?? 'pending';
  }

  summary(): { placeId: string; outcome: PlaceOutcome }[] {
    return this.places.map((p) => ({ placeId: p.id, outcome: this.outcomes.get(p.id)! }));
  }

  update(fix: Fix): RuntimeEvent[] {
    const events: RuntimeEvent[] = [];
    const proj = this.project(fix.lat, fix.lon);
    this.d = proj.along;

    if (proj.offset > this.s.offCourseM) {
      if (Number.isNaN(this.offSince)) this.offSince = fix.t;
      if (!this.off && fix.t - this.offSince >= this.s.offCourseSec) {
        this.off = true;
        events.push({ type: 'offCourse' });
      }
    } else {
      this.offSince = Number.NaN;
      if (this.off) {
        this.off = false;
        events.push({ type: 'onCourse' });
      }
    }

    if (!this.off) {
      for (const p of this.places) {
        if (this.outcomes.get(p.id) !== 'pending') continue;
        if (this.queue.includes(p.id)) continue;
        if (this.d >= p.triggerD && this.d < p.triggerD + this.s.triggerWindowM) {
          if (this.playing || this.queue.length > 0) this.queue.push(p.id);
          else {
            this.playing = true;
            this.outcomes.set(p.id, 'played');
            events.push({ type: 'play', placeId: p.id });
          }
        } else if (this.d >= p.triggerD + this.s.triggerWindowM) {
          // Ran past without ever entering the window (a cut course).
          this.outcomes.set(p.id, 'missed');
        }
      }
    }
    events.push(...this.drainQueueDrops());
    return events;
  }

  /** The clip finished (or was skipped); maybe the next queued one starts. */
  clipEnded(): RuntimeEvent[] {
    this.playing = false;
    const events = this.drainQueueDrops();
    const next = this.queue.shift();
    if (next !== undefined) {
      this.playing = true;
      this.outcomes.set(next, 'played');
      events.push({ type: 'play', placeId: next });
    }
    return events;
  }

  /** Drop queued clips that waited more than dropAfterM past their point. */
  private drainQueueDrops(): RuntimeEvent[] {
    const events: RuntimeEvent[] = [];
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const id = this.queue[i]!;
      const place = this.places.find((p) => p.id === id)!;
      if (this.d > place.triggerD + this.s.dropAfterM) {
        this.queue.splice(i, 1);
        this.outcomes.set(id, 'dropped');
        events.push({ type: 'drop', placeId: id });
      }
    }
    return events;
  }

  /**
   * Nearest point on the course that is not more than maxBackwardM behind the
   * last position — so a lap's second pass does not pull dNow back to the
   * first, and noise cannot run the course backwards.
   */
  private project(lat: number, lon: number): { along: number; offset: number } {
    const mPerDegLon = M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
    const floor = this.hasFix ? this.d - this.s.maxBackwardM : -1;
    this.hasFix = true;
    let bestAlong = this.d;
    let bestOffset = Infinity;
    const n = this.lats.length;
    for (let i = 0; i < n - 1; i++) {
      const ax = (this.lons[i]! - lon) * mPerDegLon;
      const ay = (this.lats[i]! - lat) * M_PER_DEG_LAT;
      const bx = (this.lons[i + 1]! - lon) * mPerDegLon;
      const by = (this.lats[i + 1]! - lat) * M_PER_DEG_LAT;
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      let t = len2 === 0 ? 0 : -(ax * dx + ay * dy) / len2;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const segLen = this.cum[i + 1]! - this.cum[i]!;
      const along = this.cum[i]! + t * segLen;
      if (along < floor) continue;
      const cx = ax + t * dx;
      const cy = ay + t * dy;
      const offset = Math.sqrt(cx * cx + cy * cy);
      if (offset < bestOffset) {
        bestOffset = offset;
        bestAlong = along;
      }
    }
    return { along: bestAlong, offset: bestOffset === Infinity ? 0 : bestOffset };
  }
}

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}
