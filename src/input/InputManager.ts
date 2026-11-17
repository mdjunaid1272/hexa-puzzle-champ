import * as THREE from 'three';
import {
  BOARD_ROTATION_SENSITIVITY,
  BOARD_ROTATION_SMOOTHING_RATE,
  CAMERA_PITCH_SENSITIVITY,
  DRAG_LIFT_HEIGHT,
  DRAG_THRESHOLD_PX,
  TIMING
} from '../utils/config';
import { HexGrid } from '../board/HexGrid';
import { PlacementPreview, PreviewCandidate } from './PlacementPreview';
import { AnimationManager, Easing } from '../effects/AnimationManager';
import { CameraManager } from '../core/CameraManager';

/**
 * The four mutually-exclusive things a pointer gesture can be doing.
 * PIECE_DRAG wins immediately on pointerdown (a hit-test against the hand
 * targets happens before anything else). Any other press starts as IDLE
 * (undecided) and resolves to BOARD_ROTATE or CAMERA_TILT once the drag
 * clears DRAG_THRESHOLD_PX — see the background-drag branch of onPointerMove.
 */
export enum InteractionState {
  IDLE = 'idle',
  PIECE_DRAG = 'piece_drag',
  BOARD_ROTATE = 'board_rotate',
  CAMERA_TILT = 'camera_tilt'
}

export interface HandTarget {
  slot: number;
  mesh: THREE.Object3D;
  pieceLength: number;
  /** Color index of the piece's top block — what it will link with on the board. */
  topColor: number;
  trayPosition: THREE.Vector3;
}

export interface InputCallbacks {
  onPickup: (slot: number) => void;
  onCommit: (slot: number, candidate: PreviewCandidate) => void;
  onCancel: (slot: number) => void;
}

const WHEEL_ZOOM_SENSITIVITY = 0.0009;
const PINCH_ZOOM_SENSITIVITY = 0.006;

interface PointerPos {
  x: number;
  y: number;
}

/**
 * Unified pointer-event input (mouse, touch, pen) for:
 *  - dragging a piece out of the hand,
 *  - rotating the BOARD when a drag starts on empty space and moves mostly
 *    horizontally,
 *  - tilting the CAMERA's pitch when that same kind of drag moves mostly
 *    vertically instead,
 *  - zooming the camera in/out (wheel/pinch),
 *  - and one-shot "targeting" taps used by the Rocket booster.
 * Raycasts against math planes rather than scene geometry, for jitter-free,
 * always-defined results. Board rotation (`boardRoot.rotation.y`) and camera
 * pitch (`CameraManager`) are two entirely separate transforms driven by two
 * components (dx vs dy) of the same background-drag gesture.
 */
export class InputManager {
  private _enabled = false;
  private raycaster = new THREE.Raycaster();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private targets: HandTarget[] = [];
  private activePointers = new Map<number, PointerPos>();

  private draggingTarget: HandTarget | null = null;
  private dragPointerId: number | null = null;

  private state: InteractionState = InteractionState.IDLE;

  // A press on empty background is BOARD_ROTATE or CAMERA_TILT, but which
  // one isn't decided until the drag clears DRAG_THRESHOLD_PX — until then
  // it sits "undecided" (state stays IDLE) so a tiny jitter never misfires
  // either gesture.
  private backgroundDragPointerId: number | null = null;
  private backgroundDragStart: PointerPos | null = null;
  private lastBackgroundDragPos: PointerPos | null = null;
  private targetRotationY: number;

  private pinchIds: [number, number] | null = null;
  private lastPinchDistance = 0;

