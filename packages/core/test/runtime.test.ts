import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RUNTIME_SETTINGS,
  TourRuntime,
  type Fix,
  type RuntimeEvent,
  type RuntimePlace,
  type RuntimeSettings,
} from '../src/tour/runtime';

/** Straight course north: one point per ~111 m of latitude, 5.5 km long. */
const LAT0 = 57.7;
const LON0 = 11.97;
const STEP_LAT = 0.001; // ≈ 111.2 m
const M_PER_STEP = 111.195;
const N = 51;
const lats = Array.from({ length: N }, (_, i) => LAT0 + i * STEP_LAT);
const lons = Array.from({ length: N }, () => LON0);

/** A fix on the course at `d` metres from the start, offset metres east. */
function fixAt(t: number, d: number, offsetEast = 0): Fix {
  const lat = LAT0 + (d / M_PER_STEP) * STEP_LAT;
  const mPerDegLon = 111_195 * Math.cos((lat * Math.PI) / 180);
  return { t, lat, lon: LON0 + offsetEast / mPerDegLon };
}

type Step = { kind: 'fix'; fix: Fix } | { kind: 'end' };

interface Scenario {
  name: string;
  route: { lats: number[]; lons: number[] };
  places: RuntimePlace[];
  settings: RuntimeSettings;
  steps: Step[];
}

/** Run a scenario, returning the events of every step (the golden trace). */
function run(sc: Scenario): RuntimeEvent[][] {
  const rt = new TourRuntime(sc.route.lats, sc.route.lons, sc.places, sc.settings);
  return sc.steps.map((s) => (s.kind === 'fix' ? rt.update(s.fix) : rt.clipEnded()));
}

const names = (evs: RuntimeEvent[]): string[] =>
  evs.map((e) => ('placeId' in e ? `${e.type}:${e.placeId}` : e.type));

const scenarios: Scenario[] = [];

function scenario(
  name: string,
  places: RuntimePlace[],
  steps: Step[],
  settings: RuntimeSettings = DEFAULT_RUNTIME_SETTINGS,
  route: { lats: number[]; lons: number[] } = { lats, lons },
): Scenario {
  const sc = { name, route, places, settings, steps };
  scenarios.push(sc);
  return sc;
}

