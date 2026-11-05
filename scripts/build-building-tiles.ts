/*
 * Pack Swedish building footprints into fixed-grid tiles beside the network
 * tiles — polyline-encoded outer rings, no tags, ~6 bytes a vertex. Run in
 * CI by .github/workflows/network-tiles.yml as:
 *
 *   osmium tags-filter sweden.osm.pbf w/building -o buildings.pbf
 *   osmium export buildings.pbf -f geojsonseq --attributes=type,id \
 *     | npx tsx scripts/build-building-tiles.ts <outDir>
 *
 * osmium export assembles geometry (multipolygons included), so no node
 * joining happens here — the stream is read once with near-constant memory
 * besides the growing per-tile buckets.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { encodePolyline } from '../packages/core/src/net/gtfsLines';
import { coordTiles } from '../packages/core/src/net/networkTilesBuild';
import { TILE_LAT_STEP, TILE_LON_STEP } from '../packages/core/src/net/networkTiles';

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: osmium export … -f geojsonseq | build-building-tiles.ts <outDir>');
  process.exit(1);
}

interface Feature {
  geometry?: { type: string; coordinates: unknown };
  properties?: { '@type'?: string; '@id'?: number };
}

const tiles = new Map<string, [number, string][]>();
let footprints = 0;

function addRing(id: number, ring: [number, number][]): void {
  if (ring.length < 3) return;
  const points = ring.map(([lon, lat]) => ({ lat, lon }));
  const encoded = encodePolyline(points);
  footprints++;
  for (const tile of coordTiles(points)) {
    let list = tiles.get(tile);
    if (!list) tiles.set(tile, (list = []));
    list.push([id, encoded]);
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const raw of rl) {
  // geojsonseq lines open with an RS (0x1e) separator.
  const line = raw.charCodeAt(0) === 0x1e ? raw.slice(1) : raw;
  if (line.length === 0) continue;
  let feature: Feature;
  try {
    feature = JSON.parse(line) as Feature;
  } catch {
    continue;
  }
  const g = feature.geometry;
  const baseId = feature.properties?.['@id'] ?? 0;
  // Relation-assembled footprints get negative ids: BuildingPoly ids only
  // ever meet way ids in the self-occlusion check, so they must not collide.
  const fromWay = feature.properties?.['@type'] === 'way';
  if (!g || baseId === 0) continue;
  if (g.type === 'Polygon') {
    const rings = g.coordinates as [number, number][][];
    addRing(fromWay ? baseId : -baseId, rings[0] ?? []);
  } else if (g.type === 'MultiPolygon') {
    // osmium emits way-areas as single-polygon MultiPolygons with the
    // original way id — that id must stay positive, or the LoS
    // self-occlusion check can never match a place to its own building.
    const polys = g.coordinates as [number, number][][][];
    if (fromWay && polys.length === 1) {
      addRing(baseId, polys[0]![0] ?? []);
    } else {
      for (let k = 0; k < polys.length; k++) {
        addRing(-(baseId * 10 + k), polys[k]![0] ?? []);
      }
    }
  }
}

await mkdir(outDir, { recursive: true });
let totalBytes = 0;
for (const [id, buildings] of tiles) {
  const body = JSON.stringify({ version: 1, buildings });
  totalBytes += body.length;
  await writeFile(join(outDir, `bld_${id}.json`), body);
}
const manifest = {
  version: 1,
  generated: new Date().toISOString(),
  latStep: TILE_LAT_STEP,
  lonStep: TILE_LON_STEP,
  tiles: [...tiles.keys()].sort(),
};
await writeFile(join(outDir, 'index-bld.json'), JSON.stringify(manifest));
console.log(
  `wrote ${tiles.size} building tiles (${footprints} footprints) + index-bld.json — ${(totalBytes / 1e6).toFixed(0)} MB plain JSON`,
);
