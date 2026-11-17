export class Clock {
  private last = performance.now();
  private accumulatedPauseMs = 0;

  tick(): number {
    const now = performance.now();
    const deltaMs = now - this.last;
    this.last = now;
    // Clamp to avoid huge jumps after a tab was backgrounded.
    return Math.min(deltaMs, 100) / 1000;
  }

  resync(): void {
    this.last = performance.now();
  }
}
