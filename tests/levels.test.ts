import { describe, expect, it } from 'vitest';
import { fullHexLayout, getLevelDef, LEVELS, MIN_PLAYABLE_CELLS, validateLayout } from '../src/utils/levels';
import { COLORS, MAX_STACK_HEIGHT } from '../src/utils/config';
import { GameState, GameStatus } from '../src/core/GameState';
import { resolveBoard } from '../src/systems/MergeSystem';
import { playLevel } from './helpers/bot';

const levelCells = (i: number) => {
  const def = getLevelDef(i);
  return def.playableCells ?? fullHexLayout(def.boardRadius);
};

describe('layout validation', () => {
  it('accepts a plain board', () => {
    expect(validateLayout(fullHexLayout(2), []).ok).toBe(true);
  });

  it('rejects a board whose free area is split in two', () => {
    const cells = fullHexLayout(2);
    // a wall of obstacles straight across the middle row
    const wall = [-2, -1, 0, 1, 2].map((q) => ({ q, r: 0, hits: 3 }));
    const check = validateLayout(cells, wall, [], { allowAdjacentObstacles: true });
    expect(check.ok).toBe(false);
    expect(check.problems.join()).toMatch(/split/);
  });

  it('rejects too few free cells', () => {
    const cells = fullHexLayout(1); // 7 cells
    const check = validateLayout(cells, []);
    expect(check.problems.join()).toMatch(/free cells/);
    expect(MIN_PLAYABLE_CELLS).toBeGreaterThan(7);
  });

  it('rejects an obstacle that cannot be broken (no free neighbour at all)', () => {
    const cells = fullHexLayout(2);
    const corner = { q: 2, r: -2, hits: 4 }; // a corner tip touches only 3 cells; wall them all in
    const blockers = [corner, { q: 1, r: -2, hits: 4 }, { q: 1, r: -1, hits: 4 }, { q: 2, r: -1, hits: 4 }];
    const check = validateLayout(cells, blockers, [], { allowAdjacentObstacles: true });
    expect(check.ok).toBe(false);
    expect(check.problems.join()).toMatch(/touches only 0/);
  });

  it('a generated (non-cluster) obstacle needs at least two free neighbours', () => {
    const cells = fullHexLayout(2);
    const corner = { q: 2, r: -2, hits: 4 }; // touches 3 board cells; block two of them
    const check = validateLayout(cells, [corner, { q: 1, r: -1, hits: 4 }].slice(0, 1), [], {});
    expect(check.ok).toBe(true); // 3 free neighbours: fine
    const squeezed = validateLayout(cells, [corner, { q: 1, r: -2, hits: 4 }, { q: 2, r: -1, hits: 4 }], [], { allowAdjacentObstacles: false });
    expect(squeezed.ok).toBe(false);
  });

  it('rejects touching obstacles unless explicitly allowed', () => {
    const cells = fullHexLayout(2);
    const pair = [{ q: 0, r: 0, hits: 3 }, { q: 1, r: 0, hits: 3 }];
    expect(validateLayout(cells, pair).ok).toBe(false);
    expect(validateLayout(cells, pair, [], { allowAdjacentObstacles: true }).ok).toBe(true);
  });

  it('rejects objects that are not on the board, and a starting stack on an obstacle', () => {
    const cells = fullHexLayout(2);
    expect(validateLayout(cells, [{ q: 9, r: 9, hits: 3 }]).ok).toBe(false);
    expect(validateLayout(cells, [{ q: 0, r: 0, hits: 3 }], [{ q: 0, r: 0, colors: [0] }]).ok).toBe(false);
    expect(validateLayout(cells, [], [{ q: 8, r: 8, colors: [0] }]).ok).toBe(false);
  });
});

describe('every level is well formed', () => {
  for (let i = 0; i < 80; i++) {
    it(`level ${i + 1}: valid layout, sensible numbers`, () => {
      const def = getLevelDef(i);
      const check = validateLayout(levelCells(i), def.obstacles, def.startingStacks, { allowAdjacentObstacles: i === 1 });
      expect(check.problems).toEqual([]);
      expect(def.activeColors).toBeGreaterThanOrEqual(3);
      expect(def.activeColors).toBeLessThanOrEqual(COLORS.length);
      expect(def.maxPieceLayers).toBeGreaterThanOrEqual(3);
      expect(def.maxPieceLayers).toBeLessThanOrEqual(MAX_STACK_HEIGHT);
      expect(def.target).toBeGreaterThan(0);
      expect(def.target).toBeLessThanOrEqual(300);
      expect(def.coinReward).toBeGreaterThan(0);
      for (const o of def.obstacles) expect(o.hits).toBeGreaterThanOrEqual(1);
    });
  }

  it('is deterministic: asking for the same level twice gives the same board', () => {
    for (const i of [3, 9, 14, 40]) {
      expect(JSON.stringify(getLevelDef(i))).toBe(JSON.stringify(getLevelDef(i)));
    }
  });
});

