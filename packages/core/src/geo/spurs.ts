import { angleDiffDeg, bearingDeg, haversineMeters } from '../geo';

/**
 * Out-and-back spurs in a course's point sequence: the path leaves a spot,
 * comes back to (nearly) the same spot, and arrives heading the opposite
 * way it left. The heading test is what separates a spur from a legitimate
 * little loop — a loop closes travelling roughly the way it departed, an
 * out-and-back arrives reversed. Matching on the near-return rather than
 * point-mirroring also catches spurs whose legs run on parallel paths a few
 * metres apart, which an exact-palindrome test is blind to. Used by the
 * manual pruning mode.
 */
export interface PointSpur {
  /** Junction point: the course is back within tolerance of it at to + 1.
      Removing points (from + 1 .. to) keeps the junction and the return. */
  from: number;
  /** The farthest point of the spur from the junction. */
  tip: number;
  to: number;
  /** One-way length, junction to tip, metres. */
  lengthM: number;
}

export function findPointSpurs(
  lats: ArrayLike<number>,
  lons: ArrayLike<number>,
  tolM = 15,
  minLengthM = 20,
  maxPathM = 1200,
): PointSpur[] {
  const n = lats.length;
  const d = (a: number, b: number): number =>
    haversineMeters(lats[a]!, lons[a]!, lats[b]!, lons[b]!);
  const heading = (a: number, b: number): number =>
    bearingDeg(lats[a]!, lons[a]!, lats[b]!, lons[b]!);
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1]! + d(i - 1, i);

  // A clickable spur must be pure retrace END TO END: walking two pointers
  // from the span's ends toward the tip, the legs must stay within
  // tolerance of each other the whole way. A lobe whose interior is
  // genuinely different ground — a street leading to a square, say — never
  // qualifies as one unit, however neatly it returns to its mouth; only
  // the true out-and-backs inside it get dots, and peeling stops where the
  // retrace stops.
  const pureRetrace = (i: number, m: number): boolean => {
    let a = i;
    let b = m;
    while (b - a > 2) {
      const fwd = d(a + 1, b);
      const back = d(a, b - 1);
      const both = d(a + 1, b - 1);
      const best = Math.min(fwd, back, both);
      if (best > tolM) return false;
      if (best === both) {
        a++;
        b--;
      } else if (best === fwd) {
        a++;
      } else {
        b--;
      }
    }
    return true;
  };

  const candidates: PointSpur[] = [];
  for (let i = 0; i + 3 < n; i++) {
    const hOut = heading(i, i + 1);
    for (let m = i + 2; m + 1 < n && cum[m]! - cum[i]! <= maxPathM; m++) {
      if (d(i, m) > tolM) continue;
      const hBack = heading(m - 1, m);
      if (Math.abs(angleDiffDeg(hOut, hBack)) < 130) continue;
      const lengthM = (cum[m]! - cum[i]!) / 2;
      if (lengthM < minLengthM) break;
      if (!pureRetrace(i, m)) continue;
      let tip = i + 1;
      let best = 0;
      for (let k = i + 1; k <= m; k++) {
        const dk = d(i, k);
        if (dk > best) {
          best = dk;
          tip = k;
        }
      }
      candidates.push({ from: i, tip, to: m - 1, lengthM });
      break;
    }
  }
  candidates.sort((a, b) => a.lengthM - b.lengthM);
  const inner: PointSpur[] = [];
  for (const c of candidates) {
    if (inner.some((o) => c.from <= o.to && o.from <= c.to)) continue;
    inner.push(c);
  }
  // Grow each kept spur outward while the ground is pure retrace (mirrored
  // points), so one dot removes a whole simple spur instead of peeling it
  // ring by ring — but a lobe boundary (a square's two different sides)
  // stops the growth, which is what keeps the inner dot inner.
  const grown = inner.map((c) => {
    let i = c.from;
    let m = c.to + 1;
    while (i > 0 && m + 1 < n && d(i - 1, m + 1) <= tolM) {
      i--;
      m++;
    }
    let tip = i + 1;
    let best = 0;
    for (let k = i + 1; k <= m; k++) {
      const dk = d(i, k);
      if (dk > best) {
        best = dk;
        tip = k;
      }
    }
    return { from: i, tip, to: m - 1, lengthM: (cum[m]! - cum[i]!) / 2 };
  });
  grown.sort((a, b) => a.lengthM - b.lengthM);
  const out: PointSpur[] = [];
  for (const c of grown) {
    if (out.some((o) => c.from <= o.to && o.from <= c.to)) continue;
    out.push(c);
  }
  out.sort((a, b) => a.from - b.from);
  return out;
}
