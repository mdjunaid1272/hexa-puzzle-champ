import * as THREE from 'three';
import { SceneManager } from './core/SceneManager';
import { CameraManager } from './core/CameraManager';
import { Clock } from './core/Clock';
import { GameState, GameStatus } from './core/GameState';
import { BoardRenderer } from './board/BoardRenderer';
import { BlockManager } from './blocks/BlockManager';
import { applyMiniRocket, applyRocket, BoosterResult } from './systems/BoosterSystem';
import { ResolveEvent, resolveBoard } from './systems/MergeSystem';
import { AnimationManager, Easing } from './effects/AnimationManager';
import { EffectsManager } from './effects/EffectsManager';
import { AudioManager } from './effects/AudioManager';
import { UIManager } from './ui/UIManager';
import { HandTarget, InputManager } from './input/InputManager';
import { PlacementPreview, PreviewCandidate } from './input/PlacementPreview';
import { BLOCK_HEIGHT, COLORS, HEX_SIZE, INITIAL_BOARD_ROTATION_DEG, LAYER_PITCH, TIMING } from './utils/config';

/** Largest board radius (world units from its center to its farthest cell
 * edge) that still fits the screen above the hand tray at scale 1. Bigger
 * boards are shrunk uniformly to this size. */
const BOARD_FIT_RADIUS = 5.0;
const BOARD_MAX_SCALE = 1.2;
const Y_AXIS = new THREE.Vector3(0, 1, 0);

// Tray row: sits just below the board in the top-down view and clear of the booster buttons.
const TRAY_SLOTS = [new THREE.Vector3(-2.7, 0.55, 6.5), new THREE.Vector3(0, 0.65, 6.7), new THREE.Vector3(2.7, 0.55, 6.5)];

export class Game {
  private canvas: HTMLCanvasElement;
  private sceneManager: SceneManager;
  private cameraManager: CameraManager;
  private clock = new Clock();
  /** Fixed point at the world origin the camera always looks at. */
  private cameraTarget = new THREE.Object3D();
  /** Board-local center of the current level's board (its bounding-box middle). */
  private boardCenter = new THREE.Vector2(0, 0);
  /** Uniform scale that makes the current board fit the screen (1 = no shrink). */
  private boardScale = 1;
  private tmpCenter = new THREE.Vector3();
  /** True while the "Level N / Goal" board is open and the player hasn't pressed Start yet. */
  private introOpen = false;
  private state = new GameState();
  private animationManager = new AnimationManager();
  private boardRenderer: BoardRenderer | null = null;
  private blockManager: BlockManager;
  private effects: EffectsManager;
  private audio = new AudioManager();
  private ui: UIManager;
  private preview: PlacementPreview;
  private input: InputManager;
  private handGroups: (THREE.Group | null)[] = [null, null, null];
  private rocketArmed = false;
  private miniRocketArmed = false;
  /** One pivot Group per occupied cell ("HexaBlockGroup") — positioned once
   * at that cell's board-local X/Z and never moved again. Every tile placed
   * on that cell is a child of THIS group with position LOCKED to (0, y, 0):
   * only Y (its layer) ever varies, so tiles in one stack are geometrically
   * guaranteed to share the exact same X/Z — not just computed to match by
   * coincidence of a shared formula. Keyed by "q,r". */
  private stackGroups = new Map<string, THREE.Group>();
  /** Everything that is visually "the board" (pads, obstacles, placed
   * stacks, placement preview, board-tied particle effects) lives under
   * this one group. Rotating it (see InputManager) spins the whole 3D
   * platform in place; the camera and all screen-space UI never move. The
   * hand tray is deliberately NOT a child of this — it's fixed UI. */
  private boardRoot = new THREE.Group();

  constructor() {
    this.canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
    this.sceneManager = new SceneManager(this.canvas);
    this.boardRoot.rotation.y = THREE.MathUtils.degToRad(INITIAL_BOARD_ROTATION_DEG);
    this.sceneManager.scene.add(this.boardRoot);
    // The rig looks at boardRoot's world position every frame (not a
    // hardcoded point) — passing the group itself keeps that correct even
    // if the board were ever repositioned.
    this.cameraManager = new CameraManager((this.canvas.parentElement?.clientWidth || window.innerWidth) / (this.canvas.parentElement?.clientHeight || window.innerHeight), this.cameraTarget);
    this.blockManager = new BlockManager(this.sceneManager.scene);
    this.effects = new EffectsManager(this.boardRoot, this.cameraManager, this.animationManager, this.canvas);
    this.preview = new PlacementPreview(this.boardRoot, this.state.grid);

    this.ui = new UIManager({
      onResume: () => this.togglePause(),
      onMuteToggle: () => this.toggleMute(),
      onRestartLevel: () => this.startLevel(this.state.levelManager.levelIndex),
      onNextLevel: () => this.onNextLevelClicked(),
      onRetryLevel: () => this.startLevel(this.state.levelManager.levelIndex),
      onMainMenu: () => this.returnToMainMenu(),
      onPlayOn: () => this.onPlayOn(),
      onShuffle: () => this.onShuffleClicked(),
      onRocket: () => this.onRocketClicked(),
      onMiniRocket: () => this.onMiniRocketClicked(),
      onSplashPlay: () => this.startLevel(this.state.levelManager.unlockedLevelIndex),
      onLevelIntroContinue: () => this.dismissLevelIntro(),
      onResetLevelRequested: () => this.ui.showResetConfirm(),
      onResetLevelConfirmed: () => this.onResetLevelConfirmed(),
      onResetLevelCancelled: () => this.ui.hideResetConfirm()
    });
    this.ui.setMuted(this.audio.muted);

    this.input = new InputManager(this.canvas, this.cameraManager.camera, this.state.grid, this.preview, this.animationManager, this.cameraManager, this.boardRoot, {
      onPickup: () => {
        this.audio.unlock();
        this.audio.pickup();
      },
      onCommit: (slot, candidate) => this.commitPlacement(slot, candidate),
      onCancel: (slot) => this.cancelPlacement(slot)
    });

    window.addEventListener('resize', this.onResize);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    window.addEventListener('keydown', this.onKeyDown);

    this.onResize();
    this.ui.showSplash(this.state.levelManager.unlockedLevelIndex, this.state.levelManager.coins);
    requestAnimationFrame(this.loop);
  }

