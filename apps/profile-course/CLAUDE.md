# Profile Course – race-profile course generator

A client-only static web app: upload a race GPX, pick a start point and radius, get a runnable
course nearby whose elevation profile matches the race. Full plan in `docs/build-plan.md` —
read it before starting a new phase.

## Architecture

- **Client-only** (HTML + TypeScript + Web Worker), no backend, no API keys. Hosted as static files.
- **UI layer** (main thread) talks to the **search worker** via typed `postMessage`
  (`src/shared/messages.ts`); never does heavy computation.
- **Map**: Leaflet with OSM raster tiles.
- **Data sources** (all free, CORS, no key): Overpass API (runnable ways + surface tags),
  Terrarium terrain tiles on AWS (elevation, decode `(R*256 + G + B/256) - 32768`),
  Open-Meteo elevation as fallback.
- **Cache**: IndexedDB (`idb-keyval`) for Overpass responses (rounded centre + radius) and DEM
  tiles (z/x/y).

## Data pipeline (per search, steps 2–4 cached)

1. Parse GPX → `TargetProfile { totalDistance, samples (25 m, relative to start), totalGain,
   totalLoss, gradientHistogram }`. 5-sample moving median before resampling.
2. Overpass query for runnable highways within radius (footway, path, track, cycleway,
   residential, living_street, unclassified, tertiary, service, pedestrian, steps, bridleway;
   exclude `access=private|no`, `foot=no`).
3. Build graph: nodes = shared OSM nodes + way endpoints; edges store length, geometry,
   surfaceClass (paved/gravel/trail/unknown), penalty, elevation every 25 m. Drop components
   not connected to the start, then prune dead-end subtrees (cul-de-sacs, driveways) — Leo
   explicitly wants no in-and-back-out detours. Surface mismatch uses a cost matrix where
   paved↔gravel ≈ 0.1 (near-equivalent for a runner) but paved↔trail = 1.0.
4. Sample elevation per edge from DEM tiles, bilinear, **raw — no median smoothing**. The
   median belongs to GPX, where it removes barometric spikes; the DEM is already smooth. An
   edge is a street between two junctions, and most are 25–50 m, so a 5-wide window spanned
   the whole edge and flattened it to a single value — on the test graph that lost four fifths
   of the real relief (469 m of edge-local gain down to 83 m) and moved edge-end heights by 3 m
   on average, 56 m at worst, with a shared junction coming out at a different height depending
   on which edge was asked.
5. Snap start to nearest graph node within 100 m.

