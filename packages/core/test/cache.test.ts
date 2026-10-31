import { describe, expect, it } from 'vitest';
import { cacheGetFresh, cacheSet, cacheSetStamped } from '../src/net/cache';

describe('stamped cache', () => {
  it('returns a fresh entry and refuses a stale one', async () => {
    await cacheSetStamped('ttl:fresh', 42);
    expect(await cacheGetFresh('ttl:fresh', 60_000)).toBe(42);
    expect(await cacheGetFresh('ttl:fresh', -1)).toBeUndefined();
  });

  it('treats a legacy unwrapped entry as stale', async () => {
    await cacheSet('ttl:legacy', 42);
    expect(await cacheGetFresh('ttl:legacy', 60_000)).toBeUndefined();
  });

  it('misses cleanly', async () => {
    expect(await cacheGetFresh('ttl:missing', 60_000)).toBeUndefined();
  });

  it('round-trips a stamped null (cached negative answer)', async () => {
    await cacheSetStamped('ttl:null', null);
    expect(await cacheGetFresh<null>('ttl:null', 60_000)).toBeNull();
  });
});
