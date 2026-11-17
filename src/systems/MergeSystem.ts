// The core gameplay loop: STACK SORTING / COLOR TRANSFER, not match-3.
//
//   TOP-COLOR MATCH -> TRANSFER ONE TILE -> NEW TOP EXPOSED -> CHECK AGAIN
//   -> (no more transfers) -> CHECK COMPLETION -> CLEAR -> RE-CHECK -> ...
//
// Every occupied cell holds a vertical stack of colored tiles. Only the
// TOPMOST run of one color on a stack matters for merging. Two hex-adjacent
// cells whose top colors match are "linked", and tiles flow between them by
// ONE consistent rule everywhere in a cascade:
//
//   TILES FLOW FROM THE SMALLER TOP GROUP INTO THE LARGER ONE.
//
//   * The cell with the longer top run of that color is the RECEIVER, the
//     cell with the shorter run is the DONOR, and the donor hands over its top
//     tile, one tile at a time (so the player sees every tile move).
//   * If both runs are equal, the cell currently being resolved (the stack the
//     player just placed, or one that just changed) is the receiver.
//   * A receiver already at MAX_STACK_HEIGHT cannot take a tile; nothing moves
//     (the pair simply stays as it is).
//
// Why this cannot loop or bounce a tile back and forth: every transfer moves a
// tile from a group of size d to a group of size r with r >= d. Afterwards the
// receiver's group is r+1 and the donor's is d-1 (or the donor exposes a fresh
// group), so the sum of squared top-group sizes rises by 2(r-d)+2 >= 2 every
// time. That sum is bounded by the number of tiles, and only a clear (which
// removes at least COMPLETION_THRESHOLD tiles for good) can lower it, so a
// cascade always ends. A tile can only ever go back where it came from if the
// groups have changed so much that the move is now a fair one in the other
// direction — never as a repeating swap. MAX_EVENTS is a last-resort guard.
// Once nothing can move, a stack whose top run is COMPLETION_THRESHOLD or more
// clears its WHOLE top run (5, 6, 7 ...).
//
// This is pure board-state logic (no Three.js), so it is fully testable and
// the renderer just plays back the ordered event log it returns.

import { Cell } from '../board/Cell';
import { HexGrid, AxialCoord } from '../board/HexGrid';
import { COMPLETION_THRESHOLD, MAX_STACK_HEIGHT } from '../utils/config';

export interface TransferEvent {
  type: 'transfer';
  id: string;
  color: number;
  fromQ: number;
  fromR: number;
  fromLayer: number;
  toQ: number;
  toR: number;
  toLayer: number;
}

export interface ClearEvent {
  type: 'clear';
  q: number;
  r: number;
  color: number;
  ids: string[]; // bottom-to-top, within the cleared run
  baseLayer: number; // layer index the run started at, before clearing
}

export type ResolveEvent = TransferEvent | ClearEvent;

function cellKey(q: number, r: number): string {
  return `${q},${r}`;
}

/** How many tiles of the top color are stacked consecutively at the top. */
export function topRunLength(cell: Cell): number {
  if (cell.stack.length === 0) return 0;
  const topColor = cell.stack[cell.stack.length - 1].color;
  let count = 0;
  for (let i = cell.stack.length - 1; i >= 0; i--) {
    if (cell.stack[i].color !== topColor) break;
    count++;
  }
  return count;
}

/** Hard limits that keep a malformed board from ever hanging the game. A
 * legitimate cascade needs at most one event per tile on the board. */
const MAX_EVENTS = 4000;
const MAX_STEPS = 40000;

interface Move {
  donor: Cell;
  receiver: Cell;
}

/**
 * Resolves the board until it is stable. Mutates the grid to its final state
 * and returns every transfer/clear that happened, in the exact order they
 * occurred, so the renderer can play them back one at a time.
 *
 * `originQ/originR` (optional) is the cell that just changed — a placement
 * target. It is resolved first and wins equal-size ties. Every other occupied
 * cell is then checked too, so matching neighbours ANYWHERE on the board merge
 * (e.g. a level's pre-placed starting stacks), not only next to the new piece.
 */
