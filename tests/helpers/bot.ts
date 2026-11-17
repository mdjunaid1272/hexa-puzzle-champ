// A headless player used by the tests and the level-balancing script. It uses
// the real game rules (GameState.applyTurn) with no rendering, and picks
// moves greedily by looking one move ahead — roughly an attentive casual
// player, not a perfect solver.

import { GameState, GameStatus } from '../../src/core/GameState';
import { resolveBoard } from '../../src/systems/MergeSystem';
import { Piece } from '../../src/systems/SpawnSystem';

export interface BotMove {
  slot: number;
  q: number;
  r: number;
  score: number;
}

/** Scores one candidate move by trying it on a copy of the board. */
function scoreMove(state: GameState, piece: Piece, q: number, r: number): number {
  const trial = state.grid.clone();
  const cell = trial.getCell(q, r)!;
  cell.stack = piece.map((b) => ({ id: b.id, color: b.color }));
  const events = resolveBoard(trial, q, r);
  let cleared = 0;
  let transfers = 0;
  for (const e of events) {
    if (e.type === 'clear') cleared += e.ids.length;
    else transfers += 1;
  }
  const empty = trial.allCells().filter((c) => trial.canAcceptPiece(c, 1)).length;
  // Prefer: clearing, then keeping the board open, then flipping tiles together.
  let score = cleared * 10 + empty * 1.5 + transfers * 2;
  // Mild preference for touching other stacks (more chances to merge later)
  // over scattering pieces into isolated corners.
  const touching = trial
    .getNeighbors(q, r)
    .map((n) => trial.getCell(n.q, n.r))
    .filter((c) => c && c.stack.length > 0).length;
  score += touching * 0.3;
  return score;
}

export function chooseMove(state: GameState): BotMove | null {
  let best: BotMove | null = null;
  state.spawnSystem.getHand().forEach((piece, slot) => {
    if (!piece) return;
    for (const cell of state.grid.placeableCells(piece.length)) {
      const score = scoreMove(state, piece, cell.q, cell.r);
      if (!best || score > best.score) best = { slot, q: cell.q, r: cell.r, score };
    }
  });
  return best;
}

export interface PlayResult {
  won: boolean;
  moves: number;
  progress: number;
  target: number;
}

/** Plays one level to the end (win, no moves left, or the move limit). */
export function playLevel(levelIndex: number, seed: number, maxMoves = 400): PlayResult {
  const state = new GameState(seed);
  state.beginLevel(levelIndex);
  // A level may start with matching stacks already placed; settle them like the game does.
  let moves = 0;
  while (state.status === GameStatus.PLAYING && moves < maxMoves) {
    const move = chooseMove(state);
    if (!move) {
      state.failLevel();
      break;
    }
    state.applyTurn(move.slot, move.q, move.r);
    moves += 1;
  }
  return {
    won: state.status === GameStatus.LEVEL_COMPLETE,
    moves,
    progress: state.levelManager.progress,
    target: state.levelManager.def.target
  };
}
