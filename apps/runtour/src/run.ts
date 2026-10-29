import L from 'leaflet';
import { validateTour, type TourPlaceImage } from '@running/core/tour/types';
import type { LocateHandle } from './locate';
import { fitVisible } from './ui/visibleMap';
import { getRunState, getTourJson, sendRunAction, type RunState } from './native';
import { PLACE_COLOR } from './variant';

export interface RunModeOptions {
  map: L.Map;
  sheet: HTMLElement;
  /** The preparation panel, hidden while a run is on. */
  controls: HTMLElement;
  /** The shared "you are here" dot; the service's GPS fixes drive it. */
  locate: LocateHandle;
  onExit(): void;
}

export interface RunModeHandle {
  enter(): void;
  /** Enter run mode at startup when the service already has a run going. */
  maybeResume(): boolean;
}

const ICONS = {
  pause:
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">' +
    '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
  play:
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">' +
    '<path d="M8 5l12 7-12 7z"/></svg>',
  skip:
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">' +
    '<path d="M5 5l10 7-10 7z"/><rect x="16.5" y="5" width="3" height="14" rx="1"/></svg>',
  repeat:
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" ' +
    'stroke-width="2.4" stroke-linecap="round" aria-hidden="true">' +
    '<path d="M19 12a7 7 0 1 1-2.05-4.95"/><path d="M19.6 2.6v5h-5"/></svg>',
};

const OUTCOME_GLYPH: Record<string, string> = {
  played: '✓',
  dropped: '↷',
  missed: '✗',
  pending: '·',
};

function fmtTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * The run screen, in the sheet over the live map: the preparation controls
 * step aside for a panel polling the Android run service once a second —
 * next place, distance, player-style controls, and the summary at the end.
 */
