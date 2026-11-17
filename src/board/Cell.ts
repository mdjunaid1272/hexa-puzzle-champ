export interface HexBlockRef {
  id: string;
  color: number; // ColorId index
}

export interface Cell {
  q: number;
  r: number;
  stack: HexBlockRef[]; // bottom-to-top
  /** Frozen blocker sitting on this cell. Must be cleared (hits -> 0) before it can be used. */
  blockerHits: number;
}

export function createCell(q: number, r: number): Cell {
  return { q, r, stack: [], blockerHits: 0 };
}

export function cellKey(q: number, r: number): string {
  return `${q},${r}`;
}