  /**
   * Stops everything in flight and returns the scene to a clean, empty board.
   * Used when a level starts or restarts and when leaving for the menu. Order
   * matters: animations are cancelled FIRST (running each one's cleanup, which
   * restores shared materials, frees pooled effects and removes popups), then
   * the blocks are released and the stack groups removed. Cancelled animations
   * never run their completions, so a half-played cascade cannot carry on into
   * the next level.
   */
  private resetRuntime(): void {
    this.input.cancelTargeting();
    this.input.cancelGesture();
    this.animationManager.clear();
    this.effects.reset();
    this.preview.hide();
    this.clearHandVisuals();
    this.blockManager.releaseAll();
    for (const group of this.stackGroups.values()) this.boardRoot.remove(group);
    this.stackGroups.clear();
    this.rocketArmed = false;
    this.miniRocketArmed = false;
    this.ui.setRocketArmed(false);
    this.ui.setMiniRocketArmed(false);
  }

  private startLevel(levelIndex: number): void {
    this.audio.unlock();
    this.resetRuntime();
    this.state.beginLevel(levelIndex);
    this.boardRenderer?.dispose();
    this.fitBoard();
    this.boardRenderer = new BoardRenderer(this.boardRoot, this.state.grid);
    this.preview.setGrid(this.state.grid);
    this.input.setGrid(this.state.grid);
    this.renderStartingStacks();

    this.ui.flash();
    this.popBoardIn();
    this.ui.setProgress(0, this.state.levelManager.def.target);
    this.ui.setCoins(this.state.levelManager.coins);
    this.ui.setCombo(null);
    this.ui.showHUD();
    this.syncBoosterUI();

    this.spawnHandVisuals();
    this.input.enabled = false;
    this.introOpen = true;
    this.ui.showLevelIntro(this.state.levelManager.levelIndex + 1, this.state.levelManager.def.target);
  }

  /**
   * Measures the current level's board and works out (a) where its middle is,
   * so it can be turned and viewed around that point instead of the grid's
   * (0,0) cell — custom board shapes are not symmetric around (0,0) — and (b)
   * how much to shrink it so the whole board, at any rotation, stays on screen
   * above the hand tray instead of running off the edge or into the tray.
   */
  private fitBoard(): void {
    const grid = this.state.grid;
    const cells = grid.allCells();
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    const pts = cells.map((c) => grid.coordinateToWorld(c.q, c.r, 0, BLOCK_HEIGHT));
    for (const p of pts) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    let radius = 0;
    for (const p of pts) radius = Math.max(radius, Math.hypot(p.x - cx, p.z - cz));
    radius += HEX_SIZE; // the outermost cell's own reach
    this.boardCenter.set(cx, cz);
    // Big boards shrink to fit; small ones grow a little so the cells stay big and easy to hit.
    this.boardScale = Math.min(BOARD_MAX_SCALE, BOARD_FIT_RADIUS / radius);
    this.boardRoot.scale.setScalar(this.boardScale);
    this.updateBoardPlacement();
  }

  /** Keeps the board's middle at the world origin (where the camera looks)
   * for every board rotation, so it turns in place around its own center. */
  private updateBoardPlacement(): void {
    // Runs every frame, so it reuses two vectors instead of allocating.
    // Uses the board's live scale (not the final one) so it stays centred while it pops in.
    const c = this.tmpCenter.set(this.boardCenter.x, 0, this.boardCenter.y);
    c.multiplyScalar(this.boardRoot.scale.x).applyAxisAngle(Y_AXIS, this.boardRoot.rotation.y);
    this.boardRoot.position.set(-c.x, 0, -c.z);
  }

  /** The whole board springs up from a smaller size when a level starts. */
  private popBoardIn(): void {
    const target = this.boardScale;
    const start = target * 0.55;
    this.boardRoot.scale.setScalar(start);
    const finish = (): void => {
      this.boardRoot.scale.setScalar(target);
    };
    this.animationManager.add(560, (t) => this.boardRoot.scale.setScalar(start + (target - start) * t), Easing.easeOutBack, finish, finish);
  }

