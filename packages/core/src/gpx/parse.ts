export interface GpxPoint {
  lat: number;
  lon: number;
  ele: number | null;
}

export interface ParsedGpx {
  name: string | null;
  points: GpxPoint[];
  hasElevation: boolean;
}

// Regex-based parser: DOMParser is unavailable in workers, and GPX point
// extraction only needs trkpt/rtept attributes plus an optional child <ele>.
const POINT_RE = /<(trkpt|rtept)\b([^>]*)\/>|<(trkpt|rtept)\b([^>]*)>([\s\S]*?)<\/\3>/g;
const LAT_RE = /\blat\s*=\s*["']([^"']+)["']/;
const LON_RE = /\blon\s*=\s*["']([^"']+)["']/;
const ELE_RE = /<ele>\s*([-\d.eE+]+)\s*<\/ele>/;
const NAME_RE = /<name>([\s\S]*?)<\/name>/;

export function parseGpx(xml: string): ParsedGpx {
  const points: GpxPoint[] = [];
  let sawTrkpt = false;

  for (const m of xml.matchAll(POINT_RE)) {
    const tag = m[1] ?? m[3];
    const attrs = m[2] ?? m[4] ?? '';
    const body = m[5] ?? '';
    if (tag === 'trkpt' && !sawTrkpt) {
      sawTrkpt = true;
      points.length = 0; // trkpt wins over any rtept collected earlier
    }
    if (sawTrkpt && tag !== 'trkpt') continue;

    const latM = LAT_RE.exec(attrs);
    const lonM = LON_RE.exec(attrs);
    if (!latM || !lonM) continue;
    const lat = Number(latM[1]);
    const lon = Number(lonM[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const eleM = ELE_RE.exec(body);
    const ele = eleM ? Number(eleM[1]) : null;
    points.push({ lat, lon, ele: Number.isFinite(ele ?? NaN) ? ele : null });
  }

  if (points.length < 2) {
    throw new Error('GPX contains fewer than 2 track/route points');
  }

  const name = NAME_RE.exec(xml)?.[1]?.trim() ?? null;
  const hasElevation = points.every((p) => p.ele !== null);
  return { name, points, hasElevation };
}
