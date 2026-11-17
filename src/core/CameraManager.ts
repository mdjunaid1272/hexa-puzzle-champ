import * as THREE from 'three';
import {
  CAMERA,
  CAMERA_DISTANCE,
  CAMERA_PITCH_SMOOTHING_RATE,
  INITIAL_CAMERA_PITCH_DEG,
  MAX_CAMERA_PITCH_DEG,
  MIN_CAMERA_PITCH_DEG
} from '../utils/config';

const DISTANCE_SCALE_MIN = 0.78;
const DISTANCE_SCALE_MAX = 1.3;
// Fixed azimuth (radians, measured off the board's +Z side) the rig's pitch
// arc stays on. The camera never circles the board horizontally — boardRoot
// spins in place instead (see Game.ts/InputManager) — so there is no
// user-controlled azimuth here, only vertical pitch.
const AZIMUTH_RAD = 0;

/**
 * A minimal orbit-style camera rig, kept deliberately simple: a fixed
 * azimuth, a user-controlled PITCH (elevation angle off the board's
 * vertical axis, clamped to [MIN_CAMERA_PITCH_DEG, MAX_CAMERA_PITCH_DEG]),
 * and a constant distance from the board's center. The board (boardRoot)
 * handles all horizontal rotation on its own transform; this rig only ever
 * moves along the vertical arc, and always looks at the board's actual
 * world position (not a hardcoded point), so it keeps framing correctly
 * even if the board were ever repositioned.
 */
export class CameraManager {
  camera: THREE.PerspectiveCamera;
  /** Camera's current world position — also the recoil origin for screen shake. */
  readonly basePosition = new THREE.Vector3();
  private aspectScale = 1;
  private distanceScaleValue = 1;
  private pitchDeg = INITIAL_CAMERA_PITCH_DEG;
  private targetPitchDeg = INITIAL_CAMERA_PITCH_DEG;
  private readonly lookAtTarget = new THREE.Vector3();

  constructor(
    aspect: number,
    /** The point the rig looks at every frame — a fixed target at the screen
     * center. The board is positioned so its own center sits exactly here, no
     * matter what shape the level's board is (see Game.updateBoardPlacement). */
    private readonly boardRoot: THREE.Object3D
  ) {
    this.camera = new THREE.PerspectiveCamera(CAMERA.fov, aspect, CAMERA.near, CAMERA.far);
    this.applyFraming(aspect);
  }

  applyFraming(aspect: number): void {
    // Narrow (portrait/mobile) aspect ratios need the camera pulled back so
    // the full board radius stays inside the frustum.
    // Fit-to-width: distance grows as 1/aspect so the board keeps the same
    // share of the column width on a 390px phone and a wide desktop window.
    this.aspectScale = Math.max(1, 0.62 / aspect);
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.updatePosition();
  }

  /** Zoom in/out by a relative distance-scale delta (positive = zoom out). */
  zoom(deltaScale: number): void {
    this.distanceScaleValue = THREE.MathUtils.clamp(this.distanceScaleValue + deltaScale, DISTANCE_SCALE_MIN, DISTANCE_SCALE_MAX);
    this.updatePosition();
  }

  getPitchDeg(): number {
    return this.pitchDeg;
  }

  getTargetPitchDeg(): number {
    return this.targetPitchDeg;
  }

  /** Sets the pitch the rig eases toward (see update()) — not applied instantly. */
  setTargetPitch(deg: number): void {
    this.targetPitchDeg = THREE.MathUtils.clamp(deg, MIN_CAMERA_PITCH_DEG, MAX_CAMERA_PITCH_DEG);
  }

  /** Relative pitch adjustment (e.g. from a drag delta), clamped the same way. */
  nudgeTargetPitch(deltaDeg: number): void {
    this.setTargetPitch(this.targetPitchDeg + deltaDeg);
  }

  /** Sets both current and target pitch immediately, no smoothing — for
   * programmatic control (init, debug) rather than a drag gesture. */
  setPitchImmediate(deg: number): void {
    this.pitchDeg = THREE.MathUtils.clamp(deg, MIN_CAMERA_PITCH_DEG, MAX_CAMERA_PITCH_DEG);
    this.targetPitchDeg = this.pitchDeg;
    this.updatePosition();
  }

  /** Smoothly converges the rig's actual pitch toward the drag target every
   * frame — exponential/framerate-independent, mirroring boardRoot's own
   * rotation smoothing (InputManager.update) so both gestures feel equally
   * immediate with no visible lag. Call once per frame unconditionally. */
  update(dtSeconds: number): void {
    const diff = this.targetPitchDeg - this.pitchDeg;
    if (Math.abs(diff) > 1e-4) {
      const k = 1 - Math.exp(-CAMERA_PITCH_SMOOTHING_RATE * dtSeconds);
      this.pitchDeg += diff * k;
    }
    this.updatePosition();
  }

  private updatePosition(): void {
    this.boardRoot.updateWorldMatrix(true, false);
    this.boardRoot.getWorldPosition(this.lookAtTarget);

    const distance = CAMERA_DISTANCE * this.aspectScale * this.distanceScaleValue;
    const pitchRad = THREE.MathUtils.degToRad(this.pitchDeg);
    // Spherical position around the board center at a fixed azimuth — only
    // elevation (pitch) and radius (zoom) ever move the camera.
    const horizontal = distance * Math.sin(pitchRad);
    const x = this.lookAtTarget.x + horizontal * Math.sin(AZIMUTH_RAD);
    const y = this.lookAtTarget.y + distance * Math.cos(pitchRad);
    const z = this.lookAtTarget.z + horizontal * Math.cos(AZIMUTH_RAD);

    this.basePosition.set(x, y, z);
    this.camera.position.copy(this.basePosition);
    this.camera.lookAt(this.lookAtTarget);
  }
}
