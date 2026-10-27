import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  composeText,
  pickOpener,
  countWords,
  cutToTarget,
  splitSentences,
  stripNoiseParentheticals,
  WORDS_PER_SECOND,
} from '../src/text/trim';
import { fetchExtract, splitExtractSections } from '../src/text/summary';

const FIXTURES = join(__dirname, 'fixtures');
const load = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

describe('stripNoiseParentheticals', () => {
  it('drops pronunciations, coordinates and reference markers', () => {
    expect(
      stripNoiseParentheticals(
        'Feskekôrka (Swedish pronunciation: [ˈfɛ̂sːkɛˌɕœrka], "Fish Church") is a market.[1]',
      ),
    ).toBe('Feskekôrka is a market.');
    expect(stripNoiseParentheticals('The fort (57°41′N 11°56′E) still stands.')).toBe(
      'The fort still stands.',
    );
  });

  it('keeps ordinary asides', () => {
    expect(stripNoiseParentheticals('The hall (now a museum) is open.')).toBe(
      'The hall (now a museum) is open.',
    );
  });
});

describe('sentence cutting', () => {
  const text =
    'One sentence here with six words. Second sentence is also six words. ' +
    'Third one has exactly six words. Fourth sentence rounds it all out.';

  it('splits encyclopaedia prose into sentences', () => {
    expect(splitSentences(text)).toHaveLength(4);
  });

  it('cuts at the sentence boundary closest to the budget', () => {
    expect(countWords(cutToTarget(text, 12))).toBe(12);
    expect(countWords(cutToTarget(text, 14))).toBe(12);
    expect(countWords(cutToTarget(text, 17))).toBe(18);
    // Always keeps at least one sentence, however small the budget.
    expect(countWords(cutToTarget(text, 1))).toBe(6);
  });
});

describe('composeText', () => {
  const extract = Array.from(
    { length: 20 },
    (_, i) => `Sentence number ${i + 1} tells a little more of the story.`,
  ).join(' ');

  it('prefixes the spoken line and lands near the target duration', () => {
    const c = composeText('Skansen Kronan', extract, 40);
    expect(c.text.startsWith(pickOpener('Skansen Kronan', undefined, 'en'))).toBe(true);
    expect(c.text).toContain('Skansen Kronan');
    expect(c.seconds).toBeGreaterThanOrEqual(30);
    expect(c.seconds).toBeLessThanOrEqual(50);
    expect(c.words).toBe(countWords(c.text));
  });

  it('a shorter target gives a shorter clip', () => {
    const short = composeText('X', extract, 20);
    const long = composeText('X', extract, 90);
    expect(short.words).toBeLessThan(long.words);
    expect(Math.abs(short.seconds - 20)).toBeLessThanOrEqual(5);
  });

  it('an empty extract still announces the place', () => {
    expect(composeText('The Spot', '', 40).text).toBe(pickOpener('The Spot', undefined, 'en'));
  });

  it('a place off the path opens with the hand it is on', () => {
    const c = composeText('Skansen Kronan', extract, 40, 'left');
    expect(c.text.startsWith(pickOpener('Skansen Kronan', 'left', 'en'))).toBe(true);
    expect(pickOpener('The Spot', 'right', 'en')).toContain('right');
    expect(pickOpener('The Spot', 'right', 'en')).toContain('The Spot');
  });

  it('openers vary with the name, stay stable per name, and speak the language', () => {
    const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
    const openers = new Set(names.map((n) => pickOpener(n, undefined, 'en').replace(n, '')));
    expect(openers.size).toBeGreaterThan(1);
    expect(pickOpener('X', 'left', 'sv')).toContain('vänstra');
    expect(pickOpener('X', 'right', 'it')).toContain('destra');
    expect(pickOpener('X', undefined, 'nosuch')).toContain('X');
  });
});

describe('splitExtractSections', () => {
  it('splits the saved Skansen Kronan page into its sections', () => {
    const json = JSON.parse(load('wiki_extract_skansen_en.json')) as {
      query: { pages: Record<string, { extract: string }> };
    };
    const plain = Object.values(json.query.pages)[0]!.extract;
    const sections = splitExtractSections(plain);
    expect(sections.some((s) => s.heading === 'History')).toBe(true);
    const history = sections.find((s) => s.heading === 'History')!;
    expect(countWords(history.body)).toBeGreaterThan(20);
  });
});

describe('fetchExtract', () => {
  const summaryFixture = load('wiki_summary_feskekorka_en.json');
  const extractFixture = load('wiki_extract_skansen_en.json');

  it('returns a long-enough REST summary as-is', async () => {
    const fetchFn = (async (url: RequestInfo | URL) => {
      expect(String(url)).toContain('/page/summary/');
      return new Response(summaryFixture, { status: 200 });
    }) as typeof fetch;
    const got = (await fetchExtract([{ lang: 'en', title: 'Feskekôrka' }], { fetchFn }))!;
    expect(got.lang).toBe('en');
    expect(countWords(got.extract)).toBeGreaterThan(40);
    expect(got.url).toContain('wikipedia.org');
  });

  it('tops up a thin lead with the History section', async () => {
    const thinLead = JSON.stringify({
      extract: 'Skansen Kronan is a redoubt in Gothenburg.',
      content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Skansen_Kronan' } },
    });
    const fetchFn = (async (url: RequestInfo | URL) => {
      if (String(url).includes('/page/summary/')) return new Response(thinLead, { status: 200 });
      return new Response(extractFixture, { status: 200 });
    }) as typeof fetch;
    const got = (await fetchExtract([{ lang: 'en', title: 'Skansen Kronan' }], { fetchFn }))!;
    expect(got.extract).toContain('Skansen Kronan is a redoubt');
    expect(countWords(got.extract)).toBeGreaterThan(40);
  });

  it('falls through 404s to the next page in line', async () => {
    const fetchFn = (async (url: RequestInfo | URL) => {
      if (String(url).includes('en.wikipedia')) return new Response('', { status: 404 });
      return new Response(summaryFixture, { status: 200 });
    }) as typeof fetch;
    const got = (await fetchExtract(
      [
        { lang: 'en', title: 'No Such Page' },
        { lang: 'sv', title: 'Feskekôrka' },
      ],
      { fetchFn },
    ))!;
    expect(got.lang).toBe('sv');
  });

  it('words-per-second matches the plan: 30–45 s is 70–110 words', () => {
    expect(Math.round(30 * WORDS_PER_SECOND)).toBeGreaterThanOrEqual(70);
    expect(Math.round(45 * WORDS_PER_SECOND)).toBeLessThanOrEqual(110);
  });
});
