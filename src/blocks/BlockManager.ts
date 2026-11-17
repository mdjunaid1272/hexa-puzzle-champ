import * as THREE from 'three';
import {
  BlockGeometries,
  buildBlockGroup,
  createBaseMaterials,
  createBlockGeometries,
  createTopMaterials,
  setBlockColor
} from './HexBlockMesh';

/**
 * Owns every live block mesh plus a pool of retired ones. Geometries and
 * materials are created once and shared — meshes are reused (never
 * recreated) across a block's lifetime and across pooled reuse after clears.
 */
export class BlockManager {
  private geometries: BlockGeometries;
  private topMaterials: THREE.Material[];
  private baseMaterials: THREE.Material[];
  private active = new Map<string, THREE.Group>();
  private pool: THREE.Group[] = [];

  constructor(private scene: THREE.Scene) {
    this.geometries = createBlockGeometries();
    this.topMaterials = createTopMaterials();
    this.baseMaterials = createBaseMaterials();
  }

  /** A returned mesh is always (re)parented to the flat scene root first,
   * regardless of pooling history — a mesh released after sitting under the
   * rotating boardRoot (a placed-then-cleared piece) must not silently stay
   * there if it's reacquired for the hand tray next. Callers reparent it to
   * wherever it actually belongs (a hand-tray group, or boardRoot) right
   * after acquiring; this just guarantees a known, neutral starting point. */
  acquire(blockId: string, colorIndex: number): THREE.Group {
    let group = this.pool.pop();
    if (!group) {
      group = buildBlockGroup(this.geometries, this.topMaterials, this.baseMaterials, colorIndex);
    } else {
      setBlockColor(group, this.topMaterials, this.baseMaterials, colorIndex);
    }
    this.scene.add(group);
    group.visible = true;
    group.scale.set(1, 1, 1);
    // A pooled group can carry a stale rotation from a PREVIOUS life: attach()
    // (used when reparenting onto the rotated boardRoot) bakes in whatever
    // compensating local rotation was needed to preserve world orientation at
    // that moment, and it never gets cleared on its own. Reset unconditionally
    // so every acquired block — new or reused — starts perfectly unrotated.
    group.rotation.set(0, 0, 0);
    this.active.set(blockId, group);
    return group;
  }

  getMesh(blockId: string): THREE.Group | undefined {
    return this.active.get(blockId);
  }

  getAllActiveMeshes(): THREE.Group[] {
    return Array.from(this.active.values());
  }

  release(blockId: string): void {
    const group = this.active.get(blockId);
    if (!group) return;
    this.active.delete(blockId);
    group.visible = false;
    // Pull it out of whatever it was parented to (a stack's pivot group, a
    // hand-tray group) immediately — a released block is done with that
    // parent, and leaving it behind as an invisible child would make that
    // parent look non-empty (e.g. a cell's pivot group failing an
    // "all children gone" check) even though nothing renders anymore.
    this.scene.add(group);
    this.pool.push(group);
  }

  releaseAll(): void {
    for (const id of Array.from(this.active.keys())) this.release(id);
  }

  dispose(): void {
    this.geometries.tile.dispose();
    // The top-face artwork textures are GPU memory too, not just the materials.
    this.topMaterials.forEach((m) => {
      (m as THREE.MeshBasicMaterial).map?.dispose();
      m.dispose();
    });
    this.baseMaterials.forEach((m) => m.dispose());
  }
}
