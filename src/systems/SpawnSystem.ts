import { GROUP_SIZE_WEIGHTS, HAND_SIZE } from '../utils/config';
import type { HexGrid } from '../board/HexGrid';
import { resolveBoard } from './MergeSystem';

let idCounter = 0;
export function generateBlockId(): string {
  idCounter += 1;
  return `blk_${idCounter}`;
}

export interface PieceLayer {
  id: string;
  color: number;
}

// bottom-to-top: index 0 is the BOTTOM of the stack (placed first, buried
// deepest), the LAST index is the TOP/exposed tile (the one that matters for
// top-color matching once placed). This matches HexBlockRef/Cell.stack
// elsewhere in the codebase — never reversed here.
export type Piece = PieceLayer[];

/** What the best single move for one piece would do on the current board. */
export interface PieceOutcome {
  cleared: number; // blocks removed by the cascade
  transfers: number; // blocks that flipped between stacks
  freedCells: number; // net empty cells gained (a clear that frees more room than the piece used)
  score: number;
}

/** How many candidate hands are generated and compared per refill. */
const CANDIDATE_HANDS = 6;
/** Per piece, only the most promising cells are actually simulated. */
const CELLS_SIMULATED_PER_PIECE = 4;

/**
 * Holds a hand of HAND_SIZE pieces the player can drag in any order. A slot
 * goes empty once its piece is placed; the whole hand refills together once
 * every slot has been used, matching the "wave" of pieces in the reference.
 *
 * Generation rules, all satisfied together:
 *
 * 1. HAND-WIDE: every refill first picks one fixed SET of colors
 *    (size min(activeColors, HAND_SIZE)) for the whole wave — the entire
 *    hand never shows more distinct colors than that set, however tall or
 *    mixed the individual pieces are.
 *
 * 2. PER-PIECE: every individual piece is built as exactly THREE contiguous
 *    color groups (A×n + B×m + C×k), using three different colors drawn
 *    from that same hand-wide set, each group a random positive size.
 *
 * 3. BOARD-AWARE (when a board is supplied): several candidate hands are
 *    generated and each is scored by looking one move ahead on a copy of the
 *    board. Hands are picked at random from the candidates, weighted toward
 *    better ones — more strongly the more crowded the board is — and a hand
 *    that leaves a crowded board with no useful move at all is rejected.
 *    On an open board every candidate is close to equally likely, so the
 *    game stays unpredictable; it only steps in when the board is tight.
 *
 * Everything draws from the one injected rng, so a fixed seed always gives
 * the same game.
 */
export class SpawnSystem {
  private hand: (Piece | null)[] = new Array(HAND_SIZE).fill(null);

  constructor(private rng: () => number) {}

  /** Picks the fixed color set for one hand wave — every piece this wave
   * will only ever use colors from this list. Colors scarcer on the board
   * are weighted slightly more likely to be picked (anti-frustration bias). */
  private pickHandColorSet(activeColors: number, boardColorCounts: number[]): number[] {
    const count = Math.max(1, Math.min(activeColors, HAND_SIZE));
    const remaining = Array.from({ length: activeColors }, (_, c) => c);
    const chosen: number[] = [];
    while (chosen.length < count && remaining.length > 0) {
      const weights = remaining.map((c) => 1 / (1 + (boardColorCounts[c] ?? 0)));
      const total = weights.reduce((sum, w) => sum + w, 0);
      let roll = this.rng() * total;
      let idx = remaining.length - 1;
      for (let i = 0; i < remaining.length; i++) {
        roll -= weights[i];
        if (roll <= 0) {
          idx = i;
          break;
        }
      }
      chosen.push(remaining[idx]);
      remaining.splice(idx, 1);
    }
    return chosen;
  }

