export interface UICallbacks {
  onResume: () => void;
  onMuteToggle: () => void;
  onRestartLevel: () => void;
  onNextLevel: () => void;
  onRetryLevel: () => void;
  onMainMenu: () => void;
  onPlayOn: () => void;
  onShuffle: () => void;
  onRocket: () => void;
  onMiniRocket: () => void;
  onSplashPlay: () => void;
  onLevelIntroContinue: () => void;
  onResetLevelRequested: () => void;
  onResetLevelConfirmed: () => void;
  onResetLevelCancelled: () => void;
}

export class UIManager {
  private hud = document.getElementById('hud') as HTMLDivElement;
  private overlaySplash = document.getElementById('overlay-splash') as HTMLDivElement;
  private overlayPause = document.getElementById('overlay-pause') as HTMLDivElement;
  private overlayVictory = document.getElementById('overlay-victory') as HTMLDivElement;
  private overlayFail = document.getElementById('overlay-fail') as HTMLDivElement;
  private overlayLevelIntro = document.getElementById('overlay-level-intro') as HTMLDivElement;
  private overlayResetConfirm = document.getElementById('overlay-reset-confirm') as HTMLDivElement;
  private progressFill = document.getElementById('progress-fill') as HTMLDivElement;
  private progressText = document.getElementById('progress-text') as HTMLSpanElement;
  private coinValue = document.getElementById('coin-value') as HTMLSpanElement;
  private comboBadge = document.getElementById('combo-badge') as HTMLDivElement;
  private hintPill = document.getElementById('hint-pill') as HTMLDivElement;
  private victoryLevel = document.getElementById('victory-level') as HTMLParagraphElement;
  private victoryCoins = document.getElementById('victory-coins') as HTMLSpanElement;
  private levelIntroNumber = document.getElementById('level-intro-number') as HTMLParagraphElement;
  private levelIntroTarget = document.getElementById('level-intro-target') as HTMLSpanElement;
  private btnNextLevel = document.getElementById('btn-next-level') as HTMLButtonElement;
  private failLevel = document.getElementById('fail-level') as HTMLParagraphElement;
  private failRemaining = document.getElementById('fail-remaining') as HTMLSpanElement;
  private btnPlayOn = document.getElementById('btn-play-on') as HTMLButtonElement;
  private btnRocket = document.getElementById('btn-rocket') as HTMLButtonElement;
  private btnShuffle = document.getElementById('btn-shuffle') as HTMLButtonElement;
  private btnMiniRocket = document.getElementById('btn-mini-rocket') as HTMLButtonElement;
  private shuffleCount = document.getElementById('shuffle-count') as HTMLSpanElement;
  private rocketCount = document.getElementById('rocket-count') as HTMLSpanElement;
  private miniRocketCount = document.getElementById('mini-rocket-count') as HTMLSpanElement;
  private splashStats = document.getElementById('splash-stats') as HTMLDivElement;
  private splashLevels = document.getElementById('splash-levels') as HTMLSpanElement;
  private splashCoins = document.getElementById('splash-coins') as HTMLSpanElement;
  private settingsPanel = document.getElementById('settings-panel') as HTMLDivElement;
  private soundIcon = document.getElementById('sound-icon') as HTMLImageElement;
  private splashSoundIcon = document.getElementById('splash-sound-icon') as HTMLImageElement;

