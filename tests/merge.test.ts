import { describe, expect, it, vi } from 'vitest';
import { HexGrid } from '../src/board/HexGrid';
import { resolveBoard, resolveBoardFrom, topRunLength, TransferEvent, ClearEvent } from '../src/systems/MergeSystem';
import { COMPLETION_THRESHOLD, MAX_STACK_HEIGHT } from '../src/utils/config';
import { colorsAt, emptyGrid, put } from './helpers/board';
import { mulberry32 } from '../src/utils/prng';

const transfers = (events: ReturnType<typeof resolveBoard>): TransferEvent[] => events.filter((e): e is TransferEvent => e.type === 'transfer');
const clears = (events: ReturnType<typeof resolveBoard>): ClearEvent[] => events.filter((e): e is ClearEvent => e.type === 'clear');

describe('block transfers', () => {
  it('tiles flow from the smaller top group into the larger one', () => {
    const grid = emptyGrid();
    put(grid, 0, 0, [1, 0]); // top group: 1 tile
    put(grid, 1, 0, [1, 0, 0]); // top group: 2 tiles (the bigger one)
    const events = resolveBoard(grid, 0, 0);
    expect(transfers(events)).toHaveLength(1);
    expect(transfers(events)[0]).toMatchObject({ fromQ: 0, fromR: 0, toQ: 1, toR: 0, fromLayer: 1, toLayer: 3 });
    expect(colorsAt(grid, 0, 0)).toEqual([1]);
    expect(colorsAt(grid, 1, 0)).toEqual([1, 0, 0, 0]);
  });

  it('on equal groups the cell being resolved receives', () => {
    const grid = emptyGrid();
    put(grid, 0, 0, [1, 0]);
    put(grid, 1, 0, [2, 0]);
    const events = resolveBoard(grid, 1, 0); // the stack just placed at 1,0
    expect(transfers(events)[0]).toMatchObject({ fromQ: 0, fromR: 0, toQ: 1, toR: 0 });
    expect(colorsAt(grid, 1, 0)).toEqual([2, 0, 0]);
  });

  it('does nothing when neighbouring tops differ', () => {
    const grid = emptyGrid();
    put(grid, 0, 0, [0, 1]);
    put(grid, 1, 0, [1, 2]);
    expect(resolveBoard(grid, 0, 0)).toEqual([]);
  });

  it('only links hex-adjacent cells, not cells two steps apart', () => {
    const grid = emptyGrid();
    put(grid, 0, 0, [1, 0]);
    put(grid, 2, 0, [1, 0]); // two steps away along the same row
    expect(resolveBoard(grid, 0, 0)).toEqual([]);
  });

  it('matching neighbours merge anywhere on the board, not just next to the origin', () => {
    const grid = emptyGrid();
    put(grid, -1, 0, [1, 0, 0]);
    put(grid, -1, 1, [1, 0]);
    put(grid, 2, -1, [3]); // the "origin" is nowhere near them
    const events = resolveBoard(grid, 2, -1);
    expect(transfers(events)).toHaveLength(1);
    expect(colorsAt(grid, -1, 0)).toEqual([1, 0, 0, 0]);
  });

  it('a tile moves one layer at a time and layer numbers are correct for the animation', () => {
    const grid = emptyGrid();
    put(grid, 0, 0, [2, 2, 0, 0]); // top group of 2
    put(grid, 1, 0, [1, 0]); // top group of 1
    const events = transfers(resolveBoard(grid, 0, 0));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ fromLayer: 1, toLayer: 4, toQ: 0, toR: 0 });
  });

  it('never moves a tile into a full stack', () => {
    const grid = emptyGrid();
    put(grid, 0, 0, [1, 1, 1, 1, 1, 1, 1, 1, 0, 0]); // full (10), top group 2
    put(grid, 1, 0, [1, 0]); // would give its tile to the bigger group, but that is full
    const events = resolveBoard(grid, 1, 0);
    expect(transfers(events)).toHaveLength(0);
    expect(grid.getCell(0, 0)!.stack).toHaveLength(MAX_STACK_HEIGHT);
  });
});

