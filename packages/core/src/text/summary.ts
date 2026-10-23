import { cacheGet, cacheSet } from '../net/cache';
import { countWords } from './trim';

export interface PlaceExtract {
  extract: string;
  lang: string;
  title: string;
  url: string;
}

export interface TextFetchOptions {
  fetchFn?: typeof fetch;
}

/** Below this many words the lead is too thin and the full page is consulted. */
const LEAD_TOO_SHORT_WORDS = 40;

const SECTION_HEADINGS = /^(history|architecture|background|description|historia|arkitektur|beskrivning)$/i;

async function restSummary(
  lang: string,
  title: string,
  options: TextFetchOptions,
): Promise<PlaceExtract | null> {
  const fetchFn = options.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const key = `wikisummary:v1:${lang}:${title}`;
  const cached = await cacheGet<PlaceExtract | null>(key);
  if (cached !== undefined) return cached;
  const res = await fetchFn(
    `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replaceAll(' ', '_'))}`,
  );
  if (res.status === 404) {
    await cacheSet(key, null);
    return null;
  }
  if (!res.ok) throw new Error(`Wikipedia summary (${lang}) returned ${res.status}`);
  const json = (await res.json()) as {
    extract?: string;
    content_urls?: { desktop?: { page?: string } };
  };
  const out: PlaceExtract | null = json.extract
    ? {
        extract: json.extract,
        lang,
        title,
        url:
          json.content_urls?.desktop?.page ??
          `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replaceAll(' ', '_'))}`,
      }
    : null;
  await cacheSet(key, out);
  return out;
}

/** Plain-text page sections via TextExtracts, split on == Heading == markers. */
export function splitExtractSections(plain: string): { heading: string; body: string }[] {
  const out: { heading: string; body: string }[] = [];
  const re = /^==+\s*(.*?)\s*==+\s*$/gm;
  let last: { heading: string; start: number } | null = { heading: '', start: 0 };
  for (const m of plain.matchAll(re)) {
    if (last) out.push({ heading: last.heading, body: plain.slice(last.start, m.index).trim() });
    last = { heading: m[1]!, start: m.index! + m[0].length };
  }
  if (last) out.push({ heading: last.heading, body: plain.slice(last.start).trim() });
  return out.filter((s) => s.body.length > 0);
}

async function fullPageSection(
  lang: string,
  title: string,
  options: TextFetchOptions,
): Promise<string | null> {
  const fetchFn = options.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const key = `wikiextract:v1:${lang}:${title}`;
  let plain = await cacheGet<string>(key);
  if (plain === undefined) {
    const params = new URLSearchParams({
      action: 'query',
      format: 'json',
      origin: '*',
      prop: 'extracts',
      explaintext: '1',
      exsectionformat: 'wiki',
      titles: title,
    });
    const res = await fetchFn(`https://${lang}.wikipedia.org/w/api.php?${params.toString()}`);
    if (!res.ok) throw new Error(`Wikipedia extracts (${lang}) returned ${res.status}`);
    const json = (await res.json()) as {
      query?: { pages?: Record<string, { extract?: string }> };
    };
    plain = Object.values(json.query?.pages ?? {})[0]?.extract ?? '';
    await cacheSet(key, plain);
  }
  if (!plain) return null;
  const sections = splitExtractSections(plain);
  const preferred = sections.find((s) => SECTION_HEADINGS.test(s.heading));
  return preferred?.body ?? null;
}

/**
 * The text material for a place: the REST summary lead, topped up with the
 * History/Architecture section when the lead is under 40 words. Tries the
 * given pages in order (English first by convention).
 */
export async function fetchExtract(
  pages: { lang: string; title: string }[],
  options: TextFetchOptions = {},
): Promise<PlaceExtract | null> {
  for (const page of pages) {
    const lead = await restSummary(page.lang, page.title, options);
    if (!lead) continue;
    if (countWords(lead.extract) >= LEAD_TOO_SHORT_WORDS) return lead;
    const section = await fullPageSection(page.lang, page.title, options).catch(() => null);
    if (section) return { ...lead, extract: `${lead.extract} ${section}` };
    return lead;
  }
  return null;
}
