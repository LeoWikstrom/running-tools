const HANDLE_VISIBLE_PX = 30;
const TAP_THRESHOLD_PX = 8;
/** Fraction of the screen each open stop covers, whatever the sheet holds. */
const MIDDLE_FRACTION = 0.25;
const FULL_FRACTION = 0.55;

/** `tall` covers the screen; `full` is the usual half-screen panel. */
export type SheetLevel = 'collapsed' | 'middle' | 'full' | 'tall';

export interface SheetController {
  level(): SheetLevel;
  setLevel(level: SheetLevel): void;
  /** Collapse, remembering the current stop so restore() can return to it. */
  collapse(): void;
  /** Re-open at the stop the sheet was last opened to. */
  restore(): void;
}

/**
 * Bottom sheet with three stops. Dragging the handle snaps to the nearest one;
 * tapping it collapses an open sheet, or re-opens a collapsed one at whichever
 * stop it came from.
 */
export function initSheet(
  sheet: HTMLElement,
  handle: HTMLElement,
  /** Told whenever the sheet settles on a stop (not during the drag). */
  onLevel?: (level: SheetLevel) => void,
): SheetController {
  let level: SheetLevel = 'full';
  let lastOpen: Exclude<SheetLevel, 'collapsed'> = 'full';
  let dragging = false;
  let startY = 0;
  let startOffset = 0;

  // A pushed-down sheet keeps its box height, so its last items would sit below
  // the screen edge with nothing left to scroll. This spacer gives them room.
  const spacer = document.createElement('div');
  spacer.setAttribute('aria-hidden', 'true');
  sheet.appendChild(spacer);

  const isWide = () => window.matchMedia('(min-width: 900px)').matches;

  /** Sheet height with the spacer collapsed, so the stops don't feed back. */
  function naturalHeight(): number {
    const was = spacer.style.height;
    spacer.style.height = '0px';
    const h = sheet.getBoundingClientRect().height;
    spacer.style.height = was;
    return h;
  }

  const maxOffset = () => naturalHeight() - HANDLE_VISIBLE_PX;

  function offsetFor(l: SheetLevel, max = maxOffset()): number {
    // The sheet box may be taller than a stop allows, so the surplus is pushed
    // below the screen edge; `tall` brings all of it up.
    if (l === 'tall') return 0;
    if (l === 'collapsed') return max;
    const fraction = l === 'full' ? FULL_FRACTION : MIDDLE_FRACTION;
    const surplus = max + HANDLE_VISIBLE_PX - window.innerHeight * fraction;
    return Math.min(max, Math.max(0, surplus));
  }

  function apply(offset: number, animate: boolean): void {
    sheet.style.transition = animate ? 'transform 0.2s ease-out' : 'none';
    sheet.style.transform = offset > 0 ? `translateY(${offset}px)` : '';
  }

  let applied = -1;

  function setLevel(l: SheetLevel): void {
    level = l;
    if (l !== 'collapsed') lastOpen = l;
    const offset = offsetFor(l);
    applied = offset;
    spacer.style.height = `${Math.round(offset)}px`;
    apply(offset, true);
    onLevel?.(l);
  }

  // Results and panels change the sheet's height, which moves every stop.
  new ResizeObserver(() => {
    if (isWide() || dragging) return;
    if (Math.abs(offsetFor(level) - applied) > 1) setLevel(level);
  }).observe(sheet);

  /**
   * The stops from highest to lowest, dropping any that lands where the one
   * before it already sits (a short sheet has nothing to show at `tall`).
   */
  function stops(max: number): { level: SheetLevel; offset: number }[] {
    const out: { level: SheetLevel; offset: number }[] = [];
    for (const level of ['tall', 'full', 'middle', 'collapsed'] as const) {
      const offset = offsetFor(level, max);
      if (out.length === 0 || offset - out[out.length - 1]!.offset > 8) out.push({ level, offset });
    }
    return out;
  }

  function nearestStop(list: { offset: number }[], offset: number): number {
    let best = 0;
    for (let i = 1; i < list.length; i++) {
      if (Math.abs(offset - list[i]!.offset) < Math.abs(offset - list[best]!.offset)) best = i;
    }
    return best;
  }

  let dragMax = 0;
  handle.addEventListener('pointerdown', (e) => {
    if (isWide()) return; // the sheet is a static sidebar on wide screens
    dragging = true;
    startY = e.clientY;
    dragMax = maxOffset();
    startOffset = offsetFor(level, dragMax);
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    apply(Math.min(dragMax, Math.max(0, startOffset + e.clientY - startY)), false);
  });

  // Rotating the phone changes every stop's offset.
  window.addEventListener('resize', () => {
    if (isWide()) {
      spacer.style.height = '0px';
      // Clear any translateY left from mobile so the desktop sidebar sits flush.
      sheet.style.transform = '';
      sheet.style.transition = '';
    } else setLevel(level);
  });

  const finish = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    const dy = e.clientY - startY;
    if (Math.abs(dy) < TAP_THRESHOLD_PX) {
      setLevel(level === 'collapsed' ? lastOpen : 'collapsed');
      return;
    }
    const max = maxOffset();
    const list = stops(max);
    const from = nearestStop(list, startOffset);
    let to = nearestStop(list, Math.min(max, Math.max(0, startOffset + dy)));
    // However short the flick, it moves at least one stop the way it went.
    if (dy > 0) to = Math.max(to, Math.min(from + 1, list.length - 1));
    else to = Math.min(to, Math.max(from - 1, 0));
    setLevel(list[to]!.level);
  };
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);

  if (!isWide()) setLevel('full');

  return {
    level: () => level,
    setLevel,
    collapse() {
      if (!isWide() && level !== 'collapsed') setLevel('collapsed');
    },
    restore() {
      if (!isWide() && level === 'collapsed') setLevel(lastOpen);
    },
  };
}
