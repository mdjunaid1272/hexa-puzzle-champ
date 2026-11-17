import { HexGrid } from '../board/HexGrid';
import { LevelManager } from '../systems/LevelManager';
import { ScoreSystem } from '../systems/ScoreSystem';
import { generateBlockId, Piece, SpawnSystem } from '../systems/SpawnSystem';
import { applyPlayOn, BoosterResult } from '../systems/BoosterSystem';
import { resolveBoard, ResolveEvent } from '../systems/MergeSystem';
import { applyBlockerDamage, BlockerHit } from '../systems/ObstacleSystem';
import { mulberry32, resolveSeed } from '../utils/prng';
import { COLORS } from '../utils/config';

export enum GameStatus {
  MENU = 'MENU',
  PLAYING = 'PLAYING',
  DRAGGING = 'DRAGGING',
  RESOLVING = 'RESOLVING',
  PAUSED = 'PAUSED',
  LEVEL_COMPLETE = 'LEVEL_COMPLETE',
  LEVEL_FAILED = 'LEVEL_FAILED'
}

/** What should happen once a turn (placement + its whole cascade) has fully played out. */
export type TurnOutcome = 'complete' | 'failed' | 'continue';

export class GameState {
  status: GameStatus = GameStatus.MENU;
  grid: HexGrid;
  levelManager = new LevelManager();
  scoreSystem = new ScoreSystem();
  spawnSystem: SpawnSystem;
  rng: () => number;
  statusBeforePause: GameStatus = GameStatus.PLAYING;
  /** Whether the once-per-level "Play on" rescue has been spent this attempt. */
  playOnUsed = false;

  /** `seed` fixes every random choice (piece generation) — same seed, same
   * game. Without it the `?seed=` URL parameter, then a random seed, is used. */
  constructor(private fixedSeed?: number) {
    this.rng = mulberry32(this.fixedSeed ?? resolveSeed());
    this.grid = new HexGrid(this.levelManager.def.boardRadius, this.levelManager.def.obstacles, this.levelManager.def.playableCells);
    this.spawnSystem = new SpawnSystem(this.rng);
  }

  boardColorCounts(): number[] {
    const counts = new Array(COLORS.length).fill(0);
    for (const cell of this.grid.allCells()) {
      for (const block of cell.stack) counts[block.color] += 1;
    }
    return counts;
  }

  beginLevel(levelIndex: number): void {
    this.rng = mulberry32(this.fixedSeed ?? resolveSeed());
    this.levelManager.startLevel(levelIndex);
    this.grid = new HexGrid(this.levelManager.def.boardRadius, this.levelManager.def.obstacles, this.levelManager.def.playableCells);
    for (const stack of this.levelManager.def.startingStacks) {
      const cell = this.grid.getCell(stack.q, stack.r);
      if (!cell) continue;
      cell.stack = stack.colors.map((color) => ({ id: generateBlockId(), color }));
    }
    this.scoreSystem.reset();
    this.playOnUsed = false;
    this.spawnSystem = new SpawnSystem(this.rng);
    this.refillHandIfNeeded();
    this.status = GameStatus.PLAYING;
  }

  refillHandIfNeeded(): void {
    const def = this.levelManager.def;
    this.spawnSystem.ensureHandFilled(def.activeColors, this.boardColorCounts(), def.maxPieceLayers, this.grid);
  }

  canPlaceAnyHandPiece(): boolean {
    for (const piece of this.spawnSystem.getHand()) {
      if (piece && this.grid.canPlacePieceAnywhere(piece.length)) return true;
    }
    return false;
  }

  /**
   * Puts the hand piece in `slot` onto cell (q, r). Pure board rule: the cell
   * must be on the board, empty and not blocked. Returns the piece that was
   * placed (bottom-to-top), or null — and changes nothing — if the move is
   * illegal.
   */
  placePiece(slot: number, q: number, r: number): Piece | null {
    const piece = this.spawnSystem.getHand()[slot];
    const cell = this.grid.getCell(q, r);
    if (!piece || !cell) return null;
    if (!this.grid.canAcceptPiece(cell, piece.length)) return null;
    cell.stack.push(...piece);
    this.spawnSystem.consume(slot);
    return piece;
  }

