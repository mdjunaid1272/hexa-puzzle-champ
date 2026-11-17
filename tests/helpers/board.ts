// Small helpers for building boards in tests.

import { HexGrid } from '../../src/board/HexGrid';
import { Cell } from '../../src/board/Cell';

let n = 0;

/** A stack of tiles with the given colors, bottom-to-top, with fresh ids. */
export function tiles(colors: number[]): Cell['stack'] {
  return colors.map((color) => ({ id: `t${++n}`, color }));
}

/** The 19-cell radius-2 board with nothing on it. */
export function emptyGrid(): HexGrid {
  return new HexGrid(2);
}

/** Puts a stack on a cell and returns the cell. */
export function put(grid: HexGrid, q: number, r: number, colors: number[]): Cell {
  const cell = grid.getCell(q, r);
  if (!cell) throw new Error(`no cell at ${q},${r}`);
  cell.stack = tiles(colors);
  return cell;
}

/** The colors on a cell, bottom-to-top. */
export function colorsAt(grid: HexGrid, q: number, r: number): number[] {
  return (grid.getCell(q, r) as Cell).stack.map((b) => b.color);
}

/** Every tile id currently on the board. */
export function allIds(grid: HexGrid): string[] {
  return grid.allCells().flatMap((c) => c.stack.map((b) => b.id));
}