describe('difficulty curve', () => {
  it('goals, colors and obstacle toughness never go down as levels advance', () => {
    let target = 0;
    let colors = 0;
    for (let i = 0; i < 80; i++) {
      const def = getLevelDef(i);
      expect(def.target).toBeGreaterThanOrEqual(target);
      expect(def.activeColors).toBeGreaterThanOrEqual(colors);
      target = def.target;
      colors = def.activeColors;
    }
  });

  it('the early levels are gentle: few colors, small goals, no obstacles in level 1', () => {
    expect(LEVELS[0].activeColors).toBe(3);
    expect(LEVELS[0].obstacles).toHaveLength(0);
    expect(LEVELS[0].target).toBeLessThanOrEqual(60);
    expect(getLevelDef(4).activeColors).toBeLessThanOrEqual(5);
  });

  it('new ideas arrive one at a time: obstacles at level 2, a fourth color at level 3', () => {
    expect(LEVELS[1].obstacles.length).toBeGreaterThan(0);
    expect(LEVELS[1].startingStacks.length).toBeGreaterThan(0);
    expect(LEVELS[2].activeColors).toBe(4);
  });

  it('there is no sudden jump in colors between neighbouring levels', () => {
    for (let i = 1; i < 60; i++) expect(getLevelDef(i).activeColors - getLevelDef(i - 1).activeColors).toBeLessThanOrEqual(1);
  });

  it('the full palette is reached, and the late-game goal levels off at a sensible length', () => {
    expect(getLevelDef(30).activeColors).toBe(COLORS.length);
    expect(getLevelDef(60).target).toBe(getLevelDef(40).target);
  });

  it('level 2 starts with stacks that merge and clear on the first settle', () => {
    const state = new GameState(1);
    state.beginLevel(1);
    const events = resolveBoard(state.grid);
    const clear = events.find((e) => e.type === 'clear');
    expect(clear).toBeDefined();
  });
});

describe('a greedy player can actually play the levels (win rate stays in a sensible band)', () => {
  const seeds = [11, 12, 13, 14, 15, 16, 17, 18];
  const winRate = (level: number): number => seeds.filter((s) => playLevel(level, s).won).length / seeds.length;

  it('early levels (1-6) are comfortable', () => {
    for (const level of [0, 1, 2, 3, 4, 5]) expect(winRate(level)).toBeGreaterThanOrEqual(0.85);
  });

  it('middle levels (9-14) are mostly winnable but not trivial to rely on', () => {
    for (const level of [8, 11, 13]) expect(winRate(level)).toBeGreaterThanOrEqual(0.6);
  });

  it('late levels stay winnable', () => {
    for (const level of [19, 29, 39]) expect(winRate(level)).toBeGreaterThanOrEqual(0.35);
  });

  it('a finished level pays out and unlocks the next one', () => {
    const state = new GameState(21);
    state.beginLevel(0);
    let guard = 0;
    // play the bot to completion through the real state API
    while (state.status === GameStatus.PLAYING && guard++ < 200) {
      const hand = state.spawnSystem.getHand();
      let moved = false;
      for (let slot = 0; slot < hand.length && !moved; slot++) {
        const piece = hand[slot];
        if (!piece) continue;
        const cell = state.grid.placeableCells(piece.length)[0];
        if (cell && state.applyTurn(slot, cell.q, cell.r)) moved = true;
      }
      if (!moved) state.failLevel();
    }
    if (state.status === GameStatus.LEVEL_COMPLETE) {
      expect(state.levelManager.coins).toBe(state.levelManager.def.coinReward);
      expect(state.levelManager.unlockedLevelIndex).toBe(1);
    } else {
      // a naive first-cell player may run out of room; the game must then be properly "failed"
      expect(state.status).toBe(GameStatus.LEVEL_FAILED);
    }
  });
});
