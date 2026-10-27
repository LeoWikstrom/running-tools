/**
 * Best-effort on-device translation via the browser Translator API (Chrome
 * 138+). Where the API or the language pair is unavailable the caller keeps
 * the original text; the reliable path is the phase 7 LLM rewrite.
 */

interface BrowserTranslator {
  translate(text: string): Promise<string>;
}

interface TranslatorStatic {
  availability(opts: { sourceLanguage: string; targetLanguage: string }): Promise<string>;
  create(opts: { sourceLanguage: string; targetLanguage: string }): Promise<BrowserTranslator>;
}

const api = (globalThis as { Translator?: TranslatorStatic }).Translator;

/** Whether this browser offers on-device translation at all. */
export const translatorAvailable = api !== undefined;

const translators = new Map<string, Promise<BrowserTranslator>>();

export async function translateBestEffort(
  text: string,
  sourceLanguage: string,
  targetLanguage: string,
): Promise<string | null> {
  if (!api || !sourceLanguage || sourceLanguage === targetLanguage) return null;
  const key = `${sourceLanguage}>${targetLanguage}`;
  try {
    let translator = translators.get(key);
    if (!translator) {
      const availability = await api.availability({ sourceLanguage, targetLanguage });
      // 'downloadable'/'downloading' make create() fetch the language pack —
      // slow once, then on-device.
      if (availability === 'unavailable') return null;
      translator = api.create({ sourceLanguage, targetLanguage });
      translators.set(key, translator);
    }
    const out = (await (await translator).translate(text)).trim();
    return out.length > 0 ? out : null;
  } catch {
    translators.delete(key);
    return null;
  }
}