export function resolveBoard(grid: HexGrid, originQ?: number, originR?: number): ResolveEvent[] {
  const events: ResolveEvent[] = [];
  const queue: AxialCoord[] = [];
  const queued = new Set<string>();

  const enqueue = (q: number, r: number): void => {
    const key = cellKey(q, r);
    if (queued.has(key)) return;
    queued.add(key);
    queue.push({ q, r });
  };

  if (originQ !== undefined && originR !== undefined && grid.getCell(originQ, originR)) enqueue(originQ, originR);
  for (const cell of grid.allCells()) {
    if (cell.stack.length > 0) enqueue(cell.q, cell.r);
  }

  /** The one transfer, if any, this cell should take part in right now:
   * where the cell is the receiver it absorbs the SMALLEST matching group
   * first; if only larger matching groups surround it, it gives to the
   * LARGEST of them. Ties keep AXIAL_DIRECTIONS order, so it is deterministic. */
  const pickMove = (cell: Cell): Move | null => {
    if (cell.stack.length === 0) return null;
    const topColor = cell.stack[cell.stack.length - 1].color;
    const myRun = topRunLength(cell);
    let absorb: { move: Move; run: number } | null = null;
    let give: { move: Move; run: number } | null = null;

    for (const n of grid.getNeighbors(cell.q, cell.r)) {
      const other = grid.getCell(n.q, n.r);
      if (!other || other.blockerHits > 0 || other.stack.length === 0) continue;
      if (other.stack[other.stack.length - 1].color !== topColor) continue;
      const otherRun = topRunLength(other);

      if (otherRun <= myRun && cell.stack.length < MAX_STACK_HEIGHT) {
        // This cell holds the bigger group (or ties and is the cell being
        // resolved), so it absorbs the neighbour's top tile.
        if (!absorb || otherRun < absorb.run) absorb = { move: { donor: other, receiver: cell }, run: otherRun };
      }
      if (otherRun >= myRun && other.stack.length < MAX_STACK_HEIGHT) {
        // The neighbour holds the bigger group (or ties), so this cell can give
        // its top tile to it. Absorbing is preferred, so on an exact tie this is
        // only used when this cell itself is full.
        if (!give || otherRun > give.run) give = { move: { donor: cell, receiver: other }, run: otherRun };
      }
    }
    return absorb ? absorb.move : give ? give.move : null;
  };

  let steps = 0;
  while (queue.length > 0 && steps < MAX_STEPS && events.length < MAX_EVENTS) {
    steps += 1;
    const coord = queue.shift() as AxialCoord;
    queued.delete(cellKey(coord.q, coord.r));
    const cell = grid.getCell(coord.q, coord.r);
    if (!cell || cell.stack.length === 0) continue;

    for (;;) {
      if (cell.stack.length === 0) break;
      if (events.length >= MAX_EVENTS) break;

      const move = pickMove(cell);
      if (move) {
        const { donor, receiver } = move;
        const fromLayer = donor.stack.length - 1;
        const block = donor.stack.pop() as Cell['stack'][number];
        const toLayer = receiver.stack.length;
        receiver.stack.push(block);
        events.push({
          type: 'transfer',
          id: block.id,
          color: block.color,
          fromQ: donor.q,
          fromR: donor.r,
          fromLayer,
          toQ: receiver.q,
          toR: receiver.r,
          toLayer
        });
        // Both cells' tops just changed; re-check whichever one is not this cell.
        const other = donor === cell ? receiver : donor;
        enqueue(other.q, other.r);
        continue; // this cell may have more to do
      }

      // Nothing can move — clear the whole top run if it is big enough.
      const run = topRunLength(cell);
      if (run >= COMPLETION_THRESHOLD) {
        const baseLayer = cell.stack.length - run;
        const removed = cell.stack.splice(baseLayer, run);
        events.push({
          type: 'clear',
          q: cell.q,
          r: cell.r,
          color: removed[0].color,
          ids: removed.map((b) => b.id),
          baseLayer
        });
        enqueue(cell.q, cell.r); // clearing may expose a new top — re-check it fresh next dequeue
      }
      break;
    }
  }

  if (steps >= MAX_STEPS || events.length >= MAX_EVENTS) {
    console.warn('resolveBoard: safety limit hit — check rules for an infinite transfer/clear loop');
  }

  return events;
}

/** Back-compat entry point: resolve everything, starting from one cell. */
export function resolveBoardFrom(grid: HexGrid, originQ: number, originR: number): ResolveEvent[] {
  return resolveBoard(grid, originQ, originR);
}
