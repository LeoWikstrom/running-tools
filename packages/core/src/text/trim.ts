/** Spoken pace used to convert a target duration into a word budget. */
export const WORDS_PER_SECOND = 2.4;

/**
 * Drop parentheticals that would read badly aloud: pronunciations, listen
 * links, coordinates, birth–death spans — not ordinary asides.
 */
export function stripNoiseParentheticals(text: string): string {
  const noise =
    /(pronounced|pronunciation|listen|IPA|audio|°|\d{4}\s*[–—-]\s*\d{4}|\/[^)]*\/|\[[^\]]*\])/i;
  let out = text.replace(/\s*\(([^()]*)\)/g, (m, inner: string) => {
    return noise.test(inner) ? '' : m;
  });
  // Reference markers like [1] or [a], and bare citation needed tags.
  out = out.replace(/\s*\[[^\]]{1,20}\]/g, '');
  // Collapse doubled whitespace the removals leave behind.
  return out.replace(/\s{2,}/g, ' ').replace(/\s+([.,;:])/g, '$1').trim();
}

/** Naive sentence split, good enough for encyclopaedia prose. */
export function splitSentences(text: string): string[] {
  const parts = text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-ZÅÄÖÆØÉ0-9"“‘(])/);
  return parts.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * For streets and squares the listener is standing on: drop the sentences
 * that explain where it is and which streets surround it — they can see
 * that themselves. Swedish and English encyclopaedia phrasings; the text is
 * kept whole if the filter would empty it.
 */
export function stripLocationSentences(text: string): string {
  const location =
    /\b(ligger|belägen|belägna|sträcker sig|går (mellan|från)|löper|leder (från|till)|förbinder|gränsar|korsar|korsas|mynnar|utgår från|avgränsas|omges av|kantas av|is located|is situated|lies (in|between|at)|runs (from|between|through)|stretches|extends (from|between)|connects|bounded by|lined (by|with)|intersects?)\b/i;
  const kept = splitSentences(text).filter((s) => !location.test(s));
  return kept.length > 0 ? kept.join(' ') : text;
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

/**
 * Cut at the sentence boundary closest to the word budget: sentences are added
 * while they bring the total nearer the target than stopping would.
 */
export function cutToTarget(text: string, targetWords: number): string {
  const sentences = splitSentences(text);
  const kept: string[] = [];
  let words = 0;
  for (const s of sentences) {
    const w = countWords(s);
    if (kept.length > 0 && Math.abs(words + w - targetWords) >= Math.abs(words - targetWords)) {
      break;
    }
    kept.push(s);
    words += w;
  }
  return kept.join(' ');
}

export interface ComposedText {
  text: string;
  words: number;
  /** Estimated spoken duration, seconds. */
  seconds: number;
}

export type NarrationLang = 'en' | 'sv' | 'it';

export const NARRATION_LANGS: { code: NarrationLang; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'sv', label: 'Svenska' },
  { code: 'it', label: 'Italiano' },
];

/** Opening lines per language; {name} is replaced. Varied to avoid repetition. */
const OPENERS: Record<NarrationLang, { passing: string[]; left: string[]; right: string[] }> = {
  en: {
    passing: ['You are passing {name}.', 'You are coming up on {name}.', 'Just ahead is {name}.'],
    left: [
      'On your left you can see {name}.',
      'To your left is {name}.',
      'Coming up on your left: {name}.',
    ],
    right: [
      'On your right you can see {name}.',
      'To your right is {name}.',
      'Coming up on your right: {name}.',
    ],
  },
  sv: {
    passing: [
      'Du passerar {name}.',
      'Snart kommer du till {name}.',
      'Strax framför dig ligger {name}.',
    ],
    left: [
      'Till vänster ser du {name}.',
      'På din vänstra sida ligger {name}.',
      'Snart dyker {name} upp till vänster.',
    ],
    right: [
      'Till höger ser du {name}.',
      'På din högra sida ligger {name}.',
      'Snart dyker {name} upp till höger.',
    ],
  },
  it: {
    passing: [
      'Stai passando {name}.',
      'Stai per arrivare a {name}.',
      'Poco più avanti trovi {name}.',
    ],
    left: [
      'Alla tua sinistra puoi vedere {name}.',
      'Sulla tua sinistra si trova {name}.',
      'Tra poco, alla tua sinistra: {name}.',
    ],
    right: [
      'Alla tua destra puoi vedere {name}.',
      'Sulla tua destra si trova {name}.',
      'Tra poco, alla tua destra: {name}.',
    ],
  },
};

/** Deterministic per name, so a refetch keeps the same opener. */
export function pickOpener(
  name: string,
  side: 'left' | 'right' | undefined,
  lang: string,
): string {
  const set = OPENERS[lang as NarrationLang] ?? OPENERS.en;
  const list = side ? set[side] : set.passing;
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return list[hash % list.length]!.replace('{name}', name);
}

/**
 * The clip a place gets: an opening line ("You are passing <name>." or, when
 * the place sits clearly off the path, a left/right variant, in the narration
 * language) plus the cleaned extract cut to the target duration.
 */
export function composeText(
  name: string,
  extract: string,
  targetSeconds: number,
  side?: 'left' | 'right',
  lang = 'en',
): ComposedText {
  const prefix = pickOpener(name, side, lang);
  const budget = Math.max(10, Math.round(targetSeconds * WORDS_PER_SECOND) - countWords(prefix));
  const cleaned = stripNoiseParentheticals(extract);
  const body = cutToTarget(cleaned, budget);
  const text = body.length > 0 ? `${prefix} ${body}` : prefix;
  const words = countWords(text);
  return { text, words, seconds: Math.round(words / WORDS_PER_SECOND) };
}
