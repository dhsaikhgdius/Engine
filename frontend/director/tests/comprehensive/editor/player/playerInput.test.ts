import { expect, it } from "vitest";
import {
  blocksPlayerKeyboardInput,
  createEmptyPlayerInput,
  createEmptyPlayerVehicleDriveInput,
  createPlayerDoubleTapTracker,
  getPlayerLookAxes,
  isPlayerLookKey,
  isPlayerMovementKey,
  isPlayerVehicleDriveKey,
  PLAYER_CONTROLLER_RESERVED_CODES,
  PLAYER_DOUBLE_TAP_WINDOW_MS,
  PLAYER_VEHICLE_DRIVE_CODES,
  PLAYER_VEHICLE_TOGGLE_CODE,
  registerPlayerDirectionTap,
  updatePlayerLookKey,
  updatePlayerMovementKey,
  updatePlayerVehicleDriveKey,
} from "../../../../src/comprehensive/editor/player/playerInput";

it("maps movement keys without treating the descent control as a blocked shortcut", () => {
  const input = createEmptyPlayerInput();

  expect(isPlayerMovementKey("ControlLeft")).toBe(true);
  expect(blocksPlayerKeyboardInput({ altKey: false, code: "ControlLeft", ctrlKey: true, metaKey: false })).toBe(false);
  updatePlayerMovementKey(input, "ControlLeft", true);
  expect(input.descend).toBe(true);

  updatePlayerMovementKey(input, "ControlLeft", false);
  expect(input.descend).toBe(false);
});

it("latches a short jump tap until the simulation consumes it", () => {
  const input = createEmptyPlayerInput();
  updatePlayerMovementKey(input, "Space", true);
  updatePlayerMovementKey(input, "Space", false);

  expect(input.jump).toBe(false);
  expect(input.jumpPressed).toBe(true);
});

it("maps Q/E to flight descend/ascend without latching a jump", () => {
  const input = createEmptyPlayerInput();

  expect(isPlayerMovementKey("KeyQ")).toBe(true);
  expect(isPlayerMovementKey("KeyE")).toBe(true);

  updatePlayerMovementKey(input, "KeyE", true);
  expect(input.ascend).toBe(true);
  expect(input.jump).toBe(false);
  expect(input.jumpPressed).toBe(false);
  updatePlayerMovementKey(input, "KeyE", false);
  expect(input.ascend).toBe(false);

  updatePlayerMovementKey(input, "KeyQ", true);
  expect(input.descend).toBe(true);
  updatePlayerMovementKey(input, "KeyQ", false);
  expect(input.descend).toBe(false);
});

it("continues blocking browser and operating-system modifier shortcuts", () => {
  expect(blocksPlayerKeyboardInput({ altKey: false, code: "KeyW", ctrlKey: true, metaKey: false })).toBe(true);
  expect(blocksPlayerKeyboardInput({ altKey: true, code: "KeyW", ctrlKey: false, metaKey: false })).toBe(true);
  expect(blocksPlayerKeyboardInput({ altKey: false, code: "KeyW", ctrlKey: false, metaKey: true })).toBe(true);
});

it("maps KeyC to hold-to-crouch", () => {
  const input = createEmptyPlayerInput();

  expect(input.crouch).toBe(false);
  expect(isPlayerMovementKey("KeyC")).toBe(true);

  updatePlayerMovementKey(input, "KeyC", true);
  expect(input.crouch).toBe(true);
  // Browser keydown auto-repeat keeps the held state without side effects.
  updatePlayerMovementKey(input, "KeyC", true);
  expect(input.crouch).toBe(true);

  updatePlayerMovementKey(input, "KeyC", false);
  expect(input.crouch).toBe(false);
});

it("toggles slow walk on the first KeyR press and ignores keydown auto-repeat", () => {
  const input = createEmptyPlayerInput();

  expect(input.slowWalk).toBe(false);
  expect(isPlayerMovementKey("KeyR")).toBe(true);

  updatePlayerMovementKey(input, "KeyR", true);
  expect(input.slowWalk).toBe(true);
  // Held key repeats must not flip the toggle back.
  updatePlayerMovementKey(input, "KeyR", true);
  updatePlayerMovementKey(input, "KeyR", true);
  expect(input.slowWalk).toBe(true);
  updatePlayerMovementKey(input, "KeyR", false);
  expect(input.slowWalk).toBe(true);

  // A fresh press toggles it off again.
  updatePlayerMovementKey(input, "KeyR", true);
  expect(input.slowWalk).toBe(false);
  updatePlayerMovementKey(input, "KeyR", false);
  expect(input.slowWalk).toBe(false);
});

