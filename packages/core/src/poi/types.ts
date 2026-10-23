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
  /** Wikipedia page length in bytes, a proxy for how much there is to tell. */
  pageLength?: number;
  sitelinks?: number;
  /** Has a heritage designation (Wikidata P1435). */
  heritage?: boolean;
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
}

export const DEFAULT_POI_SETTINGS: PoiSettings = {
  corridorWidth: 80,
  minSpacing: 200,
  leadDistance: 30,
  maxPlaces: 25,
};
