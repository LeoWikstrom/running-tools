/** Typed face of the `window.RunTour` bridge the Android app injects. */
interface RunTourBridge {
  listTours(): string;
  getTour(id: string): string;
  saveTour(json: string): string;
  deleteTour(id: string): void;
  synthesize(tourId: string, filename: string, text: string, lang: string, cb: number): void;
  fetchText(url: string, cb: number): void;
  /** Absent on APKs older than the image prefetch. */
  downloadTourFile?(tourId: string, filename: string, url: string, cb: number): void;
  /** Live speech for the preview; the WebView has no Web Speech API. */
  speak?(text: string, lang: string, cb: number): void;
  stopSpeaking?(): void;
  playFile(tourId: string, filename: string): boolean;
  stopPlayback(): void;
  startRun(tourId: string): void;
  runState(): string;
  runAction(action: string): void;
  /** Absent on APKs older than background downloads: a foreground-service
      notification that keeps a minimised app downloading. Empty text ends it. */
  downloadStatus?(text: string): void;
}

declare global {
  interface Window {
    RunTour?: RunTourBridge;
    __rtResolve?: (id: number, ok: boolean, payload: string) => void;
    /** Called by the app when a manually played clip reaches its end. */
    __rtPlaybackEnded?: () => void;
  }
}

export interface TourInfo {
  id: string;
  name: string;
  places: number;
  audio: number;
}

export const native: RunTourBridge | undefined = window.RunTour;

/** Show/update the download notification in the APK; a no-op on the web.
    Empty text takes it down. */
export function downloadNotice(text: string): void {
  try {
    native?.downloadStatus?.(text);
  } catch {
    // An old APK without the method must never break a download.
  }
}

let nextCallback = 1;
const pending = new Map<number, { resolve: (s: string) => void; reject: (e: Error) => void }>();

window.__rtResolve = (id, ok, payload) => {
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  if (ok) entry.resolve(payload);
  else entry.reject(new Error(payload));
};

function call(start: (cb: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const id = nextCallback++;
    pending.set(id, { resolve, reject });
    start(id);
  });
}

export function listTours(): TourInfo[] {
  if (!native) return [];
  return JSON.parse(native.listTours()) as TourInfo[];
}

export function getTourJson(id: string): string {
  return native?.getTour(id) ?? '';
}

/** Returns the stored id; throws when the phone refused the JSON. */
export function saveTourToPhone(json: string): string {
  const id = native!.saveTour(json);
  if (!id) throw new Error('The phone could not store the tour.');
  return id;
}

export function deleteTour(id: string): void {
  native?.deleteTour(id);
}

export function synthesize(
  tourId: string,
  filename: string,
  text: string,
  lang: string,
): Promise<string> {
  return call((cb) => native!.synthesize(tourId, filename, text, lang, cb));
}

export function fetchTextNative(url: string): Promise<string> {
  return call((cb) => native!.fetchText(url, cb));
}

export function playFile(tourId: string, filename: string): boolean {
  return native?.playFile(tourId, filename) ?? false;
}

export function stopPlayback(): void {
  native?.stopPlayback();
}

export function onPlaybackEnded(cb: () => void): void {
  window.__rtPlaybackEnded = cb;
}

export const hasNativeSpeech = !!native?.speak;

/** Resolves when the utterance ends (or is interrupted by the next one). */
export function speakNative(text: string, lang: string): Promise<void> {
  return call((cb) => native!.speak!(text, lang, cb)).then(() => undefined);
}

export function stopSpeakingNative(): void {
  native?.stopSpeaking?.();
}

export function startRun(tourId: string): void {
  native?.startRun(tourId);
}

export interface RunState {
  started: boolean;
  paused: boolean;
  finished: boolean;
  tourId: string;
  tourName: string;
  dNow: number;
  tourDistance: number;
  elapsedSeconds: number;
  offCourse: boolean;
  nextPlaceName: string | null;
  nextPlaceRemainingM: number | null;
  /** The place whose clip is sounding right now, when any. */
  playingPlaceId: string | null;
  lat: number | null;
  lon: number | null;
  summary: { outcome: 'played' | 'dropped' | 'missed' | 'pending'; name: string }[];
}

/** The run service's state snapshot; null in a plain browser. */
export function getRunState(): RunState | null {
  if (!native?.runState) return null;
  try {
    return JSON.parse(native.runState()) as RunState;
  } catch {
    return null;
  }
}

export type RunAction = 'pause' | 'skip' | 'repeat' | 'finish' | 'reset';

export function sendRunAction(action: RunAction): void {
  native?.runAction(action);
}

export function audioFilename(placeId: string): string {
  return `${placeId.replace(/[^a-zA-Z0-9._-]/g, '_')}.wav`;
}

/** Download a URL into the tour's directory on the phone. */
export function downloadTourFile(tourId: string, filename: string, url: string): Promise<void> {
  if (!native?.downloadTourFile) return Promise.reject(new Error('not supported by this app'));
  return call((cb) => native!.downloadTourFile!(tourId, filename, url, cb)).then(() => undefined);
}

export function imageFilename(placeId: string, url: string): string {
  const ext = /\.(png|jpe?g|gif|webp)(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase() ?? 'jpg';
  return `img_${placeId.replace(/[^a-zA-Z0-9._-]/g, '_')}.${ext}`;
}
