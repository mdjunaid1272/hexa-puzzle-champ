// All tunable constants live here — no magic numbers elsewhere.

export const HEX_SIZE = 1.0;
export const BLOCK_HEIGHT = 0.14; // thin slabs: stacks read as many slim layers
// Visible seam between stacked tiles: each layer sits LAYER_PITCH apart
// (taller than the tile itself), leaving a thin gap so a stack reads as
// separate stacked discs instead of one solid touching column.
export const LAYER_GAP = 0.02;
export const LAYER_PITCH = BLOCK_HEIGHT + LAYER_GAP;
export const BOARD_RADIUS = 4; // physical grid radius, never changes
export const MAX_STACK_HEIGHT = 10;
// A stack "completes" and clears once this many same-color tiles are stacked
// consecutively on top of it — reached via top-color transfers from
// neighbors, not by flood-filling the whole board. Tune freely.
export const COMPLETION_THRESHOLD = 5;

export const BASE_SCORE_PER_BLOCK = 10;

export const DRAG_LIFT_HEIGHT = 3.0;

// The camera is fixed (side-top angle, never orbits) — instead the whole
// board rotates around its own vertical (Y) axis, like a physical puzzle
// platter. Radians of board yaw per pixel of horizontal drag.
export const BOARD_ROTATION_SENSITIVITY = 0.008;
// Exponential convergence rate (per second) for smoothing the board's
// current rotation toward the drag target — high enough to feel immediate
// (converges within a couple of frames) while still ironing out per-event
// jitter from discrete pointermove samples.
export const BOARD_ROTATION_SMOOTHING_RATE = 18;
// A pleasant non-zero starting yaw (degrees) so the board doesn't default
// to a perfectly square-on view.
export const INITIAL_BOARD_ROTATION_DEG = 0; // square-on: hex columns run straight up and down, like a puzzle on a table

// The camera never orbits horizontally (the board's own yaw covers that —
// see above) but it DOES tilt vertically: PITCH is the angle, in degrees,
// between the camera and the board's vertical (Y) axis. Small pitch reads
// as more top-down; large pitch reads as a lower, more side-on view. Drag
// up on empty space/background raises pitch (more side-on, as if pulling
// the far edge of the board up toward you); drag down lowers it (more
// top-down) — see InputManager.
// A subtle band around the initial framing, not a dramatic top-down<->side
// swing — the board's own rotation is the primary way to look around it,
// tilt is just a small adjustment on top of that fixed side-top read.
export const MIN_CAMERA_PITCH_DEG = 14;
export const MAX_CAMERA_PITCH_DEG = 46;
// A high, mostly top-down view: cells read as big flat hexagons that are easy
// to aim at, with just enough tilt to see the stacks' side layers.
export const INITIAL_CAMERA_PITCH_DEG = 28;
// Fixed radius from the board center — pitch only changes elevation around
// that sphere, never zoom (zoom is the separate wheel/pinch control).
export const CAMERA_DISTANCE = 26.9072481;
// Degrees of pitch per pixel of vertical background drag.
export const CAMERA_PITCH_SENSITIVITY = 0.08;
// Exponential convergence rate (per second) for smoothing actual pitch
// toward the drag target — same feel as BOARD_ROTATION_SMOOTHING_RATE.
export const CAMERA_PITCH_SMOOTHING_RATE = 18;
// A background (non-piece) drag doesn't commit to rotating the board or
// tilting the camera until it has moved this many pixels — below that it's
// still considered a stationary tap/jitter. Once past it, whichever axis
// (horizontal vs vertical) has moved further for the rest of that single
// drag gesture.
export const DRAG_THRESHOLD_PX = 7;

export const HAND_SIZE = 3;
export const BOOSTER_STARTING_CHARGES = 2;
// Every freshly generated piece is exactly three contiguous color groups
// (A×n + B×m + C×k, three different colors, never interleaved) — this is
// the size of ONE group, not the whole piece. Weighted toward 2 so group
// boundaries are usually visually obvious without pieces getting huge.
export const GROUP_SIZE_WEIGHTS: { size: number; weight: number }[] = [
  { size: 1, weight: 2 },
  { size: 2, weight: 3 },
  { size: 3, weight: 3 },
  { size: 4, weight: 1 }
];

// Block side-wall colors, one per block color, in the SAME order as the
// top-face artwork list in HexBlockMesh.ts (index-for-index). Each value is
// the average face color of that color's artwork, so the lit side walls match
// the glossy tops. Pieces use the first `activeColors` entries of this list.
export const COLORS = [
  0xf8b41c, // sunflower (yellow)
  0x1e93e8, // sky (blue)
  0xe81d20, // cherry (red)
  0xf186af, // punch (pink)
  0x5bbd42, // leaf (green)
  0xf46718, // tangerine (orange)
  0x743a8c, // violet (purple)
  0x2bd7d2 // aqua (cyan)
];

export const COLOR_NAMES = ['sunflower', 'sky', 'cherry', 'punch', 'leaf', 'tangerine', 'violet', 'aqua'];

export const TIMING = {
  pickup: 120,
  drop: 240,
  clear: 300,
  cascadeFall: 190,
  comboPopup: 450
};

// Base lens settings for the camera rig (see CameraManager). Position is no
// longer a fixed point — it's derived every frame from CAMERA_DISTANCE and
// the current pitch (CAMERA_PITCH_* above), and always looks at the board's
// actual world center rather than a hardcoded point.
export const CAMERA = {
  fov: 36,
  near: 0.1,
  far: 100
};

export const STORAGE_KEYS = {
  coins: 'hexcascade.coins',
  unlockedLevel: 'hexcascade.unlockedLevel',
  muted: 'hexcascade.muted'
};