  /** A short celebration on the board itself when the level is won. */
  private celebrateBoard(): void {
    const base = this.boardScale;
    const finish = (): void => {
      this.boardRoot.scale.setScalar(base);
    };
    this.animationManager.add(
      620,
      (t) => this.boardRoot.scale.setScalar(base * (1 + Math.sin(t * Math.PI) * 0.07)),
      Easing.easeOutQuad,
      finish,
      finish
    );
    this.effects.screenShake(0.1, 260);
  }

  private dismissLevelIntro(): void {
    this.introOpen = false;
    this.ui.hideLevelIntro();
    if (this.state.status !== GameStatus.PLAYING) return;
    // Pre-placed stacks drop onto the board one after another, then settle any merges.
    const groups = [...this.stackGroups.values()];
    const STAGGER_MS = 55;
    const DROP_MS = 380;
    groups.forEach((group, i) => {
      group.position.y = 6;
      this.animationManager.after(i * STAGGER_MS, () => {
        const from = new THREE.Vector3(group.position.x, 6, group.position.z);
        const to = new THREE.Vector3(group.position.x, 0, group.position.z);
        this.animationManager.animateMove(group, from, to, DROP_MS, Easing.easeOutBack);
      });
    });
    const total = groups.length > 0 ? (groups.length - 1) * STAGGER_MS + DROP_MS : 0;
    this.animationManager.after(total + 60, () => {
      if (this.state.status === GameStatus.PLAYING) this.settleBoard();
    });
  }

  /** Instantiates meshes for any stacks a level defines as already on the
   * board at start (LevelDef.startingStacks) — placed instantly, no drop
   * animation, since the player didn't put them there. */
  private renderStartingStacks(): void {
    for (const cell of this.state.grid.allCells()) {
      cell.stack.forEach((block, layer) => {
        const group = this.getOrCreateStackGroup(cell.q, cell.r);
        const mesh = this.blockManager.acquire(block.id, block.color);
        group.add(mesh);
        mesh.position.set(0, layer * LAYER_PITCH + BLOCK_HEIGHT / 2, 0);
        mesh.scale.set(1, 1, 1);
        mesh.userData.cellQ = cell.q;
        mesh.userData.cellR = cell.r;
      });
    }
  }

  private cellKey(q: number, r: number): string {
    return `${q},${r}`;
  }

  /** The one pivot Group ("HexaBlockGroup") for a cell — created lazily the
   * first time something is placed there, positioned exactly once at that
   * cell's board-local X/Z (Y=0, the board surface) and never moved again.
   * Every tile on that cell is added as a child with position.x/z LOCKED to
   * 0 — only position.y (its layer) is ever set — so every tile in the
   * stack is geometrically guaranteed to share the same center, not merely
   * computed to match. A child of boardRoot, so it rotates with the board
   * like everything else, with no per-tile compensation needed. */
  private getOrCreateStackGroup(q: number, r: number): THREE.Group {
    const key = this.cellKey(q, r);
    let group = this.stackGroups.get(key);
    if (!group) {
      group = new THREE.Group();
      const origin = this.state.grid.coordinateToWorld(q, r, 0, BLOCK_HEIGHT);
      group.position.set(origin.x, 0, origin.z);
      this.boardRoot.add(group);
      this.stackGroups.set(key, group);
    }
    return group;
  }

  /** Removes a cell's pivot group once every tile has left it (transferred
   * away or cleared) — checked against the group's actual visual children,
   * not the logical grid model, since a whole cascade's logical state is
   * always computed up-front while the visuals for it are still playing
   * back one step at a time. */
  private releaseStackGroupIfEmpty(q: number, r: number): void {
    const key = this.cellKey(q, r);
    const group = this.stackGroups.get(key);
    if (group && group.children.length === 0) {
      this.boardRoot.remove(group);
      this.stackGroups.delete(key);
    }
  }

  private syncBoosterUI(): void {
    const c = this.state.levelManager.boosterCharges;
    this.ui.setBoosterCharges(c.shuffle, c.rocket, c.miniRocket);
  }

  private clearHandVisuals(): void {
    for (let slot = 0; slot < this.handGroups.length; slot++) {
      const group = this.handGroups[slot];
      if (!group) continue;
      for (const child of [...group.children]) {
        const id = child.userData.blockId as string | undefined;
        if (id) this.blockManager.release(id);
      }
      this.sceneManager.scene.remove(group);
      this.handGroups[slot] = null;
    }
  }

