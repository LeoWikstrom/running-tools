# Course-quality experiments, 2026-11-05 → 2026-11-06 (reverted)

A record of the attempts to stop generated RunTour courses from padding their
length with spurs, laps and back-and-forths, tested mainly around
Moorgate/Great Swan Alley in the City of London and verified headlessly on a
central-Gothenburg graph built from the pre-baked network tiles. The
algorithmic changes were **reverted on 2026-11-06** — despite each step being
individually reasoned and several being measurably effective in isolation,
the London results stayed unacceptable. This file preserves what was tried,
why, what was measured, and what we think the real problem is, so the next
attempt starts ahead of this one.

## What stayed (not reverted)

These came out of the same sessions but are orthogonal to course shape and
worked:

- **Pool/display parity**: the generation pool now applies the same
  street/square/event filters as the shown places (`excludeStreets/Squares/
  Events` through `GenerateParams`). Before this, courses detoured to
  "collect" Wikipedia-notable streets that the editor then hid — spurs to
  invisible targets.
- **Defunct filter**: Wikidata P576/P3999 → `PlaceCandidate.defunct`,
  excluded everywhere (the Whalebone case). Wards (Q7969215, Q185441) joined
  the excluded admin types (the "Bishopsgate" case — the article's item is
  the living ward, not the demolished gate).
- **Chunked place fetches**: Wikipedia/Wikidata per ~1 km sub-circle
  (geosearch truncates at 500 pages; one whole-area SPARQL times out over
  central London and silently cost every place its sitelinks — which are
  40 % of the interest score, which is how "no places with interest ≥ 30"
  happened beside the Tower of London). Wikidata chunks run sequentially so
  its Retry-After handling works; whole-source failures are surfaced.
- **Manual spur pruning** (red dots, tap to remove, undo/redo bar over the
  map) with the point-spur detector in `core/geo/spurs.ts`. The detector's
  final semantics, per Leo: a dot is only offered for a span that is **pure
  retrace end to end** (leg-pairing walk within ~15 m tolerance, handling
  offset/parallel legs); innermost candidates win; a kept spur grows outward
  only while the ground stays mirrored. A street→square lobe whose interior
  is genuinely different ground is never offered as one unit.
- The "touching N places" status reworded (beam targets vs the corridor's
  full place list are different nets by design).

## The reverted attempts, in order, with reasoning

1. **Repeat weight 0.15 → 0.35** (`sliderWeights`). Reasoning: reused ground
   should never pay as distance filler; at 0.15 a 150 m out-and-back cost
   ~22 points — cheaper than most places earn. Outcome: visibly fewer but
   still many repeats; also revealed the deeper issues below.

2. **Corridor repeat in the beam** (union-find of edges sharing ≥60 % of
   their ~14 m cells). Reasoning: the beam charged repeat on *edge identity*
   only, so Blomfield Street's middle and two sidewalks were three "fresh"
   streets — the cell-grid knowledge lived only in the final scorer, after
   the whole beam had lapped. Outcome: correct idea, wrong structure —
   transitive closure chained short plaza/corner edges until one corridor
   held **14 170 edges, 27 % of central Gothenburg** (measured), and any
   direction rule over it forbade most of the map.

3. **Hard same-direction rule, three generations**:
   - *Edge-level*: forbid a second same-direction pass of a corridor.
     Banned walking straight (consecutive segments of one street are the
     same corridor) — everything infeasible.
   - *Pass-based*: contiguous runs through a corridor; straight = free,
     reversal = charged retrace, out-back-out = forbidden, later same-dir
     pass = forbidden. Still infeasible via the mega-corridors of (2).
   - *Pairwise siblings* (no union-find): each edge gets direct cell-overlap
     siblings with a bearing-derived direction sign (max 31 siblings on the
     real graph — sane). Feasibility returned but became **a lottery across
     lengths** (3 km ✓, 5 km ✗ in 0.1 s, 8 km ✓): the beam keeps one state
     per (node, places-bitset) key, and under a hard ban the kept
     best-scoring state was often a constraint dead-end while a discarded
     state could still finish.

4. **Soft 6× same-direction cost** (`SAME_DIR_FACTOR = 6`, ~2 pts/m).
   Reasoning: "at all costs" as a price no alternative ever loses to, with
   feasibility preserved as a last resort. Restored all lengths (measured:
   4/5/6/8 km × two beam widths, all found courses ≤2 s). But same-direction
   laps kept appearing in real courses — see (5).

