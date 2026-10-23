import { cacheGet, cacheSet } from './cache';

export const TERRAIN_ZOOM = 13;
export const TILE_SIZE = 256;
const TILE_URL = (z: number, x: number, y: number) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

export function lonToTileX(lon: number, z: number): number {
  return ((lon + 180) / 360) * 2 ** z;
}

export function latToTileY(lat: number, z: number): number {
  const rad = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z;
}

/** Terrarium encoding: elevation = (R*256 + G + B/256) - 32768. */
export function decodeTerrarium(rgba: Uint8ClampedArray): Float32Array {
  const out = new Float32Array(rgba.length / 4);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = rgba[p]! * 256 + rgba[p + 1]! + rgba[p + 2]! / 256 - 32768;
  }
  return out;
}

export function bilinearSample(
  grid: Float32Array,
  width: number,
  height: number,
  px: number,
  py: number,
): number {
  const x = Math.min(Math.max(px, 0), width - 1);
  const y = Math.min(Math.max(py, 0), height - 1);
  const x0 = Math.min(Math.floor(x), width - 2);
  const y0 = Math.min(Math.floor(y), height - 2);
  const fx = x - x0;
  const fy = y - y0;
  const a = grid[y0 * width + x0]!;
  const b = grid[y0 * width + x0 + 1]!;
  const c = grid[(y0 + 1) * width + x0]!;
  const d = grid[(y0 + 1) * width + x0 + 1]!;
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}

async function decodePng(bytes: ArrayBuffer): Promise<Float32Array> {
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2d context unavailable');
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
  bitmap.close();
  return decodeTerrarium(data);
}

// Phone worker lives indefinitely; cap decoded tiles (~256 KB each) to limit memory.
const LRU_CAP = 64;

export class TerrainSampler {
  private tiles = new Map<string, Float32Array>();
  private pending = new Map<string, Promise<Float32Array>>();

  constructor(
    private zoom: number = TERRAIN_ZOOM,
    // Wrapped: calling a stored bare `fetch` with `this` set to the sampler
    // throws "Illegal invocation".
    private fetchFn: typeof fetch = (...args) => fetch(...args),
  ) {}

  private async loadTile(tx: number, ty: number): Promise<Float32Array> {
    const key = `${this.zoom}/${tx}/${ty}`;
    const loaded = this.tiles.get(key);
    if (loaded) {
      // Re-insert to mark as most-recently used.
      this.tiles.delete(key);
      this.tiles.set(key, loaded);
      return loaded;
    }
    let promise = this.pending.get(key);
    if (!promise) {
      promise = this.fetchTile(tx, ty, key).finally(() => {
        this.pending.delete(key);
      });
      this.pending.set(key, promise);
    }
    const grid = await promise;
    this.tiles.set(key, grid);
    if (this.tiles.size > LRU_CAP) {
      this.tiles.delete(this.tiles.keys().next().value!);
    }
    return grid;
  }

  private async fetchTile(tx: number, ty: number, key: string): Promise<Float32Array> {
    const cacheId = `terrain:${key}`;
    let bytes = await cacheGet<ArrayBuffer>(cacheId);
    if (!bytes) {
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 20_000);
          const res = await this.fetchFn(TILE_URL(this.zoom, tx, ty), {
            signal: controller.signal,
          });
          clearTimeout(timer);
          if (!res.ok) throw new Error(`Terrain tile ${key} returned ${res.status}`);
          bytes = await res.arrayBuffer();
          break;
        } catch (err) {
          lastError = err;
        }
      }
      if (!bytes) throw new Error(`Terrain tile ${key} failed: ${String(lastError)}`);
      await cacheSet(cacheId, bytes);
    }
    return decodePng(bytes);
  }

  async elevationAt(lat: number, lon: number): Promise<number> {
    const xf = lonToTileX(lon, this.zoom);
    const yf = latToTileY(lat, this.zoom);
    const tx = Math.floor(xf);
    const ty = Math.floor(yf);
    const grid = await this.loadTile(tx, ty);
    // -0.5: pixel centres sit half a pixel in from the tile edge.
    return bilinearSample(
      grid,
      TILE_SIZE,
      TILE_SIZE,
      (xf - tx) * TILE_SIZE - 0.5,
      (yf - ty) * TILE_SIZE - 0.5,
    );
  }

  /** Prefetches all needed tiles in parallel, then samples synchronously. */
  async elevations(lats: ArrayLike<number>, lons: ArrayLike<number>): Promise<Float32Array> {
    const needed = new Map<string, [number, number]>();
    for (let i = 0; i < lats.length; i++) {
      const tx = Math.floor(lonToTileX(lons[i]!, this.zoom));
      const ty = Math.floor(latToTileY(lats[i]!, this.zoom));
      needed.set(`${this.zoom}/${tx}/${ty}`, [tx, ty]);
    }
    // The batch holds its own references: a big graph needs more tiles than
    // LRU_CAP, so sampling from `this.tiles` would read tiles the batch's own
    // later prefetches already evicted.
    const grids = new Map<string, Float32Array>();
    await Promise.all(
      [...needed].map(async ([key, [tx, ty]]) => {
        grids.set(key, await this.loadTile(tx, ty));
      }),
    );

    const out = new Float32Array(lats.length);
    for (let i = 0; i < lats.length; i++) {
      const xf = lonToTileX(lons[i]!, this.zoom);
      const yf = latToTileY(lats[i]!, this.zoom);
      const tx = Math.floor(xf);
      const ty = Math.floor(yf);
      const grid = grids.get(`${this.zoom}/${tx}/${ty}`)!;
      out[i] = bilinearSample(
        grid,
        TILE_SIZE,
        TILE_SIZE,
        (xf - tx) * TILE_SIZE - 0.5,
        (yf - ty) * TILE_SIZE - 0.5,
      );
    }
    return out;
  }
}
