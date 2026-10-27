import { haversineMeters } from '../geo';
import { hasSignal, interestScore, isExcludedType } from './score';
import { DEFAULT_POI_SETTINGS, type Place, type PlaceCandidate, type PoiSettings } from './types';

/** Along-course gap that separates two passes of the same spot. */
const PASS_GAP_M = 150;
/** Closer than this to the path, "on your left/right" would overclaim. */
const SIDE_MIN_OFFSET_M = 15;

export interface PassProjection {
  along: number;
  offset: number;
  /** Which side of the travel direction the point lies: 1 left, −1 right, 0 on it. */
  side: -1 | 0 | 1;
}

/**
 * Project a point onto the course and return the *first pass*: of all stretches
 * where the course comes within `corridor` of the point, the earliest one (its
 * closest approach). Null when the course never comes that near.
 */
export function firstPassProjection(
  lats: ArrayLike<number>,
  lons: ArrayLike<number>,
  lat: number,
  lon: number,
  corridor: number,
): PassProjection | null {
  const n = lats.length;
  if (n < 2) return null;
  const toRad = Math.PI / 180;
  const mPerDegLat = 111_195;
  const mPerDegLon = mPerDegLat * Math.cos(lat * toRad);
  const px = (v: number) => (v - lon) * mPerDegLon;
  const py = (v: number) => (v - lat) * mPerDegLat;

  let along = 0;
  let inPass = false;
  let passBest: PassProjection | null = null;
  let lastNearAlong = 0;
  let firstPass: PassProjection | null = null;

  for (let i = 0; i < n - 1; i++) {
    const ax = px(lons[i]!);
    const ay = py(lats[i]!);
    const bx = px(lons[i + 1]!);
    const by = py(lats[i + 1]!);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : -(ax * dx + ay * dy) / len2;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    const dist = Math.sqrt(cx * cx + cy * cy);
    const segLen = haversineMeters(lats[i]!, lons[i]!, lats[i + 1]!, lons[i + 1]!);
    const hereAlong = along + t * segLen;

    if (dist <= corridor) {
      // The point sits at this frame's origin; z of travel × (course → point)
      // says which hand it is on.
      const z = dy * cx - dx * cy;
      const side = z > 0 ? 1 : z < 0 ? -1 : 0;
      if (inPass && hereAlong - lastNearAlong > PASS_GAP_M && passBest) {
        // The previous pass ended a while ago; it was the first.
        firstPass = passBest;
        break;
      }
      if (!inPass) {
        inPass = true;
        passBest = { along: hereAlong, offset: dist, side };
      } else if (passBest && dist < passBest.offset) {
        passBest = { along: hereAlong, offset: dist, side };
      }
      lastNearAlong = hereAlong;
    }
    along += segLen;
  }
  return firstPass ?? passBest;
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function addWikipedia(target: PlaceCandidate, page?: { lang: string; title: string }): void {
  if (!page) return;
  target.wikipedias ??= [];
  if (!target.wikipedias.some((w) => w.lang === page.lang)) target.wikipedias.push(page);
}

function mergeInto(target: PlaceCandidate, extra: PlaceCandidate): void {
  target.wikidataId ??= extra.wikidataId;
  addWikipedia(target, target.wikipedia);
  addWikipedia(target, extra.wikipedia);
  for (const w of extra.wikipedias ?? []) addWikipedia(target, w);
  // Prefer an English page for the default narration language.
  if (!target.wikipedia || (target.wikipedia.lang !== 'en' && extra.wikipedia?.lang === 'en')) {
    target.wikipedia = extra.wikipedia ?? target.wikipedia;
  }
  target.pageLength = Math.max(target.pageLength ?? 0, extra.pageLength ?? 0) || undefined;
  target.sitelinks = Math.max(target.sitelinks ?? 0, extra.sitelinks ?? 0) || undefined;
  if (extra.heritage) target.heritage = true;
  for (const t of extra.types) if (!target.types.includes(t)) target.types.push(t);
  target.website ??= extra.website;
  target.image ??= extra.image;
  for (const s of extra.sources) {
    if (!target.sources.some((own) => own.url === s.url)) target.sources.push(s);
  }
}

/** Merge candidates by Wikidata id when present, else by normalised name within 50 m. */
export function dedupeCandidates(candidates: PlaceCandidate[]): PlaceCandidate[] {
  const byWikidata = new Map<string, PlaceCandidate>();
  const byName = new Map<string, PlaceCandidate[]>();
  const out: PlaceCandidate[] = [];

  for (const raw of candidates) {
    const c: PlaceCandidate = {
      ...raw,
      types: [...raw.types],
      sources: [...raw.sources],
      wikipedias: raw.wikipedias ? [...raw.wikipedias] : undefined,
    };
    if (c.wikidataId) {
      const seen = byWikidata.get(c.wikidataId);
      if (seen) {
        mergeInto(seen, c);
        continue;
      }
      byWikidata.set(c.wikidataId, c);
    }
    const norm = normalizeName(c.name);
    const near = byName
      .get(norm)
      ?.find((p) => haversineMeters(p.lat, p.lon, c.lat, c.lon) <= 50 && p !== c);
    if (near) {
      // Two ids for the same named spot within 50 m: trust the earlier one.
      if (c.wikidataId && !near.wikidataId) {
        // The new one is better identified; merge the old into it instead.
        mergeInto(c, near);
        out[out.indexOf(near)] = c;
        byName.get(norm)![byName.get(norm)!.indexOf(near)] = c;
        continue;
      }
      mergeInto(near, c);
      continue;
    }
    const list = byName.get(norm);
    if (list) list.push(c);
    else byName.set(norm, [c]);
    out.push(c);
  }
  return out;
}

/**
 * The full pipeline on already-fetched candidates: dedupe, corridor filter
 * with first-pass projection, score, thin to minSpacing, cap, trigger points.
 * Returns places ordered by distance along the course.
 */
export function buildPlaces(
  lats: ArrayLike<number>,
  lons: ArrayLike<number>,
  candidates: PlaceCandidate[],
  settings: Partial<PoiSettings> = {},
  /** Place ids removed by hand; dropped before thinning so neighbours survive. */
  excludeIds?: ReadonlySet<string>,
): Place[] {
  const s: PoiSettings = { ...DEFAULT_POI_SETTINGS, ...settings };
  const merged = dedupeCandidates(candidates).filter((c) => hasSignal(c) && !isExcludedType(c));

  const placed: Place[] = [];
  for (const c of merged) {
    const pass = firstPassProjection(lats, lons, c.lat, c.lon, s.corridorWidth);
    if (!pass) continue;
    const score = interestScore(c);
    if (score <= 0) continue;
    const id = c.wikidataId ?? `${c.sources[0]?.kind ?? 'place'}:${normalizeName(c.name)}`;
    if (excludeIds?.has(id)) continue;
    placed.push({
      ...c,
      id,
      score,
      d: pass.along,
      triggerD: Math.max(0, pass.along - s.leadDistance),
      offset: pass.offset,
      side:
        pass.offset >= SIDE_MIN_OFFSET_M && pass.side !== 0
          ? pass.side === 1
            ? 'left'
            : 'right'
          : undefined,
    });
  }

  placed.sort((a, b) => a.d - b.d || b.score - a.score);

  // Thin: within minSpacing of the last kept place, the higher score survives.
  const thinned: Place[] = [];
  for (const p of placed) {
    const last = thinned[thinned.length - 1];
    if (last && p.d - last.d < s.minSpacing) {
      if (p.score > last.score) thinned[thinned.length - 1] = p;
      continue;
    }
    thinned.push(p);
  }

  // Cap: drop the lowest scores, keeping course order.
  if (thinned.length > s.maxPlaces) {
    const keep = new Set(
      [...thinned].sort((a, b) => b.score - a.score).slice(0, s.maxPlaces),
    );
    return thinned.filter((p) => keep.has(p));
  }
  return thinned;
}
