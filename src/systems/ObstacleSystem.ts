import { HexGrid } from '../board/HexGrid';

export interface BlockerHit {
  q: number;
  r: number;
  remaining: number;
  cleared: boolean;
}

/**
 * Frozen blocker cells take one point of damage whenever a match clears in a
 * hex-adjacent cell. Returns every blocker that was hit this resolve pass
 * (for effects), each flagged if that hit broke it.
 */
export function applyBlockerDamage(grid: HexGrid, touchedCells: { q: number; r: number }[]): BlockerHit[] {
  const hits: BlockerHit[] = [];

  // Each entry in touchedCells is one distinct clear event, so a blocker
  // adjacent to two separate clears in the same cascade (whether that's the
  // same cell clearing twice or two different neighboring cells) takes
  // damage for each one — not capped at one hit per resolve() call. A
  // single cell can only list a given neighbor once, so this never
  // double-counts a single clear event against the same blocker.
  for (const { q, r } of touchedCells) {
    for (const n of grid.getNeighbors(q, r)) {
      const cell = grid.getCell(n.q, n.r);
      if (!cell || cell.blockerHits <= 0) continue;
      cell.blockerHits -= 1;
      hits.push({ q: n.q, r: n.r, remaining: cell.blockerHits, cleared: cell.blockerHits <= 0 });
    }
  }

  return hits;
}
