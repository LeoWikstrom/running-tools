export interface PlaceSource {
  kind: 'wikipedia' | 'wikidata' | 'osm';
  url: string;
}

/** A raw place from one source, before merging and scoring. */
export interface PlaceCandidate {
  name: string;
  lat: number;
  lon: number;
  wikidataId?: string;
  /** Best Wikipedia page for fetching the text later. */
  wikipedia?: { lang: string; title: string };
  /** Every language's page seen while merging — the narration language picks
      its own title from here rather than guessing one. */
  wikipedias?: { lang: string; title: string }[];
  /** Wikipedia page length in bytes, a proxy for how much there is to tell. */
  pageLength?: number;
  sitelinks?: number;
  /** Has a heritage designation (Wikidata P1435). */
  heritage?: boolean;
  /** Dissolved, demolished or closed per Wikidata (P576/P3999) — a tour
      must not route past a place that no longer exists. */
  defunct?: boolean;
  /** Wikidata P31 ids and/or OSM tag values like historic=castle. */
  types: string[];
  website?: string;
  image?: string;
  sources: PlaceSource[];
}

/** A merged, scored place pinned to the course. */
export interface Place extends PlaceCandidate {
  id: string;
  /** Interest, 0–100. */
  score: number;
  /** Distance along the course of the first pass, metres. */
  d: number;
  /** Where the audio starts: d minus the lead distance, clamped to 0. */
  triggerD: number;
  /** Lateral distance from the course, metres. */
  offset: number;
  /** Which hand the place is on when clearly off the path; absent when on it. */
  side?: 'left' | 'right';
}

export interface PoiSettings {
  /** Keep only places within this lateral distance of the course, metres. */
  corridorWidth: number;
  /** Two places closer than this along the course: the lower score goes. */
  minSpacing: number;
  /** The audio starts this far before the place, metres. */
  leadDistance: number;
  /** Hard cap on places per tour. */
  maxPlaces: number;
  /** Drop streets/squares as places — you are standing on them anyway. */
  excludeStreets: boolean;
  excludeSquares: boolean;
  /** Drop events (crashes, battles, disasters) — a coordinate where
      something once happened is not a place to see. Opt-in to keep them. */
  excludeEvents: boolean;
}

export const DEFAULT_POI_SETTINGS: PoiSettings = {
  // 80 let in places a block away, behind corners and invisible from the
  // course; 60 keeps roughly "across the street and the square".
  corridorWidth: 60,
  minSpacing: 200,
  leadDistance: 30,
  maxPlaces: 25,
  excludeStreets: false,
  excludeSquares: false,
  excludeEvents: true,
};
