import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { AnimationManager, Easing } from '../src/effects/AnimationManager';

describe('AnimationManager', () => {
  it('runs a tween to completion and calls its completion once', () => {
    const am = new AnimationManager();
    const done = vi.fn();
    const seen: number[] = [];
    am.add(100, (t) => seen.push(t), Easing.linear, done);
    am.update(0.05);
    expect(done).not.toHaveBeenCalled();
    am.update(0.06);
    expect(done).toHaveBeenCalledTimes(1);
    expect(seen[seen.length - 1]).toBe(1);
    expect(am.activeCount).toBe(0);
    am.update(0.5);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('clear() drops running tweens WITHOUT completing them, but runs their cancel handlers', () => {
    const am = new AnimationManager();
    const complete = vi.fn();
    const cancel = vi.fn();
    am.add(500, () => undefined, Easing.linear, complete, cancel);
    am.add(500, () => undefined, Easing.linear, complete); // no cancel handler is fine
    am.clear();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled(); // a half-played cascade must not carry on after a reset
    expect(am.activeCount).toBe(0);
    am.update(1);
    expect(complete).not.toHaveBeenCalled();
  });

  it('a tween started by another tween\'s completion waits for the next frame', () => {
    const am = new AnimationManager();
    const order: string[] = [];
    am.add(10, () => undefined, Easing.linear, () => {
      order.push('first done');
      am.add(10, () => undefined, Easing.linear, () => order.push('second done'));
    });
    am.update(0.02);
    expect(order).toEqual(['first done']);
    am.update(0.02);
    expect(order).toEqual(['first done', 'second done']);
  });

  it('after() runs now for no delay and later otherwise, and is cancelled by clear()', () => {
    const am = new AnimationManager();
    const now = vi.fn();
    const later = vi.fn();
    am.after(0, now);
    expect(now).toHaveBeenCalledTimes(1);
    am.after(50, later);
    am.update(0.03);
    expect(later).not.toHaveBeenCalled();
    am.update(0.03);
    expect(later).toHaveBeenCalledTimes(1);

    const cancelled = vi.fn();
    am.after(50, cancelled);
    am.clear();
    am.update(1);
    expect(cancelled).not.toHaveBeenCalled();
  });

  it('a zero-length tween finishes on the next update', () => {
    const am = new AnimationManager();
    const done = vi.fn();
    am.add(0, () => undefined, Easing.linear, done);
    am.update(0.016);
    expect(done).toHaveBeenCalled();
  });

  it('page flip lands exactly on the destination, upright, passing over the hinge', () => {
    const am = new AnimationManager();
    const obj = new THREE.Object3D();
    const from = new THREE.Vector3(0, 0.07, 0);
    const to = new THREE.Vector3(1.3, 0.3, 0.75);
    const done = vi.fn();
    am.animatePageFlip(obj, from, to, 200, done);
    am.update(0.1); // halfway: eased midpoint
    const mid = obj.position.clone();
    expect(mid.y).toBeGreaterThan(Math.max(from.y, to.y)); // arcs up and over
    expect(Math.abs(new THREE.Vector3(0, 1, 0).applyQuaternion(obj.quaternion).y)).toBeLessThan(0.05); // standing on edge
    am.update(0.2);
    expect(done).toHaveBeenCalledTimes(1);
    expect(obj.position.distanceTo(to)).toBeLessThan(1e-6);
    expect(obj.quaternion.angleTo(new THREE.Quaternion())).toBeLessThan(1e-6); // reset to upright
  });

  it('animateClear restores the shared material even if it is cancelled halfway', () => {
    const am = new AnimationManager();
    const group = new THREE.Group();
    const shared = new THREE.MeshBasicMaterial({ color: 0xff0000 });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), shared);
    group.add(mesh);
    am.animateClear(group, mesh, 300);
    expect(mesh.material).not.toBe(shared); // a private copy while it fades
    am.update(0.1);
    am.clear();
    expect(mesh.material).toBe(shared); // the shared one is back, so other blocks of that color are unaffected
    expect(shared.opacity).toBe(1);
  });
});
