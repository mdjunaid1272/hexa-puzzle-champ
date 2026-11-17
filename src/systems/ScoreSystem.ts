import { BASE_SCORE_PER_BLOCK, COMPLETION_THRESHOLD } from '../utils/config';

/** Points for one completed/cleared stack run, scaled by cascade depth. */
export function scoreForClear(count: number, comboStep: number): number {
  return Math.round(BASE_SCORE_PER_BLOCK * count * (1 + 0.5 * (count - COMPLETION_THRESHOLD)) * comboStep);
}

/** Tracks the running point total for floating "+N" popups and combo feedback within a level. */
export class ScoreSystem {
  score = 0;
  comboStreak = 0;

  addClearScore(count: number, comboStep: number): number {
    const points = scoreForClear(count, comboStep);
    this.score += points;
    return points;
  }

  onTurnResolved(hadClears: boolean): void {
    this.comboStreak = hadClears ? this.comboStreak + 1 : 0;
  }

  reset(): void {
    this.score = 0;
    this.comboStreak = 0;
  }
}
