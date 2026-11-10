/**
 * The Wikipedia editions to query, in result-priority order: the narration
 * language leads, then English and the local language as fallbacks. With
 * nativeOnly only the narration edition is searched — those are the only
 * results that can be used without machine translation.
 */
export function searchLangs(
  narrationLang: string,
  localLang: string,
  nativeOnly = false,
): string[] {
  const narration = narrationLang.trim().toLowerCase();
  const local = localLang.trim().toLowerCase();
  const out: string[] = [];
  for (const lang of nativeOnly ? [narration] : [narration, 'en', local]) {
    if (lang && !out.includes(lang)) out.push(lang);
  }
  return out;
}
