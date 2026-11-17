// Pure hex-grid math and board data. Zero rendering dependency — unit-testable
// without a WebGL context. Flat-top axial coordinates.

import { HEX_SIZE, MAX_STACK_HEIGHT } from '../utils/config';
import { Cell, cellKey, createCell } from './Cell';

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface AxialCoord {
  q: number;
  r: number;
}

export const AXIAL_DIRECTIONS: AxialCoord[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 }
];

export function cubeDistance(a: AxialCoord, b: AxialCoord): number {
  const ax = a.q,
    az = a.r,
    ay = -ax - az;
  const bx = b.q,
    bz = b.r,
    by = -bx - bz;
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by), Math.abs(az - bz));
}

export function axialRound(qf: number, rf: number): AxialCoord {
  let x = qf;
  let z = rf;
  let y = -x - z;
  let rx = Math.round(x);
  let ry = Math.round(y);
  let rz = Math.round(z);
  const xDiff = Math.abs(rx - x);
  const yDiff = Math.abs(ry - y);
  const zDiff = Math.abs(rz - z);
  if (xDiff > yDiff && xDiff > zDiff) {
    rx = -ry - rz;
  } else if (yDiff > zDiff) {
    ry = -rx - rz;
  } else {
    rz = -rx - ry;
  }
  return { q: rx, r: rz };
}

export interface ObstacleSpec {
  q: number;
  r: number;
  hits: number;
}

/**
 * Board for a single level, rebuilt fresh per level. Either a plain
 * radius-N hex-of-hexes, or an explicit set of `playableCells` for a
 * custom compact shape — either way, every generated cell uses the same
 * axial coordinate system and six-direction adjacency (`getNeighbors`),
 * so placement/matching/cascade/obstacle code never needs to know which
 * mode built the board.
 */
export class HexGrid {
  private cells = new Map<string, Cell>();
  readonly radius: number;

  constructor(radius: number, obstacles: ObstacleSpec[] = [], playableCells?: AxialCoord[]) {
    this.radius = radius;
    if (playableCells) {
      for (const { q, r } of playableCells) {
        this.cells.set(cellKey(q, r), createCell(q, r));
      }
    } else {
      for (let q = -radius; q <= radius; q++) {
        const rMin = Math.max(-radius, -q - radius);
        const rMax = Math.min(radius, -q + radius);
        for (let r = rMin; r <= rMax; r++) {
          this.cells.set(cellKey(q, r), createCell(q, r));
        }
      }
    }
    for (const obs of obstacles) {
      const cell = this.getCell(obs.q, obs.r);
      if (cell) cell.blockerHits = obs.hits;
    }
  }

  coordinateToWorld(q: number, r: number, stackIndex: number, blockHeight: number): Vec3Like {
    const worldX = HEX_SIZE * (1.5 * q);
    const worldZ = HEX_SIZE * ((Math.sqrt(3) / 2) * q + Math.sqrt(3) * r);
    const worldY = stackIndex * blockHeight;
    return { x: worldX, y: worldY, z: worldZ };
  }

  worldToCoordinate(worldX: number, worldZ: number): AxialCoord {
    const qf = (2 / 3) * (worldX / HEX_SIZE);
    const rf = (-1 / 3) * (worldX / HEX_SIZE) + (Math.sqrt(3) / 3) * (worldZ / HEX_SIZE);
    return axialRound(qf, rf);
  }

  getNeighbors(q: number, r: number): AxialCoord[] {
    return AXIAL_DIRECTIONS.map((d) => ({ q: q + d.q, r: r + d.r }));
  }

  isValidCell(q: number, r: number): boolean {
    return this.cells.has(cellKey(q, r));
  }

  getCell(q: number, r: number): Cell | null {
    return this.cells.get(cellKey(q, r)) ?? null;
  }

  allCells(): Cell[] {
    return Array.from(this.cells.values());
  }

  cellDistance(a: AxialCoord, b: AxialCoord): number {
    return cubeDistance(a, b);
  }

  /**
   * A dragged stack can only be dropped on an EMPTY cell — the puzzle
   * decision is which empty cell to use so its top color lines up with
   * neighboring stacks, not piling new layers directly onto an existing one.
   */
  canAcceptPiece(cell: Cell, pieceLength: number): boolean {
    if (cell.blockerHits > 0) return false;
    if (cell.stack.length > 0) return false;
    return pieceLength <= MAX_STACK_HEIGHT;
  }

  canPlacePieceAnywhere(pieceLength: number): boolean {
    for (const cell of this.cells.values()) {
      if (this.canAcceptPiece(cell, pieceLength)) return true;
    }
    return false;
  }

  /** Every cell that can currently take a dragged piece of this length. */
  placeableCells(pieceLength: number): Cell[] {
    return this.allCells().filter((c) => this.canAcceptPiece(c, pieceLength));
  }

  /** An independent copy of the board (stacks and blockers included), for
   * look-ahead — piece generation and the test bot try moves on copies. */
  clone(): HexGrid {
    const copy = new HexGrid(this.radius, [], this.allCells().map((c) => ({ q: c.q, r: c.r })));
    for (const cell of this.cells.values()) {
      const target = copy.getCell(cell.q, cell.r) as Cell;
      target.stack = cell.stack.map((b) => ({ id: b.id, color: b.color }));
      target.blockerHits = cell.blockerHits;
    }
    return copy;
  }
}
