import * as THREE from 'three';
import { AnimationManager, Easing } from './AnimationManager';
import { CameraManager } from '../core/CameraManager';

const SPRITE_POOL_SIZE = 40;
const RING_POOL_SIZE = 12;
const SPRITES_PER_BURST = 10;

function buildRadialTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.4, 'rgba(255,255,255,0.7)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  return tex;
}

interface PooledSprite {
  sprite: THREE.Sprite;
  inUse: boolean;
}

interface PooledRing {
  mesh: THREE.Mesh;
  inUse: boolean;
}

export class EffectsManager {
  private spriteTexture = buildRadialTexture();
  private spritePool: PooledSprite[] = [];
  private ringPool: PooledRing[] = [];
  private shakeRemainingMs = 0;
  private shakeDurationMs = 1;
  private shakeMagnitude = 0;
  private popupLayer = document.getElementById('popup-layer') as HTMLDivElement;

  /** `boardRoot` is the rotating group the board lives under. Board-tied
   * effects (clear bursts, obstacle-break bursts) are parented there so a
   * board-local position (from HexGrid.coordinateToWorld) places them
   * correctly regardless of the board's current rotation. `floatingText`
   * is DOM/screen-space, so it separately converts local->world via
   * boardRoot before projecting. */
  constructor(
    private boardRoot: THREE.Group,
    private cameraManager: CameraManager,
    private animationManager: AnimationManager,
    private canvas: HTMLCanvasElement
  ) {
    for (let i = 0; i < SPRITE_POOL_SIZE; i++) {
      const mat = new THREE.SpriteMaterial({ map: this.spriteTexture, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      boardRoot.add(sprite);
      this.spritePool.push({ sprite, inUse: false });
    }

    for (let i = 0; i < RING_POOL_SIZE; i++) {
      const geo = new THREE.RingGeometry(0.4, 0.55, 24);
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      boardRoot.add(mesh);
      this.ringPool.push({ mesh, inUse: false });
    }
  }

  /** `localPos` is board-local — the sprite/ring pools are parented under
   * boardRoot, so this positions correctly at any board rotation. */
  clearBurst(localPos: THREE.Vector3, colorHex: number, comboStep: number): void {
    const count = Math.min(SPRITES_PER_BURST + comboStep * 2, this.spritePool.length);
    let spawned = 0;
    for (const entry of this.spritePool) {
      if (entry.inUse) continue;
      if (spawned >= count) break;
      spawned += 1;
      this.fireSprite(entry, localPos, colorHex);
    }

    const ringEntry = this.ringPool.find((r) => !r.inUse);
    if (ringEntry) this.fireRing(ringEntry, localPos, colorHex, comboStep);
  }

  private fireSprite(entry: PooledSprite, worldPos: THREE.Vector3, colorHex: number): void {
    entry.inUse = true;
    const { sprite } = entry;
    sprite.material.color.setHex(colorHex);
    sprite.material.opacity = 1;
    sprite.visible = true;
    sprite.position.copy(worldPos);
    const scale = 0.35 + Math.random() * 0.25;
    sprite.scale.set(scale, scale, scale);

    const angle = Math.random() * Math.PI * 2;
    const dist = 0.6 + Math.random() * 1.1;
    const target = worldPos.clone().add(new THREE.Vector3(Math.cos(angle) * dist, 0.4 + Math.random() * 0.9, Math.sin(angle) * dist));

    const release = (): void => {
      sprite.visible = false;
      entry.inUse = false;
    };
    this.animationManager.add(
      420 + Math.random() * 180,
      (t) => {
        sprite.position.lerpVectors(worldPos, target, t);
        sprite.material.opacity = 1 - t;
      },
      Easing.easeOutQuad,
      release,
      release // a reset mid-burst must still hand the sprite back to the pool
    );
  }

  /** A small soft ring where a flipped tile lands — marks the receiving stack. */
  landingPuff(localPos: THREE.Vector3, colorHex: number): void {
    const ringEntry = this.ringPool.find((r) => !r.inUse);
    if (ringEntry) this.fireRing(ringEntry, localPos, colorHex, 0, 0.5);
  }

  private fireRing(entry: PooledRing, worldPos: THREE.Vector3, colorHex: number, comboStep: number, sizeScale = 1): void {
    entry.inUse = true;
    const { mesh } = entry;
    (mesh.material as THREE.MeshBasicMaterial).color.setHex(colorHex);
    (mesh.material as THREE.MeshBasicMaterial).opacity = 0.85;
    mesh.position.set(worldPos.x, 0.05, worldPos.z);
    mesh.scale.set(0.2, 0.2, 0.2);
    mesh.visible = true;

    const maxScale = (1.6 + comboStep * 0.35) * sizeScale;
    const release = (): void => {
      mesh.visible = false;
      entry.inUse = false;
    };
    this.animationManager.add(
      380,
      (t) => {
        const s = THREE.MathUtils.lerp(0.2, maxScale, t);
        mesh.scale.set(s, s, s);
        (mesh.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - t);
      },
      Easing.easeOutQuad,
      release,
      release
    );
  }

  screenShake(magnitude: number, durationMs: number): void {
    this.shakeMagnitude = Math.max(this.shakeMagnitude, magnitude);
    this.shakeDurationMs = durationMs;
    this.shakeRemainingMs = durationMs;
  }

  /** `localPos` is board-local (e.g. from HexGrid.coordinateToWorld) — this
   * is the one effect here that isn't parented under boardRoot (it's a DOM
   * overlay), so it converts to actual world space itself before projecting. */
  floatingText(localPos: THREE.Vector3, camera: THREE.Camera, text: string, className = ''): void {
    const projected = localPos.clone();
    projected.y += 0.8;
    this.boardRoot.localToWorld(projected);
    projected.project(camera);
    const rect = this.canvas.getBoundingClientRect();
    const sx = rect.left + ((projected.x + 1) / 2) * rect.width;
    const sy = rect.top + ((-projected.y + 1) / 2) * rect.height;

    const el = document.createElement('div');
    el.className = `floating-popup ${className}`;
    el.textContent = text;
    el.style.left = `${sx}px`;
    el.style.top = `${sy}px`;
    this.popupLayer.appendChild(el);

    const startY = sy;
    this.animationManager.add(
      850,
      (t) => {
        el.style.top = `${startY - t * 46}px`;
        el.style.opacity = `${1 - t}`;
      },
      Easing.easeOutQuad,
      () => el.remove(),
      () => el.remove() // a reset must not leave a stranded "+N" on screen
    );
  }

  /** Returns every pooled effect to idle and removes any popup still on screen.
   * Called when a level is restarted or the player leaves to the menu. */
  reset(): void {
    for (const entry of this.spritePool) {
      entry.sprite.visible = false;
      entry.inUse = false;
    }
    for (const entry of this.ringPool) {
      entry.mesh.visible = false;
      entry.inUse = false;
    }
    this.popupLayer.replaceChildren();
    this.shakeRemainingMs = 0;
    this.shakeMagnitude = 0;
    this.cameraManager.camera.position.copy(this.cameraManager.basePosition);
  }

  update(dtSeconds: number): void {
    const camera = this.cameraManager.camera;
    if (this.shakeRemainingMs > 0) {
      this.shakeRemainingMs -= dtSeconds * 1000;
      const t = Math.max(0, this.shakeRemainingMs / this.shakeDurationMs);
      const mag = this.shakeMagnitude * t;
      camera.position.set(
        this.cameraManager.basePosition.x + (Math.random() - 0.5) * mag,
        this.cameraManager.basePosition.y + (Math.random() - 0.5) * mag,
        this.cameraManager.basePosition.z
      );
      if (this.shakeRemainingMs <= 0) {
        this.shakeMagnitude = 0;
        camera.position.copy(this.cameraManager.basePosition);
      }
    }
  }
}
