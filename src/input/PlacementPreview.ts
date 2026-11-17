import * as THREE from 'three';
import { COLORS, HEX_SIZE, LAYER_PITCH } from '../utils/config';
import { HexGrid } from '../board/HexGrid';

const VALID_COLOR = 0x4bd97e;
const INVALID_COLOR = 0xff5d6c;
const MAX_GHOST_LAYERS = 12;
const MAX_LINK_RINGS = 6;

export interface PreviewCandidate {
  q: number;
  r: number;
  nextLayer: number;
  valid: boolean;
  pieceLength: number;
  /** Color index of the dragged piece's top block. */
  linkColor: number;
  /** Neighbouring stacks that show that same color on top — tiles will flow between them and the dropped piece. */
  links: { q: number; r: number }[];
}

interface GhostDisc {
  group: THREE.Group;
  fill: THREE.Mesh;
  outline: THREE.LineSegments;
}

/**
 * A small reusable pool of ghost discs and link rings — never destroyed or
 * recreated per frame.
 *
 *  - The candidate cell shows a stack as tall as the piece being dragged:
 *    green with a gentle bob when the drop is allowed, a single red disc when
 *    it is not (occupied, blocked or off the board).
 *  - When the drop is allowed, every neighbouring stack that shows the piece's
 *    top color gets a pulsing ring in that color. Those are exactly the
 *    stacks tiles will flow between, so the player can see why things will
 *    move before they let go.
 */
export class PlacementPreview {
  private discs: GhostDisc[] = [];
  private rings: THREE.Mesh[] = [];
  private bobTime = 0;
  private current: PreviewCandidate | null = null;

  /** Ghost discs are parented under `boardRoot` (not the scene root) so they
   * rotate along with the board — a candidate cell's board-local position
   * (from HexGrid.coordinateToWorld) then always lands on the correct
   * visual spot no matter the board's current rotation. */
  constructor(private boardRoot: THREE.Group, private grid: HexGrid) {
    const discGeo = new THREE.CylinderGeometry(HEX_SIZE * 0.94, HEX_SIZE * 0.94, 0.06, 6).rotateY(Math.PI / 2);
    const edgeGeo = new THREE.EdgesGeometry(discGeo);
    for (let i = 0; i < MAX_GHOST_LAYERS; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: VALID_COLOR, transparent: true, opacity: 0.4, depthWrite: false });
      const fill = new THREE.Mesh(discGeo, mat);
      const lineMat = new THREE.LineBasicMaterial({ color: VALID_COLOR, transparent: true, opacity: 0.9 });
      const outline = new THREE.LineSegments(edgeGeo, lineMat);

      const group = new THREE.Group();
      group.add(fill);
      group.add(outline);
      group.visible = false;
      boardRoot.add(group);
      this.discs.push({ group, fill, outline });
    }

    const ringGeo = new THREE.RingGeometry(HEX_SIZE * 0.78, HEX_SIZE * 0.92, 6).rotateX(-Math.PI / 2).rotateY(Math.PI / 2);
    for (let i = 0; i < MAX_LINK_RINGS; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false, depthTest: false });
      const ring = new THREE.Mesh(ringGeo, mat);
      ring.visible = false;
      ring.renderOrder = 5;
      boardRoot.add(ring);
      this.rings.push(ring);
    }
  }

  setGrid(grid: HexGrid): void {
    this.grid = grid;
  }

  /** Shows the given candidate (or hides everything for null). */
  update(dtSeconds: number, candidate: PreviewCandidate | null): void {
    this.current = candidate;
    this.render(dtSeconds);
  }

  /** Call once per frame: keeps the bob and the link-ring pulse moving even
   * while the pointer is held still over a cell. */
  tick(dtSeconds: number): void {
    if (this.current) this.render(dtSeconds);
  }

  private render(dtSeconds: number): void {
    const candidate = this.current;
    if (!candidate) {
      for (const d of this.discs) d.group.visible = false;
      for (const r of this.rings) r.visible = false;
      return;
    }

    this.bobTime += dtSeconds;
    const bob = candidate.valid ? Math.sin(this.bobTime * 4) * 0.04 + 0.04 : 0;
    const color = candidate.valid ? VALID_COLOR : INVALID_COLOR;
    const layersShown = candidate.valid ? Math.min(candidate.pieceLength, MAX_GHOST_LAYERS) : 1;

    this.discs.forEach((disc, i) => {
      if (i >= layersShown) {
        disc.group.visible = false;
        return;
      }
      disc.group.visible = true;
      const world = this.grid.coordinateToWorld(candidate.q, candidate.r, candidate.nextLayer + i, LAYER_PITCH);
      disc.group.position.set(world.x, world.y + bob, world.z);
      (disc.fill.material as THREE.MeshBasicMaterial).color.setHex(color);
      (disc.outline.material as THREE.LineBasicMaterial).color.setHex(color);
    });

    const pulse = 0.5 + 0.5 * Math.sin(this.bobTime * 6);
    const ringColor = COLORS[candidate.linkColor] ?? VALID_COLOR;
    this.rings.forEach((ring, i) => {
      const link = candidate.valid ? candidate.links[i] : undefined;
      if (!link) {
        ring.visible = false;
        return;
      }
      const cell = this.grid.getCell(link.q, link.r);
      const height = cell ? cell.stack.length : 0;
      const world = this.grid.coordinateToWorld(link.q, link.r, height, LAYER_PITCH);
      ring.visible = true;
      ring.position.set(world.x, world.y + 0.06, world.z);
      const s = 1 + pulse * 0.08;
      ring.scale.set(s, 1, s);
      const mat = ring.material as THREE.MeshBasicMaterial;
      mat.color.setHex(ringColor);
      mat.opacity = 0.55 + pulse * 0.45;
    });
  }

  hide(): void {
    this.update(0, null);
  }

  dispose(): void {
    this.discs.forEach((d) => {
      d.group.removeFromParent();
    });
    this.rings.forEach((r) => {
      r.removeFromParent();
      (r.material as THREE.Material).dispose();
    });
    const first = this.discs[0];
    if (first) {
      first.fill.geometry.dispose();
      first.outline.geometry.dispose();
    }
    this.discs.forEach((d) => {
      (d.fill.material as THREE.Material).dispose();
      (d.outline.material as THREE.Material).dispose();
    });
    if (this.rings[0]) this.rings[0].geometry.dispose();
  }
}
