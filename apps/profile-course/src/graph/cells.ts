/**
 * The corridor grid both the repeat detector and the GPS-trace grid are packed
 * into: ~14 m cells, fine enough to keep opposite sidewalks apart. Longitude
 * metres are hardcoded for ~58° N, which is where the app is used; a cell is
 * only ever compared with another cell, so the exact scale does not matter as
 * long as every producer uses the same one — hence this single function.
 */
export const CELL_SIZE_M = 14;

const ROW_STRIDE = 1_000_003;

/**
 * `| 0` because the ids live in an Int32Array on the edges: the product
 * overflows 32 bits and wraps there, so every other producer has to wrap the
 * same way or its cells would never match an edge's. The wrap only collides
 * cells 60 km apart in latitude *and* 600 km apart in longitude, which no
 * single graph spans.
 */
export function cellIdAt(lat: number, lon: number): number {
  return (
    (Math.round((lat * 111320) / CELL_SIZE_M) * ROW_STRIDE +
      Math.round((lon * 58000) / CELL_SIZE_M)) |
    0
  );
}

/** The cell itself and its 8 neighbours, for dilating a grid by one cell. */
export function cellAndNeighbours(id: number, out: number[]): void {
  out.length = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) out.push((id + dy * ROW_STRIDE + dx) | 0);
  }
}
