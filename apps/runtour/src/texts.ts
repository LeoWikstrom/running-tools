import { fetchExtract } from '@running/core/text/summary';
import { composeText } from '@running/core/text/trim';
import type { Place } from '@running/core/poi/types';

export interface PlaceText {
  text: string;
  sourceUrl?: string;
  sourceLang?: string;
  /** Wrong-language source or hand-written: wants a human eye. */
  needsReview: boolean;
  reviewed: boolean;
}

/** Candidate Wikipedia pages for a place, English first. */
function pagesFor(place: Place): { lang: string; title: string }[] {
  const pages: { lang: string; title: string }[] = [];
  if (place.wikipedia?.lang === 'en') pages.push(place.wikipedia);
  else {
    pages.push({ lang: 'en', title: place.name });
    if (place.wikipedia) pages.push(place.wikipedia);
  }
  return pages;
}

export async function fetchPlaceText(
  place: Place,
  narrationLang: string,
  targetSeconds: number,
): Promise<PlaceText | null> {
  const extract = await fetchExtract(pagesFor(place));
  if (!extract) return null;
  const composed = composeText(place.name, extract.extract, targetSeconds);
  return {
    text: composed.text,
    sourceUrl: extract.url,
    sourceLang: extract.lang,
    needsReview: extract.lang !== narrationLang,
    reviewed: false,
  };
}
