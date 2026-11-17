import * as THREE from 'three';
import { HexGrid } from './HexGrid';
import { BLOCK_HEIGHT, HEX_SIZE } from '../utils/config';
import { fixHexCapUvAspectRatio } from '../utils/hexCapUv';

const PAD_HEIGHT = 0.08;
const PAD_RADIUS = HEX_SIZE * 1.002; // very slight overlap so cells tile with no visible seam
const BASE_COLOR = new THREE.Color(0xf0faff); // pale icy blue tint
const PAD_OPACITY = 0.86;
const OBSTACLE_HEIGHT = 0.234; // fixed: obstacle blocks keep their original thickness while block layers are thin // slightly translucent, like frosted glass // multiplies the white platform texture: slightly darker grey instead of pure white
const PAD_TEXTURE_URL = new URL('../../img/platform.png', import.meta.url).href;

interface ObstacleView {
  q: number;
  r: number;
  mesh: THREE.Group;
  label: HTMLDivElement;
}

/**
 * Renders one level's board: a glossy hex pad per cell (single InstancedMesh,
 * one draw call) plus a small icy blocker mesh + hit-count label for every
 * obstacle cell. Rebuilt fresh whenever a level starts, since board size and
 * obstacle layout are level-specific.
 */
export class BoardRenderer {
  private padMesh: THREE.InstancedMesh;
  private obstacles: ObstacleView[] = [];
  private dummy = new THREE.Object3D();
  private labelLayer: HTMLElement;
  private texture: THREE.Texture;

  /** `boardRoot` is the rotating group everything visual lives under — the
   * board can spin freely around it without this class knowing or caring;
   * every position here is BOARD-LOCAL, computed the same way regardless of
   * boardRoot's current rotation. Obstacle hit-count labels are the one
   * exception: being DOM elements, they need actual world-space screen
   * projection, so `updateLabels` converts local->world via boardRoot. */
  constructor(private boardRoot: THREE.Group, private grid: HexGrid) {
    this.labelLayer = document.getElementById('popup-layer') as HTMLElement;

    const cells = grid.allCells();
    // CylinderGeometry's hex cap has a vertex on +Z / flat edges on +X by default;
    // our axial->world formulas assume the opposite (flat-top: vertex on +X),
    // so every hex geometry needs a 90° yaw to tile without seams.
    const geometry = new THREE.CylinderGeometry(PAD_RADIUS, PAD_RADIUS, PAD_HEIGHT, 6).rotateY(Math.PI / 2);
    // 0.93: platform.png's hex silhouette has rounded corners that fall
    // short of a true vertex — see fixHexCapUvAspectRatio's zoom param.
    fixHexCapUvAspectRatio(geometry, 0.93);
    this.texture = new THREE.TextureLoader().load(PAD_TEXTURE_URL);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    // MeshBasicMaterial (unlit) — a lit material reads the white platform.png
    // pixels and then darkens them under scene lighting, so the cell never
    // quite reads as PURE white. This just displays the texture's own pixels
    // untouched, same fix already applied to the hexablocks' top face.
    const material = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, opacity: PAD_OPACITY, depthWrite: true }); // tint comes from the per-tile instance color below (applying it here too would square it)
    this.padMesh = new THREE.InstancedMesh(geometry, material, cells.length);
    this.padMesh.receiveShadow = true;

    cells.forEach((cell, i) => {
      const world = grid.coordinateToWorld(cell.q, cell.r, 0, BLOCK_HEIGHT);
      this.dummy.position.set(world.x, -PAD_HEIGHT / 2, world.z);
      this.dummy.scale.set(1, 1, 1);
      this.dummy.updateMatrix();
      this.padMesh.setMatrixAt(i, this.dummy.matrix);
      this.padMesh.setColorAt(i, BASE_COLOR);

      if (cell.blockerHits > 0) {
        this.obstacles.push(this.buildObstacle(cell.q, cell.r));
      }
    });
    if (this.padMesh.instanceColor) this.padMesh.instanceColor.needsUpdate = true;

    boardRoot.add(this.padMesh);
  }

  private buildObstacle(q: number, r: number): ObstacleView {
    const world = this.grid.coordinateToWorld(q, r, 0, BLOCK_HEIGHT);
    const geo = new THREE.CylinderGeometry(HEX_SIZE * 0.88, HEX_SIZE * 0.88, OBSTACLE_HEIGHT, 6).rotateY(Math.PI / 2);
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0xbfe7f7,
      transparent: true,
      opacity: 0.72,
      roughness: 0.1,
      transmission: 0.35,
      clearcoat: 1,
      clearcoatRoughness: 0.05
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(world.x, OBSTACLE_HEIGHT / 2, world.z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const group = new THREE.Group();
    group.add(mesh);
    this.boardRoot.add(group);

    const label = document.createElement('div');
    label.className = 'floating-popup ghost-badge';
    label.style.fontSize = '14px';
    this.labelLayer.appendChild(label);

    return { q, r, mesh: group, label };
  }

  private tmpLabelPos = new THREE.Vector3();

  /** Call once per frame while obstacles remain, to keep hit-count labels pinned to their cell. */
  updateLabels(camera: THREE.Camera, canvas: HTMLCanvasElement): void {
    if (this.obstacles.length === 0) return;
    const rect = canvas.getBoundingClientRect();
    const pos = this.tmpLabelPos; // one reused vector — this runs every frame
    for (const obs of this.obstacles) {
      const cell = this.grid.getCell(obs.q, obs.r);
      if (!cell || cell.blockerHits <= 0) {
        obs.label.style.display = 'none';
        continue;
      }
      const local = this.grid.coordinateToWorld(obs.q, obs.r, 0, BLOCK_HEIGHT);
      pos.set(local.x, OBSTACLE_HEIGHT + 0.15, local.z);
      this.boardRoot.localToWorld(pos); // board-local -> actual world position, accounting for current rotation
      pos.project(camera);
      const sx = rect.left + ((pos.x + 1) / 2) * rect.width;
      const sy = rect.top + ((-pos.y + 1) / 2) * rect.height;
      obs.label.style.display = 'block';
      obs.label.style.left = `${sx}px`;
      obs.label.style.top = `${sy}px`;
      // Only touch the text when the number actually changed (every DOM write costs layout).
      const text = String(cell.blockerHits);
      if (obs.label.textContent !== text) obs.label.textContent = text;
    }
  }

  /** Frees the geometry and material of an obstacle's ice block that has been
   * broken and removed from the board. */
  static disposeObstacleMesh(group: THREE.Object3D): void {
    group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
  }

  /** Hide + fade out the ice block once its hit count reaches zero. */
  clearObstacle(q: number, r: number): THREE.Group | null {
    const idx = this.obstacles.findIndex((o) => o.q === q && o.r === r);
    if (idx === -1) return null;
    const [obs] = this.obstacles.splice(idx, 1);
    obs.label.remove();
    return obs.mesh;
  }

  dispose(): void {
    this.boardRoot.remove(this.padMesh);
    this.padMesh.geometry.dispose();
    (this.padMesh.material as THREE.Material).dispose();
    this.texture.dispose();
    for (const obs of this.obstacles) {
      this.boardRoot.remove(obs.mesh);
      obs.mesh.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
      obs.label.remove();
    }
    this.obstacles = [];
  }
}