  private targetingCallback: ((q: number, r: number) => void) | null = null;
  private targetingMeshLookup: (() => THREE.Object3D[]) | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private camera: THREE.Camera,
    private grid: HexGrid,
    private preview: PlacementPreview,
    private animationManager: AnimationManager,
    private cameraManager: CameraManager,
    private boardRoot: THREE.Group,
    private callbacks: InputCallbacks
  ) {
    this.targetRotationY = boardRoot.rotation.y;
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
  }

  get enabled(): boolean {
    return this._enabled;
  }

  /** Turning input off also drops any gesture in progress: a piece being
   * dragged snaps back to its tray slot and pinch/rotate tracking is reset, so
   * nothing can be dropped or rotated while the game is paused or resolving. */
  set enabled(value: boolean) {
    if (!value && this._enabled) this.cancelGesture();
    this._enabled = value;
  }

  /** Abandons whatever the pointer is doing right now. */
  cancelGesture(): void {
    if (this.draggingTarget) this.cancelDrag();
    this.activePointers.clear();
    this.pinchIds = null;
    this.backgroundDragPointerId = null;
    this.backgroundDragStart = null;
    this.lastBackgroundDragPos = null;
    this.state = InteractionState.IDLE;
  }

  setHandTargets(targets: HandTarget[]): void {
    this.targets = targets;
  }

  setGrid(grid: HexGrid): void {
    this.grid = grid;
  }

  get dragging(): boolean {
    return this.draggingTarget !== null;
  }

  /** Current interaction state (IDLE / PIECE_DRAG / BOARD_ROTATE / CAMERA_TILT). */
  get interactionState(): InteractionState {
    return this.state;
  }

  /** Sets the board's yaw immediately, with no smoothing — for programmatic
   * control (e.g. restoring a saved rotation) rather than pointer drag. */
  setRotationImmediate(radians: number): void {
    this.targetRotationY = radians;
    this.boardRoot.rotation.y = radians;
  }

  /** Smoothly converges boardRoot's actual rotation toward the drag target
   * every frame — exponential (framerate-independent) so it feels immediate
   * (within ~2-3 frames at 60fps) while still ironing out per-event jitter
   * from discrete pointermove samples. Call once per frame regardless of
   * whether a rotation drag is currently active (also settles any residual
   * difference after the pointer is released). Camera pitch has its own,
   * identical smoothing inside CameraManager.update(), called separately. */
  update(dtSeconds: number): void {
    const diff = this.targetRotationY - this.boardRoot.rotation.y;
    if (Math.abs(diff) < 1e-5) return;
    const k = 1 - Math.exp(-BOARD_ROTATION_SMOOTHING_RATE * dtSeconds);
    this.boardRoot.rotation.y += diff * k;
  }

  /**
   * Arms one-shot cell targeting (used by the Rocket booster); the next tap
   * fires the callback with the targeted cell. `getMeshes` should return every
   * currently-placed block mesh so tall stacks can be hit precisely — raycasting
   * a flat ground plane alone misjudges tall stacks under an angled camera.
   */
  beginTargeting(onPick: (q: number, r: number) => void, getMeshes: () => THREE.Object3D[]): void {
    this.targetingCallback = onPick;
    this.targetingMeshLookup = getMeshes;
  }

  cancelTargeting(): void {
    this.targetingCallback = null;
    this.targetingMeshLookup = null;
  }

  private toNdc(clientX: number, clientY: number): THREE.Vector2 {
    const rect = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  }

  /** Casts the given screen point onto the board SURFACE (y=0). Always a
   * fresh raycast from the exact coordinates passed in — never cached.
   * Deliberately NOT the elevated height a dragged piece floats at: under
   * the fixed camera tilt, a ray to an elevated plane crosses y=0 at a
   * noticeably different (x,z) than the cell the player is actually
   * pointing at on the board (the taller the lift, the bigger that
   * parallax gap) — raycasting the real board surface is what makes a
   * dragged piece land in the cell under the pointer instead of drifting
   * off toward whichever direction the camera is tilted. */
  private raycastDragPlane(clientX: number, clientY: number): THREE.Vector3 | null {
    const ndc = this.toNdc(clientX, clientY);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(this.groundPlane, hit) ? hit : null;
  }

  /** Resolves a WORLD-space drag-plane hit to the hex cell currently under
   * it. The board can be rotated at any angle, so the world hit is first
   * transformed into boardRoot's LOCAL space — only then does the fixed
   * axial-coordinate math apply, exactly as if the board were unrotated.
   * Returns null (= invalid/off-board) if that axial coordinate isn't a
   * real playable cell, rather than falling back to the nearest one. */
  private candidateAt(worldHit: THREE.Vector3, target: HandTarget): PreviewCandidate | null {
    const local = this.boardRoot.worldToLocal(worldHit.clone());
    const axial = this.grid.worldToCoordinate(local.x, local.z);
    const cell = this.grid.getCell(axial.q, axial.r);
    if (!cell) return null;
    const valid = this.grid.canAcceptPiece(cell, target.pieceLength);
    // Neighbouring stacks whose top color matches the piece's top: these are
    // the ones tiles will flow between once it lands, so the preview can show
    // WHY something is about to move.
    const links: { q: number; r: number }[] = [];
    if (valid) {
      for (const n of this.grid.getNeighbors(axial.q, axial.r)) {
        const other = this.grid.getCell(n.q, n.r);
        if (other && other.blockerHits === 0 && other.stack.length > 0 && other.stack[other.stack.length - 1].color === target.topColor) {
          links.push({ q: n.q, r: n.r });
        }
      }
    }
    return { q: axial.q, r: axial.r, nextLayer: cell.stack.length, valid, pieceLength: target.pieceLength, linkColor: target.topColor, links };
  }

  private onPointerDown = (ev: PointerEvent): void => {
    if (!this.enabled) return;

    if (this.targetingCallback) {
      const ndc = this.toNdc(ev.clientX, ev.clientY);
      this.raycaster.setFromCamera(ndc, this.camera);
      const cb = this.targetingCallback;
      this.targetingCallback = null;
      const meshLookup = this.targetingMeshLookup;
      this.targetingMeshLookup = null;

      // Prefer hitting the actual placed geometry — a flat ground-plane
      // raycast misjudges tall stacks once the board is rotated.
      const meshes = meshLookup ? meshLookup() : [];
      if (meshes.length > 0) {
        const hits = this.raycaster.intersectObjects(meshes, true);
        if (hits.length > 0) {
          let node: THREE.Object3D | null = hits[0].object;
          while (node && node.userData.cellQ === undefined) node = node.parent;
          if (node) {
            cb(node.userData.cellQ as number, node.userData.cellR as number);
            return;
          }
        }
      }

      const hit = new THREE.Vector3();
      if (this.raycaster.ray.intersectPlane(this.groundPlane, hit)) {
        const local = this.boardRoot.worldToLocal(hit.clone());
        const axial = this.grid.worldToCoordinate(local.x, local.z);
        cb(axial.q, axial.r);
      }
      return;
    }

    this.canvas.setPointerCapture(ev.pointerId);
    this.activePointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });

    if (this.activePointers.size === 2 && !this.draggingTarget) {
      const ids = Array.from(this.activePointers.keys()) as [number, number];
      this.pinchIds = ids;
      this.lastPinchDistance = this.pinchDistance();
      this.backgroundDragPointerId = null;
      this.backgroundDragStart = null;
      this.lastBackgroundDragPos = null;
      this.state = InteractionState.IDLE;
      return;
    }

    if (this.activePointers.size > 1 || this.draggingTarget || this.pinchIds) return;

    const ndc = this.toNdc(ev.clientX, ev.clientY);
    this.raycaster.setFromCamera(ndc, this.camera);

    for (const target of this.targets) {
      const hits = this.raycaster.intersectObject(target.mesh, true);
      if (hits.length === 0) continue;

      this.dragPointerId = ev.pointerId;
      this.draggingTarget = target;
      this.state = InteractionState.PIECE_DRAG;

      const mesh = target.mesh;
      this.animationManager.add(
        TIMING.pickup,
        (t) => {
          mesh.position.y = THREE.MathUtils.lerp(target.trayPosition.y, DRAG_LIFT_HEIGHT, t);
        },
        Easing.easeOutQuad
      );

      this.callbacks.onPickup(target.slot);
      return;
    }

    // Missed every piece and not in targeting mode — pressing empty
    // board/background is the start of either a board-rotate or a
    // camera-tilt drag; which one is decided in onPointerMove once the
    // drag clears DRAG_THRESHOLD_PX (state stays IDLE until then).
    this.backgroundDragPointerId = ev.pointerId;
    this.backgroundDragStart = { x: ev.clientX, y: ev.clientY };
    this.lastBackgroundDragPos = { x: ev.clientX, y: ev.clientY };
    this.state = InteractionState.IDLE;
  };

  private pinchDistance(): number {
    if (!this.pinchIds) return 0;
    const a = this.activePointers.get(this.pinchIds[0]);
    const b = this.activePointers.get(this.pinchIds[1]);
    if (!a || !b) return 0;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  private onPointerMove = (ev: PointerEvent): void => {
    if (this.activePointers.has(ev.pointerId)) {
      this.activePointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    }

    if (this.pinchIds) {
      const dist = this.pinchDistance();
      const deltaPixels = dist - this.lastPinchDistance;
      this.lastPinchDistance = dist;
      this.cameraManager.zoom(-deltaPixels * PINCH_ZOOM_SENSITIVITY);
      return;
    }

    if (this.draggingTarget && ev.pointerId === this.dragPointerId) {
      const hit = this.raycastDragPlane(ev.clientX, ev.clientY);
      if (!hit) return;

      this.draggingTarget.mesh.position.x = hit.x;
      this.draggingTarget.mesh.position.z = hit.z;

      const candidate = this.candidateAt(hit, this.draggingTarget);
      this.preview.update(1 / 60, candidate);
      return;
    }

    if (this.backgroundDragPointerId !== null && ev.pointerId === this.backgroundDragPointerId && this.lastBackgroundDragPos && this.backgroundDragStart) {
      const dxFrame = ev.clientX - this.lastBackgroundDragPos.x;
      const dyFrame = ev.clientY - this.lastBackgroundDragPos.y;
      this.lastBackgroundDragPos = { x: ev.clientX, y: ev.clientY };

      if (this.state === InteractionState.IDLE) {
        // Still undecided — wait for enough total movement before
        // committing to a gesture, so a near-stationary press/tap never
        // spuriously rotates the board or tilts the camera by a hair.
        const totalDx = ev.clientX - this.backgroundDragStart.x;
        const totalDy = ev.clientY - this.backgroundDragStart.y;
        if (Math.hypot(totalDx, totalDy) < DRAG_THRESHOLD_PX) return;
        // Whichever axis has moved further wins for the rest of THIS drag
        // (locked in, not re-evaluated every frame) — mirrors how a real
        // trackpad/joystick disambiguates a diagonal gesture, and avoids
        // flip-flopping between rotate/tilt mid-drag.
        this.state = Math.abs(totalDx) >= Math.abs(totalDy) ? InteractionState.BOARD_ROTATE : InteractionState.CAMERA_TILT;
      }

      if (this.state === InteractionState.BOARD_ROTATE) {
        // Free 360° yaw around boardRoot's Y axis. Dragging right spins the
        // near face of the board to the right, like grabbing a physical disc.
        this.targetRotationY += dxFrame * BOARD_ROTATION_SENSITIVITY;
      } else if (this.state === InteractionState.CAMERA_TILT) {
        // Drag up (negative dy) raises pitch toward a lower, more side-on
        // view (as if pulling the far edge of the board up toward you);
        // drag down lowers pitch back toward more top-down.
        this.cameraManager.nudgeTargetPitch(-dyFrame * CAMERA_PITCH_SENSITIVITY);
      }
    }
  };

  private onPointerUp = (ev: PointerEvent): void => {
    this.activePointers.delete(ev.pointerId);

    if (this.pinchIds && (ev.pointerId === this.pinchIds[0] || ev.pointerId === this.pinchIds[1])) {
      this.pinchIds = null;
    }

    if (this.draggingTarget && ev.pointerId === this.dragPointerId) {
      // pointercancel carries no reliable release position (an OS gesture
      // interrupted the drag) — always snap back rather than guess a target.
      if (ev.type === 'pointercancel') {
        this.cancelDrag();
      } else {
        this.finishDrag(ev.clientX, ev.clientY);
      }
      return;
    }

    if (this.backgroundDragPointerId !== null && ev.pointerId === this.backgroundDragPointerId) {
      // The board/camera simply stay at whatever angle/pitch they were
      // dragged to — no snapping to preset values, ever.
      this.backgroundDragPointerId = null;
      this.backgroundDragStart = null;
      this.lastBackgroundDragPos = null;
      this.state = InteractionState.IDLE;
    }
  };

  private onWheel = (ev: WheelEvent): void => {
    if (!this.enabled) return;
    ev.preventDefault();
    this.cameraManager.zoom(ev.deltaY * WHEEL_ZOOM_SENSITIVITY);
  };

  /**
   * Commits (or rejects) the drag using a FRESH raycast from the actual
   * release coordinates — never the last cached pointermove candidate.
   * Fast pointer movement can deliver a pointerup at a position that
   * differs from the last pointermove sample; recomputing here guarantees
   * the drop always lands on the cell genuinely under the pointer at the
   * moment of release, not wherever it was one frame earlier — this holds
   * true at any board rotation, since candidateAt() always re-derives the
   * cell from the board's CURRENT transform.
   */
  private finishDrag(clientX: number, clientY: number): void {
    const target = this.draggingTarget as HandTarget;
    this.draggingTarget = null;
    this.dragPointerId = null;
    this.state = InteractionState.IDLE;
    this.preview.hide();

    const hit = this.raycastDragPlane(clientX, clientY);
    const candidate = hit ? this.candidateAt(hit, target) : null;

    if (candidate && candidate.valid) {
      this.callbacks.onCommit(target.slot, candidate);
    } else {
      this.callbacks.onCancel(target.slot);
    }
  }

  private cancelDrag(): void {
    const target = this.draggingTarget as HandTarget;
    this.draggingTarget = null;
    this.dragPointerId = null;
    this.state = InteractionState.IDLE;
    this.preview.hide();
    this.callbacks.onCancel(target.slot);
  }

  dispose(): void {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
  }
}