  /** Fisher-Yates shuffle of the hand's color set — gives each piece its own
   * A/B/C ordering (so not every piece in a hand looks identical) while
   * still only ever using colors from that shared set. */
  private shuffledColorOrder(handColors: number[]): number[] {
    const order = [...handColors];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    // A piece needs exactly 3 different colors; if the hand's set is
    // smaller (only possible if activeColors < HAND_SIZE), cycle it back
    // around so the generator still always has 3 entries to draw from.
    while (order.length < 3) order.push(order[order.length % handColors.length]);
    return order;
  }

  private pickOneGroupSize(): number {
    const total = GROUP_SIZE_WEIGHTS.reduce((sum, w) => sum + w.weight, 0);
    let roll = this.rng() * total;
    for (const w of GROUP_SIZE_WEIGHTS) {
      roll -= w.weight;
      if (roll <= 0) return w.size;
    }
    return GROUP_SIZE_WEIGHTS[0].size;
  }

  /** Rolls a size for each of the 3 mandatory groups, then shrinks the
   * largest ones down (never below 1) until the total fits maxLayers. Every
   * group always ends up >= 1, so the three-groups structure is never
   * broken by the cap — a tightly-capped level just gets smaller groups. */
  private pickGroupSizes(maxLayers: number): [number, number, number] {
    const sizes: [number, number, number] = [this.pickOneGroupSize(), this.pickOneGroupSize(), this.pickOneGroupSize()];
    let total = sizes[0] + sizes[1] + sizes[2];
    let guard = 0;
    while (total > maxLayers && guard < 100) {
      const idx = sizes.indexOf(Math.max(...sizes)) as 0 | 1 | 2;
      if (sizes[idx] > 1) {
        sizes[idx] -= 1;
        total -= 1;
      } else {
        break; // already at the 1-1-1 floor; can't shrink further
      }
      guard += 1;
    }
    return sizes;
  }

  /** Builds one piece as exactly 3 contiguous color groups: colorOrder[0]
   * repeated sizes[0] times, then colorOrder[1] repeated sizes[1] times,
   * then colorOrder[2] repeated sizes[2] times — never interleaved. */
  private generatePiece(colorOrder: number[], maxLayers: number): Piece {
    const sizes = this.pickGroupSizes(maxLayers);
    const piece: Piece = [];
    for (let group = 0; group < 3; group++) {
      for (let i = 0; i < sizes[group]; i++) {
        piece.push({ id: generateBlockId(), color: colorOrder[group] });
      }
    }
    return piece;
  }

  private generateHand(activeColors: number, boardColorCounts: number[], maxLayers: number): Piece[] {
    const handColors = this.pickHandColorSet(activeColors, boardColorCounts);
    const hand: Piece[] = [];
    for (let i = 0; i < HAND_SIZE; i++) {
      hand.push(this.generatePiece(this.shuffledColorOrder(handColors), maxLayers));
    }
    return hand;
  }

  /**
   * Looks one move ahead: tries the piece on the cells most likely to matter
   * (empty cells touching a stack with the same top color first) on a copy of
   * the board and reports the best result. Returns null if the piece fits
   * nowhere. Pure — the real board is never touched.
   */
  static bestOutcome(grid: HexGrid, piece: Piece): PieceOutcome | null {
    const cells = grid.placeableCells(piece.length);
    if (cells.length === 0) return null;
    const topColor = piece[piece.length - 1].color;
    const emptyBefore = cells.length;

    const ranked = cells
      .map((cell, order) => {
        let links = 0;
        let neighbours = 0;
        for (const n of grid.getNeighbors(cell.q, cell.r)) {
          const other = grid.getCell(n.q, n.r);
          if (!other || other.stack.length === 0) continue;
          neighbours += 1;
          if (other.stack[other.stack.length - 1].color === topColor) links += 1;
        }
        return { cell, links, neighbours, order };
      })
      .sort((a, b) => b.links - a.links || b.neighbours - a.neighbours || a.order - b.order)
      .slice(0, CELLS_SIMULATED_PER_PIECE);

    let best: PieceOutcome = { cleared: 0, transfers: 0, freedCells: 0, score: 0 };
    for (const { cell } of ranked) {
      const trial = grid.clone();
      const target = trial.getCell(cell.q, cell.r)!;
      target.stack = piece.map((b) => ({ id: b.id, color: b.color }));
      const events = resolveBoard(trial, cell.q, cell.r);
      let cleared = 0;
      let transfers = 0;
      for (const e of events) {
        if (e.type === 'clear') cleared += e.ids.length;
        else transfers += 1;
      }
      const emptyAfter = trial.allCells().filter((c) => trial.canAcceptPiece(c, 1)).length;
      const freedCells = Math.max(0, emptyAfter - (emptyBefore - 1));
      const score = cleared * 4 + transfers * 2 + freedCells * 3;
      if (score > best.score) best = { cleared, transfers, freedCells, score };
    }
    return best;
  }

