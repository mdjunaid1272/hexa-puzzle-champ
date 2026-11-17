import { describe, expect, it } from 'vitest';
import { GameState, GameStatus } from '../src/core/GameState';
import { scoreForClear } from '../src/systems/ScoreSystem';
import { applyBlockerDamage } from '../src/systems/ObstacleSystem';
import { resolveSeed } from '../src/utils/prng';
import { COMPLETION_THRESHOLD } from '../src/utils/config';
import { colorsAt, put, tiles } from './helpers/board';

function startedState(level = 0, seed = 1234): GameState {
  const state = new GameState(seed);
  state.beginLevel(level);
  return state;
}

describe('placement', () => {
  it('puts the hand piece on an empty cell and removes it from the hand', () => {
    const state = startedState();
    const piece = state.spawnSystem.getHand()[0]!;
    const cell = state.grid.placeableCells(piece.length)[0];
    const placed = state.placePiece(0, cell.q, cell.r);
    expect(placed).toBe(piece);
    expect(cell.stack.map((b) => b.color)).toEqual(piece.map((b) => b.color));
    expect(state.spawnSystem.getHand()[0]).toBeNull();
  });

  it('keeps the piece bottom-to-top, so the last layer is the exposed top', () => {
    const state = startedState();
    const piece = state.spawnSystem.getHand()[1]!;
    const cell = state.grid.placeableCells(piece.length)[3];
    state.placePiece(1, cell.q, cell.r);
    expect(cell.stack[cell.stack.length - 1].id).toBe(piece[piece.length - 1].id);
    expect(cell.stack[0].id).toBe(piece[0].id);
  });

  it('refuses an occupied cell and changes nothing', () => {
    const state = startedState();
    const cell = state.grid.placeableCells(1)[0];
    state.placePiece(0, cell.q, cell.r);
    const before = cell.stack.map((b) => b.id);
    expect(state.placePiece(1, cell.q, cell.r)).toBeNull();
    expect(cell.stack.map((b) => b.id)).toEqual(before);
    expect(state.spawnSystem.getHand()[1]).not.toBeNull(); // not consumed
  });

  it('refuses a cell that is not on the board', () => {
    const state = startedState();
    expect(state.placePiece(0, 99, 99)).toBeNull();
    expect(state.spawnSystem.getHand()[0]).not.toBeNull();
  });

  it('refuses an empty hand slot', () => {
    const state = startedState();
    const [a, b] = state.grid.placeableCells(1);
    state.placePiece(0, a.q, a.r);
    expect(state.placePiece(0, b.q, b.r)).toBeNull();
  });

  it('refuses an obstacle cell', () => {
    const state = startedState(1); // level 2 has obstacles
    const obstacle = state.grid.allCells().find((c) => c.blockerHits > 0)!;
    expect(obstacle).toBeDefined();
    expect(state.placePiece(0, obstacle.q, obstacle.r)).toBeNull();
    expect(obstacle.stack).toHaveLength(0);
  });

  it('applyTurn rejects a move unless the game is waiting for one', () => {
    const state = startedState();
    const cell = state.grid.placeableCells(1)[0];
    state.status = GameStatus.PAUSED;
    expect(state.applyTurn(0, cell.q, cell.r)).toBeNull();
    state.status = GameStatus.RESOLVING;
    expect(state.applyTurn(0, cell.q, cell.r)).toBeNull();
    expect(cell.stack).toHaveLength(0);
  });
});

