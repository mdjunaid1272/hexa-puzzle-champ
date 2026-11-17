import { STORAGE_KEYS } from '../utils/config';

/**
 * Thin Web Audio wrapper. All sounds are tiny synthesized tones generated at
 * runtime (oscillator + gain envelope) rather than loaded audio files, so the
 * game ships with zero external audio assets while still giving readable,
 * distinct feedback per event.
 */
export class AudioManager {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  muted = false;

  constructor() {
    this.muted = this.loadMuted();
  }

  private ensureContext(): void {
    if (this.ctx) return;
    // Browsers only allow audio after the page has had a real user gesture.
    // Until then, stay silent instead of creating a context that would just
    // log an autoplay warning; unlock() creates it from the first tap/click.
    const activation = typeof navigator !== 'undefined' ? navigator.userActivation : undefined;
    if (activation && !activation.hasBeenActive) return;
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new AudioCtx();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = this.muted ? 0 : 0.5;
    this.masterGain.connect(this.ctx.destination);
  }

  /** Must be called from a user gesture (first pointerdown/click) per browser autoplay policy. */
  unlock(): void {
    this.ensureContext();
    if (this.ctx?.state === 'suspended') void this.ctx.resume();
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    this.saveMuted();
    if (this.masterGain) this.masterGain.gain.value = this.muted ? 0 : 0.5;
    return this.muted;
  }

  private tone(freq: number, durationSec: number, type: OscillatorType, delaySec = 0, gainScale = 1): void {
    if (this.muted || !this.ctx || !this.masterGain) return; // nothing to schedule while muted
    const t0 = this.ctx.currentTime + delaySec;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(0.35 * gainScale, t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + durationSec);
    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(t0);
    osc.stop(t0 + durationSec + 0.02);
  }

  pickup(): void {
    this.ensureContext();
    this.tone(520, 0.08, 'sine');
  }

  drop(): void {
    this.ensureContext();
    this.tone(300, 0.1, 'triangle');
  }

  match(): void {
    this.ensureContext();
    this.tone(660, 0.16, 'sine');
  }

  /** One tile flipping onto another stack. `chainIndex` is how many tiles
   * have already flipped in this cascade: each one is a semitone higher
   * (up to an octave), so a long chain audibly climbs and the sound follows
   * what the player is watching. */
  merge(chainIndex = 0): void {
    this.ensureContext();
    const lift = Math.pow(2, Math.min(chainIndex, 12) / 12);
    this.tone(440 * lift, 0.07, 'triangle');
    this.tone(560 * lift, 0.09, 'triangle', 0.05, 0.8);
  }

  /** A refused drop: short, low and soft so it reads as "not there" without being harsh. */
  invalid(): void {
    this.ensureContext();
    this.tone(190, 0.1, 'triangle', 0, 0.6);
    this.tone(150, 0.12, 'triangle', 0.06, 0.5);
  }

  cascade(comboStep: number): void {
    this.ensureContext();
    const base = 520 + comboStep * 70;
    this.tone(base, 0.14, 'sine');
    this.tone(base * 1.5, 0.14, 'sine', 0.04, 0.7);
  }

  combo(comboStep: number): void {
    this.ensureContext();
    const notes = [523.25, 659.25, 783.99, 1046.5];
    for (let i = 0; i < Math.min(comboStep, notes.length); i++) {
      this.tone(notes[i], 0.22, 'triangle', i * 0.05, 0.8);
    }
  }

  gameOver(): void {
    this.ensureContext();
    this.tone(392, 0.3, 'sawtooth');
    this.tone(261.6, 0.4, 'sawtooth', 0.15, 0.8);
  }

  click(): void {
    this.ensureContext();
    this.tone(440, 0.05, 'square', 0, 0.4);
  }

  private loadMuted(): boolean {
    try {
      return localStorage.getItem(STORAGE_KEYS.muted) === '1';
    } catch {
      return false;
    }
  }

  private saveMuted(): void {
    try {
      localStorage.setItem(STORAGE_KEYS.muted, this.muted ? '1' : '0');
    } catch {
      // ignore
    }
  }
}