  private spawnHandVisuals(): void {
    const hand = this.state.spawnSystem.getHand();
    hand.forEach((piece, slot) => {
      if (!piece || this.handGroups[slot]) return;
      // Same pivot-group pattern as a board stack's HexaBlockGroup: `group`
      // is the one pivot, every tile is its direct child with x/z LOCKED to
      // 0 and only y (its layer, same formula as the board) ever set — so
      // tray pieces get the identical "geometrically guaranteed centered"
      // guarantee as placed stacks, not just a coincidentally-matching one.
      const group = new THREE.Group();
      piece.forEach((layer, i) => {
        const mesh = this.blockManager.acquire(layer.id, layer.color);
        // x/z stay 0 — only y (the layer) is ever set, same rule as a
        // board stack's HexaBlockGroup. The tray's own y-offset convention
        // (no + BLOCK_HEIGHT/2 term) is unrelated to that guarantee — it's
        // just where TRAY_SLOTS was tuned to sit a piece's bottom layer.
        mesh.position.set(0, i * LAYER_PITCH, 0);
        mesh.scale.set(1, 1, 1);
        mesh.userData.blockId = layer.id;
        group.add(mesh);
      });
      group.position.copy(TRAY_SLOTS[slot]);
      group.scale.set(0.01, 0.01, 0.01);
      this.sceneManager.scene.add(group);
      this.handGroups[slot] = group;
      // Pieces pop in one after another, each with a little overshoot.
      const small = new THREE.Vector3(0.01, 0.01, 0.01);
      const full = new THREE.Vector3(this.boardScale, this.boardScale, this.boardScale);
      this.animationManager.after(slot * 90, () => this.animationManager.animateScale(group, small, full, 320, Easing.easeOutBack));
    });
    this.updateInputTargets();
  }

  private updateInputTargets(): void {
    const hand = this.state.spawnSystem.getHand();
    const targets: HandTarget[] = [];
    hand.forEach((piece, slot) => {
      const group = this.handGroups[slot];
      if (piece && group) targets.push({ slot, mesh: group, pieceLength: piece.length, topColor: piece[piece.length - 1].color, trayPosition: TRAY_SLOTS[slot] });
    });
    this.input.setHandTargets(targets);
  }

  private commitPlacement(slot: number, candidate: PreviewCandidate): void {
    // A drop that arrives while paused, resolving or finished is refused, and
    // the piece goes back to its tray slot.
    if (this.state.status !== GameStatus.PLAYING) {
      this.cancelPlacement(slot);
      return;
    }
    const group = this.handGroups[slot];
    const cell = this.state.grid.getCell(candidate.q, candidate.r);
    if (!group || !cell) {
      this.cancelPlacement(slot);
      return;
    }
    const baseLayer = cell.stack.length;
    // The board rule (empty, unblocked cell) is enforced in one place:
    // GameState.placePiece. It also takes the piece out of the hand.
    const piece = this.state.placePiece(slot, candidate.q, candidate.r);
    if (!piece) {
      this.cancelPlacement(slot);
      return;
    }

    this.input.enabled = false;
    this.state.status = GameStatus.RESOLVING;
    this.audio.drop();

    const destGroup = this.getOrCreateStackGroup(candidate.q, candidate.r);
    const children = [...group.children];
    children.forEach((child, i) => {
      // attach() reparents onto the destination cell's pivot group while
      // preserving the piece's current WORLD position — it comes out the
      // other side with the equivalent LOCAL position (relative to that
      // pivot), so the drop animation below runs entirely in the pivot's
      // local space from here on. The animation's "from" is whatever that
      // conversion produced; the "to" is snapped to the exact (0, y, 0)
      // formula regardless, so the tile always lands perfectly centered
      // even if "from" carried tiny floating-point drift.
      //
      // attach() ALSO preserves world ROTATION — the piece was unrotated
      // sitting in the (never-rotated) hand tray, so if boardRoot is
      // currently rotated, attach() would bake in a compensating local
      // rotation to keep it looking unrotated at this exact instant. That
      // compensation never updates again, so if the board is rotated
      // further afterward, this tile would visibly drift out of alignment
      // with every other tile placed at a different board angle. Force it
      // back to identity immediately — every tile must only ever inherit
      // rotation from its parent chain, never carry its own baked-in tilt.
      destGroup.attach(child);
      child.rotation.set(0, 0, 0);
      const from = child.position.clone();
      // Tag with its cell so the Rocket booster can hit-test tall stacks precisely.
      child.userData.cellQ = candidate.q;
      child.userData.cellR = candidate.r;

      const targetPos = new THREE.Vector3(0, (baseLayer + i) * LAYER_PITCH + BLOCK_HEIGHT / 2, 0);
      const isLast = i === children.length - 1;
      this.animationManager.animateDrop(
        child,
        from,
        targetPos,
        TIMING.drop,
        isLast
          ? () => {
              // A puff of the piece's top colour where it lands, then the merges begin.
              const land = this.state.grid.coordinateToWorld(candidate.q, candidate.r, baseLayer + children.length - 1, LAYER_PITCH);
              this.effects.landingPuff(new THREE.Vector3(land.x, land.y + BLOCK_HEIGHT, land.z), COLORS[piece[piece.length - 1].color]);
              this.resolveFrom(candidate.q, candidate.r);
            }
          : undefined
      );
    });

    this.sceneManager.scene.remove(group);
    this.handGroups[slot] = null;
    this.updateInputTargets();
  }

