import { cacheGet, cacheSet } from '@running/core/net/cache';
import type { TourPlaceImage } from '@running/core/tour/types';

/** Only photos at least this old count as "historical". */
const HISTORIC_MAX_YEAR = 1980;
/** No photograph predates this; earlier "dates" are depicted scenes. */
const HISTORIC_MIN_YEAR = 1826;
const SEARCH_RADIUS_M = 120;
const THUMB_WIDTH = 640;

interface CommonsImageInfo {
  thumburl?: string;
  url?: string;
  descriptionurl?: string;
  extmetadata?: Record<string, { value?: string }>;
}

interface CommonsPage {
  title?: string;
  imageinfo?: CommonsImageInfo[];
}

function yearOf(info: CommonsImageInfo): number | null {
  const raw = info.extmetadata?.DateTimeOriginal?.value ?? '';
  const m = /\b(1[89]\d\d|20\d\d)\b/.exec(raw.replace(/<[^>]*>/g, ' '));
  if (!m) return null;
  const year = Number(m[1]);
  return year >= HISTORIC_MIN_YEAR && year <= HISTORIC_MAX_YEAR ? year : null;
}

const stripHtml = (s: string): string => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

function toImage(info: CommonsImageInfo, year: number): TourPlaceImage | null {
  const url = info.thumburl ?? info.url;
  const pageUrl = info.descriptionurl;
  if (!url || !pageUrl) return null;
  const artist = stripHtml(info.extmetadata?.Artist?.value ?? '');
  const licence = stripHtml(info.extmetadata?.LicenseShortName?.value ?? '');
  const attribution =
    [artist, licence].filter((s) => s.length > 0).join(' · ') + ' · Wikimedia Commons';
  return { url, pageUrl, attribution, year };
}

/**
 * The oldest dated photo on Wikimedia Commons near the place, or null when
 * nothing old enough is filed there. Best effort by design: Commons dates are
 * messy, coverage outside landmarks is thin.
 */
export async function fetchHistoricalImage(
  lat: number,
  lon: number,
): Promise<TourPlaceImage | null> {
  const cacheKey = `histimg:v1:${lat.toFixed(4)},${lon.toFixed(4)}`;
  const cached = await cacheGet<TourPlaceImage | 'none'>(cacheKey);
  if (cached) return cached === 'none' ? null : cached;

  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    origin: '*',
    generator: 'geosearch',
    ggscoord: `${lat}|${lon}`,
    ggsradius: String(SEARCH_RADIUS_M),
    ggsnamespace: '6',
    ggslimit: '40',
    prop: 'imageinfo',
    iiprop: 'url|extmetadata',
    iiurlwidth: String(THUMB_WIDTH),
  });
  const res = await fetch(`https://commons.wikimedia.org/w/api.php?${params}`);
  if (!res.ok) throw new Error(`Commons returned ${res.status}`);
  const json = (await res.json()) as {
    query?: { pages?: Record<string, CommonsPage> };
    error?: { info?: string };
  };
  // Commons answers 200 with an error body when its search is busy; caching
  // that as "no image" would stick forever.
  if (json.error) throw new Error(json.error.info ?? 'Commons error');

  let best: TourPlaceImage | null = null;
  for (const page of Object.values(json.query?.pages ?? {})) {
    const info = page.imageinfo?.[0];
    if (!info) continue;
    const year = yearOf(info);
    if (year === null) continue;
    if (best && (best.year ?? Infinity) <= year) continue;
    best = toImage(info, year) ?? best;
  }
  await cacheSet(cacheKey, best ?? 'none');
  return best;
}