The radius is a **start/finish zone only** (Leo's decision): courses may go arbitrarily far
outside it. The network is fetched at `radius + targetLength/2` (capped 15 km); nodes inside
the user radius form a valid-end mask, and search states are Dijkstra-pruned when they can no
longer reach a valid end within the length budget.

## Matching algorithm

Score (lower = better) on 25 m samples:
`S = w_e·RMSE + w_g·gain/loss error + w_h·EMD(gradient histograms) + w_s·surfaceMismatch
+ w_p·penalties + w_r·repeatFraction`, weights `1.0 / 20 / 10 / 15 / 30 / 10` (debug-tunable).

Plus a confinement term: a course should reach at least 0.15 × its length away from its start
(a plain loop manages 0.32). Laps spaced more than the 1 km oscillation window apart are free to
the repeat term's eye and were invisible to the beam's partial rank entirely, which is how "the
circles in the cemetery" kept coming back — a dense patch of paths can fake any distance and any
profile. The beam now carries each state's reach from its own root and ranks on it, so laps lose
while they are being built rather than after scoring, when the whole beam already laps.

The corridor cells (~14 m, fine enough to keep opposite sidewalks distinct) also catch a lap that
comes back round on a *parallel* path — a twin bike/foot path, the next aisle of a cemetery.
Reuse within the 1 km oscillation window is a bounce or a tight circle; beyond it, it is a lap,
and counts as repeated ground. Without that, a course could re-climb the same hill for free and
manufacture the target's total gain instead of matching its features, which Leo wants always
discouraged.

The local-shape term is the RMS over 500 m windows of offset-corrected RMSE, not the worst
window. With a max, a course that had already ruined one stretch got every other stretch free,
so it could swap the race's one long climb for a sawtooth of small hills the whole way round and
pay only once — and the gradient histogram cannot object, because eight 4 % bumps and one 4 %
climb are the same distribution. Squaring still lets one awful window dominate a course that is
merely approximate throughout. Weight 9 (was 6, which the RMS aggregate would have softened by
about a quarter): Leo wants local similarity to outrank matching the totals, accepting that
where the terrain has no matching climb the course now under-delivers the race's gain rather
than faking it.

- Phase 2 baseline: 2 000 seeded random walks, keep best 20, local improvement.
- Phase 3: beam search over `(node, 100 m bucket)` states, B = 200/bucket, Dijkstra pruning on
  reachability, k-shortest-paths window replacement (300–1 500 m, k = 5, two passes).
  B is a floor: start-anywhere subsamples the zone to at most 120 roots and widens the beam to
  16 states per root (capped at 10 × the asked-for effort), because one shared beam left each
  lineage barely a state and every start simply faked the profile in its own corner. That is
  why start-anywhere is the slow option, and it is labelled as such in the UI.
- Deterministic via user-visible seed; "Try another" increments it.
- Budget: graph build ≤ 2 s, search ≤ 8 s on a mid-range phone (R = 5 km, 21 km target).
  If over: halve B, double bucket size.

The bottom sheet has four stops — collapsed, middle, full (≈55 % of the screen, the default) and
tall (nearly the whole screen). The box itself is up to 94 vh; a stop pushes the surplus below the
screen edge, and a spacer inside gives the hidden part room to scroll.

## Conventions

- Heavy loops use typed arrays and plain `for` loops; no per-step allocation in the beam search.
- Everything in `src/search/` and `src/graph/` must run in the worker (no DOM access).
- Every network call: cache read first, timeout, retry (Overpass has a mirror fallback).
- Finish a phase → run `npm test` and `npm run lint` → commit with the phase name → next phase.
- Test fixtures live in `test/fixtures/` (3 real GPX races; add saved Overpass JSON + a terrain
  tile in phase 1).
- Dev server: `npm run dev` (binds 0.0.0.0 for phone testing in Termux).

## Phase checklist

- [x] **Phase 0 – Scaffold**: Vite + TS strict + Vitest + ESLint + Prettier; Leaflet map, tap
      sets start marker, radius slider draws circle; worker wired with typed messages.
- [x] **Phase 1 – Data in**: GPX parser + profile builder (tests on the three fixtures),
      Overpass client + cache, graph builder, Terrarium fetcher/decoder/sampler, edge
      elevation, start snapping. Terrarium URL verified:
      `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`.
- [x] **Phase 2 – First courses**: scorer (6 terms + tests), random-walk baseline, result panel
      with overlaid profile chart, GPX export.
- [x] **Phase 3 – Beam search**: Dijkstra, beam search (per-node dedup for diversity,
      same-bucket queue for short edges, incremental gain/loss in the partial score),
      Yen's k-shortest-paths local improvement, baseline selectable in the debug panel.
      Perf on a real phone graph still to verify in phase 5 testing.
- [x] **Phase 4 – Surface & options**: surface presets (road/gravel/trail/any), safety
      penalties/bonuses from tags (sidewalk, maxspeed, cycleway, foot=designated, lit),
      return-to-start (Dijkstra-pruned), distance override, km range, seed/Try another,
      shareable URL hash. The hash decides *everything about the result* — weights (sparse
      `name:value` pairs), vias + tolerance, effort, connectors, algorithm, traces checkbox —
      but stays short and readable: only what differs from its default is written, and a hash
      that carries `lat` (every shared link does) reads absence as the default, overriding the
      receiver's stored settings (2026-10-22). The hash is joined by hand, not by
      URLSearchParams.toString, which would percent-escape the , : ; in the via and weight
      lists that a fragment allows as-is. Past 100 chars (edited weights and vias sprawl) the
      plain form gives way to `#c=<base64url>` — a versioned binary pack (`src/ui/linkCodec.ts`,
      round-trip tests in test/linkCodec.test.ts) that decodes back into the plain params so
      the reader has one parsing path; below it, plain stays, because packing would shave only
      ~10 chars off a minimal hash and Leo wants simple links readable. Reproducibility still
      assumes the same GPX and the same map/trace data on the opening device; the manual's
      Sharing section says so.
- [ ] **Pre-built area graphs** (prioritised by Leo over Phase 5 — public Overpass servers
      proved unreliable even at 2 km): download/store an area once, search offline from it.
- [x] **Phase 5 (minus deploy)**: cancel button, offline-aware errors, PWA shell (manifest,
      icon, network-first/cache-first service worker, registered in prod builds only),
      gokartor.se layer switcher (`https://kartor.gokartor.se/Master/{z}/{y}/{x}.png` —
      note y/x order; usage terms not published, personal use). Deploy explicitly deferred
      by Leo.
- [x] **Via points**: must-pass markers (optional km each, adjustable ± window, pick-on-chart),
      enforced as a visit-order bitmask in the beam with reachability pruning; improve pass
      cannot remove a via. Resolution is point-to-segment, 25 m radius. The course visits the
      list in order: km-bearing vias sort by km *among themselves*, while a via without a km
      keeps its place in the list — visited somewhere between its neighbours, exactly when
      unimportant — and carries ↑/↓ buttons to change which neighbours (2026-10-21; they only
      swap positions, which cannot break the km order of the others). Each row is one flex line:
      a bold accent number matching the map marker (`.via-n` — coordinates said less), the km
      box, pick-on-chart, ↑/↓, ×. Reordering slides the rows (FLIP) with the view held still —
      the old anchor-scrolling that kept the edited row fixed is gone. The via tolerance lives
      in Advanced settings → Search, not in the via subgroup.
- [x] **Comparison GPX**: upload an own course, map-matched (connectors on, skip-ahead over
      gaps), scored like a generated course, with an Improve button.
- [x] **Editing mode**: persistent — pull the course where you want it, or tap a point then its
      destination, repeatedly until Exit editing. Exit (✕) and Undo sit over the map. Each
      reroute replaces an adjustable window (default ±600 m) of the *current* course, so edits
      chain. Both ends of the replaced stretch must lie *inside* the window, so the course either
      side of it keeps its exact shape and length; the stretch between them may well come out
      longer or shorter, which only shifts the km marks after it, and that is fine by Leo. The
      pair is chosen so the detour costs about what the stretch it replaces cost — a tighter pair
      spikes out to the point and straight back — with ties to the shorter stretch. The dragged
      point no longer has to be reached at the km that was picked, which was the old objective
      and is what let the splice wander outside the window. An edit is refused only when no node
      inside the window can reach the tapped point within the Dijkstra budget (4 × the window).
      The window is a **radius as well as a distance**: where the course laps, ground a long way
      round comes back within reach along the course, and replacing the stretch between two such
      nodes rewrote a whole lap nowhere near the drag. So the stretch runs out from the drag only
      until the course first leaves a `windowM` circle round it (the two nodes either side always
      count, since one edge can be longer than the radius). The drawn window and the rubber band
      follow the same rule, so the band never promises more than it keeps.
      Via points outrank edits: the window shrinks
      rather than route one away. **Every course carries its own path** — the edge indices it
      was built from, plus the recipe for the graph they index into (the four `ensurePrepared`
      arguments and the edge/node counts as a fingerprint). An edit sends that back, and the
      worker rebuilds the graph if it is not the one in hand; a graph is deterministic given the
      network response, which is cached in IndexedDB, so the rebuild costs no network.
      Map-matching a course we generated ourselves back to the graph is lossy — it rewrites the
      course wherever the match prefers another way through, anywhere at all, which is what used
      to change the course far outside the edit window after a tab switch or an undo. It was
      first fixed with a worker-side cache under an id the course carried, but an id dies with
      the worker, so after a reload every restored course fell back to matching and the match
      threw ("could not follow the course near km 20.2") — the whole tab strip became
      uneditable. Matching is now the fallback only: geometry we never produced (an uploaded
      course), or a rebuild that is unavailable (offline, Overpass down — then whatever graph is
      in hand is matched against rather than refusing) or that comes out a different size,
      meaning OSM has changed under the course.
      While pulling, the grabbed point follows the finger with translucent straight legs to the
      two points the edit leaves in place (onthegomap-style); the course snaps to the routed
      result on release. A translucent box can also outline the window (off by default).
      The **wheel while the point is still held** resizes that window, ×1.25 a notch away from
      the user and ×0.8 towards, rounded to 50 m and clamped to the panel's 100–3000 m. The box
      is shown for the length of the gesture whether or not the checkbox is on, the rubber
      band's two ends move with it, and the new size is said in the pill over the point — so the
      reach is judged against the map rather than guessed from a number in the panel. The map's
      own wheel zoom is switched off for the length of a pull, since the gesture owns the wheel.
      Node edits have no window (they reach to the two neighbouring junctions and no further),
      so the submode leaves the wheel to the map.
      **Picking which pass.** A tap resolves to a course point by pixels alone, so the two passes
      of a stretch the course covers twice used to collapse to whichever was a hair nearer, and
      one of them was simply unreachable. Two ways in now, both keeping the plain tap and pull
      untouched: *holding* a point where the course passes more than once offers each pass in
      turn every 2 s, with the km and "pass n of m" in a pill *above the point itself* (the eye
      is on the point, not on the status bar at the side) and a short vibration on
      each switch, and the drag or release then means the pass last offered — crossing the drag
      threshold stops the cycling, so a pull is never stolen by a switch mid-gesture. Passes are
      told apart by index gap among the grab points (≥ 8 apart is a second pass, closer is one
      pass, a hairpin included), because the map layer knows pixels, not distances. Second way:
      scrubbing the profile chart and *letting go* picks that distance as the edit's origin, the
      same commit-on-release as a via marker, and the map is then armed for the destination tap.
      The chart's samples sit at exactly 25 m while the export points sit at 25–50 m, so the
      marker is found by cumulative distance, never by the same index. Holding a *multi-pass* dot
      in node submode therefore cycles instead of marking, which means such a dot cannot join a
      batch delete — known gap, deliberate.
      **Node submode**
      ("Nodes" in the edit bar) treats course nodes as waypoints, ignoring the score entirely:
      every junction is drawn as a dot, a pull moves that node, a tap on a dot deletes it, a pull
      on the course *between* two dots adds a node on that leg (the rubber band hangs from the
      two dots either side), and a tap away from the course adds one on the leg whose geometry
      passes nearest the tap.
      Reconnection is by shortest path *excluding the old node*, so the course visibly stops
      going there (falling back to routing through it only when that is the sole connection); an
      out-and-back spur drops both legs. Nothing outside the two touched legs ever moves, and the
      start/finish cannot be moved or deleted this way. Distances along the course are cumulative
      haversine, never index × 25 m: each edge spreads its own samples, so the step is 25–50 m.
      *Holding* a dot marks it red instead of pulling it and reveals a Delete button; several can
      be marked, and they go in one edit, because deleting them one at a time would route each
      reconnection through the next node about to go. Neighbouring marked nodes are bypassed as
      one run, by a single shortest path excluding all of them, and every run's way round avoids
      every marked node, not just its own — otherwise a node the user marked came back on the
      course by the side door, as another run's detour. On a tight network that can leave no way
      round at all, and then the batch is refused rather than half done. Tapping a marked dot releases it;
      Esc backs out exactly one step, innermost first: a pull in progress or a half-finished
      two-tap edit (dropped with the course untouched, still in editing mode), then the marks,
      then node submode, then editing itself. Editing feedback also shows in a
      pill over the map, because the sheet may be collapsed — and on desktop that pill, the edit
      bar and the via bar all start beside the left panel, not over it.
      **A refused edit says why**, in the pill *after* the re-arm — the re-arm would otherwise
      talk over the reason with its own invitation, which left every refusal looking like
      nothing had happened at all. If the worker no longer held the course's path and had to
      match it back to the network to edit it, the refusal says that too: a lossy match is a
      likelier reason for it than the window being too tight.
      A pull also used to take the page's text with it. Leaflet exempts only tiles and marker
      icons from selection, so a pull could mark the tooltips, the controls and on into the
      panel, and the next press then dragged the selection instead of the course (and a native
      drag cancels the pointer, so the edit was dropped). The map is now `user-select: none`,
      and taking a pull clears the selection and preventDefaults the press. A via marker under
      the press keeps its own drag.
- [x] **Multiple candidates**: a search offers up to 4 courses, each from a search of its own.
      Picking them out of one search's runners-up gave four near-copies leaving by the same
      street (on the test fixture the runners-up sit at 0.88–1.00 edge overlap with the winner),
      so every run after the first costs the previous courses' edges like unpleasant ground —
      a nudge, not a ban, since a park with one entrance still has to be enterable — and, when
      the start may be anywhere in the zone, drops start nodes within 300 m of one already used.
      A run whose winner still covers >0.8 of a course already offered is thrown away rather
      than shown as a false alternative. The runs are sequential, so tabs fill one at a time:
      an unfilled tab shows its own search's percentage and cannot be clicked, and `coursesDone`
      closes the ones nothing was found for. Run 0 is untouched by all this — it is the same
      search, improved from the same full candidate list, as before (picking before improving
      made the winner measurably worse, because improvement reorders the top candidates) — so
      the first course lands no later than it used to. The tabs are a strip of browser tabs dropping
      from the top of the window over the map, labelled with the mismatch: the shown one is
      accent filled, hangs lower and overlaps the tabs either side of it with a drop shadow, a
      course that has arrived but is not shown sits shorter and greyer as if
      behind it, and one still being searched for spins a ring beside its percentage — so the
      strip says what is ready without being read. The strip itself is `pointer-events: none`
      so the map stays usable between tabs, and it publishes its height as `--tab-strip-h`,
      which pushes the edit/via bars and the status pill down. 1–9 selects, and the arrows walk the strip
      once a tab has focus. Switching leaves editing mode; every tab carries its own path, so an
      edit lands on the course on screen. An edit, undo or improve rewrites the shown
      tab in place. The whole strip survives a reload (every course is persisted, with which one
      was shown); only the shown course goes into the URL hash. A restored strip whose courses
      predate them carrying their own path is dropped on load — such a course can only be
      map-matched to be edited, and a tab that cannot be edited is not worth keeping. The GPX and
      the settings stay, so it is one Search away.
- [x] **Hover readout** (onthegomap-style): with the mouse within 18 px of the course, a
      translucent point follows it along the line with a pill above reading distance, height
      above sea level and gradient. It tracks the nearest *leg* and interpolates along it, not
      the nearest point — export points are 25–50 m apart and a readout that hops between them
      does not read as following the course. The gradient is taken over ±50 m for the same
      reason the course is: one step of a ~30 m DEM grid is as much noise as slope. Mouse only
      (a finger has no hover, and on touch the course is for pulling), suppressed while a point
      is being pulled, and on its own marker and tooltip so it never clobbers the editing ones.
      **The two hovers answer each other**: the chart has always marked the map, and the map now
      moves the chart's crosshair too, so a hill can be found from either side. The crosshair a
      map hover puts up is not a scrub — it sets no pick — or letting go over the chart
      afterwards would commit a distance the user never chose while editing.
**Strava, Garmin and public GPS traces were built and then removed** (Leo's call, 2026-10-20).
A Strava/Garmin section adds nothing: both services export GPX, and loading a downloaded GPX is
already the main way in. Their APIs cannot close that gap from a client-only app anyway —
Strava's token exchange needs a client secret with nowhere to keep it, Garmin has no consumer
API, and the heatmap's tiles are CloudFront-signed per account, so the URL would have to be
pasted from the user's own browser and re-pasted when it expired. The OSM public trace overlay
went with it: the traces are every mode of travel, cars included, so "people go here" says
nothing about whether people *run* here. Do not re-add any of it without a source that
distinguishes running from driving.

- [x] **Where people actually run** (the one part of that kept, on Leo's call 2026-10-20; the
      panel heading is now simply "GPS traces"): the
      **raw trackpoints API** under its own advanced sub-heading inside Offline areas, with an
      unticked-by-default checkbox in Advanced settings and a note that it takes a long time.
      What makes it answer the objection above is the **pace filter**: within a `<trkseg>`,
      consecutive points 1.5–5.5 m/s apart (3–11 min/km, ≤ 60 s between them) are kept and the
      rest dropped, so cars and walkers go. Untimed points go too — public-visibility traces come
      back stripped of their clock *and* their order, so there is no telling a run from a commute
      in them. On a real Gothenburg box that leaves 1 400 of 5 000 points.
      `api.openstreetmap.org/api/0.6/trackpoints?bbox=…&page=N` hands out 5 000 points a page,
      so the circle is tiled into ~2 km boxes (also under the 0.25 deg² bbox cap) and each is
      paged until a short page, strictly sequentially — we are a guest on that API. Hence the
      warning in the UI; the search's Cancel stops it, and then nothing is saved.
      The kept points become counts per **~14 m cell, the same grid the corridor/repeat detector
      uses** — `cellIdAt` in `src/graph/cells.ts` is now the single packing both share, `| 0`
      included, because the edges hold their cells in an Int32Array and the product overflows:
      a producer that did not wrap identically would never match an edge's cell. The grid is
      dilated by one cell when applied, since a consumer GPS lands beside the path as often as
      on it. Every graph gets `edge.traced` attached after the elevation pass (coverage is free
      to carry; it is the weight that the checkbox turns on, and `untracked` defaults to 0), and
      the beam ranks on it as well, since the final score only reorders what the beam survived.
      **Ground no download covers reads as unrun on purpose**: if it were free instead, the
      search would be pulled straight out of the area that was downloaded.
      **The weight is 5, benchmarked** (`bench/traceWeight.ts`, sweep 0/5/10/20/40 over 3 seeds
      on a real 2 km Gothenburg graph, every course rescored at `untracked: 0` so the totals are
      comparable). Traces covered 4 421 of 22 197 edges, and preferring that fifth makes courses
      lap it: out-and-back 42.8 → 44.7 → 48.1 → 50.8 → 56.1 and repeats 2.2 → 6.8 at 20, while
      the unrun fraction sat at 80/78/80/74 % — the term buys almost no coverage until 40, which
      reaches 33 % unrun only by wrecking local shape (20.0 → 27.0) and the profile itself. So 5
      is a tie-breaker between otherwise similar ways, exposed as the "Unrun ground" weight in
      Advanced settings; don't raise it without trace coverage far denser than a fifth.

**Keyboard shortcuts** live in one list, `SHORTCUTS` in `src/ui/shortcuts.ts`, rendered into both
the `?` dialog and a subgroup of Advanced settings — a phone has no `?` to press, so the panel is
the only place the list can be read there. Each letter stands in for a control and does nothing
when that control is unavailable (`G` only with a course to download, `N` only while editing), so
the shortcut cannot reach a state the buttons cannot. Ctrl/⌘ Z is the only one that keeps a
modifier, and it is scoped to editing mode because `exitEditing` drops the history anyway. Enter
means Find course only where nothing else answers it (`enterIsFree`): on a button, a summary, a
link or a file input it would steal the panel's own keyboard use. With a dialog up, every key
but Esc and `?` is swallowed rather than acting on a course the user cannot see.
The arrows walk the course strip from anywhere **except over the map**, where Leaflet pans with
them. They first asked for the focus to be inside the strip, as a tablist conventionally would,
and so never worked: selecting a course rebuilds the strip, so the click or number key that chose
one destroyed the very button the arrows wanted focused. They also step over a tab still being
searched for, since such a tab cannot be shown. `renderCourseTabs` now *reuses* its buttons when
only their state changed (same reason, plus switching tabs morphs via CSS transitions — a fresh
element has no old style to transition from).

Panel sections (Offline areas, Advanced settings) are `details.section`, pressed into the panel
rather than printed on it (Leo's spec 2026-10-20): the summary is a full-width header row in the
panel's own surface, ruled off edge to edge above and below, with a large chevron; the contents
sit in a `div.section-body` a step apart in colour behind an inset shadow. The panel itself is
dark grey, not black — `--panel-bg`/`--section-bg`/`--edge` are `light-dark()` custom properties
on `:root`. Opening animates via `::details-content` block-size + `interpolate-size:
allow-keywords`; browsers without it open instantly, styled the same (the `.section-body`
wrapper exists so the styling never depends on `::details-content` support). Inside, the
controls sit in onthegomap-style `.subgroup`s — an uppercase grey HEADING sharing its row with
the dividing line, never collapsible — ordered: main = upload+Find on one row / chart / stats
/ match-race-section, then Course settings, Via points; Offline areas = Path network, GPS
traces (short hint in the panel, the full story behind an ⓘ dialog fed from a hidden `<p>` in
the HTML); Advanced = Search (algorithm…connectors), Your own course (the compare upload lives
here now), Weights, Editing; then a Documentation section
of its own (manual button, a colour Legend, Keyboard shortcuts — the last desktop-only via the
900 px media query, since a phone has no `?` key, which is why the list is in the panel at
all). Adjacent sections share their dividing line (`+` sibling margin −17px collapses the gap
to −1 px so the borders overlap). On desktop the panel casts a shadow onto the map. All buttons
and summaries show a pointer cursor and a hover effect — under `@media (any-hover: hover)`,
because on a phone the *primary* pointer is the touchscreen and plain `(hover: hover)` is false
even with a mouse attached; the ⓘ keeps its help cursor. Entering edit mode slides the edit
bar's buttons in staggered, left to right (CSS `nth-child` delays; showing the bar restarts
them because `hidden` flips display), and leaving plays the same stagger in reverse
(`slideOutRow` in `src/ui/animate.ts` — the bar is hidden only after the last button is out).
The accent is **pink `#c63d80`** (`--accent` / `--accent-deep #a62d68` on `:root`; Leo picked
pink 2026-10-20 over blue/raspberry/orange/yellow via a live tab audition — nothing on the map
tiles is pink — then muted it slightly from the `#db2777` that auditioned). It also colours the
zone circle (`map.ts`), both chart lines that are "the course's own" (`profileChart.ts`:
race-only line and the found course's line — the race goes grey once a course overlays it),
native controls via `accent-color` on `:root` (the weight/zone sliders especially), theme-color,
the manifest, the icon, and the start pin — an inline-SVG divIcon (`START_PIN` in `map.ts`,
drop-shadow via `.start-pin`); Leaflet's default blue marker pngs and the `_getIconUrl`
workaround went with it. Surface colours are *not* accent: paved stays blue. Subgroup headings
use `--accent-muted` — **pinned to a mix of the original `#db2777`**, because Leo wanted the
headings unchanged when the accent was muted. The dual-slider draws its track once on the
container (each input's own track is transparent — the upper input's track painted over the
lower knob). The chart scrub shows the map point in the *hover* look with the hover readout's pill
(`showCoursePoint(p, 'hover', label)`) and takes both down on release; the red `course-point`
look is only for an edit's picked origin. The chart's release handler must check `chartPick` itself — `onCommit` always
exists, so the chart keeps the point on every release and main.ts hides it when no pick was
armed. The tab strip is 12px
taller than the published `--tab-strip-h` (42px): transparent padding so the tabs' drop
shadows are not clipped to a hard edge by the strip's own overflow.

**One modal dialog** (`src/ui/dialog.ts`, built lazily, `openDialog/closeDialog/dialogOpen`)
serves the `?` shortcut list, every weight's ⓘ explanation (`src/ui/weights.ts`, tooltip on
desktop, dialog on tap) and the manual (`src/ui/manual.ts`, opened from the Documentation
subgroup). Each weight is a small number box synced to a slider (0–10 or 0–100); the box
accepts more and the slider then pegs — `collectWeights` still reads only the boxes, so the
sliders are pure UI. The untracked row greys out with its checkbox (`reflectUseTraces`).

**Draw your own profile** (Leo, 2026-10-21): an SVG drawing pad in the Your own course subgroup
(`src/ui/drawProfile.ts`). Grid scales come from two sliders — length 1–42.2 km (a marathon) and
elevation range ±20–400 m; the vertical slider is `writing-mode: vertical-lr` and
`touch-action: none` (its adjustment *is* a vertical gesture, so the global pan-y concession
would steal every drag). The knob starts on the centre line (the start's own elevation, always
0 — the profile is relative); pulling right draws 25 m samples, pulling left of it erases, and
climbs are clamped to MAX_GRADE 20 % — a vertical pull advances a step per move event, so the
cap shapes the ramp and sheer walls cannot be drawn. "Use as input" needs ≥ 1 km drawn, smooths the drawing first (two ±2-sample box-blur
passes, ~250 m — a staircase becomes rolling terrain) and goes
through `buildProfileFromSamples` (`gpx/profile.ts`) with turnsPerKm = 4 (a drawing says nothing
about turns), then the ordinary `setFullProfile` path; it also sets the Course distance input
explicitly, since `setFullProfile` only fills an empty one — stats, range slider, chart, persistence
and Find course cannot tell it from a GPX. `gpxLabel` becomes "Drawn profile" and the GPX file
input is cleared so the chooser does not claim a file that is no longer the target.

**Search generations** (replaced the earlier `awaitingCourses` gate after the 2026-10-21 code
review): `startSearch` increments `searchGeneration` and sends it; the worker adopts it
(`searchGen`), treats a search whose generation is stale as cancelled (`stale()` checked
everywhere `cancelled` was — a new `search` message must not revive a cancelled run or let two
searches share the module-level graph/startNode/validEnd, which search() now also captures into
locals), and echoes `gen` in every search-related reply; main drops mismatches. Cancel and
`clearResult` also bump the generation. Results pair with `searchProfile`/`matchedProfile`
captured at *send* time — activeProfile() may have moved by arrival — and `matched` is dropped
while a search runs. All per-tab indices use `picked.length` (a discarded run re-fills the same
tab; `run` drifts past it). Undo is disabled while `pendingEdit` (the history entry is
speculative; popping it before the reply loses the pre-edit course). Other review fixes:
corridor-repeat sample distance measured from the edge's start (was inflated by its own edge
length — 1 km boundary tests in test/score.test.ts pin it); connector splits of one segment
insert in projection-t order and copy way node lists before splicing (the response object is a
cache entry); GPX POINT_RE matches self-closing trkpts first (the wrapped alternative used to
swallow the next point); terrain tiles clear their `pending` entry on fetch failure (one
transient failure used to poison every later search) and are LRU-capped at 64; trace downloads
time out, rethrow 4xx, flag MAX_PAGES truncation, and save nothing on cancel; store payloads
write with `cacheSetOrThrow` *before* their index entry (quota failures surface instead of
listing an area whose blob never landed); offline areas carry a schema version (pre-version
entries grandfathered as v4); the beam's completion-gate slack derives from the penalty weight
and its dedup key from the via count. Follow-ups done the same day: preview ticks update in place
(`ChartHandle.updateCourse` rewrites both polylines' points without rebuilding the SVG or its
listeners, so the crosshair survives; `map.drawPreview` mutates one translucent accent polyline
via `setLatLngs`, taken down by drawCourse/clearCourse); `snapToNode` answers from a per-graph
64 m cell hash (WeakMap-cached) instead of scanning every node per ~80 m match waypoint;
Overpass retries back off per round, honour Retry-After (capped 60 s) and never sleep after the
final round; `loadTraceCounts` merges stored grids with max-per-cell, since overlapping
downloads fetched the same public traces. For item 11 the low-risk half-step was taken instead of
compaction: StateStore is flat growable typed arrays (`newStateStore`/`growStore`, capacity
doubling) — Int32/Int8 for the integer fields, Float64 for the rest so results stay
bit-identical, same `s.field[i]` indexing in the hot loop. Integer fields halve, everything
leaves the GC-scanned heap, growth is controlled doubling. Full mark-and-compact of
parent-pointer history (the only way to actually *free* dead states mid-search) remains
deliberately not done: it needs index remapping across parents/buckets/kept candidates, and a
missed reference silently corrupts a course — only attempt against a measured memory baseline
with bit-identical bench scores.

**Download-area prompt** (Leo, 2026-10-21): Find course over a start no saved area covers
(centre within `radiusMeters` of any `savedAreas` entry) opens a dialog offering the download
first. Download = fetch inside the dialog (mirrored to the Path network subsection), then close
+ search when the `areas` list lands; "Don't show again" = localStorage
`profile-course.skipAreaPrompt`, global; ✕/Esc/backdrop = suppressed for that start point only
(`areaPromptDismissedFor`, not persisted) and the search goes ahead — unless a download is
running, which a ✕ leaves running. `openDialog` gained an optional `onClose` fired on any close.
Ticking "unrun ground" with no trace download covering the start gets the same treatment
(2026-10-22): a dialog offers the traces download (radius select mirrored to the subsection,
"Don't show again" = `profile-course.skipTracesPrompt`); ✕ just closes — the tick stays, there
is no search to go ahead with, and the subsection's button carries the progress.

**Live search preview** (Leo, 2026-10-21): while a search runs, its best candidate so far shows
faded on the map and as a translucent line on the chart, turning solid when the course lands.
The beam's `onProgress` gained a fourth argument, `leader` — the top-ranked *partial* path
(`bucket[0]` after the rank sort, `reconstruct`ed per bucket; cheap, and strictly outside the
expansion loop). The worker streams one `bestSoFar { index, segments, samples, score }` per run:
a complete candidate always beats a partial (posted on improvement only, so nothing flickers
between improvements), partials are time-throttled to one per 200 ms and carry
`assembleCourse(...).samples` for the chart. Main stores previews per tab
(`candidatePreviews`) and only paints the tab on screen; a spinner tab is clickable once its
run has started (only true-0 % tabs stay disabled — they have no search behind them yet), and
entering one shows the preview with the result panel hidden. `coursesDone` and Cancel fall back
to course 1 if the watched preview's run never delivered. Previews are never persisted. The
early preview jumps around as leads change — deliberate, it is honestly what the beam is
considering. The improvement pass streams too (`improveCandidates`' `onProgress(fraction,
current)`): each runner-up shows as it is being polished, `courseProgress` walks 0.9→1.0 and the
"improving" stage 0.92→0.99 instead of sitting silent at 92 %. Two perf fixes went in with it
(2026-10-21): the scan recomputes `pathNodes`/cumulative lengths only when a window was actually
replaced (was once per window — quadratic in course length), and Yen's k-shortest-paths answers
are cached per improve call keyed on `(from,to,⌊windowLen⌉)` — valid because they depend only on
the static graph, and later passes rescan mostly unchanged windows. `scanOnce` now also yields
every 8th window so Cancel can reach the worker mid-pass (not every window: the chained-timer
clamp of 4 ms would cost more than it buys). Remaining known lever if improve is still slow:
incremental scoring of a spliced window instead of `assembleCourse` over the whole course per
alternative — a bigger, riskier refactor, not done.

**Course actions are icon buttons on the map** (`#map-buttons`, right edge under the zoom
control, 30 px like the zoom buttons, with the same 8 px step to the zoom control as between
themselves — top 52 px as measured against the real phone, not the computed Leaflet height).
The buttons sit *below* the sheet's z-index: whatever the sheet covers, it covers. When it is
pulled to its `tall` stop, a `sheet-tall` class on `body` (set by `initSheet`'s `onLevel`
callback) slides 🔗 and 🎲/↻ up into a row beside the zoom control, in the strip the sheet
cannot reach; ✎ (`.map-edit`) stays behind the menu — editing needs the map anyway, and three
buttons up there crowded the course tabs: ✎ edit (aria-pressed while editing), 🔗 copy link (prompt() fallback — clipboard needs
a secure context and phone testing runs over plain http), 🎲 try another / ↻ improve. "Try
another" draws a *random* seed (no seed is better than any other), and the seed field has its
own 🎲. Search progress prints in `#start-hint`, not the Find button, which now shares a row
with the GPX chooser and is too small for it. GPX download flips the button to "Saved ✓" for
2 s because Chrome on Android saves without a word. Cancelling a search drops the unfilled
spinner tabs. `setStart` centres on the *visible* map: `createMap` takes an `obscured()`
callback and pans by half the sheet's cover (its top edge on a phone, its right edge on
desktop).
