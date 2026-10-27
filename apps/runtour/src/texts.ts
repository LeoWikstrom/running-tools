import { fetchExtract } from '@running/core/text/summary';
import { composeText, WORDS_PER_SECOND } from '@running/core/text/trim';
import type { Place } from '@running/core/poi/types';
import { translateBestEffort } from './translate';

export interface PlaceText {
  text: string;
  sourceUrl?: string;
  sourceLang?: string;
  /** Wrong-language source or hand-written: wants a human eye. */
  needsReview: boolean;
  reviewed: boolean;
}

/**
 * The place's name in the narration language — its Wikipedia title there,
 * stripped of disambiguators ("Tyska kyrkan, Göteborg" → "Tyska kyrkan") —
 * falling back to the merged candidate name.
 */
export function placeDisplayName(place: Place, narrationLang: string): string {
  const inLang = [place.wikipedia, ...(place.wikipedias ?? [])].find(
    (w) => w?.lang === narrationLang,
  );
  const raw = inLang?.title ?? place.name;
  const stripped = raw
    .replace(/\s*\(.*\)\s*$/, '')
    .replace(/,[^,]*$/, '')
    .trim();
  return stripped.length > 0 ? stripped : place.name;
}

/** Candidate Wikipedia pages for a place, the narration language first. */
function pagesFor(place: Place, narrationLang: string): { lang: string; title: string }[] {
  const known = [place.wikipedia, ...(place.wikipedias ?? [])].filter(
    (w): w is { lang: string; title: string } => w !== undefined,
  );
  const pages: { lang: string; title: string }[] = [];
  const push = (page: { lang: string; title: string }): void => {
    if (!pages.some((p) => p.lang === page.lang && p.title === page.title)) pages.push(page);
  };
  // The narration language's own page, by its real title when we know it.
  const inLang = known.find((w) => w.lang === narrationLang);
  push(inLang ?? { lang: narrationLang, title: place.name });
  for (const w of known) push(w);
  // English is the biggest net; worth a try before giving up.
  if (narrationLang !== 'en' && !known.some((w) => w.lang === 'en')) {
    push({ lang: 'en', title: place.name });
  }
  return pages;
}

export async function fetchPlaceText(
  place: Place,
  narrationLang: string,
  targetSeconds: number,
): Promise<PlaceText | null> {
  const extract = await fetchExtract(pagesFor(place, narrationLang), {
    // Enough material for the clip plus headroom for the sentence-boundary cut.
    targetWords: Math.ceil(targetSeconds * WORDS_PER_SECOND * 1.3),
  });
  if (!extract) return null;
  let body = extract.extract;
  if (extract.lang !== narrationLang) {
    // On-device translation where the browser offers it; machine output still
    // gets the review flag. The reliable path is the phase 7 LLM rewrite.
    body = (await translateBestEffort(body, extract.lang, narrationLang)) ?? body;
  }
  const composed = composeText(
    placeDisplayName(place, narrationLang),
    body,
    targetSeconds,
    place.side,
    narrationLang,
  );
  return {
    text: composed.text,
    sourceUrl: extract.url,
    sourceLang: extract.lang,
    needsReview: extract.lang !== narrationLang,
    reviewed: false,
  };
}
