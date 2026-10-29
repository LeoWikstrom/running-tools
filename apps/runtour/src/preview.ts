import { haversineMeters } from '@running/core/geo';
import {
  DEFAULT_RUNTIME_SETTINGS,
  TourRuntime,
  type RuntimeEvent,
  type RuntimeSettings,
} from '@running/core/tour/runtime';
import { VARIANT_DEFAULTS } from './variant';

/** The preview plays with the variant's trigger geometry, like the phone will. */
const RUNTIME_SETTINGS: RuntimeSettings = {
  ...DEFAULT_RUNTIME_SETTINGS,
  triggerWindowM: VARIANT_DEFAULTS.triggerWindowM,
  dropAfterM: VARIANT_DEFAULTS.dropAfterM,
};

export interface PreviewPlace {
  id: string;
  name: string;
  triggerD: number;
  text: string;
}

export interface PreviewCallbacks {
  onPosition(lat: number, lon: number, d: number, offCourse: boolean): void;
  onSpeak(place: PreviewPlace): void;
  onInfo(text: string): void;
  onDone(): void;
}

export interface PreviewHandle {
  stop(): void;
  /** Simulated previews only: change the speed-up factor mid-run. */
  setSpeed?(factor: number): void;
  /** Freeze the runner and the voice without losing the position. */
  setPaused(paused: boolean): void;
}

const TICK_MS = 500;

function speak(text: string, lang: string, onEnd: () => void): void {
  if (!('speechSynthesis' in window)) {
    // No voice on this browser: pretend the clip took its estimated time.
    setTimeout(onEnd, 1000);
    return;
  }
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = lang;
  utterance.onend = onEnd;
  utterance.onerror = onEnd;
  speechSynthesis.speak(utterance);
}

/**
 * Walk a simulated runner along the course at the given pace (optionally
 * sped up), reading each clip with the Web Speech API — order, lead and
 * length can be checked from the sofa.
 */
export function startSimulatedPreview(
  lats: number[],
  lons: number[],
  places: PreviewPlace[],
  lang: string,
  paceSecPerKm: number,
  speedFactor: number,
  cb: PreviewCallbacks,
): PreviewHandle {
  const cum = new Float64Array(lats.length);
  for (let i = 1; i < lats.length; i++) {
    cum[i] = cum[i - 1]! + haversineMeters(lats[i - 1]!, lons[i - 1]!, lats[i]!, lons[i]!);
  }
  const total = cum[cum.length - 1]!;
  const rt = new TourRuntime(lats, lons, places, RUNTIME_SETTINGS);
  let factor = speedFactor;
  const metresPerSecond = (): number => (1000 / paceSecPerKm) * factor;

  let d = 0;
  let t = 0;
  let stopped = false;
  let paused = false;

  const pointAt = (dist: number): [number, number] => {
    let lo = 0;
    let hi = cum.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid]! <= dist) lo = mid;
      else hi = mid;
    }
    const segLen = cum[hi]! - cum[lo]!;
    const f = segLen === 0 ? 0 : (dist - cum[lo]!) / segLen;
    return [lats[lo]! + f * (lats[hi]! - lats[lo]!), lons[lo]! + f * (lons[hi]! - lons[lo]!)];
  };

  const handleEvents = (events: RuntimeEvent[]): void => {
    for (const ev of events) {
      if (ev.type === 'play') {
        const place = places.find((p) => p.id === ev.placeId)!;
        cb.onSpeak(place);
        speak(place.text || `You are passing ${place.name}.`, lang, () => {
          if (!stopped) handleEvents(rt.clipEnded());
        });
      } else if (ev.type === 'drop') {
        const place = places.find((p) => p.id === ev.placeId);
        cb.onInfo(`Dropped “${place?.name ?? ev.placeId}” — it waited too long in the queue.`);
      }
    }
  };

  const timer = setInterval(() => {
    if (stopped || paused) return;
    t += TICK_MS / 1000;
    d = Math.min(total, d + metresPerSecond() * (TICK_MS / 1000));
    const [lat, lon] = pointAt(d);
    handleEvents(rt.update({ t, lat, lon }));
    cb.onPosition(lat, lon, rt.dNow(), rt.isOffCourse());
    if (d >= total) {
      stop();
      cb.onDone();
    }
  }, TICK_MS);

  function stop(): void {
    stopped = true;
    clearInterval(timer);
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  }

  return {
    stop,
    setSpeed(f: number): void {
      factor = f;
    },
    setPaused(p: boolean): void {
      paused = p;
      if ('speechSynthesis' in window) {
        if (p) speechSynthesis.pause();
        else speechSynthesis.resume();
      }
    },
  };
}