  /** Sends a dragged piece back to its tray slot (a refused or cancelled drop). */
  private cancelPlacement(slot: number): void {
    const group = this.handGroups[slot];
    if (!group) return;
    const from = group.position.clone();
    this.audio.invalid();
    this.animationManager.animateMove(group, from, TRAY_SLOTS[slot], 220, Easing.easeOutBack);
  }

  /**
   * Plays back the board's transfer/clear event log one event at a time —
   * this IS the cascade: each tile flip or stack completion is a discrete,
   * visible step, never an instant bulk state change.
   */
  private resolveFrom(originQ: number, originR: number): void {
    const events = this.resolveWholeBoard(originQ, originR);
    if (events.length === 0) {
      this.finalizeTurn(false);
      return;
    }
    this.playEvents(events, 0, 0);
  }

  /**
   * Resolves from the cell that just changed first (so its cascade plays in
   * the natural order), then sweeps every other occupied cell. The sweep makes
   * the whole board stable: any two neighbouring stacks that show the same top
   * color merge, wherever they are — not only next to the stack the player
   * just placed. Without it, matching neighbours elsewhere (for example a
   * level's pre-placed starting stacks) would just sit there and never flip.
   */
  private resolveWholeBoard(originQ?: number, originR?: number): ResolveEvent[] {
    // MergeSystem.resolveBoard already starts from the origin and then covers
    // every other occupied cell in one pass, with a single consistent rule.
    return resolveBoard(this.state.grid, originQ, originR);
  }

  /** Plays out any merges already waiting on the board (e.g. a level's starting stacks). */
  private settleBoard(): void {
    const events = this.resolveWholeBoard();
    if (events.length === 0) {
      if (this.state.status === GameStatus.PLAYING) this.input.enabled = true;
      return;
    }
    this.input.enabled = false;
    this.state.status = GameStatus.RESOLVING;
    this.playEvents(events, 0, 0);
  }

  /** Breaks an obstacle's ice block: a burst and a quick shrink, then it is
   * removed. If the animations are reset mid-shrink it is removed anyway, so
   * no ghost ice block can be left on the board. */
  private breakIce(q: number, r: number, burstSize: number): void {
    const iceMesh = this.boardRenderer?.clearObstacle(q, r);
    if (!iceMesh) return;
    const local = this.state.grid.coordinateToWorld(q, r, 0, BLOCK_HEIGHT);
    this.effects.clearBurst(new THREE.Vector3(local.x, 0.4, local.z), 0xbfe7f7, burstSize);
    const remove = (): void => {
      this.boardRoot.remove(iceMesh);
      BoardRenderer.disposeObstacleMesh(iceMesh);
    };
    this.animationManager.add(260, (t) => iceMesh.scale.setScalar(1 - t), Easing.easeOutQuad, remove, remove);
  }

