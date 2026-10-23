const DURATION_MS = 180;

const stillness = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Drop a newly shown overlay in from above. */
export function slideIn(el: HTMLElement): void {
  if (stillness()) return;
  el.animate(
    [
      { transform: 'translateY(-8px)', opacity: 0 },
      { transform: 'none', opacity: 1 },
    ],
    { duration: DURATION_MS, easing: 'ease-out' },
  );
}

/**
 * The reverse of a row's staggered CSS entrance: the elements leave to the
 * left, rightmost first, and `done` fires when the last is out — which is
 * when the caller may actually hide them. The animations are cancelled after
 * `done` so their end state cannot linger over the next entrance.
 */
export function slideOutRow(els: HTMLElement[], done: () => void): void {
  if (stillness() || els.length === 0) {
    done();
    return;
  }
  const anims = els.map((el, i) =>
    el.animate(
      [
        { transform: 'none', opacity: 1 },
        { transform: 'translateX(-10px)', opacity: 0 },
      ],
      {
        duration: DURATION_MS,
        easing: 'ease-in',
        delay: (els.length - 1 - i) * 55,
        fill: 'both',
      },
    ),
  );
  void Promise.allSettled(anims.map((a) => a.finished)).then(() => {
    done();
    for (const a of anims) a.cancel();
  });
}

/**
 * FLIP: call before rebuilding a list to snapshot where its items are, then
 * pass the snapshot and the rebuilt elements to `playReorder` so items slide
 * from their old positions to their new ones.
 */
export function captureTops<T>(items: Iterable<[T, HTMLElement]>): Map<T, number> {
  const tops = new Map<T, number>();
  if (stillness()) return tops;
  for (const [key, el] of items) tops.set(key, el.getBoundingClientRect().top);
  return tops;
}

export function playReorder<T>(before: Map<T, number>, after: Iterable<[T, HTMLElement]>): void {
  if (stillness()) return;
  for (const [key, el] of after) {
    const was = before.get(key);
    if (was === undefined) continue;
    const dy = was - el.getBoundingClientRect().top;
    if (Math.abs(dy) < 1) continue;
    el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], {
      duration: DURATION_MS,
      easing: 'ease-out',
    });
  }
}
