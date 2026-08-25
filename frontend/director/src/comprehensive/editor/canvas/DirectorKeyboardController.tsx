import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef, type MutableRefObject } from "react";
import { MathUtils, Spherical, Vector3 } from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import {
  DEFAULT_VIEWPORT_ROTATE_SENSITIVITY,
  normalizeViewportSensitivity,
} from "../schema/viewportNavigation";

const MAX_FRAME_DELTA = 0.05;
const HORIZONTAL_EPSILON = 1e-8;
const DIRECTOR_MOVEMENT_CODES = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "KeyE", "KeyQ"]);
const DIRECTOR_LOOK_CODES = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);
const DIRECTOR_LOOK_CHROME =
  "[data-timeline-canvas], [role='tree'], [role='listbox'], [role='slider'], [role='separator'], [role='tablist'], [role='tab'], [role='combobox'], [role='menu']";
const DIRECTOR_LOOK_MIN_POLAR = 0.08;
const DIRECTOR_LOOK_MAX_POLAR = Math.PI - 0.08;
/** Radians per second at rotate-sensitivity 1. Default 0.35 → ~1.1 rad/s. */
export const DIRECTOR_LOOK_RADIANS_PER_SECOND = Math.PI;

export interface DirectorMovementIntent {
  forward: number;
  strafe: number;
  vertical: number;
}

export interface DirectorLookIntent {
  /** +1 looks right from the current viewpoint. */
  yaw: number;
  /** +1 looks up from the current viewpoint. */
  pitch: number;
}

export function isDirectorMovementCode(code: string) {
  return DIRECTOR_MOVEMENT_CODES.has(code);
}

export function isDirectorLookCode(code: string) {
  return DIRECTOR_LOOK_CODES.has(code);
}

export function isDirectorNavigationCode(code: string) {
  return isDirectorMovementCode(code) || isDirectorLookCode(code);
}

export function getDirectorMovementIntent(pressedCodes: ReadonlySet<string>): DirectorMovementIntent {
  return {
    forward: Number(pressedCodes.has("KeyW")) - Number(pressedCodes.has("KeyS")),
    strafe: Number(pressedCodes.has("KeyD")) - Number(pressedCodes.has("KeyA")),
    vertical: Number(pressedCodes.has("KeyE")) - Number(pressedCodes.has("KeyQ")),
  };
}

export function getDirectorLookIntent(pressedCodes: ReadonlySet<string>): DirectorLookIntent {
  return {
    yaw: Number(pressedCodes.has("ArrowRight")) - Number(pressedCodes.has("ArrowLeft")),
    pitch: Number(pressedCodes.has("ArrowUp")) - Number(pressedCodes.has("ArrowDown")),
  };
}

export function getDirectorLookRadiansPerSecond(rotateSensitivity = DEFAULT_VIEWPORT_ROTATE_SENSITIVITY) {
  const normalized = normalizeViewportSensitivity(rotateSensitivity, DEFAULT_VIEWPORT_ROTATE_SENSITIVITY);
  return DIRECTOR_LOOK_RADIANS_PER_SECOND * normalized;
}

/**
 * Rotate the view in place: the camera stays put and the look-at point
 * swings left/right/up/down, like turning your head rather than orbiting a subject.
 */
export function applyDirectorViewLook(
  cameraPosition: Vector3,
  target: Vector3,
  yawDelta: number,
  pitchDelta: number,
  spherical = new Spherical(),
  look = new Vector3(),
) {
  look.copy(target).sub(cameraPosition);
  if (look.lengthSq() < 1e-8) look.set(0, 0, -1);
  spherical.setFromVector3(look);
  spherical.theta -= yawDelta;
  spherical.phi = MathUtils.clamp(spherical.phi - pitchDelta, DIRECTOR_LOOK_MIN_POLAR, DIRECTOR_LOOK_MAX_POLAR);
  spherical.makeSafe();
  target.copy(cameraPosition).add(look.setFromSpherical(spherical));
}

export function getDirectorMovementDirection(intent: DirectorMovementIntent, cameraForward: Vector3) {
  const forward = new Vector3(cameraForward.x, 0, cameraForward.z);
  if (forward.lengthSq() <= HORIZONTAL_EPSILON) forward.set(0, 0, -1);
  forward.normalize();
  const right = new Vector3().crossVectors(forward, new Vector3(0, 1, 0)).normalize();
  const movement = forward
    .multiplyScalar(intent.forward)
    .addScaledVector(right, intent.strafe)
    .addScaledVector(new Vector3(0, 1, 0), intent.vertical);
  if (movement.lengthSq() > 1) movement.normalize();
  return movement;
}

