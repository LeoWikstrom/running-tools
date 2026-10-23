/**
 * Chrome on Android jumps a slider's knob to the finger the moment it lands,
 * before knowing whether the gesture is a drag or a scroll. touch-action:
 * pan-y hands a vertical gesture over to the scroller — which fires
 * pointercancel on the input — but by then the knob has already jumped. So
 * the value is saved on every touch press and put back if the gesture turns
 * out to be a scroll, with an input event so whatever mirrors the slider
 * (weight boxes, the zone circle) follows it back.
 */
export function guardSlidersAgainstScroll(root: ParentNode = document): void {
  for (const slider of root.querySelectorAll<HTMLInputElement>('input[type="range"]')) {
    let saved: string | null = null;
    slider.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') saved = slider.value;
    });
    slider.addEventListener('pointerup', () => {
      saved = null;
    });
    slider.addEventListener('pointercancel', () => {
      if (saved === null) return;
      slider.value = saved;
      saved = null;
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
}
