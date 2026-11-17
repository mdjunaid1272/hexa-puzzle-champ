// Level definitions: board layouts, obstacles, colors, goals.
//
// The first levels are hand-tuned rows of a table; every level after them is
// produced by the same function from smooth curves, so difficulty keeps
// rising gradually and never falls off a cliff or resets. Layouts are never
// accepted blindly: every generated board goes through validateLayout()
// (connected playable area, enough room, obstacles that can really be
// broken), and a seed that fails is simply replaced by the next one.
//
// getLevelDef(index) is the one entry point — use it, never index a table.

import { mulberry32 } from './prng';

export interface ObstacleDef {
  q: number;
  r: number;
  hits: number;
}

/** A stack already sitting on the board before the player makes a move. */
export interface StartingStackDef {
  q: number;
  r: number;
  colors: number[]; // bottom-to-top
}

export interface AxialCoordLike {
  q: number;
  r: number;
}

export interface LevelDef {
  target: number; // total blocks to clear to win
  activeColors: number;
  boardRadius: number;
  // When set, the board uses EXACTLY these cells instead of a full
  // radius-N hex-of-hexes — still plain axial coordinates with the same
  // six-direction adjacency, just a custom (usually smaller) shape.
  playableCells?: AxialCoordLike[];
  obstacles: ObstacleDef[];
  startingStacks: StartingStackDef[];
  coinReward: number;
  maxPieceLayers: number; // caps a piece's TOTAL layers (sum of its 3 color-group sizes) so early levels get short, manageable pieces
}

const AXIAL_DIRECTIONS: AxialCoordLike[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 }
];

const key = (q: number, r: number): string => `${q},${r}`;

// ---------------------------------------------------------------------------
// Layouts
// ---------------------------------------------------------------------------

// A compact 13-cell board: the radius-2 hex-of-hexes (19 cells) minus its 6
// outermost corner cells — smaller but still properly hexagonal and
// symmetric, with correct six-neighbour adjacency throughout.
export const COMPACT_13_CELL_LAYOUT: AxialCoordLike[] = [
  { q: -2, r: 1 },
  { q: -1, r: -1 }, { q: -1, r: 0 }, { q: -1, r: 1 }, { q: -1, r: 2 },
  { q: 0, r: -1 }, { q: 0, r: 0 }, { q: 0, r: 1 },
  { q: 1, r: -2 }, { q: 1, r: -1 }, { q: 1, r: 0 }, { q: 1, r: 1 },
  { q: 2, r: -1 }
];

/** Every cell of a full hex-of-hexes of the given radius (19 cells for radius 2, 37 for 3). */
export function fullHexLayout(radius: number): AxialCoordLike[] {
  const cells: AxialCoordLike[] = [];
  for (let q = -radius; q <= radius; q++) {
    const rMin = Math.max(-radius, -q - radius);
    const rMax = Math.min(radius, -q + radius);
    for (let r = rMin; r <= rMax; r++) cells.push({ q, r });
  }
  return cells;
}

/** Grows a random, always-connected, rounded board of exactly `cellCount`
 * cells outward from the origin. Candidate cells that touch more of the shape
 * are weighted heavily, so it grows into a blob rather than thin spikes. */
function growBlob(rng: () => number, cellCount: number): AxialCoordLike[] {
  const included = new Set<string>([key(0, 0)]);
  const cells: AxialCoordLike[] = [{ q: 0, r: 0 }];
  const frontier = new Map<string, AxialCoordLike>();
  const addFrontierAround = (cell: AxialCoordLike): void => {
    for (const dir of AXIAL_DIRECTIONS) {
      const nq = cell.q + dir.q;
      const nr = cell.r + dir.r;
      const k = key(nq, nr);
      if (!included.has(k)) frontier.set(k, { q: nq, r: nr });
    }
  };
  addFrontierAround(cells[0]);

  while (cells.length < cellCount && frontier.size > 0) {
    const candidates = Array.from(frontier.values());
    const weights = candidates.map((c) => {
      let support = 0;
      for (const dir of AXIAL_DIRECTIONS) {
        if (included.has(key(c.q + dir.q, c.r + dir.r))) support += 1;
      }
      return 1 + support * support * 4;
    });
    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    let roll = rng() * totalWeight;
    let chosenIndex = candidates.length - 1;
    for (let i = 0; i < candidates.length; i++) {
      roll -= weights[i];
      if (roll <= 0) {
        chosenIndex = i;
        break;
      }
    }
    const chosen = candidates[chosenIndex];
    frontier.delete(key(chosen.q, chosen.r));
    included.add(key(chosen.q, chosen.r));
    cells.push(chosen);
    addFrontierAround(chosen);
  }
  return cells;
}

