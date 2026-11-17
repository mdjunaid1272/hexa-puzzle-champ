import { describe, expect, it } from 'vitest';
import { applyMiniRocket, applyPlayOn, applyRocket, PLAY_ON_STACKS } from '../src/systems/BoosterSystem';
import { GameState } from '../src/core/GameState';
import { BOOSTER_STARTING_CHARGES } from '../src/utils/config';
import { colorsAt, emptyGrid, put } from './helpers/board';

describe('Rocket', () => {
  it('clears the whole targeted stack and reports its blocks', () => {
    const grid = emptyGrid();
    const cell = put(grid, 0, 0, [0, 1, 2, 3]);
    const ids = cell.stack.map((b) => b.id);
    const result = applyRocket(grid, 0, 0)!;
    expect(result.stacks).toEqual([{ q: 0, r: 0, ids }]);
    expect(result.blocksCleared).toBe(4);
    expect(colorsAt(grid, 0, 0)).toEqual([]);
  });

  it('leaves every other stack alone', () => {
    const grid = emptyGrid();
    put(grid, 0, 0, [0, 0]);
    put(grid, 1, 0, [1, 1, 1]);
    applyRocket(grid, 0, 0);
    expect(colorsAt(grid, 1, 0)).toEqual([1, 1, 1]);
  });

  it('breaks an obstacle outright, and an obstacle is worth 0 blocks', () => {
    const grid = emptyGrid();
    grid.getCell(0, 0)!.blockerHits = 7;
    const result = applyRocket(grid, 0, 0)!;
    expect(result.obstacles).toEqual([{ q: 0, r: 0 }]);
    expect(result.blocksCleared).toBe(0);
    expect(grid.getCell(0, 0)!.blockerHits).toBe(0);
  });

  it('returns null for an empty cell or one off the board, so no charge is wasted', () => {
    const grid = emptyGrid();
    expect(applyRocket(grid, 0, 0)).toBeNull();
    expect(applyRocket(grid, 50, 50)).toBeNull();
  });
});

describe('Mini Rocket', () => {
  it('clears the target and its two tallest neighbouring stacks', () => {
    const grid = emptyGrid();
    put(grid, 0, 0, [0, 0]); // target
    put(grid, 1, 0, [1]); // height 1
    put(grid, 0, 1, [2, 2, 2, 2]); // height 4 -> chosen
    put(grid, -1, 0, [3, 3, 3]); // height 3 -> chosen
    const result = applyMiniRocket(grid, 0, 0)!;
    expect(result.stacks.map((s) => `${s.q},${s.r}`).sort()).toEqual(['-1,0', '0,0', '0,1']);
    expect(result.blocksCleared).toBe(2 + 4 + 3);
    expect(colorsAt(grid, 1, 0)).toEqual([1]); // the short one is spared
  });

  it('hits fewer cells when there are fewer neighbours, and never cells two steps away', () => {
    const grid = emptyGrid();
    put(grid, 0, 0, [0]);
    put(grid, 1, 0, [1]);
    put(grid, 2, 0, [2]); // two steps from the target
    const result = applyMiniRocket(grid, 0, 0)!;
    expect(result.stacks).toHaveLength(2);
    expect(colorsAt(grid, 2, 0)).toEqual([2]);
  });

  it('prefers stacks over obstacles when it has to choose', () => {
    const grid = emptyGrid();
    put(grid, 0, 0, [0]);
    put(grid, 1, 0, [1]);
    put(grid, 0, 1, [2]);
    grid.getCell(-1, 0)!.blockerHits = 5;
    const result = applyMiniRocket(grid, 0, 0)!;
    expect(result.obstacles).toHaveLength(0);
    expect(result.stacks).toHaveLength(3);
  });

  it('breaks an obstacle neighbour when there are not enough stacks', () => {
    const grid = emptyGrid();
    put(grid, 0, 0, [0]);
    grid.getCell(-1, 0)!.blockerHits = 5;
    const result = applyMiniRocket(grid, 0, 0)!;
    expect(result.obstacles).toEqual([{ q: -1, r: 0 }]);
    expect(result.blocksCleared).toBe(1);
  });

  it('returns null when the target is empty', () => {
    const grid = emptyGrid();
    put(grid, 1, 0, [1]);
    expect(applyMiniRocket(grid, 0, 0)).toBeNull();
    expect(colorsAt(grid, 1, 0)).toEqual([1]); // nothing happened
  });
});

describe('Play on', () => {
  it('clears the three tallest stacks and leaves obstacles alone', () => {
    const grid = emptyGrid();
    put(grid, 0, 0, [0, 0, 0, 0, 0]);
    put(grid, 1, 0, [1, 1, 1, 1]);
    put(grid, 0, 1, [2, 2, 2]);
    put(grid, -1, 0, [3, 3]);
    put(grid, 0, -1, [4]);
    grid.getCell(1, -1)!.blockerHits = 9;
    const result = applyPlayOn(grid);
    expect(result.stacks).toHaveLength(PLAY_ON_STACKS);
    expect(result.blocksCleared).toBe(5 + 4 + 3);
    expect(colorsAt(grid, -1, 0)).toEqual([3, 3]);
    expect(grid.getCell(1, -1)!.blockerHits).toBe(9);
    expect(result.obstacles).toEqual([]);
  });

  it('copes with a board that has fewer stacks than that', () => {
    const grid = emptyGrid();
    put(grid, 0, 0, [0, 0]);
    expect(applyPlayOn(grid).stacks).toHaveLength(1);
    expect(applyPlayOn(grid).stacks).toHaveLength(0);
  });
});

describe('booster charges', () => {
  it('each level starts with the full set and each use costs one', () => {
    const state = new GameState(5);
    state.beginLevel(0);
    const lm = state.levelManager;
    expect(lm.boosterCharges).toEqual({ shuffle: BOOSTER_STARTING_CHARGES, rocket: BOOSTER_STARTING_CHARGES, miniRocket: BOOSTER_STARTING_CHARGES });
    expect(lm.useBooster('rocket')).toBe(true);
    expect(lm.boosterCharges.rocket).toBe(BOOSTER_STARTING_CHARGES - 1);
    expect(lm.useBooster('rocket')).toBe(true);
    expect(lm.useBooster('rocket')).toBe(false); // out of charges
    expect(lm.boosterCharges.rocket).toBe(0);
    expect(lm.boosterCharges.shuffle).toBe(BOOSTER_STARTING_CHARGES); // others untouched
  });

  it('charges come back when the level is restarted', () => {
    const state = new GameState(5);
    state.beginLevel(0);
    state.levelManager.useBooster('shuffle');
    state.beginLevel(0);
    expect(state.levelManager.boosterCharges.shuffle).toBe(BOOSTER_STARTING_CHARGES);
  });

  it('a shuffle refills the whole hand with new pieces', () => {
    const state = new GameState(77);
    state.beginLevel(2);
    const before = state.spawnSystem.getHand().map((p) => p!.map((b) => b.id).join());
    state.spawnSystem.reset();
    state.refillHandIfNeeded();
    const after = state.spawnSystem.getHand().map((p) => p!.map((b) => b.id).join());
    expect(after.every((s) => !before.includes(s))).toBe(true);
    expect(state.spawnSystem.getHand().every((p) => p !== null)).toBe(true);
  });
});
