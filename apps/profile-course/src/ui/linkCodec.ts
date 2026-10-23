/**
 * Compact binary form of a shared link's settings, carried as `#c=<base64url>`.
 * The plain `key=value` hash stays fully supported — the writer picks whichever
 * of the two comes out shorter, and a hand-written plain link parses as before;
 * this exists so a link with edited weights and via points does not sprawl.
 * Precision: 1e-5 degrees (~1 m), 0.1 km and 0.1 weight steps — what the
 * inputs step in anyway.
 */
export interface LinkState {
  lat: number;
  lon: number;
  radiusKm: number;
  distanceKm: number | null;
  fromKm: number;
  toKm: number | null;
  mix: 'road' | 'gravel' | 'trail' | 'any';
  algorithm: 'beam' | 'walk';
  returnToStart: boolean;
  startAnywhere: boolean;
  connectors: boolean;
  useTraces: boolean;
  seed: number;
  beamWidth: number;
  viaToleranceKm: number;
  /** Only the weights that differ from their defaults. */
  weights: { name: string; value: number }[];
  vias: { lat: number; lon: number; km: number | null }[];
}

const MIXES = ['road', 'gravel', 'trail', 'any'] as const;
/** Weight indices in the blob; append only, never reorder. */
const WEIGHT_ORDER = [
  'localShape',
  'gainLoss',
  'turns',
  'surface',
  'penalty',
  'oscillation',
  'trafficLights',
  'untracked',
];
const VERSION = 1;
const HEAD = 26;
const KM_NONE = 0xffff;

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array | null {
  try {
    const bin = atob(s.replaceAll('-', '+').replaceAll('_', '/'));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

const u8 = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
const u16 = (v: number): number => Math.max(0, Math.min(0xffff, Math.round(v)));

export function encodeLink(s: LinkState): string {
  const weights = s.weights.filter((w) => WEIGHT_ORDER.includes(w.name));
  const vias = s.vias.slice(0, 255);
  const bytes = new Uint8Array(HEAD + 3 * weights.length + 10 * vias.length);
  const dv = new DataView(bytes.buffer);
  dv.setUint8(0, VERSION);
  dv.setInt32(1, Math.round(s.lat * 1e5));
  dv.setInt32(5, Math.round(s.lon * 1e5));
  dv.setUint8(9, u8(s.radiusKm * 2));
  dv.setUint16(10, u16((s.distanceKm ?? 0) * 10));
  dv.setUint16(12, u16(s.fromKm * 10));
  dv.setUint16(14, u16((s.toKm ?? 0) * 10));
  dv.setUint32(16, s.seed >>> 0);
  dv.setUint16(20, u16(s.beamWidth));
  dv.setUint8(
    22,
    Math.max(0, MIXES.indexOf(s.mix)) |
      (s.algorithm === 'walk' ? 4 : 0) |
      (s.returnToStart ? 8 : 0) |
      (s.startAnywhere ? 16 : 0) |
      (s.connectors ? 32 : 0) |
      (s.useTraces ? 64 : 0),
  );
  dv.setUint8(23, u8(s.viaToleranceKm * 10));
  dv.setUint8(24, weights.length);
  dv.setUint8(25, vias.length);
  let o = HEAD;
  for (const w of weights) {
    dv.setUint8(o, WEIGHT_ORDER.indexOf(w.name));
    dv.setUint16(o + 1, u16(w.value * 10));
    o += 3;
  }
  for (const v of vias) {
    dv.setInt32(o, Math.round(v.lat * 1e5));
    dv.setInt32(o + 4, Math.round(v.lon * 1e5));
    dv.setUint16(o + 8, v.km === null ? KM_NONE : u16(v.km * 10));
    o += 10;
  }
  return toBase64Url(bytes);
}

export function decodeLink(packed: string): LinkState | null {
  const bytes = fromBase64Url(packed);
  if (!bytes || bytes.length < HEAD) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint8(0) !== VERSION) return null;
  const wCount = dv.getUint8(24);
  const vCount = dv.getUint8(25);
  if (bytes.length !== HEAD + 3 * wCount + 10 * vCount) return null;
  const flags = dv.getUint8(22);
  const d = dv.getUint16(10);
  const to = dv.getUint16(14);
  const weights: LinkState['weights'] = [];
  let o = HEAD;
  for (let i = 0; i < wCount; i++) {
    const name = WEIGHT_ORDER[dv.getUint8(o)];
    if (name) weights.push({ name, value: dv.getUint16(o + 1) / 10 });
    o += 3;
  }
  const vias: LinkState['vias'] = [];
  for (let i = 0; i < vCount; i++) {
    const km = dv.getUint16(o + 8);
    vias.push({
      lat: dv.getInt32(o) / 1e5,
      lon: dv.getInt32(o + 4) / 1e5,
      km: km === KM_NONE ? null : km / 10,
    });
    o += 10;
  }
  return {
    lat: dv.getInt32(1) / 1e5,
    lon: dv.getInt32(5) / 1e5,
    radiusKm: dv.getUint8(9) / 2,
    distanceKm: d === 0 ? null : d / 10,
    fromKm: dv.getUint16(12) / 10,
    toKm: to === 0 ? null : to / 10,
    seed: dv.getUint32(16),
    beamWidth: dv.getUint16(20),
    mix: MIXES[flags & 3]!,
    algorithm: flags & 4 ? 'walk' : 'beam',
    returnToStart: (flags & 8) !== 0,
    startAnywhere: (flags & 16) !== 0,
    connectors: (flags & 32) !== 0,
    useTraces: (flags & 64) !== 0,
    viaToleranceKm: dv.getUint8(23) / 10,
    weights,
    vias,
  };
}

/**
 * The decoded state as the plain hash params, every field explicit, so the
 * reader has a single parsing path whichever form the link arrived in.
 */
export function linkStateToParams(s: LinkState): string {
  const parts = [
    `lat=${s.lat.toFixed(5)}`,
    `lon=${s.lon.toFixed(5)}`,
    `r=${s.radiusKm}`,
    `mix=${s.mix}`,
    `seed=${s.seed}`,
    `b=${s.beamWidth}`,
    `rts=${s.returnToStart ? 1 : 0}`,
    `sa=${s.startAnywhere ? 1 : 0}`,
    `conn=${s.connectors ? 1 : 0}`,
    `tr=${s.useTraces ? 1 : 0}`,
    `alg=${s.algorithm}`,
    `vt=${s.viaToleranceKm}`,
  ];
  if (s.distanceKm !== null) parts.push(`d=${s.distanceKm}`);
  if (s.fromKm > 0) parts.push(`from=${s.fromKm}`);
  if (s.toKm !== null) parts.push(`to=${s.toKm}`);
  if (s.weights.length > 0) {
    parts.push(`w=${s.weights.map((w) => `${w.name}:${w.value}`).join(',')}`);
  }
  if (s.vias.length > 0) {
    const via = s.vias.map((v) => `${v.lat.toFixed(5)},${v.lon.toFixed(5)},${v.km ?? ''}`);
    parts.push(`via=${via.join(';')}`);
  }
  return parts.join('&');
}
