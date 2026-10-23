# Race-profile course generator – build plan for Claude Code

Oct 14, 2026 · @Leo

## Goal and feasibility

Build a web app that takes a race GPX, a start point and a search radius, and returns a runnable course nearby whose elevation profile matches the race as closely as possible. Surface type is a secondary match criterion. This is buildable as a single static web app with no backend, because all three inputs it needs are freely available to a browser: the road/path network from OpenStreetMap, elevation from open DEM tiles, and surface tags from the same OSM data.

What the user sees: a map, an upload button, a tap-to-set start marker, a radius slider, and a target distance derived from the GPX. After a few seconds of searching, the app shows the proposed course on the map, the two elevation profiles overlaid, a match score, a surface breakdown, and a Download GPX button.

Definitions used throughout this plan:

- **Target profile**: the race GPX reduced to elevation (m) as a function of distance (m), resampled every 25 m, with the start elevation set to 0.
- **Course**: a sequence of connected OSM way segments inside the radius, starting at the chosen point and ending anywhere inside the radius (optionally back at the start).
- **Match score**: how close the course's profile is to the target profile; lower is better. Defined in the algorithm section.

Scope of version 1: one GPX in, one best course out, GPX export. Not in scope: user accounts, saving courses server-side, live tracking, turn-by-turn navigation.

## Architecture

Decision: a client-only static web app (HTML, TypeScript, Web Worker), hosted as static files. No server, no database, no API keys required for the baseline. This keeps development in Termux simple (one `npm run dev`), hosting free (GitHub Pages or Cloudflare Pages) and the app usable on any phone browser.

Components and what calls what:

