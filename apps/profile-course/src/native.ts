/** Typed face of the `window.RaceTwin` bridge the Android app injects. */
interface RaceTwinBridge {
  /** A foreground-service notification that keeps a minimised app
      downloading. Empty text takes it down. */
  downloadStatus?(text: string): void;
  /** A dismissible "finished" notice once the ongoing one is taken down. */
  downloadDone?(text: string): void;
}

declare global {
  interface Window {
    RaceTwin?: RaceTwinBridge;
  }
}

const native: RaceTwinBridge | undefined = window.RaceTwin;

/** Show/update the download notification in the APK; a no-op on the web.
    Empty text takes it down. */
export function downloadNotice(text: string): void {
  try {
    native?.downloadStatus?.(text);
  } catch {
    // An old APK without the method must never break a download.
  }
}

/** A dismissible "download finished" notification in the APK; no-op on the web. */
export function downloadDoneNotice(text: string): void {
  try {
    native?.downloadDone?.(text);
  } catch {
    // An old APK without the method must never break a download.
  }
}
