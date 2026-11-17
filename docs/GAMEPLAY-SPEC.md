# Hex Cascade — Gameplay Spec (current, authoritative)

This document describes the game as actually implemented, and states the
**reference-verification status** of every mechanic explicitly. It
supersedes `hex-cascade-gdd.pdf` for anything related to core gameplay
(matching, stacking, clearing, cascades) — that PDF describes an earlier
match-3 / flood-fill / gravity design that was deliberately replaced and
is kept only for its still-valid sections (rendering architecture,
camera, audio, etc.), not as a gameplay reference.

Reference material: `vids/vid-1.mp4` (confirmed authentic — matches the
UI style of `docs/Screenshot 2026-09-09 105723.png`) is the primary
source of truth, ~39s of gameplay at ~1.33fps. `vids/vid-2.mp4` is a
**different game** (different UI chrome, currency system, island-building
meta-layer, hearts/tournament mode) and is not used as a source of truth
for anything beyond loose genre cross-checks (many colors, gap cells are
a known convention in this genre).

Every claim below is tagged: **CONFIRMED** (directly, repeatedly observed
in vid-1), **CONFIRMED (single instance)** (observed once, not repeated),
or **UNVERIFIED** (not resolvable from available material — implemented
as a reasoned, internally-consistent default, not a verified fact).

## Core loop — CONFIRMED

Stack sorting / color transfer, not match-3. Every cell holds a vertical
stack of colored tiles; only the **topmost** tile of a stack matters for
matching. The player drags a pre-built multi-layer stack from a 3-slot
hand onto the board (hand size 3 confirmed via vid-1, Level 2 frame
showing 3 simultaneous tray pieces).

## Placement — CONFIRMED

- A dragged stack can only be dropped on an **empty** cell
  (`HexGrid.canAcceptPiece`). Placing onto an occupied cell is rejected.
- Rejected only if the cell is occupied, frozen under an obstacle
  (`blockerHits > 0`), or the piece is taller than `MAX_STACK_HEIGHT`.

## Matching and transfer

- **CONFIRMED**: two hex-adjacent cells "match" when their **top** tiles
  share a color, and a match moves tiles **one at a time**, not a bulk
  merge of entire stacks — vid-1 shows stack heights changing
  incrementally across frames, never an instant full merge.
- **UNVERIFIED**: exact donor/receiver direction when the two matching
  stacks have different heights. One observed instance (vid-1, frames
  004→005) showed a taller pre-existing stack apparently donating into a
  just-placed shorter piece; a later, repeated pattern (frames 007→010)
  showed the opposite — freshly-placed single tiles draining into an
  established taller stack. These two observations contradict each other
  under any simple "who donates" rule we could construct (by recency, by
  height, or by role), and the source video's compression/low frame rate
  (~1.33fps) isn't fine-grained enough to resolve which one is right, or
  whether a third factor we didn't identify is deciding it. Per explicit
  instruction not to invent an unverified rule with false confidence:
  **this is left UNVERIFIED.** The current implementation makes a
  deterministic, internally-consistent choice — the most-recently-changed
  cell (the placement, or a cell that just grew/cleared) acts as donor —
  because it is at least self-consistent and testable, not because it's
  confirmed correct. If this is ever pinned down precisely from clearer
  reference footage, `MergeSystem.resolveBoardFrom`'s donor selection is
  the single place to change it.