export function isEditableDirectorEventTarget(target: EventTarget | null) {
  if (typeof Element === "undefined" || !(target instanceof Element)) return false;
  return Boolean(target.closest("input, textarea, select, button, [contenteditable]:not([contenteditable='false'])"));
}

function isDirectorLookChromeTarget(target: EventTarget | null) {
  if (typeof Element === "undefined" || !(target instanceof Element)) return false;
  return Boolean(target.closest(DIRECTOR_LOOK_CHROME));
}

export function DirectorKeyboardController({
  active,
  controlsRef,
  moveEnabled = true,
  moveSpeed,
  rotateSensitivity = DEFAULT_VIEWPORT_ROTATE_SENSITIVITY,
  onInteractionEnd,
}: {
  active: boolean;
  controlsRef: MutableRefObject<OrbitControlsImpl | null>;
  moveEnabled?: boolean;
  moveSpeed: number;
  rotateSensitivity?: number;
  onInteractionEnd?: () => void;
}) {
  const { camera, invalidate } = useThree();
  const pressedCodesRef = useRef(new Set<string>());
  const cameraForwardRef = useRef(new Vector3());
  const lastHorizontalForwardRef = useRef(new Vector3(0, 0, -1));
  const movementRef = useRef(new Vector3());
  const lookOffsetRef = useRef(new Vector3());
  const lookSphericalRef = useRef(new Spherical());
  const movedSinceSettleRef = useRef(false);

  useEffect(() => {
    const pressedCodes = pressedCodesRef.current;
    const settle = () => {
      if (!movedSinceSettleRef.current) return;
      movedSinceSettleRef.current = false;
      onInteractionEnd?.();
    };
    pressedCodes.clear();
    if (!active) {
      settle();
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isEditableDirectorEventTarget(event.target)) return;
      const look = isDirectorLookCode(event.code);
      const move = moveEnabled && isDirectorMovementCode(event.code);
      if (!look && !move) return;
      if (look && isDirectorLookChromeTarget(event.target)) return;
      event.preventDefault();
      pressedCodes.add(event.code);
      invalidate();
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      pressedCodes.delete(event.code);
      if (pressedCodes.size === 0) settle();
    };
    const clear = () => {
      pressedCodes.clear();
      settle();
    };

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("blur", clear);
    return () => {
      pressedCodes.clear();
      settle();
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("blur", clear);
    };
  }, [active, invalidate, moveEnabled, onInteractionEnd]);

  useFrame((_state, delta) => {
    if (!active || !controlsRef.current) return;
    const pressed = pressedCodesRef.current;
    const intent = getDirectorMovementIntent(pressed);
    const look = getDirectorLookIntent(pressed);
    const frameDelta = Math.min(Math.max(delta, 0), MAX_FRAME_DELTA);
    const hasMove = moveEnabled && (intent.forward !== 0 || intent.strafe !== 0 || intent.vertical !== 0);
    const hasLook = look.yaw !== 0 || look.pitch !== 0;
    if (!hasMove && !hasLook) return;

    if (hasLook) {
      const rate = getDirectorLookRadiansPerSecond(rotateSensitivity) * frameDelta;
      applyDirectorViewLook(
        camera.position,
        controlsRef.current.target,
        look.yaw * rate,
        look.pitch * rate,
        lookSphericalRef.current,
        lookOffsetRef.current,
      );
      camera.lookAt(controlsRef.current.target);
    }

    if (hasMove) {
      camera.getWorldDirection(cameraForwardRef.current);
      if (cameraForwardRef.current.x ** 2 + cameraForwardRef.current.z ** 2 > HORIZONTAL_EPSILON) {
        lastHorizontalForwardRef.current.set(cameraForwardRef.current.x, 0, cameraForwardRef.current.z).normalize();
      }
      const movement = getDirectorMovementDirection(intent, lastHorizontalForwardRef.current);
      movementRef.current.copy(movement).multiplyScalar(Math.max(0, moveSpeed) * frameDelta);
      camera.position.add(movementRef.current);
      controlsRef.current.target.add(movementRef.current);
    }

    camera.updateMatrixWorld();
    movedSinceSettleRef.current = true;
    controlsRef.current.update();
    invalidate();
  });

  return null;
}