  /** Books one cleared run: adds its score (scaled by cascade depth) and its
   * blocks to the level goal. The single place both are calculated, used by
   * the on-screen cascade and by `applyTurn`. Returns the points awarded. */
  registerClear(blocks: number, comboStep: number): number {
    const points = this.scoreSystem.addClearScore(blocks, comboStep);
    this.levelManager.addProgress(blocks);
    return points;
  }

  /** Obstacles next to a cleared stack take one hit per clear. Returns the hits. */
  applyObstacleDamage(clears: { q: number; r: number }[]): BlockerHit[] {
    return applyBlockerDamage(this.grid, clears);
  }

  /**
   * One complete turn with no rendering: place, resolve the whole cascade,
   * score it, damage obstacles, refill the hand and decide what happens next.
   * The game plays the same steps with animation in between; the automated
   * tests and the level-balancing bot use this directly. Returns null (and
   * changes nothing) if the placement is illegal.
   */
  applyTurn(slot: number, q: number, r: number): { events: ResolveEvent[]; outcome: TurnOutcome; blockerHits: BlockerHit[] } | null {
    if (this.status !== GameStatus.PLAYING) return null;
    if (!this.placePiece(slot, q, r)) return null;
    const events = resolveBoard(this.grid, q, r);
    let comboStep = 0;
    const clears: { q: number; r: number }[] = [];
    for (const e of events) {
      if (e.type !== 'clear') continue;
      comboStep += 1;
      this.registerClear(e.ids.length, comboStep);
      clears.push({ q: e.q, r: e.r });
    }
    const blockerHits = this.applyObstacleDamage(clears);
    this.scoreSystem.onTurnResolved(comboStep > 0);
    if (this.levelManager.isComplete) {
      this.completeLevel();
      return { events, outcome: 'complete', blockerHits };
    }
    this.refillHandIfNeeded();
    const outcome = this.turnOutcome();
    if (outcome === 'failed') this.failLevel();
    return { events, outcome, blockerHits };
  }

  /** Decides what follows a fully resolved turn. A level that reached its goal
   * is complete even if the board is also full; otherwise it is failed once no
   * hand piece fits anywhere. */
  turnOutcome(): TurnOutcome {
    if (this.levelManager.isComplete) return 'complete';
    if (!this.canPlaceAnyHandPiece()) return 'failed';
    return 'continue';
  }

  /** Marks the level won and pays the reward — exactly once, however many
   * code paths notice the goal being reached. Returns the coins awarded
   * (0 if it had already been awarded). */
  completeLevel(): number {
    if (this.status === GameStatus.LEVEL_COMPLETE) return 0;
    this.status = GameStatus.LEVEL_COMPLETE;
    return this.levelManager.awardCoinsForLevelComplete();
  }

  failLevel(): void {
    if (this.status === GameStatus.LEVEL_COMPLETE) return;
    this.status = GameStatus.LEVEL_FAILED;
  }

  /** The once-per-level rescue after "No moves left": clears the tallest stacks.
   * Returns null if it was already used or the level isn't in the failed state. */
  playOn(): BoosterResult | null {
    if (this.status !== GameStatus.LEVEL_FAILED || this.playOnUsed) return null;
    this.playOnUsed = true;
    const result = applyPlayOn(this.grid);
    this.status = GameStatus.PLAYING;
    return result;
  }

  // ---- pause / resume ----------------------------------------------------

  get isPaused(): boolean {
    return this.status === GameStatus.PAUSED;
  }

  /** Only a running level (waiting for a move, or mid-cascade) can be paused. */
  canPause(): boolean {
    return this.status === GameStatus.PLAYING || this.status === GameStatus.RESOLVING || this.status === GameStatus.DRAGGING;
  }

  /** Returns true if it paused. Remembers what to go back to. */
  pause(): boolean {
    if (!this.canPause()) return false;
    // A drag cannot survive a pause, so it resumes as plain "waiting for a move".
    this.statusBeforePause = this.status === GameStatus.DRAGGING ? GameStatus.PLAYING : this.status;
    this.status = GameStatus.PAUSED;
    return true;
  }

  /** Returns the status it resumed to, or null if it wasn't paused. */
  resume(): GameStatus | null {
    if (this.status !== GameStatus.PAUSED) return null;
    this.status = this.statusBeforePause;
    return this.status;
  }
}