- **CONFIRMED**: if a cell has more than one same-color neighbor with
  room, donations round-robin across all of them (not just the first in
  a fixed direction order) — this was a real, user-reported bug ("same
  colors sometimes not flipping"), fixed and verified this session. Not
  independently confirmed against the reference's own neighbor-priority
  behavior (no reference frame isolates this case cleanly), but confirmed
  as the *intended* behavior per direct user correction, which takes
  precedence.
- **CONFIRMED**: after every single-tile transfer, the donor's new top is
  re-checked before anything else happens — this is what drives a
  cascade through a mixed-color stack, and matches the general shape of
  interactions observed in vid-1 (chains of tile changes following one
  placement).

## Completion / clearing

- **UNVERIFIED (exact threshold)**: `COMPLETION_THRESHOLD = 5` is a
  carried-over assumption, not confirmed by directly observing a clear
  moment in vid-1 — no sampled frame caught a stack actually clearing.
  Stack heights observed growing to 5-6 before shrinking are consistent
  with a threshold in that range but do not pin it to exactly 5.
- **CONFIRMED (by construction, not by reference)**: only the qualifying
  *consecutive run* clears, not the whole stack — `[RED,RED,BLUE,RED,RED]`
  does not count as 5 reds. This is standard behavior for the run-based
  model already in place; no reference footage isolates this exact
  scenario, but it follows necessarily from "consecutive same-color run"
  being the stated rule.
- **CONFIRMED**: completion is checked before a transfer is attempted, on
  every cell processed — this was a real, confirmed logic bug (two
  already-qualifying adjacent stacks could hand tiles back and forth
  forever and never clear), found and fixed this session with a
  reproducible before/after test, independent of reference footage.
- Clearing removes exactly the qualifying run and re-queues the cell,
  since the newly exposed layer underneath may itself start a new
  transfer/cascade — **CONFIRMED** in shape (cascades clearly continue
  after a stack changes composition in vid-1), threshold value
  unverified as above.

## Cascade resolution — CONFIRMED (architecture), UNVERIFIED (exact rules above)

`MergeSystem.resolveBoardFrom` is a queue-driven (BFS-style), state-based
resolver: starts from one changed cell, runs to full exhaustion, returns
an ordered list of `transfer`/`clear` events. `Game.ts` plays these back
one at a time with real animation so cascades are visibly step-by-step.
The player cannot act again until the whole resolve finishes
(`GameStatus.RESOLVING` locks input) — confirmed as correct behavior by
construction and by this session's rapid-input regression test, not
directly observable in a compressed reference video.

## Board / neighbors — CONFIRMED

Flat-top axial coordinates `(q, r)`, radius-2 (19-cell) board for both
Level 1 and Level 2 in vid-1 — cell count and hexagon silhouette are
directly countable in the reference frames.

```
AXIAL_DIRECTIONS = [
  { q: +1, r: 0 }, { q: +1, r: -1 }, { q: 0, r: -1 },
  { q: -1, r: 0 }, { q: -1, r: +1 }, { q: 0, r: +1 }
]
```

## Levels — CONFIRMED for Levels 1-2, UNVERIFIED beyond

- Level 1: radius-2 board, 2 active colors, target 50, no obstacles, no
  starting stacks — CONFIRMED (progress bar target, color count, and an
  empty starting board with hand reduced to 2/3 by the first captured
  frame are all directly visible).
- Level 2: same board, 3rd color introduced, target 70, 3 obstacles
  (value 10 each, in a triangular cluster at the top of the board), 3
  starting stacks already on the board before the first move — CONFIRMED
  (all visible in the Level 2 opening frame at 0/70 progress).
  Coordinates were re-derived with pixel-level rigor (not eyeballing):
  measured hex-seam and color-cluster centroid positions in
  `vid-1_051.png`/`vid-1_052.png` via `find_yellow.py`, then matched
  against this game's own camera-projected cell positions
  (`Game.projectAllCells` debug helper) to find the best-fitting
  (q,r) triple for each cluster shape. Obstacles confirmed at
  `(0,-2)/(-1,-1)/(1,-2)` (an apex + two flanks that are each adjacent to
  the apex but not each other — a "V" with a visible gap between the
  flanks, exactly matching the measured badge centroids). Starting
  stacks are the mirrored V shape: `(-1,0)` and `(1,-1)` are the two
  flanks, `(0,0)` is the point they both touch — corrected from an
  earlier guess of `(0,1)`, which is not adjacent to either flank and
  did not match the tight cluster visible in the reference.
- Levels 3-8: color count, board radius, obstacle values/count, and
  targets are **extrapolated**, not confirmed — the reference capture
  doesn't extend that far. Marked `UNVERIFIED` in `config.ts` comments.
- A "Level N / GOAL / target" interstitial before each level, and a
  purple "✨VICTORY!✨" ribbon + separate "REWARD" section on the victory
  screen — CONFIRMED, directly visible in vid-1.
- The reference's victory screen also has an ad-reward "x3 Claim" button
  — CONFIRMED present in reference, but deliberately NOT implemented:
  this project's owner explicitly had a similar rewarded-ad mechanic
  removed earlier in development.

## Piece generation

- **CONFIRMED**: piece height scales with level — Level 1/2 pieces are
  short (1-4 layers observed), not uniformly random 1-8 from the start.
  `LevelDef.maxPieceLayers` caps this per level.
- **UNVERIFIED**: whether a piece's own layers should share colors
  (internal coherence) rather than rolling independently per layer.
  Reference pieces observed are short enough (1-3 layers) that this
  couldn't be distinguished either way in the available frames.
- **UNVERIFIED**: full solvability-aware generation (considering board
  state, exposed colors, upcoming interactions) is not implemented —
  current generation is level-difficulty-aware (color count + max
  height) but not board-state-aware beyond simple inverse-frequency
  color weighting. No reference evidence one way or the other on how
  sophisticated the real generator is.

## Obstacles

- **CONFIRMED**: appearance (ice-blue hex, numeric badge), Level 2
  onwards, value 10, triangular 3-cell cluster at board top.
- **UNVERIFIED**: exact damage rule. Current implementation: any clear
  event hex-adjacent to an obstacle removes 1 hit point, once per
  adjacent clear event (not capped per turn — fixed this session as a
  separate bug). No reference frame captures an obstacle actually taking
  damage or breaking, so this rule is a reasoned default, not confirmed.
- **UNVERIFIED**: whether obstacles block *placement* only, or also
  block *transfer* into/through that cell. Current implementation blocks
  both (an obstacle cell can never hold a stack, so it can't be a
  transfer source or destination) — not directly contradicted by
  anything observed, but not confirmed either.

## Boosters — UNVERIFIED

No booster (shuffle/rocket/autosort-equivalent) is used anywhere in the
captured vid-1 footage. Names, icons, and mechanics (shuffle = reroll
hand; rocket = instant-clear a targeted stack/obstacle; autosort = engine
picks and plays a legal move) are carried over from before this
session's reference-audit work and are **not verified** against the
actual reference. A later reference screenshot hints booster
availability/charge count may vary per level, but nothing in the frame
captures confirms this, so boosters remain globally available at fixed
charges.

## Tunables (`src/utils/config.ts`)

- `MAX_STACK_HEIGHT = 10` — UNVERIFIED
- `COMPLETION_THRESHOLD = 5` — UNVERIFIED (see above)
- `COLORS`: 7 colors, `LEVELS[].activeColors` ramps 2→7 — Level 1-2 counts
  CONFIRMED, later levels UNVERIFIED
- `LEVELS[].maxPieceLayers`: level-scaled piece height — CONFIRMED in
  shape (short pieces early), exact per-level caps UNVERIFIED
- `LEVELS[].startingStacks`, `.obstacles`: CONFIRMED for Level 1-2,
  UNVERIFIED beyond

## Known open questions (carried forward)

- Transfer donor/receiver direction under height mismatch (see above) —
  the single highest-value thing to re-verify if clearer/longer reference
  footage becomes available.
- Levels 3+ board/color/obstacle/target progression.
- Booster mechanics entirely.
- Exact completion threshold and max stack height.
