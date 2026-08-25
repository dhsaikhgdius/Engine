/**
 * Normalized movement intent produced by the camera pilot's WASD/EQ keys.
 * Each axis is in [-1, 1] where opposite keys cancel.
 */
export interface PilotMovementIntent {
  /** +1 is forward (W), -1 is backward (S). */
  forward: number;
  /** +1 is right (D), -1 is left (A). */
  strafe: number;
  /** +1 is up (E), -1 is down (Q). */
  vertical: number;
}

const PILOT_MOVEMENT_CODES = new Set([
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "KeyE",
  "KeyQ",
  "ShiftLeft",
  "ShiftRight",
  "AltLeft",
  "AltRight",
]);

/**
 * Normalized look intent produced by the camera pilot's arrow keys.
 * Each axis is in [-1, 1] where opposite keys cancel.
 */
export interface PilotLookIntent {
  /** +1 looks right, matching mouse-right. */
  yaw: number;
  /** +1 looks down, matching mouse-down. */
  pitchDown: number;
}

const PILOT_LOOK_CODES = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

/** Radians per second at default rotate sensitivity. */
export const PILOT_LOOK_RADIANS_PER_SECOND = Math.PI;

/**
 * Test whether a keyboard event code is a camera pilot movement key
 * (WASD, EQ, Shift, Alt).
 *
 * @param code - The `event.code` value from a keyboard event.
 * @returns True when the code is recognized as a movement control.
 */
export function isPilotMovementCode(code: string) {
  return PILOT_MOVEMENT_CODES.has(code);
}

/**
 * Test whether a keyboard event code is a camera pilot look key (arrow keys).
 *
 * @param code - The `event.code` value from a keyboard event.
 * @returns True when the code is recognized as a look control.
 */
export function isPilotLookCode(code: string) {
  return PILOT_LOOK_CODES.has(code);
}

/**
 * Test whether a keyboard event code is any camera pilot navigation key.
 *
 * @param code - The `event.code` value from a keyboard event.
 * @returns True when the code is either a movement or look control.
 */
export function isPilotNavigationCode(code: string) {
  return isPilotMovementCode(code) || isPilotLookCode(code);
}

/**
 * Derive a normalized movement intent from the currently pressed keys.
 *
 * Opposing keys (W/S, A/D, E/Q) cancel each other, producing a value in
 * [-1, 1] per axis.
 *
 * @param pressedCodes - The set of currently held keyboard event codes.
 * @returns A movement intent with each axis in [-1, 1].
 */
export function getPilotMovementIntent(pressedCodes: ReadonlySet<string>): PilotMovementIntent {
  return {
    forward: Number(pressedCodes.has("KeyW")) - Number(pressedCodes.has("KeyS")),
    strafe: Number(pressedCodes.has("KeyD")) - Number(pressedCodes.has("KeyA")),
    vertical: Number(pressedCodes.has("KeyE")) - Number(pressedCodes.has("KeyQ")),
  };
}

/**
 * Derive a normalized look intent from the currently pressed arrow keys.
 *
 * @param pressedCodes - The set of currently held keyboard event codes.
 * @returns A look intent with each axis in [-1, 1].
 */
export function getPilotLookIntent(pressedCodes: ReadonlySet<string>): PilotLookIntent {
  return {
    yaw: Number(pressedCodes.has("ArrowRight")) - Number(pressedCodes.has("ArrowLeft")),
    pitchDown: Number(pressedCodes.has("ArrowDown")) - Number(pressedCodes.has("ArrowUp")),
  };
}

/**
 * Resolve the speed multiplier based on modifier keys held.
 *
 * Alt slows to 0.25× (precision movement), Shift boosts to 2.5× (sprint).
 * When both are held Alt takes precedence.
 *
 * @param pressedCodes - The set of currently held keyboard event codes.
 * @returns The speed multiplier: 0.25, 1.0, or 2.5.
 */
export function getPilotSpeedMultiplier(pressedCodes: ReadonlySet<string>) {
  // Alt takes priority over Shift so the user cannot accidentally sprint
  // while trying to fine-tune a position.
  if (pressedCodes.has("AltLeft") || pressedCodes.has("AltRight")) return 0.25;
  if (pressedCodes.has("ShiftLeft") || pressedCodes.has("ShiftRight")) return 2.5;
  return 1;
}

/**
 * Test whether an event target is an editable element that should consume
 * keyboard input rather than the pilot.
 *
 * @param target - The event target to test.
 * @returns True when the target is inside an input, textarea, select, button,
 *   or contenteditable element.
 */
export function isEditablePilotEventTarget(target: EventTarget | null) {
  // Guard against non-browser environments where Element is not defined.
  if (typeof Element === "undefined" || !(target instanceof Element)) return false;
  return Boolean(target.closest("input, textarea, select, button, [contenteditable]:not([contenteditable='false'])"));
}
