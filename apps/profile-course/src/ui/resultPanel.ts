import { buildGpx } from '../gpx/export';
import type { CourseResult } from '../shared/messages';

const SURFACE_NAMES = ['paved', 'gravel', 'trail', 'unknown'];

export interface ResultElements {
  stats: HTMLElement;
  advanced: HTMLDetailsElement;
  advancedBody: HTMLElement;
  /** Icon buttons on the map's right edge, under the zoom control. */
  mapButtons: HTMLElement;
  downloadButton: HTMLButtonElement;
}

export interface CourseTab {
  /** Mismatch, once that course's search has finished; null until then. */
  score: number | null;
  /** How far the search behind an unfinished tab has got, 0–1. */
  fraction: number;
}

/**
 * One tab per course the search is looking for, labelled with its mismatch —
 * or, while its own search still runs, with how far that search has got. A
 * single course needs no tabs, so the strip stays hidden until there is a
 * choice.
 */
export function renderCourseTabs(
  el: HTMLElement,
  tabs: CourseTab[],
  selected: number,
  onSelect: (index: number) => void,
): void {
  el.hidden = tabs.length < 2;
  // The strip floats over the map, so whatever else is up there moves down.
  document.documentElement.style.setProperty('--tab-strip-h', el.hidden ? '0px' : '42px');
  if (el.hidden) {
    el.textContent = '';
    return;
  }
  // Keep the buttons across redraws where only their state changed: a fresh
  // element has no old style to transition from, so switching tabs could not
  // animate — and it also destroyed the focused tab under the arrow keys.
  if (el.childElementCount !== tabs.length) {
    el.textContent = '';
    tabs.forEach((_, i) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.addEventListener('click', () => onSelect(i));
      el.appendChild(tab);
    });
  }
  tabs.forEach(({ score, fraction }, i) => {
    const tab = el.children[i] as HTMLButtonElement;
    tab.setAttribute('aria-selected', String(i === selected));
    tab.tabIndex = i === selected ? 0 : -1;
    // A tab whose search has started can be watched live; only one whose
    // search has not yet begun (0 %) has nothing to show.
    tab.disabled = score === null && fraction <= 0;
    if (score === null) {
      // The spinner element is kept across progress ticks: recreating it
      // restarted its animation every redraw, so it looked stuck at the top.
      if (!tab.querySelector('.tab-spinner')) {
        tab.textContent = '';
        const spinner = document.createElement('span');
        spinner.className = 'tab-spinner';
        spinner.setAttribute('aria-hidden', 'true');
        tab.append(spinner, document.createElement('span'));
      }
      (tab.lastElementChild as HTMLElement).textContent =
        `${i + 1} · ${Math.round(fraction * 100)} %`;
      tab.title =
        fraction > 0
          ? `Course ${i + 1} is still being searched for — watch it live`
          : `Course ${i + 1} is still being searched for`;
    } else {
      tab.textContent = `${i + 1} · ${score.toFixed(1)}`;
      tab.title = `Course ${i + 1}, mismatch ${score.toFixed(1)} — or press ${i + 1}`;
    }
  });
}

export function hideResult(els: ResultElements): void {
  els.stats.hidden = true;
  els.advanced.hidden = true;
  els.mapButtons.hidden = true;
  els.mapButtons.textContent = '';
  els.downloadButton.hidden = true;
}

export function renderResult(
  els: ResultElements,
  course: CourseResult,
  action: { label: string; onAction: () => void },
  onEdit?: { editing: boolean; toggle: () => void },
  /** What to call the course in the GPX and in its download, e.g. "Vasaloppet alt 2". */
  name = 'Profile course',
): void {
  const split = course.surfaceSplit
    .map((f, i) => (f > 0.005 ? `${Math.round(f * 100)} % ${SURFACE_NAMES[i]}` : null))
    .filter((s) => s !== null)
    .join(', ');
  els.stats.hidden = false;
  els.stats.textContent =
    `${(course.lengthM / 1000).toFixed(2)} km, +${Math.round(course.gain)} m / ` +
    `\u2212${Math.round(course.loss)} m \u00b7 mismatch ${course.score.toFixed(1)} \u00b7 ${split}`;

  const terms = Object.entries(course.breakdown ?? {})
    .filter(([, v]) => v >= 0.05)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v.toFixed(1)}`)
    .join(', ');
  els.advanced.hidden = false;
  els.advancedBody.textContent =
    `Mismatch ${course.score.toFixed(2)} — lower is better, and only comparable between ` +
    `courses scored with the same weights.` +
    (terms ? ` Contributions: ${terms}.` : '') +
    ` Seed ${course.seed}. ${course.exportPoints.length} points at 25 m spacing.`;

  els.downloadButton.hidden = false;
  els.downloadButton.onclick = () => {
    const gpx = buildGpx(
      `${name} ${(course.lengthM / 1000).toFixed(1)} km`,
      `Match score ${course.score.toFixed(2)} (seed ${course.seed})`,
      course.exportPoints,
    );
    const url = URL.createObjectURL(new Blob([gpx], { type: 'application/gpx+xml' }));
    const a = document.createElement('a');
    a.href = url;
    // Watches and route sites key off the file name, so a folder full of
    // alternatives has to say which race and which alternative each one is.
    a.download = `${name.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'course'}.gpx`;
    a.click();
    URL.revokeObjectURL(url);
    // Chrome on Android saves without a word, which reads as nothing having
    // happened — and got the same course downloaded thirty times over.
    els.downloadButton.textContent = 'Saved ✓';
    setTimeout(() => (els.downloadButton.textContent = 'GPX ⤓'), 2000);
  };

  els.mapButtons.hidden = false;
  els.mapButtons.textContent = '';
  const iconButton = (icon: string, label: string, onClick: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = icon;
    b.title = label;
    b.setAttribute('aria-label', label);
    b.addEventListener('click', onClick);
    els.mapButtons.appendChild(b);
    return b;
  };

  if (onEdit) {
    const edit = iconButton(
      '✎',
      onEdit.editing
        ? 'Exit editing'
        : 'Edit: pull the course where you want it, or tap a point then its destination',
      onEdit.toggle,
    );
    edit.setAttribute('aria-pressed', String(onEdit.editing));
    // Does not follow the others up when the tall sheet covers the column:
    // editing needs the map, so it waits behind the menu instead.
    edit.classList.add('map-edit');
  }

  const copyLink = iconButton('🔗', 'Copy link to this course', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      copyLink.textContent = '✓';
      setTimeout(() => (copyLink.textContent = '🔗'), 1500);
    } catch {
      // No clipboard over plain http (the phone-testing setup): show the link
      // in something it can be copied out of by hand.
      window.prompt('Copy the link:', location.href);
    }
  });

  iconButton(action.label === 'Try another' ? '🎲' : '↻', action.label, action.onAction);
}
