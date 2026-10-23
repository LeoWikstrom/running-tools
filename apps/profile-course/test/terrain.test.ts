import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TILE_SIZE,
  TerrainSampler,
  bilinearSample,
  decodeTerrarium,
  latToTileY,
  lonToTileX,
} from '../src/net/terrain';

describe('tile maths', () => {
  it('maps Gothenburg to the expected z13 tile', () => {
    expect(Math.floor(lonToTileX(12.0381, 13))).toBe(4369);
    expect(Math.floor(latToTileY(57.7046, 13))).toBe(2479);
  });
});

describe('decodeTerrarium', () => {
  it('decodes the documented formula', () => {
    // elevation = R*256 + G + B/256 - 32768; sea level (0 m) is R=128, G=0, B=0
    const rgba = new Uint8ClampedArray([128, 0, 0, 255, 128, 100, 128, 255]);
    const out = decodeTerrarium(rgba);
    expect(out[0]).toBe(0);
    expect(out[1]).toBeCloseTo(100.5);
  });
});

describe('bilinearSample', () => {
  const grid = new Float32Array([0, 10, 20, 30]); // 2x2
  it('returns corners exactly', () => {
    expect(bilinearSample(grid, 2, 2, 0, 0)).toBe(0);
    expect(bilinearSample(grid, 2, 2, 1, 1)).toBe(30);
  });
  it('interpolates the centre', () => {
    expect(bilinearSample(grid, 2, 2, 0.5, 0.5)).toBe(15);
  });
  it('clamps outside the grid', () => {
    expect(bilinearSample(grid, 2, 2, -5, -5)).toBe(0);
    expect(bilinearSample(grid, 2, 2, 5, 5)).toBe(30);
  });
});

describe('TerrainSampler retry on fetch failure', () => {
  // Stub browser APIs unavailable in Node so decodePng can run.
  beforeEach(() => {
    // Sea-level tile: every pixel R=128, G=0, B=0 → elevation 0 m.
    const seaLevelRgba = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4);
    for (let i = 0; i < TILE_SIZE * TILE_SIZE; i++) seaLevelRgba[i * 4] = 128;

    vi.stubGlobal('createImageBitmap', async (_blob: Blob) => ({
      width: TILE_SIZE,
      height: TILE_SIZE,
      close: () => undefined,
    }));
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        constructor(
          public width: number,
          public height: number,
        ) {}
        getContext(_type: string) {
          return {
            drawImage: () => undefined,
            getImageData: () => ({ data: seaLevelRgba }),
          };
        }
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('retries after a fetch failure and succeeds on the second call', async () => {
    let calls = 0;
    const mockFetch = vi.fn(async () => {
      calls++;
      if (calls <= 2) throw new Error('network error');
      return {
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(8),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const sampler = new TerrainSampler(13, mockFetch);

    // First elevationAt: fetchTile tries twice internally (calls 1 and 2), both fail → rejects.
    await expect(sampler.elevationAt(57.7046, 12.0381)).rejects.toThrow();

    // The rejected promise must have been removed from pending, so a second call retries.
    // This call uses attempt 3 → succeeds.
    const elev = await sampler.elevationAt(57.7046, 12.0381);
    expect(typeof elev).toBe('number');
    expect(Number.isFinite(elev)).toBe(true);
    expect(calls).toBe(3);
  });

  it('evicts LRU tile when the cache exceeds 64 entries', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
    })) as unknown as typeof fetch;

    const sampler = new TerrainSampler(7, mockFetch);
    // At zoom=7, tile width ≈ 2.8 deg. Load 65 distinct tiles via elevationAt.
    for (let i = 0; i < 65; i++) {
      await sampler.elevationAt(0, -180 + i * 2.9);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tilesMap = (sampler as any).tiles as Map<string, Float32Array>;
    expect(tilesMap.size).toBeLessThanOrEqual(64);
  });

  it('samples a batch spanning more tiles than the LRU cap', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
    })) as unknown as typeof fetch;

    const sampler = new TerrainSampler(7, mockFetch);
    // 70 points in 70 distinct tiles — a big offline-area graph does this.
    // The batch's own later prefetches must not evict the tiles it is about
    // to sample (that read a `.get(key)!` of undefined before).
    const n = 70;
    const lats = new Float64Array(n);
    const lons = new Float64Array(n);
    for (let i = 0; i < n; i++) lons[i] = -100 + i * 2.9;
    const out = await sampler.elevations(lats, lons);
    expect(out.length).toBe(n);
    for (const v of out) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('real Skatås terrain tile', () => {
  const png = PNG.sync.read(readFileSync('test/fixtures/terrarium_13_4369_2479.png'));
  const grid = decodeTerrarium(new Uint8ClampedArray(png.data));

  it('decodes to a 256x256 grid of plausible Swedish elevations', () => {
    expect(png.width).toBe(TILE_SIZE);
    expect(png.height).toBe(TILE_SIZE);
    let min = Infinity;
    let max = -Infinity;
    for (const v of grid) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    expect(min).toBeGreaterThan(-50);
    expect(max).toBeLessThan(300);
    expect(max - min).toBeGreaterThan(20); // Skatås is hilly
  });

  it('Skatås hill area is well above sea level', () => {
    const xf = lonToTileX(12.0381, 13);
    const yf = latToTileY(57.7046, 13);
    const px = (xf - Math.floor(xf)) * TILE_SIZE - 0.5;
    const py = (yf - Math.floor(yf)) * TILE_SIZE - 0.5;
    const elev = bilinearSample(grid, TILE_SIZE, TILE_SIZE, px, py);
    expect(elev).toBeGreaterThan(30);
    expect(elev).toBeLessThan(150);
  });
});