describe('multiple matching neighbours', () => {
  it('absorbs the smallest matching group first, then the next', () => {
    const grid = emptyGrid();
    put(grid, 0, 0, [1, 0, 0, 0]); // receiver, top group 3
    put(grid, 1, 0, [2, 0, 0]); // neighbour with a group of 2
    put(grid, 0, 1, [2, 0]); // neighbour with a group of 1  <- should go first
    const events = transfers(resolveBoard(grid, 0, 0));
    expect(events[0]).toMatchObject({ fromQ: 0, fromR: 1 });
    expect(events[1]).toMatchObject({ fromQ: 1, fromR: 0 });
  });

  it('collects every matching tile into one stack and clears the whole run', () => {
    const grid = emptyGrid();
    put(grid, 0, 0, [1, 0, 0, 0]);
    put(grid, 1, 0, [2, 0, 0]);
    put(grid, -1, 0, [3, 0]); // on the opposite side, so the two small groups are not neighbours themselves
    const events = resolveBoard(grid, 0, 0);
    expect(transfers(events)).toHaveLength(3);
    const cleared = clears(events);
    expect(cleared).toHaveLength(1);
    expect(cleared[0].ids).toHaveLength(6); // 3 + 2 + 1, all of it
    expect(colorsAt(grid, 0, 0)).toEqual([1]);
    expect(colorsAt(grid, 1, 0)).toEqual([2]);
    expect(colorsAt(grid, -1, 0)).toEqual([3]);
  });
});

describe('stack clearing', () => {
  it('clears a top run of exactly the threshold', () => {
    const grid = emptyGrid();
    put(grid, 0, 0, [1, ...Array(COMPLETION_THRESHOLD).fill(0)]);
    const events = resolveBoard(grid, 0, 0);
    expect(clears(events)).toHaveLength(1);
    expect(clears(events)[0]).toMatchObject({ q: 0, r: 0, color: 0, baseLayer: 1 });
    expect(clears(events)[0].ids).toHaveLength(COMPLETION_THRESHOLD);
    expect(colorsAt(grid, 0, 0)).toEqual([1]);
  });

  it('clears 6, 7, 8 ... tiles in one go — the whole run, never just five', () => {
    for (const size of [6, 7, 8, 9]) {
      const grid = emptyGrid();
      put(grid, 0, 0, [1, ...Array(size).fill(0)]);
      const cleared = clears(resolveBoard(grid, 0, 0));
      expect(cleared).toHaveLength(1);
      expect(cleared[0].ids).toHaveLength(size);
      expect(colorsAt(grid, 0, 0)).toEqual([1]);
    }
  });

  it('does not clear below the threshold', () => {
    const grid = emptyGrid();
    put(grid, 0, 0, [1, 0, 0, 0, 0]);
    expect(resolveBoard(grid, 0, 0)).toEqual([]);
  });

  it('only the unbroken top run counts; same color lower down does not', () => {
    const grid = emptyGrid();
    put(grid, 0, 0, [0, 0, 0, 0, 1, 0]);
    expect(resolveBoard(grid, 0, 0)).toEqual([]);
  });

  it('reports the cleared ids bottom-to-top', () => {
    const grid = emptyGrid();
    const cell = put(grid, 0, 0, [1, 0, 0, 0, 0, 0]);
    const expected = cell.stack.slice(1).map((b) => b.id);
    expect(clears(resolveBoard(grid, 0, 0))[0].ids).toEqual(expected);
  });
});