describe('scoring', () => {
  it('scores a clear by size and combo step', () => {
    expect(scoreForClear(5, 1)).toBe(50);
    expect(scoreForClear(6, 1)).toBe(90); // bigger clears are worth more per block
    expect(scoreForClear(7, 1)).toBe(140);
    expect(scoreForClear(5, 2)).toBe(100); // each chained clear multiplies
    expect(scoreForClear(5, 3)).toBe(150);
  });

  it('registerClear adds points and progress together', () => {
    const state = startedState();
    const points = state.registerClear(5, 1);
    expect(points).toBe(50);
    expect(state.scoreSystem.score).toBe(50);
    expect(state.levelManager.progress).toBe(5);
    state.registerClear(6, 2);
    expect(state.scoreSystem.score).toBe(50 + scoreForClear(6, 2));
    expect(state.levelManager.progress).toBe(11);
  });

  it('the combo streak counts consecutive turns with a clear and resets on a quiet turn', () => {
    const state = startedState();
    state.scoreSystem.onTurnResolved(true);
    state.scoreSystem.onTurnResolved(true);
    expect(state.scoreSystem.comboStreak).toBe(2);
    state.scoreSystem.onTurnResolved(false);
    expect(state.scoreSystem.comboStreak).toBe(0);
  });
});

describe('progress and level completion', () => {
  it('progress never goes past the goal', () => {
    const state = startedState();
    const target = state.levelManager.def.target;
    state.levelManager.addProgress(target - 3);
    state.levelManager.addProgress(50);
    expect(state.levelManager.progress).toBe(target);
    expect(state.levelManager.isComplete).toBe(true);
  });

  it('a level is not complete before the goal', () => {
    const state = startedState();
    state.levelManager.addProgress(state.levelManager.def.target - 1);
    expect(state.levelManager.isComplete).toBe(false);
    expect(state.turnOutcome()).toBe('continue');
  });

  it('completing a level pays the reward and unlocks the next level — exactly once', () => {
    const state = startedState();
    state.levelManager.addProgress(state.levelManager.def.target);
    const reward = state.levelManager.def.coinReward;
    expect(state.completeLevel()).toBe(reward);
    expect(state.status).toBe(GameStatus.LEVEL_COMPLETE);
    expect(state.levelManager.coins).toBe(reward);
    expect(state.levelManager.unlockedLevelIndex).toBe(1);
    // however many code paths notice it, the reward is not paid again
    expect(state.completeLevel()).toBe(0);
    expect(state.levelManager.coins).toBe(reward);
  });

  it('reaching the goal wins even if the board is also full', () => {
    const state = startedState();
    for (const c of state.grid.allCells()) c.stack = tiles([0]);
    state.levelManager.addProgress(state.levelManager.def.target);
    expect(state.turnOutcome()).toBe('complete');
  });

  it('a failed level cannot be turned into a win by a late failLevel call', () => {
    const state = startedState();
    state.levelManager.addProgress(state.levelManager.def.target);
    state.completeLevel();
    state.failLevel();
    expect(state.status).toBe(GameStatus.LEVEL_COMPLETE);
  });
});

describe('game over', () => {
  it('is "failed" when no hand piece fits anywhere', () => {
    const state = startedState();
    for (const c of state.grid.allCells()) if (c.blockerHits === 0) c.stack = tiles([0]);
    expect(state.canPlaceAnyHandPiece()).toBe(false);
    expect(state.turnOutcome()).toBe('failed');
  });

  it('is not failed while one empty cell is left', () => {
    const state = startedState();
    const cells = state.grid.allCells().filter((c) => c.blockerHits === 0);
    for (const c of cells) c.stack = tiles([0]);
    cells[0].stack = [];
    expect(state.turnOutcome()).toBe('continue');
  });

  it('an obstacle cell does not count as room', () => {
    const state = startedState(1);
    for (const c of state.grid.allCells()) if (c.blockerHits === 0) c.stack = tiles([0]);
    expect(state.grid.allCells().some((c) => c.blockerHits > 0 && c.stack.length === 0)).toBe(true);
    expect(state.canPlaceAnyHandPiece()).toBe(false);
  });

  it('failLevel marks the level failed, and Play on is the one way back', () => {
    const state = startedState();
    for (const c of state.grid.allCells()) if (c.blockerHits === 0) c.stack = tiles([0, 1]);
    state.failLevel();
    expect(state.status).toBe(GameStatus.LEVEL_FAILED);
    const result = state.playOn();
    expect(result).not.toBeNull();
    expect(result!.stacks).toHaveLength(3);
    expect(state.status).toBe(GameStatus.PLAYING);
    expect(state.playOnUsed).toBe(true);
    expect(state.canPlaceAnyHandPiece()).toBe(true);
    // only once per level, and only from the failed state
    state.failLevel();
    expect(state.playOn()).toBeNull();
  });

  it('Play on cannot be used while the game is running normally', () => {
    const state = startedState();
    expect(state.playOn()).toBeNull();
    expect(state.playOnUsed).toBe(false);
  });

  it('starting the level again makes Play on available again', () => {
    const state = startedState();
    state.failLevel();
    state.playOn();
    state.beginLevel(0);
    expect(state.playOnUsed).toBe(false);
  });
});