  /**
   * `comboStep` counts clears so far in this cascade (the combo multiplier);
   * `chain` counts tile flips so far (it only drives the rising flip sound).
   */
  private playEvents(events: ResolveEvent[], index: number, comboStep: number, chain = 0): void {
    if (index >= events.length) {
      const touched = events.filter((e): e is Extract<ResolveEvent, { type: 'clear' }> => e.type === 'clear').map((e) => ({ q: e.q, r: e.r }));
      for (const hit of this.state.applyObstacleDamage(touched)) {
        if (hit.cleared) this.breakIce(hit.q, hit.r, 1);
      }
      this.finalizeTurn(comboStep > 0);
      return;
    }

    const event = events[index];

    if (event.type === 'transfer') {
      const mesh = this.blockManager.getMesh(event.id);
      if (!mesh) {
        this.playEvents(events, index + 1, comboStep, chain);
        return;
      }
      // Flight happens directly under boardRoot (not either cell's pivot
      // group) — it's briefly not "resting" on either stack, so the arc
      // animation runs in plain board-local space exactly as before.
      // attach() here only reparents (preserving world position); it does
      // not by itself put the mesh at the fromWorld point below. Rotation is
      // force-reset too (see the identical reset in commitPlacement) —
      // harmless here since a stack-pivot-group child is already unrotated,
      // but cheap insurance against ever carrying a stray tilt into the
      // flight/coin-flip animation below.
      this.boardRoot.attach(mesh);
      mesh.rotation.set(0, 0, 0);
      this.releaseStackGroupIfEmpty(event.fromQ, event.fromR);

      const fromWorld = this.state.grid.coordinateToWorld(event.fromQ, event.fromR, event.fromLayer, LAYER_PITCH);
      const toWorld = this.state.grid.coordinateToWorld(event.toQ, event.toR, event.toLayer, LAYER_PITCH);
      const from = new THREE.Vector3(fromWorld.x, fromWorld.y + BLOCK_HEIGHT / 2, fromWorld.z);
      const to = new THREE.Vector3(toWorld.x, toWorld.y + BLOCK_HEIGHT / 2, toWorld.z);
      mesh.userData.cellQ = event.toQ;
      mesh.userData.cellR = event.toR;
      this.audio.merge(chain);
      this.animationManager.animatePageFlip(mesh, from, to, 190, () => {
        // Landed — hand it off to the destination cell's pivot group and
        // snap to the exact (0, y, 0) formula, so it's geometrically
        // centered rather than merely "close" from the flight's arc math.
        const destGroup = this.getOrCreateStackGroup(event.toQ, event.toR);
        destGroup.attach(mesh);
        mesh.position.set(0, event.toLayer * LAYER_PITCH + BLOCK_HEIGHT / 2, 0);
        mesh.rotation.set(0, 0, 0);
        // A small soft puff where the tile lands, in its own color: it
        // marks the receiving stack so the eye can follow the flow.
        const landed = this.state.grid.coordinateToWorld(event.toQ, event.toR, event.toLayer, LAYER_PITCH);
        this.effects.landingPuff(new THREE.Vector3(landed.x, landed.y + BLOCK_HEIGHT, landed.z), COLORS[event.color]);
        this.playEvents(events, index + 1, comboStep, chain + 1);
      });
      return;
    }

    // event.type === 'clear' — a stack just reached the completion threshold.
    const step = comboStep + 1;
    this.ui.setCombo(step);
    if (step === 1) this.audio.match();
    else this.audio.cascade(step);
    if (step >= 2) {
      this.audio.combo(Math.min(step, 4));
      this.effects.screenShake(Math.min(0.05 + step * 0.025, 0.16), 220);
    }

    const colorHex = COLORS[event.color];
    let cx = 0;
    let cy = 0;
    let cz = 0;
    // Layers pop in a quick wave from the bottom up, so a big clear reads as
    // one satisfying sweep instead of every tile vanishing in the same frame.
    const LAYER_STAGGER_MS = 32;
    event.ids.forEach((id, i) => {
      const layer = event.baseLayer + i;
      const w = this.state.grid.coordinateToWorld(event.q, event.r, layer, LAYER_PITCH);
      const burstAt = new THREE.Vector3(w.x, w.y + BLOCK_HEIGHT / 2, w.z);
      this.animationManager.after(i * LAYER_STAGGER_MS, () => {
        const mesh = this.blockManager.getMesh(id);
        if (mesh) {
          const tileMesh = mesh.getObjectByName('tile') as THREE.Mesh;
          this.animationManager.animateClear(mesh, tileMesh, TIMING.clear);
        }
        this.effects.clearBurst(burstAt, colorHex, step);
      });
      cx += w.x;
      cy += w.y + BLOCK_HEIGHT / 2;
      cz += w.z;
    });

    const n = event.ids.length;
    const points = this.state.registerClear(n, step);
    this.effects.floatingText(new THREE.Vector3(cx / n, cy / n, cz / n), this.cameraManager.camera, `+${points}`, step >= 2 ? 'combo-pop' : '');
    this.ui.setProgress(this.state.levelManager.progress, this.state.levelManager.def.target);

    const totalMs = TIMING.clear + (n - 1) * LAYER_STAGGER_MS;
    this.animationManager.add(totalMs, () => undefined, Easing.linear, () => {
      for (const id of event.ids) this.blockManager.release(id);
      this.releaseStackGroupIfEmpty(event.q, event.r);
      this.playEvents(events, index + 1, step, chain);
    });
  }

  private finalizeTurn(hadClears: boolean): void {
    this.ui.setCombo(null);
    this.state.scoreSystem.onTurnResolved(hadClears);

    if (this.state.turnOutcome() === 'complete') {
      this.onLevelComplete();
      return;
    }

    this.state.refillHandIfNeeded();
    this.spawnHandVisuals();

    if (this.state.turnOutcome() === 'failed') {
      this.onLevelFailed();
      return;
    }

    this.state.status = GameStatus.PLAYING;
    this.input.enabled = true;
  }

  private onLevelComplete(): void {
    this.input.enabled = false;
    this.disarmRocket();
    this.disarmMiniRocket();
    // completeLevel() pays the reward exactly once, however many code paths
    // notice the goal being reached; 0 means it was already handled.
    if (this.state.status === GameStatus.LEVEL_COMPLETE) return;
    const reward = this.state.completeLevel();
    this.ui.setCoins(this.state.levelManager.coins);
    this.audio.combo(4);
    this.celebrateBoard();
    this.ui.showVictory(this.state.levelManager.levelIndex + 1, reward, this.state.levelManager.isLastLevel);
  }

  private onNextLevelClicked(): void {
    if (this.state.levelManager.isLastLevel) {
      this.returnToMainMenu();
      return;
    }
    this.startLevel(this.state.levelManager.levelIndex + 1);
  }

  private onResetLevelConfirmed(): void {
    this.state.levelManager.resetProgress();
    this.ui.hideResetConfirm();
    this.ui.showSplash(this.state.levelManager.unlockedLevelIndex, this.state.levelManager.coins);
  }

  private returnToMainMenu(): void {
    // Cancel everything in flight first: otherwise a cascade that was still
    // playing when the player left would finish behind the menu, refill the
    // hand and switch the game back to PLAYING.
    this.input.enabled = false;
    this.resetRuntime();
    this.state.status = GameStatus.MENU;
    this.boardRenderer?.dispose();
    this.boardRenderer = null;
    this.ui.hidePaused();
    this.ui.hideFail();
    this.ui.flash();
    this.ui.showSplash(this.state.levelManager.unlockedLevelIndex, this.state.levelManager.coins);
  }

