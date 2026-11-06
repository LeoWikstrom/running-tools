import type { PlaceCandidate } from './types';

/**
 * Wikidata P31 classes worth telling about. Exact-id matching, no subclass
 * reasoning, so common subtypes are listed alongside their parents.
 */
export const WORTH_TELLING_WIKIDATA = new Set([
  'Q16970', // church building
  'Q317557', // parish church
  'Q2977', // cathedral
  'Q108325', // chapel
  'Q44613', // monastery
  'Q32815', // mosque
  'Q34627', // synagogue
  'Q23413', // castle
  'Q81106', // fortress
  'Q57821', // fortification
  'Q33506', // museum
  'Q207694', // art museum
  'Q4989906', // monument
  'Q5003624', // memorial
  'Q860861', // sculpture
  'Q179700', // statue
  'Q12280', // bridge
  'Q158438', // arch bridge
  'Q174782', // square
  'Q24354', // theatre building
  'Q153562', // opera house
  'Q483110', // stadium
  'Q1329623', // cultural centre
  'Q16560', // palace
  'Q39715', // lighthouse
  'Q12518', // tower
  'Q11303', // skyscraper
  'Q22698', // park
  'Q167346', // botanical garden
  'Q43501', // zoo
  'Q39614', // cemetery
  'Q11755880', // residential building (notable ones carry heritage anyway)
  'Q35112127', // historic building
  'Q1497364', // building complex
  'Q2080521', // market hall
]);

/** OSM tag values (historic=*, tourism=*) worth telling about. */
export const WORTH_TELLING_OSM = new Set([
  'castle',
  'church',
  'cathedral',
  'monastery',
  'fort',
  'citywalls',
  'ruins',
  'monument',
  'memorial',
  'archaeological_site',
  'ship',
  'wayside_shrine',
  'battlefield',
  'museum',
  'gallery',
  'attraction',
  'artwork',
  'viewpoint',
  'theatre',
  'stadium',
  'lighthouse',
]);

/**
 * Administrative entities whose coordinate is just a pin in the middle of
 * town: never a place the runner is passing. Exact P31 ids, best effort.
 */
export const EXCLUDED_WIKIDATA = new Set([
  'Q515', // city
  'Q3957', // town
  'Q532', // village
  'Q6256', // country
  'Q127448', // municipality of Sweden
  'Q2983893', // quarter/district
  'Q123705', // neighborhood
  'Q7969215', // ward of the City of London (en:Bishopsgate is one, not a gate)
  'Q185441', // electoral ward
  'Q12813115', // urban area of Sweden
  'Q1907114', // metropolitan area
  'Q13220204', // second-level administrative division
]);

/**
 * Events: things that happened at a coordinate rather than things standing
 * there — crashes, battles, disasters. Exact P31 ids (the SPARQL carries no
 * subclass closure), best effort over what city tours actually surfaced.
 */
const EVENT_WIKIDATA = new Set([
  'Q1190554', // occurrence
  'Q1656682', // event
  'Q13418847', // historical event
  'Q1078765', // railway accident
  'Q1620824', // train wreck
  'Q744913', // aviation accident
  'Q9687', // traffic collision
  'Q3839081', // disaster
  'Q8065', // natural disaster
  'Q3196', // fire
  'Q168983', // conflagration
  'Q179057', // explosion
  'Q178561', // battle
  'Q188055', // siege
  'Q3199915', // massacre
  'Q2223653', // terrorist attack
  'Q124757', // riot
  'Q7944', // earthquake
  'Q8068', // flood
  'Q906512', // shipwrecking
]);

export function isEventPlace(c: PlaceCandidate): boolean {
  return c.types.some((t) => EVENT_WIKIDATA.has(t));
}

export function isExcludedType(c: PlaceCandidate): boolean {
  // A dissolved, demolished or closed place (Wikidata P576/P3999) is never
  // tour material — a spur to a restaurant that no longer exists is wasted.
  if (c.defunct) return true;
  return c.types.some((t) => EXCLUDED_WIKIDATA.has(t));
}

// You are standing on the street and can see the square yourself — both are
// optional as narration subjects. P31 ids plus the names Swedish and English
// streets and squares actually carry.
const STREET_WIKIDATA = new Set([
  'Q79007', // street
  'Q34442', // road
  'Q83620', // thoroughfare
  'Q54114', // boulevard
  'Q7543083', // avenue
]);
const STREET_NAME =
  /(gatan|gata|vägen|leden|allén|avenyn|esplanaden|stråket|street|road|avenue|boulevard)$/i;

const SQUARE_WIKIDATA = new Set([
  'Q174782', // town square
]);
const SQUARE_NAME = /(torget|torg|platsen|plats|square|piazza)$/i;

export function isStreetPlace(c: PlaceCandidate): boolean {
  return c.types.some((t) => STREET_WIKIDATA.has(t)) || STREET_NAME.test(c.name.trim());
}

export function isSquarePlace(c: PlaceCandidate): boolean {
  return c.types.some((t) => SQUARE_WIKIDATA.has(t)) || SQUARE_NAME.test(c.name.trim());
}

function hasWorthTellingType(c: PlaceCandidate): boolean {
  return c.types.some((t) => WORTH_TELLING_WIKIDATA.has(t) || WORTH_TELLING_OSM.has(t));
}

/** Sitelinks saturate here: ~30 language editions is a world-famous place. */
const SITELINKS_FULL = 30;
/** Page length saturates here: ~20 kB is a thorough article. */
const PAGE_LENGTH_FULL = 20_000;

/**
 * Interest 0–100: sitelinks 0.4, page length 0.2, heritage designation 0.2,
 * worth-telling type 0.2.
 */
export function interestScore(c: PlaceCandidate): number {
  const sitelinkScore = Math.min(1, (c.sitelinks ?? 0) / SITELINKS_FULL);
  const lengthScore = Math.min(1, (c.pageLength ?? 0) / PAGE_LENGTH_FULL);
  const heritageScore = c.heritage ? 1 : 0;
  const typeScore = hasWorthTellingType(c) ? 1 : 0;
  return Math.round(
    100 * (0.4 * sitelinkScore + 0.2 * lengthScore + 0.2 * heritageScore + 0.2 * typeScore),
  );
}

/**
 * A candidate earns its place with any signal at all: a Wikipedia page, a
 * Wikidata item, a heritage designation or a worth-telling type. An OSM-only
 * element with none of those (or no name) is a drop.
 */
export function hasSignal(c: PlaceCandidate): boolean {
  if (!c.name) return false;
  return (
    c.wikipedia !== undefined ||
    c.wikidataId !== undefined ||
    c.heritage === true ||
    hasWorthTellingType(c)
  );
}