describe('obstacle damage', () => {
  it('a clear next to an obstacle hits it once; breaking happens at zero', () => {
    const state = startedState(1);
    const obstacle = state.grid.allCells().find((c) => c.blockerHits > 0)!;
    const neighbour = state.grid
      .getNeighbors(obstacle.q, obstacle.r)
      .map((n) => state.grid.getCell(n.q, n.r))
      .find((c) => c && c.blockerHits === 0)!;
    const startHits = obstacle.blockerHits;
    const hits = applyBlockerDamage(state.grid, [{ q: neighbour.q, r: neighbour.r }]);
    expect(hits.find((h) => h.q === obstacle.q && h.r === obstacle.r)).toMatchObject({ remaining: startHits - 1, cleared: false });
    expect(obstacle.blockerHits).toBe(startHits - 1);
  });

  it('every separate clear next to it is a separate hit, and the last one breaks it', () => {
    const state = startedState(1);
    const obstacle = state.grid.allCells().find((c) => c.blockerHits > 0)!;
    const neighbour = state.grid
      .getNeighbors(obstacle.q, obstacle.r)
      .map((n) => state.grid.getCell(n.q, n.r))
      .find((c) => c && c.blockerHits === 0)!;
    obstacle.blockerHits = 2;
    const clears = [{ q: neighbour.q, r: neighbour.r }, { q: neighbour.q, r: neighbour.r }];
    const hits = applyBlockerDamage(state.grid, clears).filter((h) => h.q === obstacle.q && h.r === obstacle.r);
    expect(hits).toHaveLength(2);
    expect(hits[1]).toMatchObject({ remaining: 0, cleared: true });
    expect(obstacle.blockerHits).toBe(0);
  });

  it('a clear that is not adjacent leaves every obstacle alone', () => {
    const state = startedState(1);
    const obstacle = state.grid.allCells().find((c) => c.blockerHits > 0)!;
    const far = state.grid.allCells().find((c) => state.grid.cellDistance(c, obstacle) >= 3 && c.blockerHits === 0)!;
    const before = state.grid.allCells().map((c) => c.blockerHits);
    expect(applyBlockerDamage(state.grid, [{ q: far.q, r: far.r }])).toEqual([]);
    expect(state.grid.allCells().map((c) => c.blockerHits)).toEqual(before);
  });

  it('a broken obstacle cell can then take a piece', () => {
    const state = startedState(1);
    const obstacle = state.grid.allCells().find((c) => c.blockerHits > 0)!;
    obstacle.blockerHits = 0;
    expect(state.grid.canAcceptPiece(obstacle, 3)).toBe(true);
  });
});