  constructor(callbacks: UICallbacks) {
    (document.getElementById('btn-splash-play') as HTMLButtonElement).addEventListener('click', callbacks.onSplashPlay);
    (document.getElementById('btn-retry-level') as HTMLButtonElement).addEventListener('click', callbacks.onRetryLevel);
    (document.getElementById('btn-resume') as HTMLButtonElement).addEventListener('click', callbacks.onResume);
    (document.getElementById('btn-main-menu') as HTMLAnchorElement).addEventListener('click', (e) => {
      e.preventDefault();
      callbacks.onMainMenu();
    });
    this.btnNextLevel.addEventListener('click', callbacks.onNextLevel);
    this.btnPlayOn.addEventListener('click', callbacks.onPlayOn);
    (document.getElementById('btn-fail-close') as HTMLButtonElement).addEventListener('click', callbacks.onMainMenu);
    this.btnShuffle.addEventListener('click', callbacks.onShuffle);
    this.btnRocket.addEventListener('click', callbacks.onRocket);
    this.btnMiniRocket.addEventListener('click', callbacks.onMiniRocket);
    (document.getElementById('btn-level-intro-continue') as HTMLButtonElement).addEventListener('click', callbacks.onLevelIntroContinue);
    (document.getElementById('btn-splash-reset') as HTMLButtonElement).addEventListener('click', callbacks.onResetLevelRequested);
    (document.getElementById('btn-reset-confirm') as HTMLButtonElement).addEventListener('click', callbacks.onResetLevelConfirmed);
    (document.getElementById('btn-reset-cancel') as HTMLAnchorElement).addEventListener('click', (e) => {
      e.preventDefault();
      callbacks.onResetLevelCancelled();
    });

    // Settings gear: toggles a small dropdown (sound + replay) rather than
    // triggering a Game callback directly — purely local UI state, nothing
    // for Game.ts to know about. Closes on an outside click, and again
    // after either action inside it so it never lingers open.
    const settingsBtn = document.getElementById('btn-settings') as HTMLButtonElement;
    const closeSettingsPanel = () => this.settingsPanel.classList.add('hidden');
    settingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.settingsPanel.classList.toggle('hidden');
    });
    document.addEventListener('click', (e) => {
      if (!this.settingsPanel.classList.contains('hidden') && !this.settingsPanel.contains(e.target as Node) && e.target !== settingsBtn) {
        closeSettingsPanel();
      }
    });
    (document.getElementById('btn-sound-toggle') as HTMLButtonElement).addEventListener('click', () => {
      callbacks.onMuteToggle();
    });
    (document.getElementById('btn-splash-sound') as HTMLButtonElement).addEventListener('click', () => {
      callbacks.onMuteToggle();
    });
    (document.getElementById('btn-replay') as HTMLButtonElement).addEventListener('click', () => {
      callbacks.onRestartLevel();
      closeSettingsPanel();
    });
  }

  showSplash(levelsCleared: number, coins: number): void {
    if (levelsCleared > 0 || coins > 0) {
      this.splashLevels.textContent = String(levelsCleared);
      this.splashCoins.textContent = String(coins);
      this.splashStats.classList.remove('hidden');
    } else {
      this.splashStats.classList.add('hidden');
    }
    this.overlaySplash.classList.remove('hidden');
    this.overlayPause.classList.add('hidden');
    this.overlayVictory.classList.add('hidden');
    this.overlayFail.classList.add('hidden');
    this.overlayLevelIntro.classList.add('hidden');
    this.overlayResetConfirm.classList.add('hidden');
    this.hud.classList.add('hidden');
  }

  showHUD(): void {
    this.overlaySplash.classList.add('hidden');
    this.overlayPause.classList.add('hidden');
    this.overlayVictory.classList.add('hidden');
    this.overlayFail.classList.add('hidden');
    this.hud.classList.remove('hidden');
  }

  showPaused(): void {
    this.overlayPause.classList.remove('hidden');
  }

  hidePaused(): void {
    this.overlayPause.classList.add('hidden');
  }

  /** Shown once per level start, before input is enabled — matches the
   * reference's "Level N / GOAL / target" interstitial. */
  showLevelIntro(levelNumber: number, target: number): void {
    this.levelIntroNumber.textContent = `Level ${levelNumber}`;
    this.levelIntroTarget.textContent = String(target);
    this.overlayLevelIntro.classList.remove('hidden');
  }

  hideLevelIntro(): void {
    this.overlayLevelIntro.classList.add('hidden');
  }

  showResetConfirm(): void {
    this.overlayResetConfirm.classList.remove('hidden');
  }

  hideResetConfirm(): void {
    this.overlayResetConfirm.classList.add('hidden');
  }

  showVictory(levelNumber: number, coinsAwarded: number, isLastLevel: boolean): void {
    this.victoryLevel.textContent = `Level ${levelNumber}`;
    this.victoryCoins.textContent = `+${coinsAwarded}`;
    // The button's label is painted into the board artwork ("NEXT LEVEL"), so
    // only its accessible name changes on the last level.
    this.btnNextLevel.setAttribute('aria-label', isLastLevel ? 'Back to menu' : 'Next level');
    this.overlayVictory.classList.remove('hidden');
  }

  /** "No moves left" board: shows the level, how many blocks were still
   * needed, and greys out PLAY ON once it has been used this level. */
  showFail(levelNumber: number, remaining: number, canPlayOn: boolean): void {
    this.failLevel.textContent = `Level ${levelNumber}`;
    this.failRemaining.textContent = String(remaining);
    this.btnPlayOn.classList.toggle('used', !canPlayOn);
    this.overlayFail.classList.remove('hidden');
  }

  hideFail(): void {
    this.overlayFail.classList.add('hidden');
  }

  setProgress(current: number, target: number): void {
    const pct = Math.min(100, (current / target) * 100);
    this.progressFill.style.width = `${pct}%`;
    this.progressText.textContent = `${current} / ${target}`;
  }

  setCoins(value: number): void {
    this.coinValue.textContent = String(value);
  }

  setCombo(comboStep: number | null): void {
    if (!comboStep || comboStep < 2) {
      this.comboBadge.classList.add('hidden');
      return;
    }
    this.comboBadge.classList.remove('hidden');
    this.comboBadge.textContent = `COMBO x${comboStep}`;
    this.comboBadge.style.transform = 'scale(1.15)';
    requestAnimationFrame(() => {
      this.comboBadge.style.transform = 'scale(1)';
    });
  }

  setBoosterCharges(shuffle: number, rocket: number, miniRocket: number): void {
    this.shuffleCount.textContent = String(shuffle);
    this.rocketCount.textContent = String(rocket);
    this.miniRocketCount.textContent = String(miniRocket);
    this.btnShuffle.disabled = shuffle <= 0;
    this.btnRocket.disabled = rocket <= 0;
    this.btnMiniRocket.disabled = miniRocket <= 0;
  }

  /** Shows a one-line hint under the HUD, or hides it for null. */
  setHint(text: string | null): void {
    if (!text) {
      this.hintPill.classList.add('hidden');
      return;
    }
    this.hintPill.textContent = text;
    this.hintPill.classList.remove('hidden');
  }

  setRocketArmed(armed: boolean): void {
    this.btnRocket.classList.toggle('armed', armed);
    this.setHint(armed ? 'Tap a stack to blast it' : null);
  }

  setMiniRocketArmed(armed: boolean): void {
    this.btnMiniRocket.classList.toggle('armed', armed);
    this.setHint(armed ? 'Tap a stack: it and 2 neighbours go' : null);
  }

  setMuted(muted: boolean): void {
    // new URL(..., import.meta.url) lets Vite bundle and hash these images;
    // a plain 'img/...' string is never copied into dist and shows broken.
    const src = muted
      ? new URL('../../img/buttons/sound-off-button.png', import.meta.url).href
      : new URL('../../img/buttons/sound-on-button.png', import.meta.url).href;
    this.soundIcon.src = src;
    this.splashSoundIcon.src = src; // the start screen's sound button shows the same state
  }
}
