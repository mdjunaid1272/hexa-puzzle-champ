import { BOOSTER_STARTING_CHARGES, STORAGE_KEYS } from '../utils/config';
import { getLevelDef, LevelDef } from '../utils/levels';

export type BoosterId = 'shuffle' | 'rocket' | 'miniRocket';

export class LevelManager {
  levelIndex = 0; // 0-based; unbounded — see getLevelDef for what happens past the hand-authored levels
  progress = 0;
  coins = 0;
  unlockedLevelIndex = 0;
  boosterCharges: Record<BoosterId, number> = { shuffle: 0, rocket: 0, miniRocket: 0 };

  constructor() {
    this.coins = this.load(STORAGE_KEYS.coins);
    this.unlockedLevelIndex = this.load(STORAGE_KEYS.unlockedLevel);
  }

  get def(): LevelDef {
    return getLevelDef(this.levelIndex);
  }

  /** Levels never run out — there is no "last level" to gate the victory
   * screen's Next/Menu choice on. */
  get isLastLevel(): boolean {
    return false;
  }

  startLevel(index: number): void {
    this.levelIndex = Math.max(0, index);
    this.progress = 0;
    this.boosterCharges = { shuffle: BOOSTER_STARTING_CHARGES, rocket: BOOSTER_STARTING_CHARGES, miniRocket: BOOSTER_STARTING_CHARGES };
  }

  /** Sends the player back to Level 1 — coins and booster charges are left
   * untouched, only which level is unlocked/current gets wound back. */
  resetProgress(): void {
    this.levelIndex = 0;
    this.unlockedLevelIndex = 0;
    this.save(STORAGE_KEYS.unlockedLevel, this.unlockedLevelIndex);
  }

  useBooster(id: BoosterId): boolean {
    if (this.boosterCharges[id] <= 0) return false;
    this.boosterCharges[id] -= 1;
    return true;
  }

  addProgress(amount: number): void {
    this.progress = Math.min(this.def.target, this.progress + amount);
  }

  get isComplete(): boolean {
    return this.progress >= this.def.target;
  }

  awardCoinsForLevelComplete(): number {
    const reward = this.def.coinReward;
    this.coins += reward;
    this.save(STORAGE_KEYS.coins, this.coins);
    if (this.levelIndex + 1 > this.unlockedLevelIndex) {
      this.unlockedLevelIndex = this.levelIndex + 1;
      this.save(STORAGE_KEYS.unlockedLevel, this.unlockedLevelIndex);
    }
    return reward;
  }

  private load(key: string): number {
    try {
      const raw = localStorage.getItem(key);
      return raw ? Number(raw) || 0 : 0;
    } catch {
      return 0;
    }
  }

  private save(key: string, value: number): void {
    try {
      localStorage.setItem(key, String(value));
    } catch {
      // private-browsing / storage disabled — ignore
    }
  }
}
