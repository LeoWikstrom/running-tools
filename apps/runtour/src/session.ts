import { cacheGet, cacheSet } from '@running/core/net/cache';
import type { Tour } from '@running/core/tour/types';

const KEY = 'runtour:session:v1';

let pending: Tour | null | undefined;
let writing = false;

/** Coalesces rapid saves; IndexedDB writes are fire-and-forget. */
export function saveSession(tour: Tour | null): void {
  pending = tour;
  if (writing) return;
  writing = true;
  queueMicrotask(async () => {
    try {
      while (pending !== undefined) {
        const next = pending;
        pending = undefined;
        await cacheSet(KEY, next);
      }
    } finally {
      writing = false;
    }
  });
}

export async function loadSession(): Promise<Tour | null> {
  return (await cacheGet<Tour | null>(KEY)) ?? null;
}
