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

/**
 * The clip a place gets: "You are passing <name>." plus the cleaned extract
 * cut to the target duration.
 */
export function composeText(name: string, extract: string, targetSeconds: number): ComposedText {
  const prefix = `You are passing ${name}.`;
  const budget = Math.max(10, Math.round(targetSeconds * WORDS_PER_SECOND) - countWords(prefix));
  const cleaned = stripNoiseParentheticals(extract);
  const body = cutToTarget(cleaned, budget);
  const text = body.length > 0 ? `${prefix} ${body}` : prefix;
  const words = countWords(text);
  return { text, words, seconds: Math.round(words / WORDS_PER_SECOND) };
}
