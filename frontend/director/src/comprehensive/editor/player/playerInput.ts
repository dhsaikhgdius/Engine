import type { PlayerInput } from "./playerLocomotion";

const MOVEMENT_CODES = new Set([
  "KeyW",
  "KeyS",
  "KeyA",
  "KeyD",
  "ShiftLeft",
  "ShiftRight",
  "Space",
  "ControlLeft",
  "ControlRight",
  "KeyQ",
  "KeyE",
  "KeyC",
  "KeyR",
]);

const LOOK_CODES = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

/**
 * Returns a zeroed input frame with all held keys and axes released.
 * The caller may mutate and reuse the returned object across frames.
 */
export function createEmptyPlayerInput(): PlayerInput {
  return {
    forward: false,
    backward: false,
    left: false,
    right: false,
    sprint: false,
    jump: false,
    jumpPressed: false,
    ascend: false,
    descend: false,
    dash: false,
    crouch: false,
    slowWalk: false,
    slowWalkKeyHeld: false,
    lookLeft: false,
    lookRight: false,
    lookUp: false,
    lookDown: false,
    moveForwardAxis: 0,
    moveRightAxis: 0,
  };
}

/**
 * Returns whether the key code is consumed by the roam movement layer.
 * Callers should skip their own handlers when this returns true.
 *
 * @param code - A KeyboardEvent.code string.
 */
export function isPlayerMovementKey(code: string) {
  return MOVEMENT_CODES.has(code);
}

/**
 * Returns whether the key code is consumed by the roam look layer.
 *
 * @param code - A KeyboardEvent.code string.
 */
export function isPlayerLookKey(code: string) {
  return LOOK_CODES.has(code);
}

/**
 * Returns whether the key code is consumed by any roam input layer
 * (movement or look).
 *
 * @param code - A KeyboardEvent.code string.
 */
export function isPlayerRoamKey(code: string) {
  return isPlayerMovementKey(code) || isPlayerLookKey(code);
}

/**
 * Mutates the roam input frame in response to a movement key change.
 * Handles press-edge detection for jump and slow-walk toggle.
 *
 * @param input - The roam input frame to mutate.
 * @param code - A KeyboardEvent.code string from the movement set.
 * @param value - True on keydown, false on keyup.
 */
export function updatePlayerMovementKey(input: PlayerInput, code: string, value: boolean) {
  if (code === "KeyW") input.forward = value;
  if (code === "KeyS") input.backward = value;
  if (code === "KeyA") input.left = value;
  if (code === "KeyD") input.right = value;
  if (code === "ShiftLeft" || code === "ShiftRight") input.sprint = value;
  if (code === "Space") {
    if (value && !input.jump) input.jumpPressed = true;
    input.jump = value;
  }
  // Flight-only vertical aliases follow the Q-down / E-up walk-mode
  // convention. They never latch jumpPressed, so E cannot fire ground jumps.
  if (code === "KeyE") input.ascend = value;
  if (code === "ControlLeft" || code === "ControlRight" || code === "KeyQ") input.descend = value;
  if (code === "KeyC") input.crouch = value;
  if (code === "KeyR") {
    // Toggle only on the first physical press: browsers auto-repeat keydown
    // while the key is held, and the controller forwards repeats verbatim.
    if (value && !input.slowWalkKeyHeld) input.slowWalk = !input.slowWalk;
    input.slowWalkKeyHeld = value;
  }
}

/**
 * Mutates the roam input frame in response to a look key change.
 *
 * @param input - The roam input frame to mutate.
 * @param code - A KeyboardEvent.code string from the look set.
 * @param value - True on keydown, false on keyup.
 */
export function updatePlayerLookKey(input: PlayerInput, code: string, value: boolean) {
  if (code === "ArrowLeft") input.lookLeft = value;
  if (code === "ArrowRight") input.lookRight = value;
  if (code === "ArrowUp") input.lookUp = value;
  if (code === "ArrowDown") input.lookDown = value;
}

/** Keyboard horizontal look rate in radians per second. */
export const PLAYER_KEYBOARD_LOOK_YAW_RAD_S = 2.4;
/** Keyboard vertical look rate in radians per second. */
export const PLAYER_KEYBOARD_LOOK_PITCH_RAD_S = 1.9;

/**
 * Converts held look keys into normalized axis values. +yaw looks right,
 * +pitch looks down — same sign as the gamepad look stick.
 *
 * @param input - The roam input frame to read look keys from.
 * @returns An object with `yaw` and `pitch` each in the range -1..1.
 */
export function getPlayerLookAxes(input: PlayerInput): { yaw: number; pitch: number } {
  return {
    yaw: Number(Boolean(input.lookRight)) - Number(Boolean(input.lookLeft)),
    pitch: Number(Boolean(input.lookDown)) - Number(Boolean(input.lookUp)),
  };
}

/**
 * Non-movement codes the roam controller consumes directly (view toggle,
 * flight toggle, roam exit). Kept here so new bindings can assert they do not
 * shadow an existing gameplay key.
 */
