import { slideIn } from './animate';

/**
 * One modal dialog for the whole app — keyboard shortcuts, weight
 * explanations, the manual. Only one thing can be modal at a time anyway, so
 * one element is reused rather than a copy per caller.
 */
let overlay: HTMLDivElement | null = null;
let titleEl: HTMLHeadingElement;
let bodyEl: HTMLDivElement;
let closeEl: HTMLButtonElement;

function ensure(): HTMLDivElement {
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.id = 'dialog-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.hidden = true;

  const card = document.createElement('div');
  card.id = 'dialog-card';
  closeEl = document.createElement('button');
  closeEl.id = 'dialog-close';
  closeEl.textContent = '✕';
  closeEl.title = 'Close (Esc)';
  closeEl.setAttribute('aria-label', 'Close');
  closeEl.addEventListener('click', closeDialog);
  titleEl = document.createElement('h2');
  bodyEl = document.createElement('div');
  bodyEl.id = 'dialog-body';
  card.append(closeEl, titleEl, bodyEl);
  overlay.appendChild(card);
  // Anywhere off the card closes: the overlay covers the window, so a tap on
  // it is a tap on the map or panel the user meant to get back to.
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeDialog();
  });
  // aria-modal promises the dialog is all there is, so Tab must not leave it.
  overlay.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const focusables = card.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (focusables.length === 0) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      last.focus();
      e.preventDefault();
    } else if (!e.shiftKey && document.activeElement === last) {
      first.focus();
      e.preventDefault();
    }
  });
  document.body.appendChild(overlay);
  return overlay;
}

let onCloseCb: (() => void) | null = null;

export function openDialog(title: string, content: Node, onClose?: () => void): void {
  const el = ensure();
  titleEl.textContent = title;
  overlay!.setAttribute('aria-label', title);
  bodyEl.replaceChildren(content);
  onCloseCb = onClose ?? null;
  el.hidden = false;
  slideIn(el);
  closeEl.focus();
}

export function dialogOpen(): boolean {
  return overlay !== null && !overlay.hidden;
}

export function closeDialog(): void {
  if (!overlay || overlay.hidden) return;
  overlay.hidden = true;
  // Focus was moved onto the ✕, which is now gone from the page.
  closeEl.blur();
  // However it closed — ✕, Esc, backdrop or a caller — the owner hears once.
  const cb = onCloseCb;
  onCloseCb = null;
  cb?.();
}