  private onLevelFailed(): void {
    this.state.failLevel();
    this.input.enabled = false;
    this.disarmRocket();
    this.disarmMiniRocket();
    this.audio.gameOver();
    const lm = this.state.levelManager;
    this.ui.showFail(lm.levelIndex + 1, Math.max(0, lm.def.target - lm.progress), !this.state.playOnUsed);
  }

  /**
   * PLAY ON (the "No moves left" board): a once-per-level rescue. Clears the
   * three tallest stacks to open up room, then hands control back. The cleared
   * blocks do not count toward the level goal — it buys space, not progress.
   */
  private onPlayOn(): void {
    const result = this.state.playOn(); // null if already used or not in the failed state
    if (!result) return;
    this.animateBoosterResult(result, 0xff8a3d, 2);
    this.audio.combo(3);
    this.effects.screenShake(0.1, 220);
    this.ui.hideFail();
    this.input.enabled = true;
  }

  /** Plays the visuals for what a booster rule just removed (see BoosterSystem):
   * each cleared stack's blocks pop in a wave, broken obstacles shatter. */
  private animateBoosterResult(result: BoosterResult, burstColor: number, burstSize: number): void {
    for (const stack of result.stacks) {
      const local = this.state.grid.coordinateToWorld(stack.q, stack.r, 0, BLOCK_HEIGHT);
      stack.ids.forEach((id, i) => {
        this.animationManager.after(i * 24, () => {
          const mesh = this.blockManager.getMesh(id);
          if (mesh) {
            const tileMesh = mesh.getObjectByName('tile') as THREE.Mesh;
            this.animationManager.animateClear(mesh, tileMesh, TIMING.clear, () => {
              this.blockManager.release(id);
              this.releaseStackGroupIfEmpty(stack.q, stack.r);
            });
          }
          const w = this.state.grid.coordinateToWorld(stack.q, stack.r, i, LAYER_PITCH);
          this.effects.clearBurst(new THREE.Vector3(local.x, w.y + BLOCK_HEIGHT / 2, local.z), burstColor, burstSize);
        });
      });
    }
    for (const o of result.obstacles) this.breakIce(o.q, o.r, burstSize);
  }

  private onShuffleClicked(): void {
    if (this.state.status !== GameStatus.PLAYING) return;
    if (!this.state.levelManager.useBooster('shuffle')) return;
    this.syncBoosterUI();
    this.audio.click();
    this.disarmRocket();
    this.disarmMiniRocket();
    this.clearHandVisuals();
    this.state.spawnSystem.reset();
    this.state.refillHandIfNeeded();
    this.spawnHandVisuals();
  }

  private onRocketClicked(): void {
    if (this.state.status !== GameStatus.PLAYING) return;
    if (this.rocketArmed) {
      this.disarmRocket();
      return;
    }
    if (this.state.levelManager.boosterCharges.rocket <= 0) return;
    this.disarmMiniRocket();
    this.rocketArmed = true;
    this.ui.setRocketArmed(true);
    this.input.beginTargeting(
      (q, r) => this.onRocketTarget(q, r),
      () => this.blockManager.getAllActiveMeshes()
    );
  }

  private disarmRocket(): void {
    if (!this.rocketArmed) return;
    this.rocketArmed = false;
    this.ui.setRocketArmed(false);
    this.input.cancelTargeting();
  }

  private onRocketTarget(q: number, r: number): void {
    // Tapping an empty cell must not waste the charge or silently disarm the
    // booster — keep it armed and wait for a real target.
    const result = applyRocket(this.state.grid, q, r);
    if (!result) {
      if (this.rocketArmed) {
        this.input.beginTargeting(
          (tq, tr) => this.onRocketTarget(tq, tr),
          () => this.blockManager.getAllActiveMeshes()
        );
      }
      return;
    }
    this.rocketArmed = false;
    this.ui.setRocketArmed(false);
    this.state.levelManager.useBooster('rocket');
    this.syncBoosterUI();
    this.audio.combo(3);
    this.finishBooster(result, 0.1, 220);
  }

  /** Shared ending of Rocket and Mini Rocket: animate what was removed, count
   * the cleared blocks toward the goal, and finish the level if that was enough.
   * Broken obstacles contribute 0 — only blocks count. */
  private finishBooster(result: BoosterResult, shake: number, shakeMs: number): void {
    this.animateBoosterResult(result, 0xff8a3d, 2);
    this.effects.screenShake(shake, shakeMs);
    this.state.levelManager.addProgress(result.blocksCleared);
    this.ui.setProgress(this.state.levelManager.progress, this.state.levelManager.def.target);
    if (this.state.turnOutcome() === 'complete') this.onLevelComplete();
  }

