import { haversineMeters } from '@running/core/geo';
import {
  DEFAULT_RUNTIME_SETTINGS,
  TourRuntime,
  type RuntimeEvent,
} from '@running/core/tour/runtime';

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
  const rt = new TourRuntime(lats, lons, places, DEFAULT_RUNTIME_SETTINGS);
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

/**
 * The same runtime driven by real GPS in the browser — works with the screen
 * on; the caller shows the notice that it stops when the screen turns off.
 */
export function startGpsPreview(
  lats: number[],
  lons: number[],
  places: PreviewPlace[],
  lang: string,
  cb: PreviewCallbacks,
): PreviewHandle {
  const rt = new TourRuntime(lats, lons, places, DEFAULT_RUNTIME_SETTINGS);
  let stopped = false;
  let paused = false;

  const handleEvents = (events: RuntimeEvent[]): void => {
    for (const ev of events) {
      if (ev.type === 'play') {
        const place = places.find((p) => p.id === ev.placeId)!;
        cb.onSpeak(place);
        speak(place.text || `You are passing ${place.name}.`, lang, () => {
          if (!stopped) handleEvents(rt.clipEnded());
        });
      } else if (ev.type === 'offCourse') {
        cb.onInfo('Off course.');
      } else if (ev.type === 'onCourse') {
        cb.onInfo('Back on course.');
      }
    }
  };

  const watch = navigator.geolocation.watchPosition(
    (pos) => {
      if (stopped || paused) return;
      handleEvents(
        rt.update({ t: pos.timestamp / 1000, lat: pos.coords.latitude, lon: pos.coords.longitude }),
      );
      cb.onPosition(pos.coords.latitude, pos.coords.longitude, rt.dNow(), rt.isOffCourse());
    },
    (err) => cb.onInfo(`GPS: ${err.message}`),
    { enableHighAccuracy: true, maximumAge: 0 },
  );

  return {
    stop(): void {
      stopped = true;
      navigator.geolocation.clearWatch(watch);
      if ('speechSynthesis' in window) speechSynthesis.cancel();
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