describe('cascade resolution', () => {
  it('a clear exposes a new top that links with a neighbour and clears again', () => {
    const grid = emptyGrid();
    put(grid, 0, 0, [2, 2, 2, 2, 0, 0, 0, 0, 0]); // clearing the five 0s leaves four 2s
    put(grid, 1, 0, [3, 2]); // a lone 2 next door
    const events = resolveBoard(grid, 0, 0);
    expect(events.map((e) => e.type)).toEqual(['clear', 'transfer', 'clear']);
    expect(clears(events)[1].ids).toHaveLength(5);
    expect(colorsAt(grid, 0, 0)).toEqual([]);
    expect(colorsAt(grid, 1, 0)).toEqual([3]);
  });

  it('the whole level-2 opening settles into one clear of all seven tiles', () => {
    const grid = emptyGrid();
    put(grid, -1, 0, [0, 0]);
    put(grid, 1, -1, [0, 0]);
    put(grid, 0, 0, [0, 0, 0]);
    const events = resolveBoard(grid);
    expect(clears(events)).toHaveLength(1);
    expect(clears(events)[0].ids).toHaveLength(7);
    expect(grid.allCells().every((c) => c.stack.length === 0)).toBe(true);
  });

  it('conserves tiles: everything on the board is either still there or reported cleared', () => {
    const rng = mulberry32(4242);
    for (let game = 0; game < 200; game++) {
      const grid = emptyGrid();
      let total = 0;
      for (const c of grid.allCells()) {
        if (rng() < 0.7) {
          const h = 1 + Math.floor(rng() * 6);
          put(grid, c.q, c.r, Array.from({ length: h }, () => Math.floor(rng() * 3)));
          total += h;
        }
      }
      const events = resolveBoard(grid);
      const cleared = clears(events).reduce((sum, e) => sum + e.ids.length, 0);
      const remaining = grid.allCells().reduce((sum, c) => sum + c.stack.length, 0);
      expect(remaining + cleared).toBe(total);
    }
  });

  it('resolveBoardFrom (the older entry point) behaves like resolveBoard with an origin', () => {
    const a = emptyGrid();
    const b = emptyGrid();
    for (const g of [a, b]) {
      put(g, 0, 0, [1, 0, 0]);
      put(g, 1, 0, [1, 0]);
    }
    expect(resolveBoardFrom(a, 0, 0).length).toBe(resolveBoard(b, 0, 0).length);
  });
});