it("registers the vehicle toggle key without shadowing reserved controller keys", () => {
  // KeyF (flight toggle) is reserved, which is why the vehicle key is KeyE.
  expect(PLAYER_CONTROLLER_RESERVED_CODES.has("KeyF")).toBe(true);
  expect(PLAYER_CONTROLLER_RESERVED_CODES.has(PLAYER_VEHICLE_TOGGLE_CODE)).toBe(false);
  // KeyE's only walk-mode meaning is the flight ascend alias, inert on foot.
  expect(isPlayerMovementKey(PLAYER_VEHICLE_TOGGLE_CODE)).toBe(true);
  // No driving key may shadow a reserved controller shortcut either.
  for (const code of PLAYER_VEHICLE_DRIVE_CODES) {
    expect(PLAYER_CONTROLLER_RESERVED_CODES.has(code)).toBe(false);
  }
  // The unmodified toggle key must reach the session, not the browser.
  expect(
    blocksPlayerKeyboardInput({ altKey: false, code: PLAYER_VEHICLE_TOGGLE_CODE, ctrlKey: false, metaKey: false }),
  ).toBe(false);
});

it("tracks held driving keys including the Space handbrake", () => {
  const drive = createEmptyPlayerVehicleDriveInput();

  expect(isPlayerVehicleDriveKey("KeyW")).toBe(true);
  expect(isPlayerVehicleDriveKey("Space")).toBe(true);
  expect(isPlayerVehicleDriveKey(PLAYER_VEHICLE_TOGGLE_CODE)).toBe(false);
  expect(isPlayerVehicleDriveKey("KeyR")).toBe(false);

  updatePlayerVehicleDriveKey(drive, "KeyW", true);
  updatePlayerVehicleDriveKey(drive, "ArrowLeft", true);
  updatePlayerVehicleDriveKey(drive, "Space", true);
  expect(drive).toEqual({ forward: true, backward: false, left: true, right: false, handbrake: true });

  updatePlayerVehicleDriveKey(drive, "KeyW", false);
  updatePlayerVehicleDriveKey(drive, "Space", false);
  expect(drive.forward).toBe(false);
  expect(drive.handbrake).toBe(false);
  expect(drive.left).toBe(true);
});

it("detects a same-direction double tap inside the window as the dash gesture", () => {
  const tracker = createPlayerDoubleTapTracker();

  expect(registerPlayerDirectionTap(tracker, "KeyW", 1000)).toBe(false);
  expect(registerPlayerDirectionTap(tracker, "KeyW", 1000 + PLAYER_DOUBLE_TAP_WINDOW_MS)).toBe(true);
  // The completed gesture is consumed: a third tap starts a new sequence.
  expect(registerPlayerDirectionTap(tracker, "KeyW", 1000 + PLAYER_DOUBLE_TAP_WINDOW_MS * 2)).toBe(false);

  // Too slow.
  expect(registerPlayerDirectionTap(tracker, "KeyA", 2000)).toBe(false);
  expect(registerPlayerDirectionTap(tracker, "KeyA", 2000 + PLAYER_DOUBLE_TAP_WINDOW_MS + 1)).toBe(false);

  // Direction changes reset the sequence.
  expect(registerPlayerDirectionTap(tracker, "KeyS", 3000)).toBe(false);
  expect(registerPlayerDirectionTap(tracker, "KeyD", 3050)).toBe(false);
  expect(registerPlayerDirectionTap(tracker, "KeyD", 3100)).toBe(true);

  // Non-direction keys never dash.
  expect(registerPlayerDirectionTap(tracker, "Space", 4000)).toBe(false);
  expect(registerPlayerDirectionTap(tracker, "Space", 4010)).toBe(false);
});

it("maps arrow keys to look instead of walking, and keeps them as vehicle steer", () => {
  const input = createEmptyPlayerInput();

  expect(isPlayerLookKey("ArrowRight")).toBe(true);
  expect(isPlayerMovementKey("ArrowRight")).toBe(false);
  expect(isPlayerVehicleDriveKey("ArrowRight")).toBe(true);

  updatePlayerLookKey(input, "ArrowRight", true);
  updatePlayerLookKey(input, "ArrowUp", true);
  expect(input.forward).toBe(false);
  expect(input.right).toBe(false);
  expect(getPlayerLookAxes(input)).toEqual({ yaw: 1, pitch: -1 });

  const tracker = createPlayerDoubleTapTracker();
  expect(registerPlayerDirectionTap(tracker, "ArrowUp", 1000)).toBe(false);
  expect(registerPlayerDirectionTap(tracker, "ArrowUp", 1100)).toBe(false);
});