export const PLAYER_CONTROLLER_RESERVED_CODES = new Set(["KeyV", "KeyF", "Escape", "Enter"]);

/**
 * Enter/exit-vehicle key. KeyF is taken by the flight toggle, so per the
 * vehicle interaction spec the fallback KeyE is used. KeyE's only walking
 * binding is the flight-mode ascend alias, which is inert on foot, and the
 * vehicle prompt never appears while flying, so the two uses cannot collide.
 */
export const PLAYER_VEHICLE_TOGGLE_CODE = "KeyE";

/** Held driving keys; W/S semantics (throttle vs brake/reverse) resolve later. */
export type PlayerVehicleDriveInput = {
  /** Throttle forward (W or ArrowUp). */
  forward: boolean;
  /** Brake or reverse (S or ArrowDown). */
  backward: boolean;
  /** Steer left (A or ArrowLeft). */
  left: boolean;
  /** Steer right (D or ArrowRight). */
  right: boolean;
  /** Handbrake held (Space). */
  handbrake: boolean;
};

/** KeyboardEvent.code values that map to vehicle drive controls. */
export const PLAYER_VEHICLE_DRIVE_CODES = new Set([
  "KeyW",
  "ArrowUp",
  "KeyS",
  "ArrowDown",
  "KeyA",
  "ArrowLeft",
  "KeyD",
  "ArrowRight",
  "Space",
]);

/**
 * Returns a zeroed vehicle drive input frame with all keys released.
 */
export function createEmptyPlayerVehicleDriveInput(): PlayerVehicleDriveInput {
  return { forward: false, backward: false, left: false, right: false, handbrake: false };
}

/**
 * Returns whether the key code is consumed by the vehicle drive layer.
 *
 * @param code - A KeyboardEvent.code string.
 */
export function isPlayerVehicleDriveKey(code: string) {
  return PLAYER_VEHICLE_DRIVE_CODES.has(code);
}

/**
 * Mutates the vehicle drive input frame in response to a drive key change.
 *
 * @param input - The vehicle drive input frame to mutate.
 * @param code - A KeyboardEvent.code string from the vehicle drive set.
 * @param value - True on keydown, false on keyup.
 */
export function updatePlayerVehicleDriveKey(input: PlayerVehicleDriveInput, code: string, value: boolean) {
  if (code === "KeyW" || code === "ArrowUp") input.forward = value;
  if (code === "KeyS" || code === "ArrowDown") input.backward = value;
  if (code === "KeyA" || code === "ArrowLeft") input.left = value;
  if (code === "KeyD" || code === "ArrowRight") input.right = value;
  if (code === "Space") input.handbrake = value;
}

const DASH_DIRECTION_CODES = new Set(["KeyW", "KeyA", "KeyS", "KeyD"]);

/** Maximum interval between two taps of the same key to count as a double tap. */
export const PLAYER_DOUBLE_TAP_WINDOW_MS = 280;

/** Tracks the previous key and timestamp for double-tap dash detection. */
export type PlayerDoubleTapTracker = { lastCode: string | null; lastTimeMs: number };

/**
 * Creates a tracker with no previous tap recorded.
 */
export function createPlayerDoubleTapTracker(): PlayerDoubleTapTracker {
  return { lastCode: null, lastTimeMs: Number.NEGATIVE_INFINITY };
}

/**
 * Register a fresh (non-repeat) movement key press and report whether it
 * completes a double tap on the same direction — the dash gesture.
 *
 * @param tracker - The double-tap tracker, mutated in place.
 * @param code - A KeyboardEvent.code string from the WASD movement set.
 * @param timeMs - The event timestamp in milliseconds.
 * @returns True when this press completes a double tap on the same key
 *  within the window.
 */
export function registerPlayerDirectionTap(tracker: PlayerDoubleTapTracker, code: string, timeMs: number) {
  if (!DASH_DIRECTION_CODES.has(code)) return false;
  const doubleTapped = tracker.lastCode === code && timeMs - tracker.lastTimeMs <= PLAYER_DOUBLE_TAP_WINDOW_MS;
  tracker.lastCode = code;
  // A completed double tap consumes the sequence so a triple tap does not
  // fire twice; otherwise remember this press as the potential first tap.
  tracker.lastTimeMs = doubleTapped ? Number.NEGATIVE_INFINITY : timeMs;
  if (doubleTapped) tracker.lastCode = null;
  return doubleTapped;
}

/**
 * Returns whether a keyboard event should be ignored by the roam input layer
 * because it is part of an OS/browser shortcut or a modifier-only chord.
 *
 * @param event - Object with the relevant modifier and code fields from
 *  a KeyboardEvent.
 * @returns True when the event should not be processed as a roam input.
 */
export function blocksPlayerKeyboardInput({
  altKey,
  code,
  ctrlKey,
  metaKey,
}: {
  altKey: boolean;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
}) {
  if (metaKey || altKey) return true;
  // Ctrl is a flight-control key by itself. Keep OS/browser shortcuts such as
  // Ctrl+W blocked without accidentally making descent impossible.
  return ctrlKey && code !== "ControlLeft" && code !== "ControlRight";
}