describe('transfer reversal prevention', () => {
  it('the case that used to bounce one tile between two cells 500 times now stays put', () => {
    const grid = emptyGrid();
    // Two nearly-full stacks that share a top color; the bigger group's stack is full.
    put(grid, 0, 0, [...Array(8).fill(1), 0]); // 9 tiles, top group 1
    put(grid, 1, 0, [...Array(8).fill(2), 0, 0]); // 10 tiles (full), top group 2
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const events = resolveBoard(grid, 0, 0);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    expect(events.length).toBeLessThan(5);
  });

  it('replaying every event follows the one rule: smaller-or-equal group gives to the larger, clears take the whole run', () => {
    const rng = mulberry32(99);
    for (let game = 0; game < 300; game++) {
      const grid = emptyGrid();
      for (const c of grid.allCells()) {
        if (rng() < 0.8) put(grid, c.q, c.r, Array.from({ length: 1 + Math.floor(rng() * 10) }, () => Math.floor(rng() * 3)));
      }
      const replay = grid.clone(); // the board as it was before resolving
      for (const e of resolveBoard(grid)) {
        if (e.type === 'transfer') {
          const donor = replay.getCell(e.fromQ, e.fromR)!;
          const receiver = replay.getCell(e.toQ, e.toR)!;
          // adjacent cells, same top color, the moved tile really is the donor's top tile
          expect(replay.getNeighbors(e.fromQ, e.fromR).some((n) => n.q === e.toQ && n.r === e.toR)).toBe(true);
          expect(donor.stack[donor.stack.length - 1].color).toBe(receiver.stack[receiver.stack.length - 1].color);
          expect(donor.stack[donor.stack.length - 1].id).toBe(e.id);
          expect(e.fromLayer).toBe(donor.stack.length - 1);
          expect(e.toLayer).toBe(receiver.stack.length);
          // flow goes from the smaller (or equal) top group into the larger, and never into a full stack
          expect(topRunLength(donor)).toBeLessThanOrEqual(topRunLength(receiver));
          expect(receiver.stack.length).toBeLessThan(MAX_STACK_HEIGHT);
          receiver.stack.push(donor.stack.pop()!);
        } else {
          const cell = replay.getCell(e.q, e.r)!;
          expect(topRunLength(cell)).toBeGreaterThanOrEqual(COMPLETION_THRESHOLD);
          expect(e.ids).toHaveLength(topRunLength(cell)); // the whole run, not just five
          expect(e.baseLayer).toBe(cell.stack.length - e.ids.length);
          cell.stack.splice(e.baseLayer, e.ids.length);
        }
      }
      // replaying the log reproduces the final board exactly
      for (const c of grid.allCells()) expect(replay.getCell(c.q, c.r)!.stack.map((b) => b.id)).toEqual(c.stack.map((b) => b.id));
    }
  });

  it('no single tile is shuffled around more than a handful of times', () => {
    const rng = mulberry32(31337);
    let worst = 0;
    for (let game = 0; game < 300; game++) {
      const grid = emptyGrid();
      for (const c of grid.allCells()) {
        if (rng() < 0.8) put(grid, c.q, c.r, Array.from({ length: 1 + Math.floor(rng() * 10) }, () => Math.floor(rng() * 2)));
      }
      const moves = new Map<string, number>();
      for (const e of transfers(resolveBoard(grid))) moves.set(e.id, (moves.get(e.id) ?? 0) + 1);
      for (const count of moves.values()) worst = Math.max(worst, count);
    }
    expect(worst).toBeLessThanOrEqual(6); // the old bug moved one tile 500 times
  });

  it('crowded, tall boards always settle: no safety-limit warning and few moves per tile', () => {
    const rng = mulberry32(2024);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let worst = 0;
    for (let game = 0; game < 400; game++) {
      const grid = new HexGrid(3);
      let tileCount = 0;
      for (const c of grid.allCells()) {
        if (rng() < 0.9) {
          const h = 1 + Math.floor(rng() * MAX_STACK_HEIGHT);
          put(grid, c.q, c.r, Array.from({ length: h }, () => Math.floor(rng() * 2)));
          tileCount += h;
        }
      }
      const events = resolveBoard(grid, 0, 0);
      worst = Math.max(worst, events.length / Math.max(1, tileCount));
    }
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    expect(worst).toBeLessThan(3); // far below the old 500-event runaway
  });

  it('after settling, equal-top neighbours remain only when a full stack blocks the move', () => {
    const rng = mulberry32(777);
    for (let game = 0; game < 400; game++) {
      const grid = emptyGrid();
      for (const c of grid.allCells()) {
        if (rng() < 0.7) put(grid, c.q, c.r, Array.from({ length: 1 + Math.floor(rng() * 10) }, () => Math.floor(rng() * 3)));
      }
      resolveBoard(grid);
      for (const c of grid.allCells()) {
        if (c.stack.length === 0) continue;
        for (const n of grid.getNeighbors(c.q, c.r)) {
          const o = grid.getCell(n.q, n.r);
          if (!o || o.stack.length === 0) continue;
          if (o.stack[o.stack.length - 1].color !== c.stack[c.stack.length - 1].color) continue;
          const blocked = c.stack.length >= MAX_STACK_HEIGHT || o.stack.length >= MAX_STACK_HEIGHT;
          expect(blocked).toBe(true);
        }
      }
    }
  });

  it('resolving an already-stable board changes nothing', () => {
    const rng = mulberry32(5);
    const grid = emptyGrid();
    for (const c of grid.allCells()) {
      if (rng() < 0.7) put(grid, c.q, c.r, Array.from({ length: 1 + Math.floor(rng() * 6) }, () => Math.floor(rng() * 3)));
    }
    resolveBoard(grid);
    expect(resolveBoard(grid)).toEqual([]);
  });

  it('topRunLength counts only the unbroken top group', () => {
    const grid = emptyGrid();
    expect(topRunLength(put(grid, 0, 0, [0, 0, 1, 1, 1]))).toBe(3);
    expect(topRunLength(put(grid, 1, 0, []))).toBe(0);
  });
});
