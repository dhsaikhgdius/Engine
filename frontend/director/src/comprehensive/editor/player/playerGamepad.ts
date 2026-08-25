/**
 * Standard-mapping gamepad support for roam mode. A pure sampling layer turns
 * the raw Gamepad snapshot into roam commands; the controller merges them
 * with keyboard/pointer input every frame, so pad and desk inputs coexist.
 *
 * Button layout (W3C "standard" mapping):
 *   left stick  — analog move (radial deadzone, tilt scales speed)
 *   right stick — free look
 *   A(0) jump · B(1) crouch hold · X(2) dash · Y(3) first/third person
 *   LB(4) slow-walk toggle · RB(5) flight toggle
 *   LT(6) flight descend · RT(7) aim hold
 *   D-pad(12-15) emotes 1-4
 */

/** Stick deflection below this magnitude is treated as zero (normalized 0–1). */
export const PLAYER_GAMEPAD_STICK_DEADZONE = 0.15;
/** Full-tilt horizontal look rate in radians per second. */
export const PLAYER_GAMEPAD_LOOK_YAW_RAD_S = 2.7;
/** Full-tilt vertical look rate in radians per second. */
export const PLAYER_GAMEPAD_LOOK_PITCH_RAD_S = 1.8;
const TRIGGER_THRESHOLD = 0.5;

const BUTTON_JUMP = 0;
const BUTTON_CROUCH = 1;
const BUTTON_DASH = 2;
const BUTTON_VIEW_TOGGLE = 3;
const BUTTON_SLOW_WALK_TOGGLE = 4;
const BUTTON_FLIGHT_TOGGLE = 5;
const BUTTON_DESCEND = 6;
const BUTTON_AIM = 7;
const BUTTON_DPAD_UP = 12;
const GAMEPAD_TRACKED_BUTTONS = 16;

export type PlayerGamepadFrame = {
  /** Whether a gamepad is connected and mapped. */
  connected: boolean;
  /** -1..1 after radial deadzone; +forward / +right. */
  moveForwardAxis: number;
  moveRightAxis: number;
  /** -1..1 stick deflections; positive turns right / looks down. */
  lookRightAxis: number;
  lookDownAxis: number;
  /** Whether the aim trigger is held (LB or LT above threshold). */
  aim: boolean;
  /** Whether the crouch button is held. */
  crouch: boolean;
  /** Whether the flight-descend button is held. */
  descend: boolean;
  /** Whether the jump button is held. */
  jump: boolean;
  /** True only on the press edge (rising edge) of the jump button. */
  jumpPressed: boolean;
  /** Whether the sprint condition is active (stick near full deflection). */
  sprint: boolean;
  /** True only on the press edge of the dash button. */
  dashPressed: boolean;
  /** True only on the press edge of the flight toggle button. */
  flightTogglePressed: boolean;
  /** True only on the press edge of the slow-walk toggle button. */
  slowWalkTogglePressed: boolean;
  /** True only on the press edge of the first/third-person view toggle button. */
  viewTogglePressed: boolean;
  /** 0-3 for D-pad up/down/left/right on the press edge, else null. */
  emotePressedIndex: number | null;
};

/**
 * Returns a zeroed frame with no gamepad connected. The caller may reuse the
 * returned object across frames by passing it to `pollPlayerGamepad`.
 */
export function createEmptyPlayerGamepadFrame(): PlayerGamepadFrame {
  return {
    connected: false,
    moveForwardAxis: 0,
    moveRightAxis: 0,
    lookRightAxis: 0,
    lookDownAxis: 0,
    aim: false,
    crouch: false,
    descend: false,
    jump: false,
    jumpPressed: false,
    sprint: false,
    dashPressed: false,
    flightTogglePressed: false,
    slowWalkTogglePressed: false,
    viewTogglePressed: false,
    emotePressedIndex: null,
  };
}

/** Tracks per-button held state between frames for edge detection. */
export type PlayerGamepadTracker = { pressed: boolean[] };

/**
 * Creates a tracker with all buttons in the released state. Must be the same
 * instance across frames for press edges to fire exactly once per physical press.
 */
export function createPlayerGamepadTracker(): PlayerGamepadTracker {
  return { pressed: new Array<boolean>(GAMEPAD_TRACKED_BUTTONS).fill(false) };
}

/**
 * Radial deadzone with rescaling: deflection just past the deadzone starts at
 * zero instead of jumping, preserving fine low-speed analog control.
 *
 * @param x - Raw horizontal stick deflection (-1..1).
 * @param y - Raw vertical stick deflection (-1..1).
 * @returns A tuple `[x, y]` with magnitude remapped from (deadzone, 1] to (0, 1],
 *  or `[0, 0]` when the input is inside the deadzone.
 */
export function applyPlayerGamepadDeadzone(x: number, y: number): [number, number] {
  const magnitude = Math.hypot(x, y);
  if (!(magnitude > PLAYER_GAMEPAD_STICK_DEADZONE)) return [0, 0];
  const scaled = Math.min(1, (magnitude - PLAYER_GAMEPAD_STICK_DEADZONE) / (1 - PLAYER_GAMEPAD_STICK_DEADZONE));
  return [(x / magnitude) * scaled, (y / magnitude) * scaled];
}

