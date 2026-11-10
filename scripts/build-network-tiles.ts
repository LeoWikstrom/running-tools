/*
 * Bake the Swedish runnable-path network into fixed-grid JSON tiles, the
 * exact OverpassResponse shape buildGraph consumes. Run in CI by
 * .github/workflows/network-tiles.yml as:
 *
 *   npx tsx scripts/build-network-tiles.ts <nodes.opl> <ways.opl> <outDir> [relations.opl]
 *
 * where the OPL files come from the Geofabrik extract via
 *   osmium tags-filter sweden-latest.osm.pbf w/highway w/barrier w/railway
 *     w/waterway w/landuse=military r/landuse=military -o filtered.pbf
 *   osmium cat --object-type n -f opl filtered.pbf -o nodes.opl
 *   osmium cat --object-type w -f opl filtered.pbf -o ways.opl
 *   osmium cat --object-type r -f opl filtered.pbf -o relations.opl
 *
 * (tags-filter is deliberately broad; keepWay applies buildQuery's precise
 * clause logic, filters osmium cannot express included.) Two passes because
 * ways reference nodes by id: nodes first into typed arrays, then ways
 * streamed into per-tile buckets. ~18 M nodes fit a few GB; the workflow
 * raises the heap.
 */
import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  keepWay,
  parseOplLine,
  toOverpassRelation,
  toOverpassWay,
  wayTiles,
} from '../packages/core/src/net/networkTilesBuild';
import { TILE_LAT_STEP, TILE_LON_STEP } from '../packages/core/src/net/networkTiles';
import { isForbiddenZoneTags } from '../packages/core/src/net/overpass';
import type {
  OverpassNode,
  OverpassRelation,
  OverpassWay,
} from '../packages/core/src/net/overpass';

const [nodesPath, waysPath, outDir, relationsPath] = process.argv.slice(2);
if (!nodesPath || !waysPath || !outDir) {
  console.error('usage: build-network-tiles.ts <nodes.opl> <ways.opl> <outDir> [relations.opl]');
  process.exit(1);
}

async function eachLine(path: string, onLine: (line: string) => void): Promise<void> {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) if (line.length > 0) onLine(line);
}

// Pass 1 — nodes. Coordinates in flat typed arrays; tags only where present.
// The id index is sharded: a single Map tops out at ~16.7M entries and the
// Swedish network holds more nodes than that.
const SHARDS = 64;
const nodeShards = Array.from({ length: SHARDS }, () => new Map<number, number>());
let lats = new Float64Array(1 << 20);
let lons = new Float64Array(1 << 20);
const nodeTags = new Map<number, Record<string, string>>();
let nodeCount = 0;

await eachLine(nodesPath, (line) => {
  const el = parseOplLine(line);
  if (!el || el.type !== 'node') return;
  if (nodeCount === lats.length) {
    const grownLats = new Float64Array(lats.length * 2);
    grownLats.set(lats);
    lats = grownLats;
    const grownLons = new Float64Array(lons.length * 2);
    grownLons.set(lons);
    lons = grownLons;
  }
  nodeShards[el.id % SHARDS]!.set(el.id, nodeCount);
  lats[nodeCount] = el.lat;
  lons[nodeCount] = el.lon;
  nodeCount++;
  if (el.tags) nodeTags.set(el.id, el.tags);
});
console.log(`${nodeCount} nodes read`);

const nodePos = (id: number): { lat: number; lon: number } | undefined => {
  const i = nodeShards[id % SHARDS]!.get(id);
  return i === undefined ? undefined : { lat: lats[i]!, lon: lons[i]! };
};

// Pass 1b — forbidden-zone relations (landuse=military multipolygons): kept
// whole, so a tile at the area's edge still assembles a closed ring.
const zoneRelations: OverpassRelation[] = [];
const zoneMemberWayIds = new Set<number>();
if (relationsPath) {
  await eachLine(relationsPath, (line) => {
    const el = parseOplLine(line);
    if (!el || el.type !== 'relation' || !isForbiddenZoneTags(el.tags)) return;
    zoneRelations.push(toOverpassRelation(el));
    for (const m of el.members) if (m.type === 'way') zoneMemberWayIds.add(m.ref);
  });
  console.log(`${zoneRelations.length} forbidden-zone relations read`);
}

// Pass 2 — ways into per-tile buckets (way list + referenced node ids).
const tiles = new Map<
  string,
  { ways: OverpassWay[]; relations: OverpassRelation[]; nodeIds: Set<number> }
>();
const tileAt = (id: string): NonNullable<ReturnType<typeof tiles.get>> => {
  let tile = tiles.get(id);
  if (!tile) tiles.set(id, (tile = { ways: [], relations: [], nodeIds: new Set() }));
  return tile;
};
const zoneMemberWays = new Map<number, OverpassWay>();
let keptWays = 0;

await eachLine(waysPath, (line) => {
  const el = parseOplLine(line);
  if (!el || el.type !== 'way') return;
  if (zoneMemberWayIds.has(el.id)) zoneMemberWays.set(el.id, toOverpassWay(el));
  if (!keepWay(el.tags)) return;
  keptWays++;
  const way = toOverpassWay(el);
  for (const id of wayTiles(el.nodes, nodePos)) {
    const tile = tileAt(id);
    tile.ways.push(way);
    for (const n of el.nodes) tile.nodeIds.add(n);
  }
});
console.log(`${keptWays} ways kept across ${tiles.size} tiles`);

// Each forbidden-zone relation goes whole — relation, member ways, their
// nodes — into every tile any member touches; the client dedupes by id.
for (const rel of zoneRelations) {
  const members = rel.members
    .map((m) => (m.type === 'way' ? zoneMemberWays.get(m.ref) : undefined))
    .filter((w): w is OverpassWay => w !== undefined);
  if (members.length === 0) continue;
  const touched = new Set<string>();
  for (const w of members) for (const t of wayTiles(w.nodes, nodePos)) touched.add(t);
  for (const t of touched) {
    const tile = tileAt(t);
    tile.relations.push(rel);
    for (const w of members) {
      tile.ways.push(w);
      for (const n of w.nodes) tile.nodeIds.add(n);
    }
  }
}

await mkdir(outDir, { recursive: true });
let totalBytes = 0;
for (const [id, tile] of tiles) {
  const nodes: OverpassNode[] = [];
  for (const n of tile.nodeIds) {
    const p = nodePos(n);
    if (!p) continue;
    const node: OverpassNode = { type: 'node', id: n, lat: p.lat, lon: p.lon };
    const tags = nodeTags.get(n);
    if (tags) node.tags = tags;
    nodes.push(node);
  }
  const body = JSON.stringify({ elements: [...tile.ways, ...tile.relations, ...nodes] });
  totalBytes += body.length;
  await writeFile(join(outDir, `net_${id}.json`), body);
}

const manifest = {
  version: 1,
  generated: new Date().toISOString(),
  latStep: TILE_LAT_STEP,
  lonStep: TILE_LON_STEP,
  tiles: [...tiles.keys()].sort(),
};
await writeFile(join(outDir, 'index.json'), JSON.stringify(manifest));
console.log(
  `wrote ${tiles.size} tiles + index.json to ${outDir} — ${(totalBytes / 1e6).toFixed(0)} MB plain JSON`,
);