  /** Mini Rocket: like the Rocket booster (target a cell, arm/disarm on a
   * second click, mutually exclusive with it since both share the one
   * targeting-callback slot on InputManager) but hits 3 whole hexacells
   * instead of 1 — the targeted cell plus its 2 nearest OCCUPIED neighbors
   * (every immediate neighbor in a hex grid is equally "nearest", distance
   * 1, so this just takes the first 2 that actually have something to
   * clear), each fully cleared the same way Rocket clears its one cell. */
  private onMiniRocketClicked(): void {
    if (this.state.status !== GameStatus.PLAYING) return;
    if (this.miniRocketArmed) {
      this.disarmMiniRocket();
      return;
    }
    if (this.state.levelManager.boosterCharges.miniRocket <= 0) return;
    this.disarmRocket();
    this.miniRocketArmed = true;
    this.ui.setMiniRocketArmed(true);
    this.input.beginTargeting(
      (q, r) => this.onMiniRocketTarget(q, r),
      () => this.blockManager.getAllActiveMeshes()
    );
  }

  private disarmMiniRocket(): void {
    if (!this.miniRocketArmed) return;
    this.miniRocketArmed = false;
    this.ui.setMiniRocketArmed(false);
    this.input.cancelTargeting();
  }

  private onMiniRocketTarget(q: number, r: number): void {
    const result = applyMiniRocket(this.state.grid, q, r);
    if (!result) {
      if (this.miniRocketArmed) {
        this.input.beginTargeting(
          (tq, tr) => this.onMiniRocketTarget(tq, tr),
          () => this.blockManager.getAllActiveMeshes()
        );
      }
      return;
    }
    this.miniRocketArmed = false;
    this.ui.setMiniRocketArmed(false);
    this.state.levelManager.useBooster('miniRocket');
    this.syncBoosterUI();
    this.audio.combo(3);
    this.finishBooster(result, 0.12, 240);
  }

  /** Pauses a running level: input off (which also drops any drag in
   * progress), booster targeting cancelled, animations frozen by the loop. */
  private pauseGame(): void {
    if (!this.state.pause()) return;
    this.disarmRocket();
    this.disarmMiniRocket();
    this.input.enabled = false; // cancels a piece mid-drag and sends it back to the tray
    this.ui.showPaused();
  }

  private resumeGame(): void {
    const resumedTo = this.state.resume();
    if (resumedTo === null) return;
    this.ui.hidePaused();
    // Input only comes back if the player was waiting for a move and no
    // full-screen board (the level intro) is open; a cascade that was
    // interrupted simply carries on and re-enables input itself when done.
    this.input.enabled = resumedTo === GameStatus.PLAYING && !this.introOpen;
    this.clock.resync();
  }

  private togglePause(): void {
    if (this.state.isPaused) this.resumeGame();
    else this.pauseGame();
  }

  private toggleMute(): void {
    const muted = this.audio.toggleMute();
    this.ui.setMuted(muted);
  }

  /** Switching tabs or minimising pauses the game — the Paused board is waiting on return. */
  private onVisibilityChange = (): void => {
    if (document.hidden) this.pauseGame();
  };

  /** Esc or P pauses and resumes from the keyboard. */
  private onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.repeat) return;
    if (ev.key === 'Escape' || ev.key === 'p' || ev.key === 'P') {
      this.togglePause();
    }
  };

  private onResize = (): void => {
    // Size from the portrait container (#app), not the whole window.
    const host = this.canvas.parentElement;
    const width = host?.clientWidth || window.innerWidth;
    const height = host?.clientHeight || window.innerHeight;
    host?.style.setProperty('--ui-scale', String(Math.min(1.6, Math.max(1, width / 390))));
    this.sceneManager.setSize(width, height);
    this.cameraManager.applyFraming(width / height);
  };

  /** Pieces waiting in the tray float gently up and down, each on its own beat.
   * A piece that is being dragged or sent back is away from its slot, so it is left alone. */
  private bobHand(): void {
    const t = performance.now() / 1000;
    this.handGroups.forEach((group, slot) => {
      if (!group) return;
      const home = TRAY_SLOTS[slot];
      if (Math.abs(group.position.x - home.x) > 0.02 || Math.abs(group.position.z - home.z) > 0.02) return;
      group.position.y = home.y + Math.sin(t * 2.2 + slot * 1.7) * 0.07;
    });
  }

  private loop = (): void => {
    const dt = this.clock.tick();
    if (this.state.status !== GameStatus.PAUSED) {
      this.animationManager.update(dt);
      // Must run before effects.update(dt): the rig recomputes camera.position
      // from its base pose here, and screen-shake (inside effects.update)
      // then layers a transient offset on TOP of that for the rest of the
      // frame — reversing the order would let this overwrite the shake.
      this.cameraManager.update(dt); // smooth camera pitch toward the drag target
      this.effects.update(dt);
      this.input.update(dt); // smooth boardRoot.rotation.y toward the drag target
      this.preview.tick(dt); // keeps the drop preview's pulse moving while the pointer is still
    }
    this.bobHand();
    this.updateBoardPlacement();
    this.boardRenderer?.updateLabels(this.cameraManager.camera, this.canvas);
    this.sceneManager.renderer.render(this.sceneManager.scene, this.cameraManager.camera);
    requestAnimationFrame(this.loop);
  };
}
