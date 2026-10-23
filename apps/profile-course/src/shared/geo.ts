const EARTH_RADIUS_M = 6371000;

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