5. **Direction-aware final scorer**. Reasoning: the improve pass (k-shortest
   -path window swaps) optimises `scoreTourCourse`, which charged all cell
   overlap at a flat 1× — improvement could smuggle back what the beam
   priced at 6×. Change: visited cells remember travel headings; a
   same-heading revisit costs 6× in the final score too.

6. **Automatic spur pruning after the beam** (`pruneDeadSpurs`): adjacent
   same-edge pairs peeled from the tip when the tip holds no collected
   place, plus asymmetric length tolerance (overshoot 2×, since pruning only
   shortens). First version shredded a 5 km ask to 1 km — in a place-poor
   area most of a course *is* filler by definition — fixed with a
   never-below-minLen floor.

7. **"Every node visited once unless absolutely necessary"** (Leo's rule):
   `crossing` (flat per-node-revisit charge, already wired in beam and final
   scorer) raised from slider-coupled 25 to a flat 400 ≈ three top places.
   Measured on Gothenburg 8 km: revisits 21 → 15. Not enough —
   instrumentation showed **all 63 finishing candidates** were
   retrace-family: every one came home along the street it left by.

8. **Burn-aware bucket ranking**. Reasoning (profile-course's lesson): a
   state arriving home under minLen must pad the difference somewhere, and
   nothing charged that until it happened; rank states as if the owed
   padding were already paid (`score − repeat × max(0, minLen − (dist +
   home))`). Outcome: negligible effect alone.

9. **Beam width 800** (worker override; core default 200). The decisive
   measurement: at width 200 clean far-flung lineages get crowded out before
   they can close the loop; at 800 with crossing 400 the same 8 km
   Gothenburg ask produced a clean loop with **0 node revisits** (crossing 0
   at width 800: 36 revisits — both levers needed).

## Why it still failed in London (hypotheses for next time)

The Gothenburg verification used a reduced weight set (repeat/crossing/turn
only, two toy places). The app generates with the full slider-derived mix —
interest up to 1.5×, penalty up to 0.14/m, centroid, crowding, a 64-place
pool — on a London graph that is denser, place-poorer after the filters, and
fetched at a 3 km radius that bounds how far an 8 km loop can spread.
Candidate explanations, none verified:

- **Weight interactions**: a high penalty weight (pedestrian slider left)
  makes fresh-but-unpleasant streets cost more than retracing pleasant ones;
  the revisit economics that worked with three weights may invert under the
  full mix. The 0-revisit result was never reproduced under app weights.
- **Pool-driven detours**: with 64 targets the course has reasons to visit
  specific spots; spurs to *collected* places are deliberately kept by the
  auto-pruner and look identical to padding on the map.
- **Graph radius**: an 8 km loop inside a 3 km-radius fetch has limited
  spreading room; the home-distance prune then funnels lineages back through
  the same corridors.
- **The improve pass** rescans windows against the final score; even
  direction-aware, its local swaps cannot restructure a bad global topology
  (measured: it trimmed the terminal retrace from 15 to 14 revisits).

## Lessons

- Beam survivor dynamics, not costs, decide course topology. Prices (even
  6×/400-point ones) only matter if a cheaper-topology lineage *survives to
  finish*; width and ranking govern that, and (node, bitset) dedup collapses
  diversity exactly when interest is sparse.
- Hard constraints + per-key dedup = feasibility lottery. Soften or widen.
- Fix the final scorer and the beam together, or improvement undoes the
  beam's discipline.
- Measure under the app's real weight mix, on the real target city, before
  declaring victory. A clean synthetic result (Gothenburg, three weights)
  did not transfer.
- Possibly the honest conclusion: incremental pricing on this beam cannot
  deliver "every node once" in sparse-interest dense cities. A structurally
  different generator — e.g. build candidate *loops* first (profile-course
  style, which solved confinement with reach-ranking) and scatter the place
  targets over them, or a dedicated loop-construction pass — may be the
  next thing worth trying.

## Revert scope (2026-11-06)

`packages/core/src/search/tourBeam.ts` and its test restored to commit
d5fbfeb (removing siblings, same-dir pricing, direction-aware final scorer,
auto-pruning, asymmetric tolerance, burn ranking); `sliderWeights` back to
repeat 0.15 and slider-coupled crossing; the worker's beamWidth 800 override
removed. Everything under "What stayed" above remains in place.
