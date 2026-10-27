let el: HTMLDivElement | null = null;
let hideTimer: number | undefined;

/**
 * A small notice fading in at the top of the screen and out again after a few
 * seconds — for statuses that must be seen wherever the panel is scrolled.
 */
export function toast(text: string, ms = 4000): void {
  if (text.length === 0) return;
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = text;
  // Force a style flush so re-showing restarts the fade.
  void el.offsetWidth;
  el.classList.add('show');
  clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => el?.classList.remove('show'), ms);
}