type GamepadButtonLike = { pressed: boolean; value: number };
type GamepadLike = {
  axes: readonly number[];
  buttons: readonly GamepadButtonLike[];
  connected: boolean;
  mapping: string;
};

function isButtonDown(gamepad: GamepadLike, index: number) {
  const button = gamepad.buttons[index];
  if (!button) return false;
  return button.pressed || button.value > TRIGGER_THRESHOLD;
}

/**
 * Sample one gamepad into roam commands and advance the edge tracker. The
 * tracker must be the same instance across frames for press edges to fire
 * exactly once per physical press.
 *
 * @param gamepad - The raw browser Gamepad snapshot, or null/undefined when
 *  no pad is connected.
 * @param tracker - Per-button held-state tracker, mutated in place.
 * @param out - Optional frame to write into; a new zeroed frame is created
 *  when omitted.
 * @returns The populated `PlayerGamepadFrame`.
 */
export function readPlayerGamepadFrame(
  gamepad: GamepadLike | null | undefined,
  tracker: PlayerGamepadTracker,
  out: PlayerGamepadFrame = createEmptyPlayerGamepadFrame(),
): PlayerGamepadFrame {
  if (!gamepad || !gamepad.connected) {
    tracker.pressed.fill(false);
    const empty = createEmptyPlayerGamepadFrame();
    Object.assign(out, empty);
    return out;
  }

  const [stickRight, stickForwardRaw] = applyPlayerGamepadDeadzone(gamepad.axes[0] ?? 0, gamepad.axes[1] ?? 0);
  const [lookRight, lookDown] = applyPlayerGamepadDeadzone(gamepad.axes[2] ?? 0, gamepad.axes[3] ?? 0);

  const down: boolean[] = new Array<boolean>(GAMEPAD_TRACKED_BUTTONS);
  const edge: boolean[] = new Array<boolean>(GAMEPAD_TRACKED_BUTTONS);
  for (let index = 0; index < GAMEPAD_TRACKED_BUTTONS; index += 1) {
    down[index] = isButtonDown(gamepad, index);
    edge[index] = down[index] && !tracker.pressed[index];
    tracker.pressed[index] = down[index];
  }

  let emotePressedIndex: number | null = null;
  for (let offset = 0; offset < 4; offset += 1) {
    if (edge[BUTTON_DPAD_UP + offset]) {
      emotePressedIndex = offset;
      break;
    }
  }

  out.connected = true;
  // The Gamepad API reports +Y as stick-down; roam forward is stick-up.
  out.moveForwardAxis = -stickForwardRaw;
  out.moveRightAxis = stickRight;
  out.lookRightAxis = lookRight;
  out.lookDownAxis = lookDown;
  out.aim = down[BUTTON_AIM];
  out.crouch = down[BUTTON_CROUCH];
  out.descend = down[BUTTON_DESCEND];
  out.jump = down[BUTTON_JUMP];
  out.jumpPressed = edge[BUTTON_JUMP];
  // Full stick deflection sprints, mirroring modern third-person defaults.
  out.sprint = Math.hypot(stickRight, stickForwardRaw) > 0.97;
  out.dashPressed = edge[BUTTON_DASH];
  out.flightTogglePressed = edge[BUTTON_FLIGHT_TOGGLE];
  out.slowWalkTogglePressed = edge[BUTTON_SLOW_WALK_TOGGLE];
  out.viewTogglePressed = edge[BUTTON_VIEW_TOGGLE];
  out.emotePressedIndex = emotePressedIndex;
  return out;
}

/**
 * Pick the first connected pad, preferring standard mapping for the layout.
 *
 * @param gamepads - The array from `navigator.getGamepads()`.
 * @returns The best-matching connected gamepad, or null when none are connected.
 */
export function selectActivePlayerGamepad(gamepads: readonly (GamepadLike | null)[]): GamepadLike | null {
  let fallback: GamepadLike | null = null;
  for (const gamepad of gamepads) {
    if (!gamepad || !gamepad.connected) continue;
    if (gamepad.mapping === "standard") return gamepad;
    fallback ??= gamepad;
  }
  return fallback;
}

/**
 * Snapshot the browser's gamepads into a roam frame. Safe in environments
 * without the Gamepad API (returns a zeroed frame).
 *
 * @param tracker - Per-button held-state tracker, mutated in place.
 * @param out - Optional frame to write into; a new one is created when omitted.
 * @returns The populated `PlayerGamepadFrame`.
 */
export function pollPlayerGamepad(tracker: PlayerGamepadTracker, out?: PlayerGamepadFrame): PlayerGamepadFrame {
  let gamepad: GamepadLike | null = null;
  try {
    const gamepads = typeof navigator !== "undefined" && typeof navigator.getGamepads === "function"
      ? navigator.getGamepads()
      : [];
    gamepad = selectActivePlayerGamepad(gamepads as readonly (GamepadLike | null)[]);
  } catch {
    gamepad = null;
  }
  return readPlayerGamepadFrame(gamepad, tracker, out);
}