describe('a whole turn', () => {
  it('applyTurn places, resolves, scores, books progress and refills the hand', () => {
    const state = startedState();
    put(state.grid, -1, 0, [0, 0, 0]);
    put(state.grid, 1, 0, [0, 0]);
    const cellsBefore = state.grid.allCells().filter((c) => c.stack.length === 0).length;
    // Drop a piece whose top is color 0 between them if one exists; otherwise just make a move.
    const hand = state.spawnSystem.getHand();
    const slot = hand.findIndex((p) => p && p[p.length - 1].color === 0);
    const useSlot = slot >= 0 ? slot : 0;
    const piece = hand[useSlot]!;
    const target = state.grid.getCell(0, 0)!;
    const turn = state.applyTurn(useSlot, target.q, target.r);
    expect(turn).not.toBeNull();
    // the piece went somewhere and the board did not lose tiles it shouldn't have
    const total = state.grid.allCells().reduce((s, c) => s + c.stack.length, 0);
    const cleared = turn!.events.reduce((s, e) => s + (e.type === 'clear' ? e.ids.length : 0), 0);
    expect(total + cleared).toBe(5 + piece.length);
    expect(state.levelManager.progress).toBe(cleared);
    expect(cellsBefore).toBeGreaterThan(0);
  });

  it('after a turn the hand is refilled once it has been fully used', () => {
    const state = startedState();
    for (let slot = 0; slot < 3; slot++) {
      const piece = state.spawnSystem.getHand()[slot]!;
      const cell = state.grid.placeableCells(piece.length)[0];
      const turn = state.applyTurn(slot, cell.q, cell.r);
      if (!turn || state.status !== GameStatus.PLAYING) break;
    }
    if (state.status === GameStatus.PLAYING) expect(state.spawnSystem.getHand().every((p) => p !== null)).toBe(true);
  });
});

describe('pause and resume', () => {
  it('pauses a running level and resumes to exactly where it was', () => {
    const state = startedState();
    expect(state.canPause()).toBe(true);
    expect(state.pause()).toBe(true);
    expect(state.isPaused).toBe(true);
    expect(state.resume()).toBe(GameStatus.PLAYING);
    expect(state.status).toBe(GameStatus.PLAYING);
  });

  it('a cascade that was playing resumes as a cascade (RESOLVING), not as waiting for a move', () => {
    const state = startedState();
    state.status = GameStatus.RESOLVING;
    state.pause();
    expect(state.resume()).toBe(GameStatus.RESOLVING);
  });

  it('a drag in progress cannot be resumed; it comes back as plain "waiting for a move"', () => {
    const state = startedState();
    state.status = GameStatus.DRAGGING;
    state.pause();
    expect(state.resume()).toBe(GameStatus.PLAYING);
  });

  it('cannot pause outside a running level', () => {
    for (const status of [GameStatus.MENU, GameStatus.LEVEL_COMPLETE, GameStatus.LEVEL_FAILED, GameStatus.PAUSED]) {
      const state = startedState();
      state.status = status;
      expect(state.pause()).toBe(false);
      expect(state.status).toBe(status);
    }
  });

  it('pausing twice does not overwrite what to resume to', () => {
    const state = startedState();
    state.status = GameStatus.RESOLVING;
    state.pause();
    expect(state.pause()).toBe(false);
    expect(state.resume()).toBe(GameStatus.RESOLVING);
  });

  it('resume does nothing when not paused', () => {
    const state = startedState();
    expect(state.resume()).toBeNull();
    expect(state.status).toBe(GameStatus.PLAYING);
  });
});

describe('seeds', () => {
  it('reads ?seed= from a query string and falls back to random', () => {
    expect(resolveSeed('?seed=42')).toBe(42);
    expect(resolveSeed('?seed=0')).toBe(0);
    expect(resolveSeed('?other=1')).toBeGreaterThanOrEqual(0);
    expect(resolveSeed('?seed=abc')).toBeGreaterThanOrEqual(0);
  });

  it('works outside a browser (no window)', () => {
    expect(() => resolveSeed()).not.toThrow();
  });
});

describe('sanity', () => {
  it('the clear threshold is five blocks', () => {
    expect(COMPLETION_THRESHOLD).toBe(5);
  });

  it('colorsAt reads a stack bottom-to-top', () => {
    const state = startedState();
    put(state.grid, 0, 0, [2, 1, 0]);
    expect(colorsAt(state.grid, 0, 0)).toEqual([2, 1, 0]);
  });
});