  /** Scores a whole hand on the given board: how much its best moves achieve,
   * plus a little for variety. `usable` is false for a hand with no useful
   * move at all on a crowded board. */
  static scoreHand(grid: HexGrid, hand: Piece[]): { score: number; bestPiece: number } {
    let total = 0;
    let bestPiece = 0;
    for (const piece of hand) {
      const outcome = SpawnSystem.bestOutcome(grid, piece);
      const s = outcome ? outcome.score : 0;
      total += s;
      bestPiece = Math.max(bestPiece, s);
    }
    const tops = new Set(hand.map((p) => p[p.length - 1].color));
    total += tops.size; // pieces that end in different colors give more choices
    return { score: total, bestPiece };
  }

  ensureHandFilled(activeColors: number, boardColorCounts: number[], maxLayers: number, grid?: HexGrid): void {
    if (!this.isHandEmpty()) return;

    if (!grid) {
      this.hand = this.generateHand(activeColors, boardColorCounts, maxLayers);
      return;
    }

    const cells = grid.allCells();
    const playable = cells.filter((c) => c.blockerHits === 0).length;
    const empty = cells.filter((c) => grid.canAcceptPiece(c, 1)).length;
    const crowd = playable > 0 ? 1 - empty / playable : 0; // 0 = open board, 1 = full
    const crowded = empty <= HAND_SIZE + 1;

    const candidates: { hand: Piece[]; score: number; bestPiece: number }[] = [];
    for (let i = 0; i < CANDIDATE_HANDS; i++) {
      const hand = this.generateHand(activeColors, boardColorCounts, maxLayers);
      candidates.push({ hand, ...SpawnSystem.scoreHand(grid, hand) });
    }

    // On a tight board, drop any hand with no useful move at all — but never
    // drop everything.
    let pool = candidates;
    if (crowded) {
      const useful = candidates.filter((c) => c.bestPiece > 0);
      if (useful.length > 0) pool = useful;
    }

    // Softmax pick: flat on an open board (unpredictable), steep on a crowded one (fair).
    const temperature = 12 - 10.5 * Math.pow(crowd, 1.5); // 12 .. 1.5
    const maxScore = Math.max(...pool.map((c) => c.score));
    const weights = pool.map((c) => Math.exp((c.score - maxScore) / temperature));
    const total = weights.reduce((sum, w) => sum + w, 0);
    let roll = this.rng() * total;
    let chosen = pool[pool.length - 1];
    for (let i = 0; i < pool.length; i++) {
      roll -= weights[i];
      if (roll <= 0) {
        chosen = pool[i];
        break;
      }
    }
    this.hand = chosen.hand;
  }

  getHand(): (Piece | null)[] {
    return this.hand;
  }

  consume(slot: number): void {
    this.hand[slot] = null;
  }

  isHandEmpty(): boolean {
    return this.hand.every((p) => p === null);
  }

  reset(): void {
    this.hand = new Array(HAND_SIZE).fill(null);
  }
}
