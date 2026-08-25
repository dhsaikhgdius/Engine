import { MOUSE } from "three";

/** The two navigation modes for the viewport: hand (pan) and cursor (orbit). */
export type DirectorNavigationMode = "hand" | "cursor";

/**
 * Flick-compatible base pointer contract for both viewport tools.
 *
 * Left drag orbits, right drag pans, and the middle button dollies. The tools
 * differ in their higher-level affordances: Cursor view adds modifier-key pan
 * (handled by OrbitControls) and right-button WASD flight; Pan view remains a
 * direct browse mode. Keeping this map in one place prevents accidental drift.
 *
 * @param mode - The current navigation mode (unused; all modes share the same button mapping).
 * @returns The mouse button mapping for OrbitControls.
 */
export function getViewportNavigationMouseButtons(mode: DirectorNavigationMode) {
  void mode;
  return {
    LEFT: MOUSE.ROTATE,
    MIDDLE: MOUSE.DOLLY,
    RIGHT: MOUSE.PAN,
  } as const;
}

/**
 * Returns whether any of the WASD movement keys (W, A, S, D, E, Q) are currently pressed.
 *
 * @param pressedCodes - The set of currently pressed key codes.
 */
export function hasViewportMovementKey(pressedCodes: ReadonlySet<string>) {
  return ["KeyW", "KeyA", "KeyS", "KeyD", "KeyE", "KeyQ"].some((code) => pressedCodes.has(code));
}