export function initRunMode(opts: RunModeOptions): RunModeHandle {
  let panel: HTMLDivElement | null = null;
  let timer: number | undefined;
  let courseLine: L.Polyline | null = null;
  let placeLayer: L.LayerGroup | null = null;
  let active = false;
  let summaryShown = false;
  let courseDrawn = false;

  const elems = {} as {
    title: HTMLHeadingElement;
    next: HTMLParagraphElement;
    stats: HTMLParagraphElement;
    off: HTMLParagraphElement;
    pause: HTMLButtonElement;
    finish: HTMLButtonElement;
    buttons: HTMLDivElement;
    summary: HTMLDivElement;
    back: HTMLButtonElement;
    image: HTMLElement;
    imageImg: HTMLImageElement;
    imageCap: HTMLElement;
  };

  /** Historical photos from the tour, shown while their clip plays. */
  const placeImages = new Map<string, { name: string; image: TourPlaceImage }>();
  let shownImageId: string | null = null;

  function build(): HTMLDivElement {
    const box = document.createElement('div');
    box.id = 'run-panel';
    elems.title = document.createElement('h1');
    elems.next = document.createElement('p');
    elems.next.className = 'run-next';
    elems.stats = document.createElement('p');
    elems.stats.className = 'hint';
    elems.off = document.createElement('p');
    elems.off.className = 'run-off';
    elems.off.textContent = 'Off course';
    elems.off.hidden = true;

    elems.image = document.createElement('figure');
    elems.image.className = 'place-image';
    elems.image.hidden = true;
    elems.imageImg = document.createElement('img');
    elems.imageCap = document.createElement('figcaption');
    elems.imageCap.className = 'hint';
    elems.image.append(elems.imageImg, elems.imageCap);

    elems.buttons = document.createElement('div');
    elems.buttons.className = 'run-buttons';
    const btn = (
      cls: string,
      icon: string,
      label: string,
      onClick: () => void,
    ): HTMLButtonElement => {
      const b = document.createElement('button');
      b.className = cls;
      b.innerHTML = icon;
      b.setAttribute('aria-label', label);
      b.title = label;
      b.addEventListener('click', onClick);
      return b;
    };
    elems.pause = btn('run-pause', ICONS.pause, 'Pause the run', () => sendRunAction('pause'));
    elems.buttons.append(
      btn('run-repeat', ICONS.repeat, 'Repeat the last clip', () => sendRunAction('repeat')),
      elems.pause,
      btn('run-skip', ICONS.skip, 'Skip the current clip', () => sendRunAction('skip')),
    );
    elems.finish = document.createElement('button');
    elems.finish.className = 'run-finish-wide';
    elems.finish.textContent = 'Finish run';
    elems.finish.addEventListener('click', () => sendRunAction('finish'));

    elems.summary = document.createElement('div');
    elems.summary.className = 'run-summary';
    elems.summary.hidden = true;
    elems.back = document.createElement('button');
    elems.back.textContent = 'Back to planning';
    elems.back.className = 'run-back';
    elems.back.hidden = true;
    elems.back.addEventListener('click', exit);

    box.append(
      elems.title,
      elems.next,
      elems.image,
      elems.stats,
      elems.off,
      elems.buttons,
      elems.finish,
      elems.summary,
      elems.back,
    );
    return box;
  }

  function drawCourse(tourId: string): void {
    try {
      const tour = validateTour(JSON.parse(getTourJson(tourId)));
      placeImages.clear();
      for (const p of tour.places) {
        if (p.image) placeImages.set(p.id, { name: p.name, image: p.image });
      }
      const points = tour.route.points.map((p) => [p[0], p[1]] as [number, number]);
      courseLine = L.polyline(points, { color: PLACE_COLOR, weight: 4 }).addTo(opts.map);
      placeLayer = L.layerGroup().addTo(opts.map);
      for (const p of tour.places) {
        L.circleMarker([p.lat, p.lon], {
          radius: 6,
          color: PLACE_COLOR,
          fillOpacity: 0.6,
          weight: 2,
        })
          .bindTooltip(p.name)
          .addTo(placeLayer);
      }
      fitVisible(opts.map, opts.sheet, courseLine.getBounds());
    } catch {
      // No course line is survivable; the run still narrates.
    }
  }

  function renderSummary(state: RunState): void {
    summaryShown = true;
    elems.next.textContent = 'Run finished';
    elems.buttons.hidden = true;
    elems.finish.hidden = true;
    elems.off.hidden = true;
    elems.summary.hidden = false;
    elems.summary.innerHTML = '';
    for (const line of state.summary) {
      const p = document.createElement('p');
      p.textContent = `${OUTCOME_GLYPH[line.outcome] ?? '·'} ${line.name}`;
      elems.summary.appendChild(p);
    }
    elems.back.hidden = false;
  }

  function render(): void {
    const state = getRunState();
    if (!state || !state.started) {
      // startRun was sent but the service has not come up yet — permission
      // dialogs may be on screen. Back offers the way out if they are denied.
      elems.title.textContent = 'Starting the run…';
      elems.next.textContent = 'Grant the permission dialogs if they appear.';
      elems.stats.textContent = '';
      elems.buttons.hidden = true;
      elems.finish.hidden = true;
      elems.back.hidden = false;
      return;
    }
    if (!courseDrawn) {
      courseDrawn = true;
      drawCourse(state.tourId);
    }
    elems.title.textContent = state.tourName || 'Run';
    if (state.finished) {
      if (!summaryShown) renderSummary(state);
      return;
    }
    elems.buttons.hidden = false;
    elems.finish.hidden = false;
    elems.back.hidden = true;
    elems.next.textContent = state.nextPlaceName
      ? `Next: ${state.nextPlaceName} — ${Math.max(0, Math.round(state.nextPlaceRemainingM ?? 0))} m`
      : 'No places left — run to the finish.';
    elems.stats.textContent =
      `${(state.dNow / 1000).toFixed(2)} / ${(state.tourDistance / 1000).toFixed(1)} km · ` +
      fmtTime(state.elapsedSeconds) + (state.paused ? ' · paused' : '');
    elems.off.hidden = !state.offCourse;
    const playing = state.playingPlaceId ? placeImages.get(state.playingPlaceId) : undefined;
    if (playing && shownImageId !== state.playingPlaceId) {
      shownImageId = state.playingPlaceId;
      elems.imageImg.src = playing.image.url;
      elems.imageImg.alt = playing.name;
      elems.imageCap.textContent =
        `${playing.name}${playing.image.year ? `, ${playing.image.year}` : ''} · ` +
        playing.image.attribution;
    }
    // The photo lingers after its clip: a glance can come seconds late.
    elems.image.hidden = shownImageId === null;
    elems.pause.innerHTML = state.paused ? ICONS.play : ICONS.pause;
    elems.pause.title = state.paused ? 'Resume the run' : 'Pause the run';
    if (state.lat !== null && state.lon !== null) opts.locate.setPosition(state.lat, state.lon);
  }

  function enter(): void {
    if (active) return;
    active = true;
    summaryShown = false;
    courseDrawn = false;
    opts.controls.hidden = true;
    opts.locate.enterRunMode();
    panel = build();
    opts.controls.insertAdjacentElement('afterend', panel);
    render();
    timer = window.setInterval(render, 1000);
  }

  function exit(): void {
    sendRunAction('reset');
    clearInterval(timer);
    courseLine?.remove();
    courseLine = null;
    placeLayer?.remove();
    placeLayer = null;
    panel?.remove();
    panel = null;
    active = false;
    opts.locate.exitRunMode();
    opts.controls.hidden = false;
    opts.onExit();
  }

  return {
    enter,
    maybeResume(): boolean {
      if (!getRunState()?.started) return false;
      enter();
      return true;
    },
  };
}
