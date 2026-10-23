const EARTH_RADIUS_M = 6371000;

export interface LatLon {
  lat: number;
  lon: number;
}

export interface PolylineProjection {
  /** Distance along the polyline to the closest point, metres. */
  along: number;
  /** Lateral distance from the query point to the polyline, metres. */
  offset: number;
  /** The closest point on the polyline. */
  lat: number;
  lon: number;
  /** Index of the first vertex of the segment the closest point lies on. */
  segment: number;
}

/**
 * Project a point onto a polyline: closest point, lateral offset and distance
 * along the line. Uses a local equirectangular projection around the query
 * point, accurate to well under a metre at the few-hundred-metre offsets that
 * matter here.
 */
export function projectOnPolyline(
  lats: ArrayLike<number>,
  lons: ArrayLike<number>,
  lat: number,
  lon: number,
): PolylineProjection | null {
  const n = lats.length;
  if (n === 0) return null;
  const toRad = Math.PI / 180;
  const cosLat = Math.cos(lat * toRad);
  const mPerDegLat = (EARTH_RADIUS_M * Math.PI) / 180;
  const mPerDegLon = mPerDegLat * cosLat;
  const px = (v: number) => (v - lon) * mPerDegLon;
  const py = (v: number) => (v - lat) * mPerDegLat;

  if (n === 1) {
    return {
      along: 0,
      offset: haversineMeters(lat, lon, lats[0]!, lons[0]!),
      lat: lats[0]!,
      lon: lons[0]!,
      segment: 0,
    };
  }

  let best: PolylineProjection | null = null;
  let bestDist2 = Infinity;
  let along = 0;
  for (let i = 0; i < n - 1; i++) {
    const ax = px(lons[i]!);
    const ay = py(lats[i]!);
    const bx = px(lons[i + 1]!);
    const by = py(lats[i + 1]!);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : (-(ax * dx + ay * dy)) / len2;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    const d2 = cx * cx + cy * cy;
    const segLen = haversineMeters(lats[i]!, lons[i]!, lats[i + 1]!, lons[i + 1]!);
    if (d2 < bestDist2) {
      bestDist2 = d2;
      best = {
        along: along + t * segLen,
        offset: Math.sqrt(d2),
        lat: lats[i]! + t * (lats[i + 1]! - lats[i]!),
        lon: lons[i]! + t * (lons[i + 1]! - lons[i]!),
        segment: i,
      };
    }
    along += segLen;
  }
  return best;
}

export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180;
  const dLon = (lon2 - lon1) * toRad;
  const y = Math.sin(dLon) * Math.cos(lat2 * toRad);
  const x =
    Math.cos(lat1 * toRad) * Math.sin(lat2 * toRad) -
    Math.sin(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Signed smallest difference between two bearings, in (-180, 180]. */
export function angleDiffDeg(a: number, b: number): number {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

export const TURN_ANGLE_DEG = 35;
const TURN_RESAMPLE_M = 15;

/**
 * Distances along the polyline where the heading changes by more than
 * TURN_ANGLE_DEG between consecutive ~15 m segments.
 */
export function turnPositions(lats: ArrayLike<number>, lons: ArrayLike<number>): number[] {
  const n = lats.length;
  if (n < 3) return [];

  // Resample to even spacing first; raw GPS/OSM point spacing is irregular
  // and makes heading noise look like turns.
  const rLats: number[] = [lats[0]!];
  const rLons: number[] = [lons[0]!];
  const rDist: number[] = [0];
  let carried = 0;
  let total = 0;
  for (let i = 1; i < n; i++) {
    const segLen = haversineMeters(lats[i - 1]!, lons[i - 1]!, lats[i]!, lons[i]!);
    if (segLen <= 0) continue;
    let along = TURN_RESAMPLE_M - carried;
    while (along <= segLen) {
      const t = along / segLen;
      rLats.push(lats[i - 1]! + t * (lats[i]! - lats[i - 1]!));
      rLons.push(lons[i - 1]! + t * (lons[i]! - lons[i - 1]!));
      rDist.push(total + along);
      along += TURN_RESAMPLE_M;
    }
    carried = segLen - (along - TURN_RESAMPLE_M);
    total += segLen;
  }
  if (rLats.length < 3) return [];

  const turns: number[] = [];
  let prevHeading = bearingDeg(rLats[0]!, rLons[0]!, rLats[1]!, rLons[1]!);
  for (let i = 2; i < rLats.length; i++) {
    const heading = bearingDeg(rLats[i - 1]!, rLons[i - 1]!, rLats[i]!, rLons[i]!);
    if (Math.abs(angleDiffDeg(prevHeading, heading)) > TURN_ANGLE_DEG) {
      const d = rDist[i - 1]!;
      // Merge successive heading changes of one physical corner.
      if (turns.length === 0 || d - turns[turns.length - 1]! > 2 * TURN_RESAMPLE_M) {
        turns.push(d);
      }
    }
    prevHeading = heading;
  }
  return turns;
}

export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}
