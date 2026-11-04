/*
 * Bake a GTFS Regional feed (Trafiklab, CC0) into the compact line JSON the
 * BusTour picker reads — one entry per route and direction, polyline-encoded
 * geometry, stops in travel order. Run with:
 *
 *   TRAFIKLAB_GTFS_KEY=… npx tsx scripts/build-gtfs-lines.ts [feed]
 *
 * `feed` defaults to vt (Västtrafik). GTFS_ZIP=path skips the download and
 * reads a local zip instead (for testing). Output: site/gtfs/<feed>.json,
 * deployed with the Pages site. The big files (stop_times, shapes) are
 * streamed line by line through `unzip -p`, never held in memory whole.
 */
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import {
  assembleGtfsLines,
  chooseRepresentatives,
  parseCsvLine,
  type GtfsRoute,
  type GtfsTrip,
} from '../packages/core/src/net/gtfsLines';

const feed = process.argv[2] ?? 'vt';
const outPath = new URL(`../site/gtfs/${feed}.json`, import.meta.url).pathname;

async function downloadZip(): Promise<string> {
  const local = process.env.GTFS_ZIP;
  if (local) return local;
  const key = process.env.TRAFIKLAB_GTFS_KEY;
  if (!key) {
    console.error('TRAFIKLAB_GTFS_KEY is not set (and no GTFS_ZIP override given).');
    process.exit(1);
  }
  const url = `https://opendata.samtrafiken.se/gtfs/${feed}/${feed}.zip?key=${key}`;
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`GTFS download failed: ${res.status}`);
  const path = join(tmpdir(), `gtfs-${feed}.zip`);
  await new Promise<void>((resolve, reject) => {
    const file = createWriteStream(path);
    Readable.fromWeb(res.body as import('node:stream/web').ReadableStream)
      .pipe(file)
      .on('finish', resolve)
      .on('error', reject);
  });
  const { size } = await stat(path);
  console.log(`downloaded ${feed}.zip — ${(size / 1e6).toFixed(1)} MB`);
  return path;
}

/** Stream one file out of the zip, calling onRow with parsed fields. */
async function eachRow(
  zip: string,
  member: string,
  onRow: (row: Record<string, string>) => void,
): Promise<void> {
  const child = spawn('unzip', ['-p', zip, member], { stdio: ['ignore', 'pipe', 'inherit'] });
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let header: string[] | null = null;
  for await (const line of rl) {
    if (line.length === 0) continue;
    const fields = parseCsvLine(line);
    if (!header) {
      // Strip a potential BOM from the first column name.
      header = fields.map((f) => f.replace(/^\uFEFF/, ''));
      continue;
    }
    const row: Record<string, string> = {};
    for (let i = 0; i < header.length; i++) row[header[i]!] = fields[i] ?? '';
    onRow(row);
  }
  await new Promise<void>((resolve, reject) => {
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`unzip -p ${member} exited ${code}`)),
    );
  });
}

const zip = await downloadZip();

const routes: GtfsRoute[] = [];
await eachRow(zip, 'routes.txt', (r) => {
  routes.push({
    routeId: r.route_id ?? '',
    shortName: r.route_short_name ?? '',
    longName: r.route_long_name ?? '',
    routeType: Number(r.route_type ?? -1),
  });
});
console.log(`${routes.length} routes`);

const trips: GtfsTrip[] = [];
await eachRow(zip, 'trips.txt', (r) => {
  trips.push({
    routeId: r.route_id ?? '',
    tripId: r.trip_id ?? '',
    directionId: r.direction_id ?? '',
    shapeId: r.shape_id ?? '',
    headsign: r.trip_headsign ?? '',
  });
});
console.log(`${trips.length} trips`);

const reps = chooseRepresentatives(routes, trips);
console.log(`${reps.length} route directions kept (bus/tram)`);
const wantTrips = new Set(reps.map((r) => r.tripId));
const wantShapes = new Set(reps.map((r) => r.shapeId));

const stopRows = new Map<string, { seq: number; stopId: string }[]>();
await eachRow(zip, 'stop_times.txt', (r) => {
  const tripId = r.trip_id ?? '';
  if (!wantTrips.has(tripId)) return;
  let list = stopRows.get(tripId);
  if (!list) stopRows.set(tripId, (list = []));
  list.push({ seq: Number(r.stop_sequence ?? 0), stopId: r.stop_id ?? '' });
});
const stopIdsByTrip = new Map<string, string[]>();
const wantStops = new Set<string>();
for (const [tripId, rows] of stopRows) {
  rows.sort((a, b) => a.seq - b.seq);
  const ids = rows.map((r) => r.stopId);
  stopIdsByTrip.set(tripId, ids);
  for (const id of ids) wantStops.add(id);
}

const stops = new Map<string, { name: string; lat: number; lon: number }>();
await eachRow(zip, 'stops.txt', (r) => {
  const id = r.stop_id ?? '';
  if (!wantStops.has(id)) return;
  stops.set(id, {
    name: r.stop_name ?? '',
    lat: Number(r.stop_lat ?? 0),
    lon: Number(r.stop_lon ?? 0),
  });
});
console.log(`${stops.size} stops`);

const shapeRows = new Map<string, { seq: number; lat: number; lon: number }[]>();
await eachRow(zip, 'shapes.txt', (r) => {
  const id = r.shape_id ?? '';
  if (!wantShapes.has(id)) return;
  let list = shapeRows.get(id);
  if (!list) shapeRows.set(id, (list = []));
  list.push({
    seq: Number(r.shape_pt_sequence ?? 0),
    lat: Number(r.shape_pt_lat ?? 0),
    lon: Number(r.shape_pt_lon ?? 0),
  });
});
const shapes = new Map<string, { lat: number; lon: number }[]>();
for (const [id, rows] of shapeRows) {
  rows.sort((a, b) => a.seq - b.seq);
  shapes.set(
    id,
    rows.map((r) => ({ lat: r.lat, lon: r.lon })),
  );
}
console.log(`${shapes.size} shapes`);

const result = assembleGtfsLines(feed, reps, stopIdsByTrip, stops, shapes);
await mkdir(new URL('../site/gtfs/', import.meta.url).pathname, { recursive: true });
// Only the `generated` stamp differs on an unchanged month; don't churn git.
try {
  const previous = JSON.parse(await readFile(outPath, 'utf8')) as typeof result;
  if (JSON.stringify({ ...previous, generated: result.generated }) === JSON.stringify(result)) {
    console.log(`${outPath} unchanged — not rewritten`);
    if (!process.env.GTFS_ZIP) await unlink(zip).catch(() => undefined);
    process.exit(0);
  }
} catch {
  // No previous file (or unreadable) — write.
}
const json = JSON.stringify(result);
await writeFile(outPath, json);
console.log(`wrote ${outPath}: ${result.lines.length} lines, ${(json.length / 1e6).toFixed(1)} MB`);
if (!process.env.GTFS_ZIP) await unlink(zip).catch(() => undefined);
