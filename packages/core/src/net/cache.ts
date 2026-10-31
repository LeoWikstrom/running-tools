import { get, set } from 'idb-keyval';

const hasIdb = typeof indexedDB !== 'undefined';
const memory = new Map<string, unknown>();

export async function cacheGet<T>(key: string): Promise<T | undefined> {
  if (!hasIdb) return memory.get(key) as T | undefined;
  try {
    return await get<T>(key);
  } catch {
    return undefined;
  }
}

export async function cacheSet(key: string, value: unknown): Promise<void> {
  if (!hasIdb) {
    memory.set(key, value);
    return;
  }
  try {
    await set(key, value);
  } catch {
    // Cache write failure is non-fatal (private mode, quota).
  }
}

/**
 * Like cacheSet, but a failed write throws: for payloads whose index entry
 * must not be written if the payload was not (a listed offline area whose
 * blob never landed would load as undefined).
 */
export async function cacheSetOrThrow(key: string, value: unknown): Promise<void> {
  if (!hasIdb) {
    memory.set(key, value);
    return;
  }
  await set(key, value);
}

/**
 * TTL pair for caches of living data (Wikipedia/Wikidata POIs and texts).
 * Terrain tiles and Overpass graphs stay on the plain pair: effectively
 * static and expensive to refetch. A legacy unwrapped entry counts as stale.
 */
export async function cacheSetStamped(key: string, value: unknown): Promise<void> {
  await cacheSet(key, { savedAt: Date.now(), value });
}

export async function cacheGetFresh<T>(key: string, maxAgeMs: number): Promise<T | undefined> {
  const entry = await cacheGet<{ savedAt?: unknown; value?: T }>(key);
  if (entry === undefined || typeof entry.savedAt !== 'number') return undefined;
  if (Date.now() - entry.savedAt > maxAgeMs) return undefined;
  return entry.value;
}
