// Pure board-state rules for the boosters (and the "Play on" rescue). No
// rendering here — each function mutates the grid and returns exactly what
// was removed, so Game can animate the same things the rules removed and
// tests can check the rules without WebGL.

import { HexGrid } from '../board/HexGrid';
import { Cell } from '../board/Cell';

export interface ClearedStack {
  q: number;
  r: number;
  ids: string[]; // bottom-to-top, as they were on the cell
}

export interface BoosterResult {
  stacks: ClearedStack[];
  /** Ice/obstacle cells that were broken (they never count as progress). */
  obstacles: { q: number; r: number }[];
  /** Total blocks removed — what counts toward the level goal for Rocket / Mini Rocket. */
  blocksCleared: number;
}

function emptyResult(): BoosterResult {
  return { stacks: [], obstacles: [], blocksCleared: 0 };
}

/** True if the cell holds something a booster can hit. */
export function isTargetable(cell: Cell | null): cell is Cell {
  return !!cell && (cell.stack.length > 0 || cell.blockerHits > 0);
}

/** Fully clears one cell: an obstacle if there is one, otherwise the whole stack. */
function clearCell(cell: Cell, into: BoosterResult): void {
  if (cell.blockerHits > 0) {
    cell.blockerHits = 0;
    into.obstacles.push({ q: cell.q, r: cell.r });
    return;
  }
  if (cell.stack.length === 0) return;
  into.stacks.push({ q: cell.q, r: cell.r, ids: cell.stack.map((b) => b.id) });
  into.blocksCleared += cell.stack.length;
  cell.stack = [];
}

/** Rocket: clears the one targeted cell. Returns null if there is nothing there (no charge should be spent). */
export function applyRocket(grid: HexGrid, q: number, r: number): BoosterResult | null {
  const cell = grid.getCell(q, r);
  if (!isTargetable(cell)) return null;
  const result = emptyResult();
  clearCell(cell, result);
  return result;
}

/**
 * Mini Rocket: clears the targeted cell plus its 2 best neighbouring cells.
 * Every neighbour is the same distance away on a hex grid, so "best" is the
 * most blocks removed: stacks first (tallest first), then obstacles; direction
 * order breaks ties so the result is deterministic. Returns null if the
 * target cell is empty.
 */
export function applyMiniRocket(grid: HexGrid, q: number, r: number): BoosterResult | null {
  const primary = grid.getCell(q, r);
  if (!isTargetable(primary)) return null;

  const neighbours = grid
    .getNeighbors(q, r)
    .map((n, order) => ({ cell: grid.getCell(n.q, n.r), order }))
    .filter((e): e is { cell: Cell; order: number } => isTargetable(e.cell))
    .sort((a, b) => b.cell.stack.length - a.cell.stack.length || a.order - b.order)
    .slice(0, 2);

  const result = emptyResult();
  clearCell(primary, result);
  for (const { cell } of neighbours) clearCell(cell, result);
  return result;
}

/** How many of the tallest stacks "Play on" clears to make room. */
export const PLAY_ON_STACKS = 3;

/** Play on (the rescue after "No moves left"): clears the tallest stacks to open up room. Obstacles are left alone. */
export function applyPlayOn(grid: HexGrid): BoosterResult {
  const tallest = grid
    .allCells()
    .filter((c) => c.stack.length > 0)
    .sort((a, b) => b.stack.length - a.stack.length)
    .slice(0, PLAY_ON_STACKS);
  const result = emptyResult();
  for (const cell of tallest) clearCell(cell, result);
  return result;
}
