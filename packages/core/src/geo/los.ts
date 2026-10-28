/**
 * Line-of-sight tests against building footprints, on the same local
 * equirectangular flat earth as projectOnPolyline — fine at corridor scale.
 */

const M_PER_DEG_LAT = 111_195;
/** Spatial-grid cell size; ~a building, so a sightline tests few polygons. */
const CELL_M = 50;

export interface BuildingPoly {
  /** OSM way id, used to keep a place from occluding itself. */
  id: number;
  lats: number[];
  lons: number[];
}

const orient = (
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): number => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);

const onSegment = (
  ax: number,
  ay: number,
  bx: number,
  by: number,
  px: number,
  py: number,
): boolean =>
  Math.min(ax, bx) <= px && px <= Math.max(ax, bx) && Math.min(ay, by) <= py && py <= Math.max(ay, by);

/** Whether segments AB and CD intersect; touching counts as intersecting. */
export function segmentsIntersect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): boolean {
  const o1 = orient(ax, ay, bx, by, cx, cy);
  const o2 = orient(ax, ay, bx, by, dx, dy);
  const o3 = orient(cx, cy, dx, dy, ax, ay);
  const o4 = orient(cx, cy, dx, dy, bx, by);
  if (o1 * o2 < 0 && o3 * o4 < 0) return true;
  if (o1 === 0 && onSegment(ax, ay, bx, by, cx, cy)) return true;
  if (o2 === 0 && onSegment(ax, ay, bx, by, dx, dy)) return true;
  if (o3 === 0 && onSegment(cx, cy, dx, dy, ax, ay)) return true;
  if (o4 === 0 && onSegment(cx, cy, dx, dy, bx, by)) return true;
  return false;
}

/** Even-odd ray cast; boundary points are not guaranteed either way. */
export function pointInPolygon(
  x: number,
  y: number,
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
): boolean {
  let inside = false;
  const n = xs.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = xs[i]!;
    const yi = ys[i]!;
    const xj = xs[j]!;
    const yj = ys[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

interface IndexedPoly {
  id: number;
  xs: Float64Array;
  ys: Float64Array;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export class BuildingIndex {
  private readonly polys: IndexedPoly[] = [];
  private readonly grid = new Map<string, number[]>();
  private readonly mPerDegLon: number;

  constructor(buildings: BuildingPoly[]) {
    const lat0 = buildings[0]?.lats[0] ?? 0;
    this.mPerDegLon = M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
    for (const b of buildings) {
      if (b.lats.length < 3) continue;
      const xs = new Float64Array(b.lats.length);
      const ys = new Float64Array(b.lats.length);
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < b.lats.length; i++) {
        xs[i] = b.lons[i]! * this.mPerDegLon;
        ys[i] = b.lats[i]! * M_PER_DEG_LAT;
        if (xs[i]! < minX) minX = xs[i]!;
        if (xs[i]! > maxX) maxX = xs[i]!;
        if (ys[i]! < minY) minY = ys[i]!;
        if (ys[i]! > maxY) maxY = ys[i]!;
      }
      const index = this.polys.length;
      this.polys.push({ id: b.id, xs, ys, minX, minY, maxX, maxY });
      for (let cx = Math.floor(minX / CELL_M); cx <= Math.floor(maxX / CELL_M); cx++) {
        for (let cy = Math.floor(minY / CELL_M); cy <= Math.floor(maxY / CELL_M); cy++) {
          const key = `${cx},${cy}`;
          const cell = this.grid.get(key);
          if (cell) cell.push(index);
          else this.grid.set(key, [index]);
        }
      }
    }
  }

  get size(): number {
    return this.polys.length;
  }

  /**
   * Whether any footprint blocks the sightline. The polygon with `excludeId`
   * and any polygon containing the target never block — a church must not
   * occlude itself, nor may the building a place sits in.
   */
  blocked(
    fromLat: number,
    fromLon: number,
    toLat: number,
    toLon: number,
    excludeId?: number,
  ): boolean {
    const ax = fromLon * this.mPerDegLon;
    const ay = fromLat * M_PER_DEG_LAT;
    const bx = toLon * this.mPerDegLon;
    const by = toLat * M_PER_DEG_LAT;
    const minX = Math.min(ax, bx);
    const maxX = Math.max(ax, bx);
    const minY = Math.min(ay, by);
    const maxY = Math.max(ay, by);

    const seen = new Set<number>();
    for (let cx = Math.floor(minX / CELL_M); cx <= Math.floor(maxX / CELL_M); cx++) {
      for (let cy = Math.floor(minY / CELL_M); cy <= Math.floor(maxY / CELL_M); cy++) {
        const cell = this.grid.get(`${cx},${cy}`);
        if (!cell) continue;
        for (const index of cell) {
          if (seen.has(index)) continue;
          seen.add(index);
          const poly = this.polys[index]!;
          if (poly.id === excludeId) continue;
          if (poly.maxX < minX || poly.minX > maxX || poly.maxY < minY || poly.minY > maxY) {
            continue;
          }
          if (pointInPolygon(bx, by, poly.xs, poly.ys)) continue;
          const n = poly.xs.length;
          for (let i = 0, j = n - 1; i < n; j = i++) {
            if (
              segmentsIntersect(ax, ay, bx, by, poly.xs[j]!, poly.ys[j]!, poly.xs[i]!, poly.ys[i]!)
            ) {
              return true;
            }
          }
        }
      }
    }
    return false;
  }
}

export const buildBuildingIndex = (buildings: BuildingPoly[]): BuildingIndex =>
  new BuildingIndex(buildings);
