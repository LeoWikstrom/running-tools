import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import {
  TILE_SIZE,
  TerrainSampler,
  bilinearSample,
  decodeTerrarium,
  latToTileY,
  lonToTileX,
} from '../src/net/terrain';

const DIR = 'bench/cache/tiles';

/**
 * Real DEM tiles in Node: the app decodes PNGs with createImageBitmap and
 * OffscreenCanvas, neither of which exists here, so tiles are fetched once to
 * disk and decoded with pngjs. Benchmarks need the real terrain — the saved
 * test tile covers 2 km of Skatås and nothing else.
 */
export class NodeSampler extends TerrainSampler {
  private grids = new Map<string, Float32Array>();

  constructor(private zoomLevel = 13) {
    super(zoomLevel);
    mkdirSync(DIR, { recursive: true });
  }

  private async grid(tx: number, ty: number): Promise<Float32Array> {
    const key = `${this.zoomLevel}_${tx}_${ty}`;
    const have = this.grids.get(key);
    if (have) return have;
    const file = `${DIR}/${key}.png`;
    if (!existsSync(file)) {
      const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${this.zoomLevel}/${tx}/${ty}.png`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`tile ${key}: ${res.status}`);
      writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    }
    const png = PNG.sync.read(readFileSync(file));
    const grid = decodeTerrarium(new Uint8ClampedArray(png.data));
    this.grids.set(key, grid);
    return grid;
  }

  override async elevationAt(lat: number, lon: number): Promise<number> {
    const xf = lonToTileX(lon, this.zoomLevel);
    const yf = latToTileY(lat, this.zoomLevel);
    const tx = Math.floor(xf);
    const ty = Math.floor(yf);
    return bilinearSample(
      await this.grid(tx, ty),
      TILE_SIZE,
      TILE_SIZE,
      (xf - tx) * TILE_SIZE - 0.5,
      (yf - ty) * TILE_SIZE - 0.5,
    );
  }

  override async elevations(
    lats: ArrayLike<number>,
    lons: ArrayLike<number>,
  ): Promise<Float32Array> {
    const out = new Float32Array(lats.length);
    for (let i = 0; i < lats.length; i++) out[i] = await this.elevationAt(lats[i]!, lons[i]!);
    return out;
  }
}