describe('TourRuntime', () => {
  it('plays each place once as the runner reaches it', () => {
    const sc = scenario(
      'simple',
      [
        { id: 'A', triggerD: 500 },
        { id: 'C', triggerD: 2000 },
      ],
      [
        { kind: 'fix', fix: fixAt(0, 0) },
        { kind: 'fix', fix: fixAt(100, 400) },
        { kind: 'fix', fix: fixAt(140, 520) },
        { kind: 'end' },
        { kind: 'fix', fix: fixAt(300, 1200) },
        { kind: 'fix', fix: fixAt(520, 2010) },
        { kind: 'end' },
        { kind: 'fix', fix: fixAt(700, 2500) },
      ],
    );
    const trace = run(sc);
    expect(names(trace[2]!)).toEqual(['play:A']);
    expect(names(trace[5]!)).toEqual(['play:C']);
    expect(trace[6]!).toEqual([]);
    expect(trace[7]!).toEqual([]);
  });

  it('queues a clip while one plays and drops it 200 m past its point', () => {
    const sc = scenario(
      'queue-drop',
      [
        { id: 'A', triggerD: 500 },
        { id: 'B', triggerD: 600 },
      ],
      [
        { kind: 'fix', fix: fixAt(0, 0) },
        { kind: 'fix', fix: fixAt(150, 510) }, // A plays
        { kind: 'fix', fix: fixAt(180, 620) }, // B queued behind A
        { kind: 'fix', fix: fixAt(250, 850) }, // B waited > 200 m: dropped
        { kind: 'end' }, // A ends; nothing left
      ],
    );
    const trace = run(sc);
    expect(names(trace[1]!)).toEqual(['play:A']);
    expect(names(trace[2]!)).toEqual([]);
    expect(names(trace[3]!)).toEqual(['drop:B']);
    expect(names(trace[4]!)).toEqual([]);
  });

  it('drops two overdue queued clips in queue (FIFO) order in one update', () => {
    const sc = scenario(
      'queue-drop-fifo',
      [
        { id: 'A', triggerD: 500 },
        { id: 'B', triggerD: 600 },
        { id: 'C', triggerD: 700 },
      ],
      [
        { kind: 'fix', fix: fixAt(0, 0) },
        { kind: 'fix', fix: fixAt(150, 510) }, // A plays
        { kind: 'fix', fix: fixAt(180, 620) }, // B queued behind A
        { kind: 'fix', fix: fixAt(210, 710) }, // C queued behind B
        { kind: 'fix', fix: fixAt(400, 1000) }, // both waited > 200 m past their points
        { kind: 'end' },
      ],
    );
    const trace = run(sc);
    expect(names(trace[1]!)).toEqual(['play:A']);
    expect(names(trace[4]!)).toEqual(['drop:B', 'drop:C']);
    expect(names(trace[5]!)).toEqual([]);
  });

  it('plays the queued clip when the first ends in time', () => {
    const sc = scenario(
      'queue-play',
      [
        { id: 'A', triggerD: 500 },
        { id: 'B', triggerD: 600 },
      ],
      [
        { kind: 'fix', fix: fixAt(0, 0) },
        { kind: 'fix', fix: fixAt(150, 510) },
        { kind: 'fix', fix: fixAt(180, 620) },
        { kind: 'end' }, // A ends at ~620 m; B is still within 600+200
      ],
    );
    const trace = run(sc);
    expect(names(trace[3]!)).toEqual(['play:B']);
  });

  it('goes off course after 20 s beyond 60 m, with no triggers while off', () => {
    const sc = scenario(
      'off-course',
      [{ id: 'A', triggerD: 500 }],
      [
        { kind: 'fix', fix: fixAt(0, 0) },
        { kind: 'fix', fix: fixAt(10, 100, 100) }, // 100 m east: off, not yet confirmed
        { kind: 'fix', fix: fixAt(25, 300, 100) }, // 15 s: still not confirmed
        { kind: 'fix', fix: fixAt(31, 520, 100) }, // 31 s: off course; A must not play
        { kind: 'fix', fix: fixAt(40, 560, 0) }, // back on: A still in window, plays
      ],
    );
    const trace = run(sc);
    expect(names(trace[1]!)).toEqual([]);
    expect(names(trace[3]!)).toEqual(['offCourse']);
    expect(names(trace[4]!)).toEqual(['onCourse', 'play:A']);
  });

  it('marks a cut-past place missed instead of playing it late', () => {
    const sc = scenario(
      'cut-course',
      [{ id: 'A', triggerD: 500 }],
      [
        { kind: 'fix', fix: fixAt(0, 0) },
        { kind: 'fix', fix: fixAt(100, 300) },
        { kind: 'fix', fix: fixAt(200, 900) }, // GPS gap: past 500+150
      ],
    );
    const trace = run(sc);
    expect(names(trace[2]!)).toEqual([]);
    const rt = new TourRuntime(sc.route.lats, sc.route.lons, sc.places, sc.settings);
    for (const s of sc.steps) if (s.kind === 'fix') rt.update(s.fix);
    expect(rt.outcome('A')).toBe('missed');
  });

  it('never walks more than 100 m backwards on GPS noise', () => {
    const sc = scenario(
      'backward-noise',
      [],
      [
        { kind: 'fix', fix: fixAt(0, 0) },
        { kind: 'fix', fix: fixAt(100, 1000) },
        { kind: 'fix', fix: fixAt(101, 700) }, // a 300 m jump back
        { kind: 'fix', fix: fixAt(102, 1010) },
      ],
    );
    const rt = new TourRuntime(sc.route.lats, sc.route.lons, sc.places, sc.settings);
    rt.update(sc.steps[0]!.kind === 'fix' ? (sc.steps[0] as { fix: Fix }).fix : (null as never));
    rt.update((sc.steps[1] as { fix: Fix }).fix);
    const dAfterSecond = rt.dNow();
    rt.update((sc.steps[2] as { fix: Fix }).fix);
    expect(rt.dNow()).toBeGreaterThanOrEqual(dAfterSecond - 100);
    run(sc);
  });

  it('a second lap of the same loop keeps dNow moving forward', () => {
    // A ~445 m square loop run twice: the route repeats the same coordinates.
    const sq: [number, number][] = [
      [57.7, 11.97],
      [57.701, 11.97],
      [57.701, 11.9719],
      [57.7, 11.9719],
    ];
    const lap: [number, number][] = [...sq, sq[0]!];
    const twice = [...lap.slice(0, -1), ...lap];
    const route = { lats: twice.map((p) => p[0]), lons: twice.map((p) => p[1]) };
    // One lap ≈ 2 × 111.2 + 2 × 113 ≈ 448 m. A place on the second lap only.
    const lapLen = 2 * 111.195 + 2 * 111.195 * Math.cos((57.7 * Math.PI) / 180) * 1.9;
    const sc = scenario(
      'loop-second-lap',
      [{ id: 'L2', triggerD: lapLen + 60 }],
      [
        // First lap: pass the same ground; L2 must stay quiet.
        { kind: 'fix', fix: { t: 0, lat: 57.7, lon: 11.97 } },
        { kind: 'fix', fix: { t: 30, lat: 57.7005, lon: 11.97 } },
        { kind: 'fix', fix: { t: 60, lat: 57.701, lon: 11.9705 } },
        { kind: 'fix', fix: { t: 90, lat: 57.7005, lon: 11.9719 } },
        { kind: 'fix', fix: { t: 120, lat: 57.7, lon: 11.971 } },
        // Second lap begins: the same physical spots, larger d.
        { kind: 'fix', fix: { t: 150, lat: 57.7003, lon: 11.97 } },
        { kind: 'fix', fix: { t: 180, lat: 57.7009, lon: 11.97 } },
      ],
      DEFAULT_RUNTIME_SETTINGS,
      route,
    );
    const rt = new TourRuntime(route.lats, route.lons, sc.places, sc.settings);
    const ds: number[] = [];
    const all: string[] = [];
    for (const s of sc.steps) {
      if (s.kind !== 'fix') continue;
      all.push(...names(rt.update(s.fix)));
      ds.push(rt.dNow());
    }
    // d never collapses back to the first lap.
    for (let i = 1; i < ds.length; i++) expect(ds[i]!).toBeGreaterThan(ds[i - 1]! - 100);
    // The second-lap place played on the second pass, not the first.
    expect(all).toContain('play:L2');
    expect(ds[1]).toBeLessThan(100);
    expect(ds[6]).toBeGreaterThan(lapLen);
  });
});

