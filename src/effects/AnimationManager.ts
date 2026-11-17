import * as THREE from 'three';

export type Easing = (t: number) => number;

export const Easing = {
  linear: (t: number): number => t,
  easeOutQuad: (t: number): number => 1 - (1 - t) * (1 - t),
  easeOutBack: (t: number): number => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
  easeOutCubic: (t: number): number => 1 - Math.pow(1 - t, 3),
  easeInOutCubic: (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
};

interface Tween {
  elapsedMs: number;
  durationMs: number;
  easing: Easing;
  onUpdate: (easedT: number) => void;
  onComplete?: () => void;
  /** Runs instead of onComplete if the tween is thrown away by clear() — for
   * releasing whatever it was holding (a pooled sprite, a DOM popup, a cloned
   * material) so that restarting a level can never leak it. */
  onCancel?: () => void;
  done: boolean;
}

/**
 * Central tween manager. All animation is driven from Game's single update
 * tick rather than independent timers, so pausing/backgrounding the tab
 * degrades gracefully instead of desyncing.
 */
export class AnimationManager {
  private tweens: Tween[] = [];

  /** Number of tweens still running (used by tests and cleanup checks). */
  get activeCount(): number {
    return this.tweens.length;
  }

  update(dtSeconds: number): void {
    if (this.tweens.length === 0) return;
    const dtMs = dtSeconds * 1000;
    // Iterate a snapshot: a completing tween often starts the next one, and
    // that new tween must wait for the next frame instead of being advanced
    // by this frame's time as well.
    const running = this.tweens.slice();
    for (const tw of running) {
      if (tw.done) continue;
      tw.elapsedMs += dtMs;
      const raw = Math.min(1, tw.durationMs <= 0 ? 1 : tw.elapsedMs / tw.durationMs);
      tw.onUpdate(tw.easing(raw));
      if (raw >= 1) {
        tw.done = true;
        tw.onComplete?.();
      }
    }
    this.tweens = this.tweens.filter((t) => !t.done);
  }

  add(durationMs: number, onUpdate: (easedT: number) => void, easing: Easing = Easing.linear, onComplete?: () => void, onCancel?: () => void): void {
    this.tweens.push({ elapsedMs: 0, durationMs, easing, onUpdate, onComplete, onCancel, done: false });
  }

  /** Throws away every running tween WITHOUT running their completions (those
   * continue gameplay, which must not happen after a reset), but does run each
   * one's cancel handler so pooled effects, popups and materials are released. */
  clear(): void {
    const dropped = this.tweens;
    this.tweens = [];
    for (const tw of dropped) {
      if (tw.done) continue;
      tw.done = true;
      tw.onCancel?.();
    }
  }

  animateMove(object: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3, durationMs: number, easing: Easing = Easing.easeOutQuad, onComplete?: () => void): void {
    object.position.copy(from);
    this.add(
      durationMs,
      (t) => {
        object.position.lerpVectors(from, to, t);
      },
      easing,
      onComplete
    );
  }

  animateScale(object: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3, durationMs: number, easing: Easing = Easing.easeOutBack, onComplete?: () => void): void {
    this.add(
      durationMs,
      (t) => {
        object.scale.lerpVectors(from, to, t);
      },
      easing,
      onComplete
    );
  }

  /** Drop/place animation: move from one world position to another with a small squash/overshoot on landing. */
  animateDrop(object: THREE.Object3D, fromPos: THREE.Vector3, toPos: THREE.Vector3, durationMs: number, onComplete?: () => void): void {
    this.animateMove(object, fromPos, toPos, durationMs, Easing.easeOutBack, onComplete);
    // squash on landing, timed against the same duration as the move above
    this.add(
      durationMs,
      (t) => {
        if (t < 0.75) return;
        const localT = (t - 0.75) / 0.25;
        const squashAmt = Math.sin(localT * Math.PI) * 0.16;
        object.scale.set(1 + squashAmt * 0.6, 1 - squashAmt, 1 + squashAmt * 0.6);
      },
      Easing.linear,
      () => object.scale.set(1, 1, 1)
    );
  }

  animateFall(object: THREE.Object3D, fromY: number, toY: number, x: number, z: number, durationMs: number, onComplete?: () => void): void {
    const from = new THREE.Vector3(x, fromY, z);
    const to = new THREE.Vector3(x, toY, z);
    this.animateMove(object, from, to, durationMs, Easing.easeOutQuad, onComplete);
  }

  /** A hex tossed onto a matching neighbor stack: an arced hop plus a full coin-flip spin. */
  animateMergeFlip(object: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3, durationMs: number, onComplete?: () => void): void {
    const arcHeight = 0.5 + from.distanceTo(to) * 0.18;
    this.add(
      durationMs,
      (t) => {
        object.position.lerpVectors(from, to, t);
        object.position.y += Math.sin(t * Math.PI) * arcHeight;
        object.rotation.z = t * Math.PI * 2;
      },
      Easing.easeOutQuad,
      () => {
        object.rotation.z = 0;
        onComplete?.();
      }
    );
  }

  /**
   * Page-turn flip: the tile hinges 180 degrees about a horizontal axis at the
   * midpoint between its start and end, like a page being turned over the
   * edge it shares with the next one. A half-turn about that point maps the
   * start position exactly onto the end position (heights included, because
   * the hinge sits at the average of the two heights), so the tile arcs up
   * and over and lands precisely on the destination with no correction
   * needed. The tile is symmetric top-to-bottom, so ending the turn upside
   * down looks identical to ending it upright; rotation is reset on landing.
   */
  animatePageFlip(object: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3, durationMs: number, onComplete?: () => void): void {
    const pivot = from.clone().add(to).multiplyScalar(0.5);
    const dir = new THREE.Vector3(to.x - from.x, 0, to.z - from.z);
    if (dir.lengthSq() < 1e-9) dir.set(1, 0, 0);
    dir.normalize();
    // Horizontal hinge axis perpendicular to the travel direction; a positive
    // turn lifts the tile up over the hinge toward the destination.
    const axis = new THREE.Vector3(dir.z, 0, -dir.x);
    const offset = from.clone().sub(pivot);
    const q = new THREE.Quaternion();
    const rotated = new THREE.Vector3();
    object.position.copy(from);
    this.add(
      durationMs,
      (t) => {
        q.setFromAxisAngle(axis, t * Math.PI);
        rotated.copy(offset).applyQuaternion(q).add(pivot);
        object.position.copy(rotated);
        object.quaternion.copy(q);
      },
      Easing.easeInOutCubic,
      () => {
        object.quaternion.identity();
        object.position.copy(to);
        onComplete?.();
      }
    );
  }

  animateClear(object: THREE.Object3D, mesh: THREE.Mesh, durationMs: number, onComplete?: () => void): void {
    const startScale = object.scale.clone();

    // mesh.material is a per-COLOR material shared across every block of
    // that color (BlockManager pools meshes but reuses materials for
    // draw-call efficiency) — fading its opacity in place would visibly fade
    // every other on-board/in-hand block of the same color along with it.
    // Clone it just for this one clear; the mesh gets a fresh shared
    // reference the next time it's re-acquired from the pool
    // (BlockManager.acquire -> setBlockColor), so the clone is disposed here
    // and never needs to outlive this single animation.
    const originalMaterial = mesh.material;
    const clonedMaterial = Array.isArray(originalMaterial) ? originalMaterial.map((m) => m.clone()) : originalMaterial.clone();
    mesh.material = clonedMaterial;
    const restore = (): void => {
      if (Array.isArray(clonedMaterial)) clonedMaterial.forEach((m) => m.dispose());
      else clonedMaterial.dispose();
      mesh.material = originalMaterial;
    };

    this.add(
      durationMs,
      (t) => {
        object.scale.set(startScale.x * (1 - t * 0.3 + Math.sin(t * Math.PI) * 0.25), startScale.y * (1 + t * 0.4), startScale.z * (1 - t * 0.3 + Math.sin(t * Math.PI) * 0.25));
        const applyOpacity = (m: THREE.MeshStandardMaterial) => {
          m.transparent = true;
          m.opacity = 1 - t;
        };
        if (Array.isArray(clonedMaterial)) clonedMaterial.forEach((m) => applyOpacity(m as THREE.MeshStandardMaterial));
        else applyOpacity(clonedMaterial as THREE.MeshStandardMaterial);
      },
      Easing.easeOutQuad,
      () => {
        restore();
        onComplete?.();
      },
      restore // if the level is reset mid-clear, still put the shared material back and free the clone
    );
  }

  /** Runs `fn` after `delayMs` (cancelled, not run, if the animations are cleared first). */
  after(delayMs: number, fn: () => void): void {
    if (delayMs <= 0) {
      fn();
      return;
    }
    this.add(delayMs, () => undefined, Easing.linear, fn);
  }

  animateBounce(object: THREE.Object3D, durationMs: number): void {
    const base = new THREE.Vector3(1, 1, 1);
    const squashed = new THREE.Vector3(1.15, 0.85, 1.15);
    this.animateScale(object, base, squashed, durationMs * 0.4, Easing.easeOutQuad, () => {
      this.animateScale(object, squashed, base, durationMs * 0.6, Easing.easeOutBack);
    });
  }
}
