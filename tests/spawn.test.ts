import { describe, expect, it } from 'vitest';
import { GameState } from '../src/core/GameState';
import { HexGrid } from '../src/board/HexGrid';
import { Piece, SpawnSystem } from '../src/systems/SpawnSystem';
import { HAND_SIZE, MAX_STACK_HEIGHT } from '../src/utils/config';
import { mulberry32 } from '../src/utils/prng';
import { put } from './helpers/board';

/** The color groups of a piece, bottom-to-top, e.g. [[0,2],[3,1],[1,3]] as [color, size] pairs. */
function groups(piece: Piece): [number, number][] {
  const out: [number, number][] = [];
  for (const b of piece) {
    const last = out[out.length - 1];
    if (last && last[0] === b.color) last[1] += 1;
    else out.push([b.color, 1]);
  }
  return out;
}

function handOf(seed: number, level: number): Piece[] {
  const state = new GameState(seed);
  state.beginLevel(level);
  return state.spawnSystem.getHand() as Piece[];
}

describe('hand generation', () => {
  it('deals a full hand', () => {
    const hand = handOf(1, 0);
    expect(hand).toHaveLength(HAND_SIZE);
    expect(hand.every((p) => p && p.length > 0)).toBe(true);
  });

  it('every piece is exactly three contiguous color groups of three different colors', () => {
    for (let seed = 1; seed <= 40; seed++) {
      for (const level of [0, 3, 9, 20]) {
        for (const piece of handOf(seed, level)) {
          const g = groups(piece);
          expect(g).toHaveLength(3);
          expect(new Set(g.map((x) => x[0])).size).toBe(3);
        }
      }
    }
  });

  it('only uses colors that are active at this level', () => {
    for (const level of [0, 1, 2, 4, 7, 12, 25]) {
      const state = new GameState(5);
      state.beginLevel(level);
      const active = state.levelManager.def.activeColors;
      for (let seed = 0; seed < 15; seed++) {
        const s = new GameState(seed);
        s.beginLevel(level);
        for (const piece of s.spawnSystem.getHand() as Piece[]) for (const b of piece) expect(b.color).toBeLessThan(active);
      }
    }
  });

  it('respects the level\'s maximum piece height, but never drops below one block per group', () => {
    for (const level of [0, 2, 8, 15]) {
      const max = new GameState(1).levelManager.def.maxPieceLayers;
      for (let seed = 0; seed < 30; seed++) {
        const s = new GameState(seed);
        s.beginLevel(level);
        const cap = Math.max(3, s.levelManager.def.maxPieceLayers);
        for (const piece of s.spawnSystem.getHand() as Piece[]) {
          expect(piece.length).toBeLessThanOrEqual(cap);
          expect(piece.length).toBeGreaterThanOrEqual(3);
          expect(piece.length).toBeLessThanOrEqual(MAX_STACK_HEIGHT);
        }
      }
      expect(max).toBeGreaterThanOrEqual(3);
    }
  });

  it('one hand wave shares one set of colors', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const hand = handOf(seed, 12);
      const colors = new Set(hand.flatMap((p) => p.map((b) => b.color)));
      expect(colors.size).toBeLessThanOrEqual(HAND_SIZE);
    }
  });

  it('every block has a unique id', () => {
    const hand = handOf(3, 5);
    const ids = hand.flatMap((p) => p.map((b) => b.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('deterministic with a fixed seed', () => {
  const colorsOf = (hand: Piece[]): string => hand.map((p) => p.map((b) => b.color).join('')).join('|');

  it('the same seed deals the same first hand', () => {
    for (const level of [0, 4, 11]) {
      expect(colorsOf(handOf(2024, level))).toBe(colorsOf(handOf(2024, level)));
    }
  });

  it('different seeds deal different hands', () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 30; seed++) seen.add(colorsOf(handOf(seed, 9)));
    expect(seen.size).toBeGreaterThan(20);
  });

  it('the same seed and the same moves give the same game, hand after hand', () => {
    const play = (): string => {
      const state = new GameState(555);
      state.beginLevel(3);
      const log: string[] = [];
      for (let turn = 0; turn < 12; turn++) {
        const hand = state.spawnSystem.getHand();
        const slot = hand.findIndex((p) => p !== null);
        if (slot < 0) break;
        const piece = hand[slot]!;
        const cell = state.grid.placeableCells(piece.length)[0];
        if (!cell) break;
        log.push(colorsOf([piece]));
        if (!state.applyTurn(slot, cell.q, cell.r)) break;
      }
      return log.join('/');
    };
    expect(play()).toBe(play());
  });
});

describe('board-aware generation', () => {
  /** A crowded board: all but three cells hold random stacks of low colors. */
  function crowdedBoard(seed: number): HexGrid {
    const rng = mulberry32(seed);
    const grid = new HexGrid(2);
    const cells = grid.allCells();
    for (const c of cells.slice(0, cells.length - 3)) put(grid, c.q, c.r, Array.from({ length: 2 + Math.floor(rng() * 5) }, () => Math.floor(rng() * 4)));
    return grid;
  }

  it('looks one move ahead without touching the real board', () => {
    const grid = crowdedBoard(1);
    const snapshot = JSON.stringify(grid.allCells().map((c) => c.stack));
    const hand = handOf(8, 3);
    SpawnSystem.scoreHand(grid, hand);
    SpawnSystem.bestOutcome(grid, hand[0]);
    expect(JSON.stringify(grid.allCells().map((c) => c.stack))).toBe(snapshot);
  });

  it('bestOutcome reports no move for a piece that fits nowhere', () => {
    const grid = new HexGrid(2);
    for (const c of grid.allCells()) put(grid, c.q, c.r, [0]);
    expect(SpawnSystem.bestOutcome(grid, handOf(1, 0)[0])).toBeNull();
  });

  it('on a crowded board its hands are clearly better than blind dealing: stronger best move, fewer dead hands', () => {
    let awareScore = 0;
    let blindScore = 0;
    let awareDead = 0;
    let blindDead = 0;
    const trials = 200;
    for (let seed = 1; seed <= trials; seed++) {
      const grid = crowdedBoard(seed);
      const counts = new Array(8).fill(0);

      const a = new SpawnSystem(mulberry32(seed));
      a.ensureHandFilled(4, counts, 6, grid);
      const b = new SpawnSystem(mulberry32(seed));
      b.ensureHandFilled(4, counts, 6);

      const best = (s: SpawnSystem): number => Math.max(...(s.getHand() as Piece[]).map((p) => SpawnSystem.bestOutcome(grid, p)?.score ?? 0));
      const as = best(a);
      const bs = best(b);
      awareScore += as;
      blindScore += bs;
      if (as === 0) awareDead += 1;
      if (bs === 0) blindDead += 1;
    }
    expect(awareScore).toBeGreaterThan(blindScore * 1.1); // clearly stronger offers
    expect(awareDead).toBeLessThanOrEqual(blindDead); // never more dead hands
  });

  it('on an open board the choice stays varied (not a fixed pick)', () => {
    const grid = new HexGrid(2);
    const seen = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) {
      const s = new SpawnSystem(mulberry32(seed));
      s.ensureHandFilled(4, new Array(8).fill(0), 6, grid);
      seen.add((s.getHand() as Piece[]).map((p) => p.map((b) => b.color).join('')).join('|'));
    }
    expect(seen.size).toBeGreaterThan(25);
  });

  it('never deals an empty or partial hand when asked to refill', () => {
    const s = new SpawnSystem(mulberry32(3));
    s.ensureHandFilled(5, new Array(8).fill(0), 6, crowdedBoard(3));
    expect(s.getHand().every((p) => p !== null)).toBe(true);
    s.consume(0);
    s.ensureHandFilled(5, new Array(8).fill(0), 6, crowdedBoard(3)); // only refills a fully used hand
    expect(s.getHand()[0]).toBeNull();
  });
});
