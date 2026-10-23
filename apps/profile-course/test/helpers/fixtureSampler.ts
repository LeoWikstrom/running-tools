import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import {
  TILE_SIZE,
  TerrainSampler,
  bilinearSample,
  decodeTerrarium,
  latToTileY,
  lonToTileX,
} from '../../src/net/terrain';

/**
 * Node has no createImageBitmap/OffscreenCanvas, so tests sample the saved
 * Skatås tile directly instead of fetching and decoding PNGs.
 */
export class FixtureSampler extends TerrainSampler {
  private grid: Float32Array;

  constructor() {
    super(13, () => {
      throw new Error('no network in tests');
    });
    const png = PNG.sync.read(readFileSync('test/fixtures/terrarium_13_4369_2479.png'));
    this.grid = decodeTerrarium(new Uint8ClampedArray(png.data));
  }

  override async elevationAt(lat: number, lon: number): Promise<number> {
    const xf = lonToTileX(lon, 13);
    const yf = latToTileY(lat, 13);
    return bilinearSample(
      this.grid,
      TILE_SIZE,
      TILE_SIZE,
      (xf - Math.floor(xf)) * TILE_SIZE - 0.5,
      (yf - Math.floor(yf)) * TILE_SIZE - 0.5,
    );
  }

  override async elevations(
    lats: ArrayLike<number>,
    lons: ArrayLike<number>,
  ): Promise<Float32Array> {
    const out = new Float32Array(lats.length);
    for (let i = 0; i < lats.length; i++) {
      out[i] = await this.elevationAt(lats[i]!, lons[i]!);
    }
    return out;
  }
}