/** Cube distance from the board center. */
function centerDistance(cell: AxialCoordLike): number {
  return (Math.abs(cell.q) + Math.abs(cell.r) + Math.abs(cell.q + cell.r)) / 2;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Fewest free (non-obstacle) cells a board may have. */
export const MIN_PLAYABLE_CELLS = 10;

export interface LayoutCheck {
  ok: boolean;
  problems: string[];
}

export interface LayoutOptions {
  /** Allow obstacles to touch each other (the hand-made cluster in level 2).
   * Such a cluster is allowed to have obstacles with a single free neighbour,
   * since they shield each other; generated obstacles need at least two. */
  allowAdjacentObstacles?: boolean;
}

/**
 * Checks that a board is actually playable:
 *  - cells are unique and obstacles/starting stacks sit on real cells,
 *  - enough free cells remain,
 *  - the free cells form ONE connected area (no sealed-off pockets),
 *  - every obstacle touches at least two free cells, so clears next to it can
 *    really break it,
 *  - (unless allowed) no two obstacles touch, so they don't wall off a region.
 */
export function validateLayout(
  cells: AxialCoordLike[],
  obstacles: ObstacleDef[],
  startingStacks: StartingStackDef[] = [],
  options: LayoutOptions = {}
): LayoutCheck {
  const problems: string[] = [];
  const cellSet = new Set(cells.map((c) => key(c.q, c.r)));
  if (cellSet.size !== cells.length) problems.push('duplicate cells');

  const obstacleSet = new Set<string>();
  for (const o of obstacles) {
    const k = key(o.q, o.r);
    if (!cellSet.has(k)) problems.push(`obstacle ${k} is not on the board`);
    if (obstacleSet.has(k)) problems.push(`duplicate obstacle ${k}`);
    if (o.hits <= 0) problems.push(`obstacle ${k} needs at least 1 hit`);
    obstacleSet.add(k);
  }
  for (const s of startingStacks) {
    const k = key(s.q, s.r);
    if (!cellSet.has(k)) problems.push(`starting stack ${k} is not on the board`);
    if (obstacleSet.has(k)) problems.push(`starting stack ${k} is on an obstacle`);
  }

  const free = cells.filter((c) => !obstacleSet.has(key(c.q, c.r)));
  if (free.length < MIN_PLAYABLE_CELLS) problems.push(`only ${free.length} free cells (need ${MIN_PLAYABLE_CELLS})`);

  // Connectivity of the free area.
  if (free.length > 0) {
    const freeSet = new Set(free.map((c) => key(c.q, c.r)));
    const seen = new Set<string>([key(free[0].q, free[0].r)]);
    const stack: AxialCoordLike[] = [free[0]];
    while (stack.length > 0) {
      const c = stack.pop() as AxialCoordLike;
      for (const d of AXIAL_DIRECTIONS) {
        const nk = key(c.q + d.q, c.r + d.r);
        if (freeSet.has(nk) && !seen.has(nk)) {
          seen.add(nk);
          stack.push({ q: c.q + d.q, r: c.r + d.r });
        }
      }
    }
    if (seen.size !== free.length) problems.push(`free area is split into pieces (${seen.size} of ${free.length} reachable)`);
  }

  // Obstacles must be breakable and must not wall things off.
  for (const o of obstacles) {
    let freeNeighbours = 0;
    for (const d of AXIAL_DIRECTIONS) {
      const nk = key(o.q + d.q, o.r + d.r);
      if (!cellSet.has(nk)) continue;
      if (obstacleSet.has(nk)) {
        if (!options.allowAdjacentObstacles) problems.push(`obstacles ${key(o.q, o.r)} and ${nk} touch`);
      } else {
        freeNeighbours += 1;
      }
    }
    const needed = options.allowAdjacentObstacles ? 1 : 2;
    if (freeNeighbours < needed) problems.push(`obstacle ${key(o.q, o.r)} touches only ${freeNeighbours} free cell(s)`);
  }

  return { ok: problems.length === 0, problems };
}

/** Picks obstacle cells for a layout: well inside the shape's outer ring (so
 * each touches several free cells), spread apart. Returns null if no valid
 * placement was found with this rng state. */
function placeObstacles(rng: () => number, cells: AxialCoordLike[], count: number, hits: number): ObstacleDef[] | null {
  if (count === 0) return [];
  const cellSet = new Set(cells.map((c) => key(c.q, c.r)));
  const neighbourCount = (c: AxialCoordLike): number => AXIAL_DIRECTIONS.filter((d) => cellSet.has(key(c.q + d.q, c.r + d.r))).length;
  // Edge-ish cells (but not corners with only 1-2 neighbours).
  const pool = cells.filter((c) => centerDistance(c) > 0 && neighbourCount(c) >= 3 && neighbourCount(c) <= 5);
  // Shuffle deterministically.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const chosen: ObstacleDef[] = [];
  for (const c of pool) {
    if (chosen.length >= count) break;
    const touchesChosen = chosen.some((o) => AXIAL_DIRECTIONS.some((d) => o.q + d.q === c.q && o.r + d.r === c.r));
    if (touchesChosen) continue;
    const trial = [...chosen, { q: c.q, r: c.r, hits }];
    if (validateLayout(cells, trial).ok) chosen.push({ q: c.q, r: c.r, hits });
  }
  return chosen.length === count ? chosen : null;
}

/** One blob-shaped board with obstacles, seeded so a given level always looks
 * the same. Tries successive seeds until the result passes validation. */
function buildBlobBoard(seed: number, cellCount: number, obstacleCount: number, hits: number): { playableCells: AxialCoordLike[]; obstacles: ObstacleDef[] } {
  for (let attempt = 0; attempt < 80; attempt++) {
    const rng = mulberry32(seed + attempt * 7919);
    const playableCells = growBlob(rng, cellCount);
    const obstacles = placeObstacles(rng, playableCells, obstacleCount, hits);
    if (obstacles && validateLayout(playableCells, obstacles).ok) return { playableCells, obstacles };
  }
  // Extremely unlikely; an obstacle-free blob is always valid.
  return { playableCells: growBlob(mulberry32(seed), cellCount), obstacles: [] };
}

// ---------------------------------------------------------------------------
// The hand-tuned opening
// ---------------------------------------------------------------------------

interface LevelSpec {
  cells: number | 'compact' | 'full2'; // board size: blob of N cells, the 13-cell board, or the 19-cell hexagon
  colors: number;
  obstacles: number;
  hits: number;
  target: number;
  layers: number; // max piece height
  reward: number;
}

// Early levels teach one idea at a time: L1 plain stacking, L2 obstacles and a
// pre-built group, L3 a fourth color, L4+ bigger irregular boards and more
// colors. Goals grow a little slower than the difficulty so levels stay short
// (about 25-45 moves).
const OPENING: LevelSpec[] = [
  { cells: 'compact', colors: 3, obstacles: 0, hits: 0, target: 50, layers: 6, reward: 30 },
  { cells: 'compact', colors: 3, obstacles: 3, hits: 3, target: 70, layers: 6, reward: 40 },
  { cells: 'full2', colors: 4, obstacles: 2, hits: 4, target: 90, layers: 5, reward: 50 },
  { cells: 26, colors: 4, obstacles: 2, hits: 5, target: 110, layers: 5, reward: 60 },
  { cells: 25, colors: 5, obstacles: 2, hits: 5, target: 130, layers: 6, reward: 75 },
  { cells: 24, colors: 5, obstacles: 3, hits: 6, target: 150, layers: 6, reward: 90 },
  { cells: 24, colors: 6, obstacles: 3, hits: 6, target: 165, layers: 6, reward: 105 },
  { cells: 25, colors: 6, obstacles: 4, hits: 7, target: 180, layers: 7, reward: 120 }
];

/** Level 2's pre-built pieces: a V of obstacles at the top, and three small
 * same-color stacks that merge on the first move — it shows how tiles flow. */
const LEVEL_2_OBSTACLES: ObstacleDef[] = [
  { q: -1, r: -1, hits: 3 },
  { q: 1, r: -2, hits: 3 },
  { q: 0, r: -1, hits: 3 }
];
const LEVEL_2_STACKS: StartingStackDef[] = [
  { q: -1, r: 0, colors: [0, 0] },
  { q: 1, r: -1, colors: [0, 0] },
  { q: 0, r: 0, colors: [0, 0, 0] }
];
/** Level 3 keeps the full hexagon with an obstacle on two opposite tips. */
const LEVEL_3_OBSTACLES: ObstacleDef[] = [
  { q: 0, r: -2, hits: 4 },
  { q: 0, r: 2, hits: 4 }
];

function buildFromSpec(index: number, spec: LevelSpec): LevelDef {
  if (spec.cells === 'compact') {
    const isLevel2 = index === 1;
    return {
      target: spec.target,
      activeColors: spec.colors,
      boardRadius: 2,
      playableCells: COMPACT_13_CELL_LAYOUT,
      obstacles: isLevel2 ? LEVEL_2_OBSTACLES : [],
      startingStacks: isLevel2 ? LEVEL_2_STACKS : [],
      coinReward: spec.reward,
      maxPieceLayers: spec.layers
    };
  }
  if (spec.cells === 'full2') {
    return {
      target: spec.target,
      activeColors: spec.colors,
      boardRadius: 2,
      obstacles: LEVEL_3_OBSTACLES,
      startingStacks: [],
      coinReward: spec.reward,
      maxPieceLayers: spec.layers
    };
  }
  const board = buildBlobBoard(index + 1, spec.cells, spec.obstacles, spec.hits);
  return {
    target: spec.target,
    activeColors: spec.colors,
    boardRadius: 3,
    playableCells: board.playableCells,
    obstacles: board.obstacles,
    startingStacks: [],
    coinReward: spec.reward,
    maxPieceLayers: spec.layers
  };
}

// ---------------------------------------------------------------------------
// Everything after the opening
// ---------------------------------------------------------------------------

/**
 * Level `index` (0-based) past the hand-tuned opening. Every number is a
 * smooth function of the index, so each level is a little harder than the
 * last: a new color every few levels (up to the full 8), more and tougher
 * obstacles, a slightly bigger board to give the extra colors room, and a goal
 * that grows slowly and then levels off so late levels stay a sensible length.
 */
function generateSpec(index: number): LevelSpec {
  const past = index - OPENING.length; // 0 for the first generated level
  return {
    cells: Math.min(31, 26 + Math.floor(past / 3)),
    colors: Math.min(8, 6 + Math.floor((past + 2) / 4)),
    obstacles: Math.min(7, 3 + Math.floor((past + 1) / 3)),
    hits: Math.min(10, 7 + Math.floor(past / 4)),
    target: Math.min(260, 190 + past * 7),
    layers: Math.min(8, 7 + Math.floor(past / 10)),
    reward: Math.min(400, Math.round(130 * Math.pow(1.06, past + 1)))
  };
}

/** The hand-tuned opening levels. */
export const LEVELS: LevelDef[] = OPENING.map((spec, i) => buildFromSpec(i, spec));

const cache = new Map<number, LevelDef>();

/** The single entry point for "what does level N look like". N can go arbitrarily high. */
export function getLevelDef(index: number): LevelDef {
  const i = Math.max(0, Math.floor(index));
  if (i < LEVELS.length) return LEVELS[i];
  let def = cache.get(i);
  if (!def) {
    def = buildFromSpec(i, generateSpec(i));
    cache.set(i, def);
  }
  return def;
}