1. **UI layer** (main thread): map, controls, result panel. Talks to the worker via `postMessage`; never does heavy computation.
2. **Map**: [Leaflet](https://leafletjs.com/) with OSM raster tiles. Chosen over MapLibre GL for smaller bundle and simpler touch handling; switch only if vector styling is needed later.
3. **GPX parser**: reads `<trkpt>` (fallback `<rtept>`), computes cumulative distance with the haversine formula, resamples elevation every 25 m. If the GPX has no `<ele>`, elevation is fetched for it from the same DEM source as the graph so both profiles share one elevation model.
4. **Graph fetcher**: one Overpass API query for all runnable ways inside the radius; builds an in-memory graph (nodes, edges with length, surface class, and an elevation sample every 25 m).
5. **Elevation sampler**: fetches DEM tiles once per tile, decodes them, and answers bilinear lookups for any lat/lon.
6. **Course search** (Web Worker): the matching algorithm; emits progress and the best-so-far course so the UI can show improvement live.
7. **Exporter**: writes the course as a GPX route/track with elevation, plus a short name and the match score in `<desc>`.
8. **Cache**: IndexedDB for Overpass responses (keyed by rounded centre + radius) and DEM tiles (keyed by z/x/y), so repeated searches in the same area are instant and offline-tolerant.

External data sources (all free, browser-callable, no key):

| Need | Source | Notes |
| --- | --- | --- |
| Road and path network, surface tags | [Overpass API](https://overpass-api.de/) | Public endpoints allow CORS. Query ways with `highway` in footway, path, track, cycleway, residential, living\_street, unclassified, tertiary, service, pedestrian, steps (penalised), bridleway. Exclude motorway, trunk, primary and `access=private`/`foot=no`. Respect fair-use: one query per search, cached. |
| Elevation | [Terrarium terrain tiles on AWS Open Data](https://registry.opendata.aws/terrain-tiles/) | PNG tiles, elevation = (R×256 + G + B/256) − 32768. Use zoom 13–14 (about 10–20 m/px in Sweden). No key, no rate limit, CORS enabled. Verify the current URL pattern before coding. |
| Elevation fallback | [Open-Meteo elevation API](https://open-meteo.com/en/docs/elevation-api) | 100 points per request, no key. Use only if tiles fail. |
| Base map | OSM standard tiles or a CARTO basemap | Check tile-usage policy; attribution required. |

Optional later upgrade: a small Python or Node backend that pre-builds the graph for a city and serves it as one gzipped file, to cut first-search latency. Not needed for v1.

## Data pipeline

Every search runs the same five steps; steps 2–4 are cached so only the first search in an area is slow.

1. **Parse the GPX** → `TargetProfile { totalDistance, samples: Float32Array(elevation at every 25 m, relative to start), totalGain, totalLoss, gradientHistogram }`. Smooth raw elevation with a 5-sample moving median before resampling to remove GPS spikes. Store `totalDistance` as the default target length; let the user override it (for example run 10 km of a half-marathon profile).
2. **Fetch the network** from Overpass: `(way[highway~"^(footway|path|track|cycleway|residential|living_street|unclassified|tertiary|service|pedestrian|steps|bridleway)$"][access!~"private|no"][foot!=no](around:R,lat,lon);); out body; >; out skel qt;`. Expect 20–80k nodes for R = 5 km in a city; parse into typed arrays.
3. **Build the graph**: nodes = OSM nodes shared by two or more ways plus way endpoints; edges = the way geometry between such nodes. Each edge stores length, forward/backward geometry, `surfaceClass` (paved / gravel / trail / unknown, derived from `surface`, `tracktype`, `highway`), a `penalty` (steps, busy tertiary roads, tracks tagged `tracktype=grade4/5`), and `elev: Float32Array` sampled every 25 m along the edge. Drop components not connected to the start node.
4. **Sample elevation** for every edge's 25 m points and for the start. Request tiles in batch, decode once into a `Float32Array` per tile, bilinear-interpolate. Smooth per edge with the same median filter as the GPX so both sides see the same noise level.
5. **Snap the start** to the nearest graph node within 100 m; tell the user if none is found.

Surface mapping (first match wins):

| OSM evidence | Class |
| --- | --- |
| `surface` = asphalt, paved, concrete, paving\_stones, sett | paved |
| `surface` = gravel, fine\_gravel, compacted, pebblestone | gravel |
| `surface` = dirt, earth, ground, grass, mud, sand, wood, unpaved or `highway=path` without `surface` | trail |
| `highway` = residential, living\_street, tertiary, unclassified, service, cycleway, footway without `surface` | paved |
| `highway=track` without `surface` | gravel |
| anything else | unknown |

The target's surface is not in the GPX. The user picks a desired mix per course (for example 100 % paved for a road race, or 60/40 gravel/trail) and the app scores against that; default is 100 % paved.

## Matching algorithm

The search is a beam search over (node, distance covered) states, scored incrementally against the target profile, with a cheap random-walk baseline shipped first so there is always a working result to compare against. Finding an optimal path of a fixed length with a shape constraint is NP-hard in general, so the goal is a good course in under 10 s on a phone, not a provably best one.

**Score** of a course (lower is better), computed on the 25 m samples:

```latex
S = w_e \cdot \mathrm{RMSE}(e_c - e_t) + w_g \cdot \frac{|G_c - G_t| + |L_c - L_t|}{G_t + L_t} + w_h \cdot \mathrm{EMD}(h_c, h_t) + w_s \cdot \mathrm{surfaceMismatch} + w_p \cdot \mathrm{penalties} + w_r \cdot \mathrm{repeatFraction}
```

- `e_c, e_t`: course and target elevation relative to their own start, compared at the same distance. This is the primary term; it makes the climbs land in the same place.
- `G, L`: total gain and loss. Keeps the overall hilliness right even when the RMSE term is fooled by an offset.
- `h`: histogram of gradients in 2 % bins; EMD (earth mover's distance) rewards similar steepness distribution. Matters because a 6 % hill and a 2 % drag of equal height train differently.
- `surfaceMismatch`: fraction of distance whose class differs from the requested mix.
- `penalties`: distance on steps, busy roads, grade4/5 tracks.
- `repeatFraction`: distance on edges already used in this course. Not forbidden (laps of a hill are legitimate) but discouraged.

Starting weights `w_e=1.0 (per metre), w_g=20, w_h=10, w_s=15, w_p=30, w_r=10`; expose them in a debug panel so they can be tuned on real courses.

**Baseline (phase 2)**: 2 000 random walks from the start, each step choosing a neighbour with probability weighted by how well the edge's elevation change matches the target's change at the current distance, stopping within ±3 % of the target length. Keep the 20 best by score, apply the local improvement step below, return the best. Good enough to validate the whole pipeline end to end.

**Beam search (phase 3)**:

1. Discretise distance into 100 m buckets. A state is `(nodeId, bucket)`; keep at most `B = 200` states per bucket (the beam), ranked by partial score.
2. Expand bucket by bucket. For each state, push every outgoing edge whose end lands in a later bucket; partial score = parent score + the RMSE contribution of this edge's samples + penalties + repeat cost. Gain/loss and histogram terms are added only at the end since they are not decomposable per edge.
3. Prune states that can no longer end inside the radius: precompute Dijkstra distance from every node to the nearest node inside the radius (zero for nodes inside). With the return-to-start option on, use distance to the start node instead and require `coveredDistance + distanceBack <= targetLength × 1.03`.
4. Among states in the final buckets (target length ±3 %) that satisfy the end constraint, compute the full score; keep the best 20.
5. Local improvement: for each of the 20, try replacing a 300–1 500 m window with an alternative path of similar length (k-shortest-paths between the window's endpoints, k = 5) and accept any change that lowers the score. Two passes.
6. Return the best; stream the best-so-far to the UI after each bucket so the user sees it converge.

Determinism: seed the random walk and tie-breaks from a user-visible seed so a result can be reproduced and a "try another" button just increments it.

**Performance budget**: graph build ≤ 2 s, search ≤ 8 s on a mid-range Android phone for R = 5 km and a 21 km target. If the beam exceeds this, halve `B` and double the bucket size before anything else.

**Validation**: unit-test the scorer against hand-made profiles (flat vs flat = 0; a profile vs itself shifted 100 m = small; vs its mirror = large). Integration-test on real courses in Gothenburg: the [Göteborgsvarvet](https://www.goteborgsvarvet.se/) half-marathon GPX with start at Skatås and R = 4 km should produce a course that includes the Älvsborg bridge-like climbs in roughly the right places and scores clearly better than a random loop of the same length.

## UI and UX

One screen, mobile-first: the map fills the viewport, a bottom sheet holds the controls and results. On screens wider than 900 px the sheet becomes a left sidebar of 380 px.

Controls, top to bottom in the sheet:

1. **Upload GPX** (`<input type="file" accept=".gpx">`). After parsing, show distance, gain, loss and a small target profile chart.
2. **Start point**: tap or click on the map to drop the marker; drag to adjust. A "use my location" button calls the Geolocation API. The snapped graph node is shown as a second small dot once the graph is loaded.
3. **Radius** slider 1–10 km (default 5), drawn as a circle on the map. Show an estimate of network size next to it so the user understands why 10 km is slow.
4. **Distance** input, defaulting to the GPX length, plus an optional from–to km range of the race to match (default: whole race); **Return to start** toggle, default off.
5. **Surface mix**: three sliders or a preset dropdown (road race / gravel / trail / any).
6. **Find course** button. While searching: a progress bar with the current bucket, the best score so far, and the best-so-far polyline updating on the map. A Cancel button terminates the worker.

Result panel:

- Course polyline on the map, coloured by surface class; start and end markers.
- Overlaid elevation chart: target in grey, course in colour, shared x-axis in km. Hovering or touching the chart highlights the matching point on the map.
- Numbers: length, gain, loss, score, surface split in %.
- Buttons: **Download GPX**, **Try another** (next seed), **Copy link** (encodes GPX hash, start, radius, settings and seed in the URL so a search is reproducible).

States to handle explicitly: no GPX yet, GPX without elevation (fetching it), Overpass timeout or rate-limit (retry with a mirror endpoint, then explain), no graph node near the start, no course found within the length tolerance (suggest a larger radius), offline with cached area (works), offline without cache (explain).

Accessibility and feel: all controls reachable by keyboard; touch targets at least 44 px; charts drawn as inline SVG so they scale; respect `prefers-color-scheme`.

## Implementation phases

Six phases, each ending in something runnable. Claude Code should finish one phase, run its tests, commit, and only then start the next. Phase 2 gives a usable app; phases 3–6 improve it.

**Phase 0 – Scaffold** (half a day)

- [ ] Vite + TypeScript project, Vitest, ESLint, Prettier; `npm run dev --host` works in Termux and the page opens on the phone.
- [ ] Leaflet map with OSM tiles and attribution; click/tap drops a start marker; radius slider draws a circle.
- [ ] Empty Web Worker wired with typed `postMessage` messages.

* Done when: map, marker and circle work on desktop and phone.

**Phase 1 – Data in** (1–2 days)

- [ ] GPX parser with tests on lidingoloppet.gpx, goteborgsvarvet.gpx and lerumsloppet.gpx (copy them from the phone's Downloads folder, \~/storage/downloads/ in Termux after termux-setup-storage, into test/fixtures), plus synthetic fixtures without elevation and using `<rtept>`.
- [ ] Target profile builder: resample, smooth, gain/loss, gradient histogram. Tests with synthetic profiles.
- [ ] Overpass client with the query from Data pipeline, mirror fallback, IndexedDB cache.
- [ ] Graph builder producing typed arrays; test on a small saved Overpass response.
- [ ] Terrarium tile fetcher + decoder + bilinear sampler, IndexedDB cache; test against a few known elevations.
- [ ] Edge elevation sampling every 25 m; start-node snapping.

* Done when: uploading a GPX shows its profile chart, and the console logs graph node and edge counts and the start node's elevation for a chosen point.

**Phase 2 – First courses** (1–2 days)

- [ ] Scorer with all six terms and unit tests (identity = 0, shift = small, mirror = large).
- [ ] Random-walk baseline in the worker, progress messages, best-so-far polyline.
- [ ] Result panel: overlaid profile chart, numbers, surface colouring.
- [ ] GPX export.

* Done when: a real race GPX + a start point produces a downloadable course whose profile visibly resembles the target.

**Phase 3 – Beam search** (2–3 days)

- [ ] Dijkstra to the radius boundary / start for pruning.
- [ ] Beam search as specified; the baseline stays selectable in a debug panel for comparison.
- [ ] Local improvement with k-shortest-paths window replacement.
- [ ] Performance measurement on a phone; tune `B` and bucket size to the budget.

* Done when: beam search beats the baseline score on all three test courses and finishes within budget.

**Phase 4 – Surface and options** (1 day)

- [ ] Surface classification from tags, surface-mix presets, surface term in the score.
- [ ] Safety from OSM tags: extra penalty on residential, unclassified and tertiary roads without `sidewalk=*` or with `maxspeed` above 50; small bonus for `highway=cycleway`, `foot=designated` and `lit=yes`.
- [ ] Return to start toggle, distance override, kilometre-range selector for the target (default whole race), seed and "Try another".
- [ ] Shareable URL state.

* Done when: a road preset avoids trails and a trail preset finds them on the same start point.

**Phase 5 – Polish and ship** (1 day)

- [ ] Error states from UI and UX; cancel button; offline behaviour with cache.
- [ ] PWA manifest and service worker for the app shell (not for map tiles).
- [ ] Deploy to GitHub Pages or Cloudflare Pages via a GitHub Action on push to `main`.

* Done when: the public URL works on the phone, and a cold search in a new area takes under 15 s.

**Phase 6 – Later** (optional)

- Download a city's graph once and store it, to skip Overpass entirely.
- Personal heatmap: fetch the user's own activities through the Strava API (OAuth, personal use) or a bulk export, map-match the GPS points to graph edges, and give edges the user has run before a bonus in the score. This is the one popularity signal a third-party app can use legitimately: the Strava and Garmin global heatmaps are not exposed by their APIs and their terms do not allow reuse (verify current terms before coding).
- OSM public GPS traces (`/api/0.6/trackpoints`) as a weaker, open-licensed popularity signal; coverage in Sweden is thin.
- Multiple result candidates side by side.
- Import a course from Strava or Garmin as the target instead of a file.

## Project setup and tooling

Stack: Vite, TypeScript (strict), vanilla DOM or Preact for the UI (no heavy framework), Leaflet, Vitest, Playwright for one smoke test. No runtime dependencies beyond Leaflet and a small IndexedDB wrapper (`idb-keyval`). Keep the production bundle under 300 kB gzipped so it loads fast on mobile data.

Suggested repo layout:

```markdown
profile-course/
  index.html
  src/
    main.ts            UI bootstrap, state, message bus to worker
    ui/                map.ts, sheet.ts, profileChart.ts, resultPanel.ts
    gpx/               parse.ts, profile.ts, export.ts
    net/               overpass.ts, terrain.ts, cache.ts
    graph/             build.ts, types.ts (typed-array graph), dijkstra.ts, ksp.ts
    search/            score.ts, randomWalk.ts, beam.ts, improve.ts, worker.ts
    shared/            geo.ts (haversine, projection), messages.ts (worker protocol)
  test/
    fixtures/          three GPX files, one saved Overpass JSON, one terrain tile
    *.test.ts
  CLAUDE.md            this plan's phases and conventions, kept current
```

Conventions for Claude Code:

- Put this document's Architecture, Data pipeline and Matching algorithm sections into `CLAUDE.md` at the start, and update the phase checklist there as work completes.
- Heavy loops use typed arrays and plain `for` loops; no per-step object allocation inside the beam search.
- Everything in `search/` and `graph/` must run in the worker without DOM access.
- Every network call has a timeout, a retry, and a cache read first.
- Commit at the end of each phase with the phase name in the message.

Running in Termux: `pkg install nodejs git`, then `npm create vite@latest`, `npm run dev -- --host 0.0.0.0` and open `http://localhost:5173` in the phone browser. Playwright will not run in Termux; run its smoke test only in the GitHub Action. Deploy with a workflow that runs `npm ci && npm test && npm run build` and publishes `dist/`.

## Risks and open questions

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| Overpass public servers are slow or rate-limit during a search | Medium | Mirror fallback, cache, keep radius ≤ 10 km; phase 6 pre-built city graphs remove the dependency |
| DEM resolution (about 30 m) hides small bumps and bridges, so profiles look smoother than GPS traces | High | Smooth the GPX the same way; compare shapes, not noise. Later: Lantmäteriet's open height data for Sweden if its licence and CORS allow browser use |
| The area simply has no terrain matching the race (flat city, hilly race) | High in places | Show the best achievable score and the gain shortfall honestly; suggest a larger radius or another start |
| Beam search too slow on phones for 21 km + 10 km radius | Medium | Performance budget with automatic `B` and bucket fallback; worker keeps UI responsive; cancel button |
| GPX files without elevation, or with barometric drift | Medium | Always refetch elevation from the DEM for the target, so both sides use one model |
| Terrarium tile URL or hosting changes | Low | Verify at phase 1; Open-Meteo fallback; tile source is one file to swap |
| Courses run through private yards, stairs or busy roads | Medium | Tag filters plus penalties; user can report a bad segment later by exclusion (phase 6) |

Decisions taken on 14 Oct 2026:

- A course may use the same edge more than once, with a small penalty.
- A course ends anywhere inside the radius by default; a toggle forces return to start.
- Test fixtures: lidingoloppet.gpx, goteborgsvarvet.gpx and lerumsloppet.gpx (see phase 1).
- The user can select a kilometre range of the race to match; default is the full race (phase 4).
- Popularity data from other runners: the Strava and Garmin heatmaps are not available to third-party apps, so safety comes from OSM tags first (phase 4) and from the user's own activity history second (phase 6).

As of 14 Oct 2026. Sources to verify at the start of phase 1: [Overpass API](https://overpass-api.de/), [Terrain tiles on AWS](https://registry.opendata.aws/terrain-tiles/), [Open-Meteo elevation](https://open-meteo.com/en/docs/elevation-api), [Leaflet](https://leafletjs.com/).