describe('case export for the Java replay', () => {
  it('writes runtime-cases.txt with the golden traces', () => {
    const lines: string[] = ['# generated by packages/core/test/runtime.test.ts — do not edit'];
    for (const sc of scenarios) {
      const rt = new TourRuntime(sc.route.lats, sc.route.lons, sc.places, sc.settings);
      lines.push(`case ${sc.name}`);
      lines.push(
        `settings ${sc.settings.offCourseM} ${sc.settings.offCourseSec} ${sc.settings.triggerWindowM} ${sc.settings.dropAfterM} ${sc.settings.maxBackwardM}`,
      );
      lines.push(
        `route ${sc.route.lats.map((lat, i) => `${lat.toFixed(7)},${sc.route.lons[i]!.toFixed(7)}`).join(' ')}`,
      );
      for (const p of sc.places) lines.push(`place ${p.id} ${p.triggerD.toFixed(3)}`);
      for (const s of sc.steps) {
        const events = s.kind === 'fix' ? rt.update(s.fix) : rt.clipEnded();
        const evs = names(events).join(' ');
        if (s.kind === 'fix') {
          lines.push(
            `fix ${s.fix.t} ${s.fix.lat.toFixed(7)} ${s.fix.lon.toFixed(7)} -> ${evs}`.trimEnd(),
          );
        } else {
          lines.push(`end -> ${evs}`.trimEnd());
        }
      }
      lines.push('endcase');
    }
    const dir = join(__dirname, '..', '..', '..', 'android', 'runtour', 'test');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'runtime-cases.txt'), lines.join('\n') + '\n');
    expect(scenarios.length).toBeGreaterThanOrEqual(6);
  });
});
