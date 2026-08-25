import { fireEvent, render } from "@testing-library/react";
import type { ComponentProps } from "react";
import { Bone, Group, Object3D, PerspectiveCamera } from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectorObject } from "../../../../src/comprehensive/editor/schema/directorProject";
import { readDirectorCharacterLocomotionRuntimeState } from "../../../../src/comprehensive/editor/runtime/mixamo/mixamoLocomotionRuntime";
import {
  freezePlayerLocomotionForMeshColliderWarmup,
  isCurrentMeshColliderBuild,
  PLAYER_CONTROLLER_FRAME_PRIORITY,
  PlayerController,
  resetMeshCollisionOwnerForMotor,
  shouldBlockForMeshColliderWarmup,
} from "../../../../src/comprehensive/editor/player/PlayerController";
import {
  createPlayerLocomotionState,
  PLAYER_CONTROLLER_CONFIG,
  stepPlayerLocomotion,
  type PlayerInput,
} from "../../../../src/comprehensive/editor/player/playerLocomotion";

const mockRuntime = vi.hoisted(() => ({
  camera: null as PerspectiveCamera | null,
  canvas: null as HTMLCanvasElement | null,
  frame: null as ((state: unknown, delta: number) => void) | null,
  framePriority: null as number | null,
  sceneObject: null as Object3D | null,
}));

vi.mock("@react-three/fiber", () => ({
  useFrame: (frame: (state: unknown, delta: number) => void, priority = 0) => {
    mockRuntime.frame = frame;
    mockRuntime.framePriority = priority;
  },
  useThree: () => ({
    camera: mockRuntime.camera,
    gl: { domElement: mockRuntime.canvas },
    scene: { getObjectByName: () => mockRuntime.sceneObject },
  }),
}));

const player: DirectorObject = {
  id: "character_player",
  name: "角色01",
  kind: "character",
  visible: true,
  locked: false,
  bodyType: "mannequin",
  placementMode: "grounded",
  characterRig: { rigType: "mixamo", posePresetId: "stand", controls: {} },
  transform: {
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  },
};

function renderController(
  onControlActiveChange = vi.fn(),
  onRuntimeStatusChange = vi.fn(),
  overrides: Partial<ComponentProps<typeof PlayerController>> = {},
) {
  const props: ComponentProps<typeof PlayerController> = {
    collisionReferenceRoot: new Group(),
    enabled: true,
    flying: false,
    groundHeight: 0,
    obstacles: [],
    onCameraSnapshot: vi.fn(),
    onControlActiveChange,
    onExitRequest: vi.fn(),
    onFinished: vi.fn(),
    onFlyingChange: vi.fn(),
    onRuntimeStatusChange,
    onTransformCommit: vi.fn(),
    onViewModeChange: vi.fn(),
    player,
    viewMode: "third",
    ...overrides,
  };
  return {
    onControlActiveChange,
    onRuntimeStatusChange,
    props,
    ...render(<PlayerController {...props} />),
  };
}

describe("PlayerController canvas control activation", () => {
  beforeEach(() => {
    mockRuntime.camera = new PerspectiveCamera(50, 1, 0.1, 1_000);
    mockRuntime.canvas = document.createElement("canvas");
    document.body.append(mockRuntime.canvas);
    mockRuntime.canvas.requestPointerLock = vi.fn();
    mockRuntime.canvas.setPointerCapture = vi.fn();
    mockRuntime.canvas.releasePointerCapture = vi.fn();
    mockRuntime.canvas.hasPointerCapture = vi.fn(() => true);
  });

  afterEach(() => {
    mockRuntime.canvas?.remove();
    mockRuntime.canvas = null;
    mockRuntime.camera = null;
    mockRuntime.frame = null;
    mockRuntime.framePriority = null;
    mockRuntime.sceneObject = null;
    vi.restoreAllMocks();
  });

  it("publishes controller state before the default skeletal frame without taking over rendering", () => {
    renderController();

    expect(mockRuntime.framePriority).toBe(PLAYER_CONTROLLER_FRAME_PRIORITY);
    expect(mockRuntime.framePriority).toBeLessThan(0);
  });

  it("activates keyboard control immediately on entry without an extra click", () => {
    const canvas = mockRuntime.canvas!;
    const playerObject = new Group();
    playerObject.name = `director-object-${player.id}`;
    mockRuntime.sceneObject = playerObject;
    const { onControlActiveChange } = renderController();

    expect(document.activeElement).toBe(canvas);
    expect(onControlActiveChange).toHaveBeenLastCalledWith(true);

    fireEvent.keyDown(window, { code: "KeyW" });
    for (let index = 0; index < 8; index += 1) mockRuntime.frame?.({}, 0.1);
    fireEvent.keyUp(window, { code: "KeyW" });

    expect(playerObject.position.length()).toBeGreaterThan(0);
  });

  it("invokes the nearest proximity interaction when E is pressed on foot", () => {
    const playerObject = new Group();
    playerObject.name = `director-object-${player.id}`;
    mockRuntime.sceneObject = playerObject;
    const onInteract = vi.fn();
    renderController(vi.fn(), vi.fn(), {
      interactionCandidates: [{ id: "set-door", position: [1, 0, 0], prompt: "打开大厅门", radiusM: 3 }],
      onInteract,
    });

    mockRuntime.frame?.({}, 1 / 60);
    fireEvent.keyDown(window, { code: "KeyE" });

    expect(onInteract).toHaveBeenCalledWith("set-door");
  });

  it("re-announces the live activation state when the controlled actor switches", () => {
    const onControlActiveChange = vi.fn();
    const rendered = renderController(onControlActiveChange);

    expect(onControlActiveChange).toHaveBeenLastCalledWith(true);
    const nextPlayer: DirectorObject = { ...player, id: "character_next", name: "角色02" };
    rendered.rerender(<PlayerController {...rendered.props} player={nextPlayer} />);

    // The canvas kept focus across the switch, so the HUD must not be reset
    // to "click to activate" while the keyboard still works.
    expect(onControlActiveChange).toHaveBeenLastCalledWith(true);
  });

  it("continues the editor camera orbit when entering roam", () => {
    mockRuntime.camera!.position.set(0, 2.4, 6);
    const onRuntimeStatusChange = vi.fn();
    renderController(vi.fn(), onRuntimeStatusChange);

    mockRuntime.frame?.({}, 1 / 60);

    const status = onRuntimeStatusChange.mock.calls.at(-1)?.[0];
    // The editor camera looked at the actor from +Z; the follow rig must stay
    // on that side instead of snapping behind the authored -Z facing.
    expect(status.cameraPosition[2]).toBeGreaterThan(0);
    expect(status.cameraDistance).toBeGreaterThan(4);
    expect(status.cameraDistance).toBeLessThan(9);
  });

  it("activates focused fallback controls without Pointer Lock", () => {
    const canvas = mockRuntime.canvas!;
    const { onControlActiveChange, unmount } = renderController();

    fireEvent.pointerDown(canvas, { button: 0, clientX: 120, clientY: 90, pointerId: 1 });

    expect(canvas.requestPointerLock).not.toHaveBeenCalled();
    expect(canvas.setPointerCapture).toHaveBeenCalledWith(1);
    expect(onControlActiveChange).toHaveBeenLastCalledWith(true);
    expect(canvas).toHaveAttribute("tabindex", "0");
    expect(canvas.style.cursor).toBe("none");

    fireEvent.pointerDown(document.body, { button: 0, pointerId: 2 });
    expect(onControlActiveChange).toHaveBeenLastCalledWith(false);
    expect(canvas.style.cursor).toBe("");

    unmount();
    expect(canvas).not.toHaveAttribute("tabindex");
  });

  it("keeps roam active when the browser rejects pointer capture", () => {
    const canvas = mockRuntime.canvas!;
    const playerObject = new Group();
    playerObject.name = `director-object-${player.id}`;
    mockRuntime.sceneObject = playerObject;
    canvas.setPointerCapture = vi.fn(() => {
      throw new DOMException("No active pointer", "InvalidStateError");
    });
    const { onControlActiveChange } = renderController();

    expect(() => {
      fireEvent.pointerDown(canvas, { button: 0, clientX: 120, clientY: 90, pointerId: 9 });
    }).not.toThrow();
    expect(onControlActiveChange).toHaveBeenLastCalledWith(true);

    fireEvent.keyDown(window, { code: "KeyW" });
    for (let index = 0; index < 8; index += 1) mockRuntime.frame?.({}, 0.1);
    fireEvent.keyUp(window, { code: "KeyW" });
    expect(playerObject.position.length()).toBeGreaterThan(0);
  });

  it("hides the cursor only while fallback drag-look is active", () => {
    const canvas = mockRuntime.canvas!;
    renderController();

    fireEvent.pointerDown(canvas, { button: 0, clientX: 120, clientY: 90, pointerId: 4 });
    expect(canvas.style.cursor).toBe("none");

    fireEvent.pointerUp(canvas, { button: 0, clientX: 180, clientY: 90, pointerId: 4 });
    expect(canvas.style.cursor).toBe("");
  });

  it("uses bounded drag-look and keyboard movement without Pointer Lock", () => {
    const canvas = mockRuntime.canvas!;
    const playerObject = new Group();
    playerObject.name = `director-object-${player.id}`;
    mockRuntime.sceneObject = playerObject;
    renderController();

    for (let index = 0; index < 30; index += 1) mockRuntime.frame?.({}, 0.1);
    const before = mockRuntime.camera!.position.toArray();

    fireEvent.pointerDown(canvas, { button: 0, clientX: 120, clientY: 90, pointerId: 1 });
    fireEvent.pointerUp(canvas, { button: 0, clientX: 120, clientY: 90, pointerId: 1 });
    fireEvent.mouseMove(document, { movementX: 60, movementY: 0 });
    for (let index = 0; index < 10; index += 1) mockRuntime.frame?.({}, 0.1);

    const afterUnboundedMove = mockRuntime.camera!.position.toArray();
    afterUnboundedMove.forEach((value, index) => expect(value).toBeCloseTo(before[index], 8));

    fireEvent.pointerDown(canvas, { button: 0, clientX: 120, clientY: 90, pointerId: 2 });
    fireEvent.pointerMove(canvas, { buttons: 1, clientX: 180, clientY: 90, pointerId: 2 });
    fireEvent.keyDown(window, { code: "KeyW" });
    for (let index = 0; index < 8; index += 1) mockRuntime.frame?.({}, 0.1);
    fireEvent.keyUp(window, { code: "KeyW" });
    fireEvent.pointerUp(canvas, { button: 0, clientX: 180, clientY: 90, pointerId: 2 });

    expect(mockRuntime.camera!.position.toArray()).not.toEqual(before);
    expect(playerObject.position.length()).toBeGreaterThan(0);
  });

  it("keeps movement, facing and the follow camera on Director's +Z character-forward contract", () => {
    const playerObject = new Group();
    playerObject.name = `director-object-${player.id}`;
    mockRuntime.sceneObject = playerObject;
    renderController();
    const canvas = mockRuntime.canvas!;

    fireEvent.pointerDown(canvas, { button: 0, clientX: 120, clientY: 90, pointerId: 1 });
    fireEvent.pointerMove(canvas, { buttons: 1, clientX: 180, clientY: 90, pointerId: 1 });
    fireEvent.keyDown(window, { code: "KeyW" });
    for (let index = 0; index < 8; index += 1) mockRuntime.frame?.({}, 0.1);

    expect(playerObject.position.x).toBeLessThan(0);
    expect(playerObject.position.z).toBeGreaterThan(0);
    expect(playerObject.rotation.y).toBeLessThan(0);
  });

  it("scales roam walk/run speed from the viewport character speed multiplier", () => {
    const walk = (moveSpeedScale: number) => {
      const playerObject = new Group();
      playerObject.name = `director-object-${player.id}`;
      mockRuntime.sceneObject = playerObject;
      const { unmount } = renderController(vi.fn(), vi.fn(), { moveSpeedScale });
      fireEvent.keyDown(window, { code: "KeyW" });
      for (let index = 0; index < 8; index += 1) mockRuntime.frame?.({}, 0.1);
      fireEvent.keyUp(window, { code: "KeyW" });
      const distance = playerObject.position.length();
      unmount();
      mockRuntime.sceneObject = null;
      mockRuntime.frame = null;
      return distance;
    };

    expect(walk(2)).toBeGreaterThan(walk(0.5) * 1.5);
  });

  it("keeps a stable third-person boom length while walking across uneven frame times", () => {
    const playerObject = new Group();
    playerObject.name = `director-object-${player.id}`;
    mockRuntime.sceneObject = playerObject;
    const onRuntimeStatusChange = vi.fn();
    renderController(vi.fn(), onRuntimeStatusChange);
    const camera = mockRuntime.camera!;

    for (let index = 0; index < 8; index += 1) mockRuntime.frame?.({}, 1 / 60);
    const distanceBefore = onRuntimeStatusChange.mock.calls.at(-1)?.[0]?.cameraDistance as number;
    const sideBefore = Math.sign(camera.position.z - playerObject.position.z) || 1;

    fireEvent.keyDown(window, { code: "KeyW" });
    for (const delta of [1 / 30, 1 / 144, 1 / 20, 1 / 90, 1 / 24]) mockRuntime.frame?.({}, delta);
    fireEvent.keyUp(window, { code: "KeyW" });

    const status = onRuntimeStatusChange.mock.calls.at(-1)?.[0];
    expect(playerObject.position.length()).toBeGreaterThan(0.05);
    expect(status.cameraDistance).toBeCloseTo(distanceBefore, 2);
    expect(Math.sign(camera.position.z - playerObject.position.z) || 1).toBe(sideBefore);
  });

  it("keeps drag-look when only a partial Pointer Lock API exists", () => {
    const canvas = mockRuntime.canvas!;
    const { onControlActiveChange, props } = renderController();

    // requestPointerLock alone (no exitPointerLock) means the lock could never
    // be released programmatically, so the controller must not engage it.
    fireEvent.pointerDown(canvas, { button: 0, clientX: 120, clientY: 90, pointerId: 1 });
    fireEvent.pointerMove(canvas, { buttons: 1, clientX: 180, clientY: 90, pointerId: 1 });
    fireEvent.pointerUp(canvas, { button: 0, clientX: 180, clientY: 90, pointerId: 1 });

    expect(canvas.requestPointerLock).not.toHaveBeenCalled();
    expect(onControlActiveChange).toHaveBeenLastCalledWith(true);
    expect(canvas.style.cursor).toBe("");
    expect(props.onExitRequest).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { code: "Escape" });
    expect(props.onExitRequest).toHaveBeenCalledOnce();
  });

  it("locks the pointer on left click and steers the view with raw mouse movement", () => {
    const canvas = mockRuntime.canvas!;
    let lockedElement: Element | null = null;
    Object.defineProperty(document, "pointerLockElement", {
      configurable: true,
      get: () => lockedElement,
    });
    canvas.requestPointerLock = vi.fn(() => {
      lockedElement = canvas;
      document.dispatchEvent(new Event("pointerlockchange"));
      return Promise.resolve();
    });
    document.exitPointerLock = vi.fn(() => {
      lockedElement = null;
      document.dispatchEvent(new Event("pointerlockchange"));
    });
    const playerObject = new Group();
    playerObject.name = `director-object-${player.id}`;
    mockRuntime.sceneObject = playerObject;

    try {
      const { props } = renderController();
      for (let index = 0; index < 30; index += 1) mockRuntime.frame?.({}, 0.1);
      const before = mockRuntime.camera!.position.toArray();

      fireEvent.pointerDown(canvas, { button: 0, clientX: 120, clientY: 90, pointerId: 1 });
      expect(canvas.requestPointerLock).toHaveBeenCalledOnce();
      expect(canvas.requestPointerLock).toHaveBeenCalledWith();
      // The lock owns the look; no drag capture should be started.
      expect(canvas.setPointerCapture).not.toHaveBeenCalled();

      // Game-style free look: locked-pointer motion arrives as document
      // `mousemove` relative deltas (no button hold), and the orbit must
      // match the pointer on the next rendered frame instead of catching up.
      fireEvent.mouseMove(document, { movementX: 90, movementY: 0 });
      mockRuntime.frame?.({}, 1 / 60);
      const afterOneFrame = mockRuntime.camera!.position.toArray();
      afterOneFrame.forEach((value) => expect(Number.isFinite(value)).toBe(true));
      expect(afterOneFrame).not.toEqual(before);

      for (let index = 0; index < 10; index += 1) mockRuntime.frame?.({}, 0.1);
      const settled = mockRuntime.camera!.position.toArray();
      afterOneFrame.forEach((value, index) => expect(value).toBeCloseTo(settled[index], 4));

      // First Escape only releases the mouse; the second exits roam.
      fireEvent.keyDown(window, { code: "Escape" });
      expect(document.exitPointerLock).toHaveBeenCalled();
      expect(props.onExitRequest).not.toHaveBeenCalled();
      fireEvent.keyDown(window, { code: "Escape" });
      expect(props.onExitRequest).toHaveBeenCalledOnce();
    } finally {
      delete (document as { pointerLockElement?: unknown }).pointerLockElement;
      delete (document as { exitPointerLock?: unknown }).exitPointerLock;
    }
  });

  it("deactivates controls when the browser releases Pointer Lock", () => {
    const canvas = mockRuntime.canvas!;
    let lockedElement: Element | null = null;
    Object.defineProperty(document, "pointerLockElement", {
      configurable: true,
      get: () => lockedElement,
    });
    canvas.requestPointerLock = vi.fn(() => {
      lockedElement = canvas;
      document.dispatchEvent(new Event("pointerlockchange"));
      return Promise.resolve();
    });
    document.exitPointerLock = vi.fn(() => {
      lockedElement = null;
      document.dispatchEvent(new Event("pointerlockchange"));
    });

    try {
      const { onControlActiveChange } = renderController();
      fireEvent.pointerDown(canvas, { button: 0, clientX: 120, clientY: 90, pointerId: 1 });
      expect(onControlActiveChange).toHaveBeenLastCalledWith(true);

      lockedElement = null;
      document.dispatchEvent(new Event("pointerlockchange"));

      expect(onControlActiveChange).toHaveBeenLastCalledWith(false);
    } finally {
      delete (document as { pointerLockElement?: unknown }).pointerLockElement;
      delete (document as { exitPointerLock?: unknown }).exitPointerLock;
    }
  });

  it("applies fine-grained wheel zoom without a fixed-step jump", async () => {
    const onRuntimeStatusChange = vi.fn();
    renderController(vi.fn(), onRuntimeStatusChange);
    const canvas = mockRuntime.canvas!;
    mockRuntime.frame?.({}, 1 / 60);
    const before = onRuntimeStatusChange.mock.calls.at(-1)?.[0]?.cameraDistance as number;

    fireEvent.pointerDown(canvas, { button: 0, clientX: 120, clientY: 90, pointerId: 1 });
    fireEvent.wheel(canvas, { deltaMode: 0, deltaY: 0.25 });
    for (let index = 0; index < 4; index += 1) mockRuntime.frame?.({}, 0.1);
    const zoomed = onRuntimeStatusChange.mock.calls.at(-1)?.[0]?.cameraDistance as number;

    expect(zoomed).toBeGreaterThan(before);
    expect(zoomed - before).toBeLessThan(0.02);

    fireEvent.wheel(canvas, { deltaMode: 0, deltaY: -0.25 });
    for (let index = 0; index < 4; index += 1) mockRuntime.frame?.({}, 0.1);
    const restoredStatus = onRuntimeStatusChange.mock.calls.at(-1)?.[0];
    const restored = restoredStatus?.cameraDistance as number;
    expect(restored).toBeLessThan(zoomed);
    expect(restored).toBeCloseTo(
      Math.hypot(
        restoredStatus.cameraPosition[0] - restoredStatus.targetPosition[0],
        restoredStatus.cameraPosition[1] - restoredStatus.targetPosition[1],
        restoredStatus.cameraPosition[2] - restoredStatus.targetPosition[2],
      ),
      6,
    );
  });

  it("keeps wheel distance zoom available while control is deactivated", () => {
    const onRuntimeStatusChange = vi.fn();
    renderController(vi.fn(), onRuntimeStatusChange);
    const canvas = mockRuntime.canvas!;
    mockRuntime.frame?.({}, 1 / 60);
    const before = onRuntimeStatusChange.mock.calls.at(-1)?.[0]?.cameraDistance as number;

    // Clicking a side panel releases keyboard control but hovering the stage
    // with the wheel is still an unambiguous distance intent.
    fireEvent.pointerDown(document.body, { button: 0, pointerId: 7 });
    fireEvent.wheel(canvas, { deltaMode: 0, deltaY: 120 });
    for (let index = 0; index < 8; index += 1) mockRuntime.frame?.({}, 0.1);

    const zoomed = onRuntimeStatusChange.mock.calls.at(-1)?.[0]?.cameraDistance as number;
    expect(zoomed).toBeGreaterThan(before);
  });

  it("preserves the live follow pivot when returning control to the editor orbit camera", () => {
    const onCameraSnapshot = vi.fn();
    const onRuntimeStatusChange = vi.fn();
    const rendered = renderController(vi.fn(), onRuntimeStatusChange, { onCameraSnapshot });

    mockRuntime.frame?.({}, 1 / 60);
    const liveStatus = onRuntimeStatusChange.mock.calls.at(-1)?.[0];
    rendered.unmount();

    const snapshot = onCameraSnapshot.mock.calls.at(-1)?.[0];
    expect(snapshot).toBeDefined();
    expect(snapshot.target).toEqual(liveStatus.targetPosition);
    expect(snapshot.position).toEqual(liveStatus.cameraPosition);
    expect(
      Math.hypot(
        snapshot.position[0] - snapshot.target[0],
        snapshot.position[1] - snapshot.target[1],
        snapshot.position[2] - snapshot.target[2],
      ),
    ).toBeCloseTo(liveStatus.cameraDistance, 6);
    expect(liveStatus.cameraDistance).toBeGreaterThan(1);
  });

  it("publishes Mixamo locomotion state without mutating pose or IK bones", () => {
    const playerObject = new Group();
    playerObject.name = `director-object-${player.id}`;
    const authoredBone = new Object3D();
    authoredBone.name = "mannequin-left-arm";
    authoredBone.rotation.x = 0.37;
    playerObject.add(authoredBone);
    mockRuntime.sceneObject = playerObject;
    const { unmount } = renderController();
    const canvas = mockRuntime.canvas!;

    mockRuntime.frame?.({}, 0.1);
    expect(readDirectorCharacterLocomotionRuntimeState(playerObject)).toMatchObject({
      mode: "idle",
      timeS: 0.1,
      weight: 1,
      localVelocityX: 0,
      localVelocityZ: 0,
      angularVelocityRadS: 0,
      verticalVelocityMps: 0,
      grounded: true,
      jumpPhase: "none",
      transitionDurationS: 0,
      clipStartedFrame: 0,
    });
    expect(authoredBone.rotation.x).toBeCloseTo(0.37, 8);

    fireEvent.pointerDown(canvas, { button: 0, clientX: 120, clientY: 90, pointerId: 1 });
    fireEvent.keyDown(window, { code: "KeyW" });
    mockRuntime.frame?.({}, 0.05);
    mockRuntime.frame?.({}, 0.05);
    const walkingState = readDirectorCharacterLocomotionRuntimeState(playerObject);
    expect(walkingState).toMatchObject({
      mode: "walk",
      weight: 1,
      grounded: true,
      jumpPhase: "none",
      transitionDurationS: 0.16,
    });
    expect(walkingState?.timeS).toBeGreaterThan(0);
    expect(walkingState?.speedMps).toBeGreaterThan(0);
    expect(walkingState?.playbackRate).toBeGreaterThan(0);
    expect(walkingState?.localVelocityZ).toBeGreaterThan(0);
    expect(Math.abs(walkingState?.localVelocityX ?? 1)).toBeLessThan(0.001);
    expect(walkingState?.clipStartedFrame).toBeGreaterThan(0);
    expect(authoredBone.rotation.x).toBeCloseTo(0.37, 8);

    unmount();
    expect(readDirectorCharacterLocomotionRuntimeState(playerObject)).toBeNull();
  });

  it("keeps opposite movement keys neutral instead of emitting a phantom gait", () => {
    const playerObject = new Group();
    playerObject.name = `director-object-${player.id}`;
    mockRuntime.sceneObject = playerObject;
    renderController();
    const canvas = mockRuntime.canvas!;

    fireEvent.pointerDown(canvas, { button: 0, clientX: 120, clientY: 90, pointerId: 1 });
    fireEvent.keyDown(window, { code: "KeyW" });
    fireEvent.keyDown(window, { code: "KeyS" });
    mockRuntime.frame?.({}, 0.1);

    expect(readDirectorCharacterLocomotionRuntimeState(playerObject)).toMatchObject({
      mode: "idle",
      speedMps: 0,
      localVelocityX: 0,
      localVelocityZ: 0,
    });

    fireEvent.keyUp(window, { code: "KeyW" });
    fireEvent.keyUp(window, { code: "KeyS" });
    fireEvent.keyDown(window, { code: "KeyA" });
    fireEvent.keyDown(window, { code: "KeyD" });
    mockRuntime.frame?.({}, 0.1);

    expect(readDirectorCharacterLocomotionRuntimeState(playerObject)).toMatchObject({
      mode: "idle",
      speedMps: 0,
      localVelocityX: 0,
      localVelocityZ: 0,
    });
  });

  it("publishes jump phases from a press edge and restarts the one-shot on a later jump", () => {
    const playerObject = new Group();
    playerObject.name = `director-object-${player.id}`;
    mockRuntime.sceneObject = playerObject;
    renderController();
    const canvas = mockRuntime.canvas!;

    mockRuntime.frame?.({}, 0.1);
    fireEvent.pointerDown(canvas, { button: 0, clientX: 120, clientY: 90, pointerId: 1 });
    fireEvent.keyDown(window, { code: "Space" });
    mockRuntime.frame?.({}, 0.05);
    const firstJump = readDirectorCharacterLocomotionRuntimeState(playerObject)!;

    expect(firstJump).toMatchObject({
      mode: "jump",
      timeS: 0,
      grounded: false,
      jumpPhase: "takeoff",
      transitionDurationS: 0.1,
    });
    expect(firstJump.verticalVelocityMps).toBeGreaterThan(0);
    const firstClipStartedFrame = firstJump.clipStartedFrame;

    // Holding Space is not a new edge and must not restart the jump clip.
    mockRuntime.frame?.({}, 0.05);
    const heldJump = readDirectorCharacterLocomotionRuntimeState(playerObject)!;
    expect(heldJump.clipStartedFrame).toBe(firstClipStartedFrame);
    expect(heldJump.timeS).toBeGreaterThan(0);
    fireEvent.keyUp(window, { code: "Space" });

    // A fresh press early in the air is outside the physical motor's landing
    // buffer and must not schedule an animation-only second jump.
    fireEvent.keyDown(window, { code: "Space" });
    mockRuntime.frame?.({}, 0.05);
    fireEvent.keyUp(window, { code: "Space" });
    expect(readDirectorCharacterLocomotionRuntimeState(playerObject)?.clipStartedFrame).toBe(firstClipStartedFrame);

    for (let index = 0; index < 48; index += 1) {
      mockRuntime.frame?.({}, 0.05);
      const state = readDirectorCharacterLocomotionRuntimeState(playerObject);
      if (state?.mode === "idle" && state.grounded) break;
    }
    expect(readDirectorCharacterLocomotionRuntimeState(playerObject)).toMatchObject({
      mode: "idle",
      grounded: true,
      jumpPhase: "none",
    });

    fireEvent.keyDown(window, { code: "Space" });
    mockRuntime.frame?.({}, 0.05);
    const secondJump = readDirectorCharacterLocomotionRuntimeState(playerObject)!;
    expect(secondJump).toMatchObject({ mode: "jump", timeS: 0, jumpPhase: "takeoff" });
    expect(secondJump.clipStartedFrame).toBeGreaterThan(firstClipStartedFrame);
  });

  it("publishes actor-local velocity and signed visual yaw velocity", () => {
    const playerObject = new Group();
    playerObject.name = `director-object-${player.id}`;
    mockRuntime.sceneObject = playerObject;
    renderController();
    const canvas = mockRuntime.canvas!;

    fireEvent.pointerDown(canvas, { button: 0, clientX: 120, clientY: 90, pointerId: 1 });
    fireEvent.keyDown(window, { code: "KeyW" });
    mockRuntime.frame?.({}, 0.1);
    fireEvent.pointerMove(canvas, { buttons: 1, clientX: 180, clientY: 90, pointerId: 1 });
    mockRuntime.frame?.({}, 0.05);

    const runtime = readDirectorCharacterLocomotionRuntimeState(playerObject)!;
    expect(runtime.localVelocityZ).toBeGreaterThan(0);
    expect(Number.isFinite(runtime.localVelocityX)).toBe(true);
    expect(runtime.angularVelocityRadS).not.toBe(0);
    expect(Number.isFinite(runtime.angularVelocityRadS)).toBe(true);
  });

  it("publishes semantic +X for the controller's right movement axis", () => {
    const playerObject = new Group();
    playerObject.name = `director-object-${player.id}`;
    mockRuntime.sceneObject = playerObject;
    renderController();
    const canvas = mockRuntime.canvas!;

    fireEvent.pointerDown(canvas, { button: 0, clientX: 120, clientY: 90, pointerId: 1 });
    fireEvent.keyDown(window, { code: "KeyD" });
    mockRuntime.frame?.({}, 1 / 60);

    const runtime = readDirectorCharacterLocomotionRuntimeState(playerObject)!;
    expect(runtime.localVelocityX).toBeGreaterThan(0);
  });

  it("preserves rightward Blend Space intent when a wall rejects planar movement", () => {
    const playerObject = new Group();
    playerObject.name = `director-object-${player.id}`;
    mockRuntime.sceneObject = playerObject;
    renderController(vi.fn(), vi.fn(), {
      obstacles: [
        {
          id: "right-wall",
          position: [-0.36, 0, 0],
          radius: 0,
          shape: "box",
          halfExtents: [0.2, 4],
          halfHeight: 2,
        },
      ],
    });
    const canvas = mockRuntime.canvas!;

    fireEvent.pointerDown(canvas, { button: 0, clientX: 120, clientY: 90, pointerId: 1 });
    fireEvent.keyDown(window, { code: "KeyD" });
    mockRuntime.frame?.({}, 0.1);
    mockRuntime.frame?.({}, 0.1);

    const runtime = readDirectorCharacterLocomotionRuntimeState(playerObject)!;
    expect(runtime.mode).toBe("walk");
    expect(runtime.localVelocityX).toBeGreaterThan(0);
    expect(Math.abs(runtime.localVelocityZ)).toBeLessThan(runtime.localVelocityX * 0.05);
  });

  it("keeps flight outside the ground jump machine while publishing vertical telemetry", () => {
    const playerObject = new Group();
    playerObject.name = `director-object-${player.id}`;
    mockRuntime.sceneObject = playerObject;
    renderController(vi.fn(), vi.fn(), { flying: true });
    const canvas = mockRuntime.canvas!;

    mockRuntime.frame?.({}, 0.05);
    const initialFlight = readDirectorCharacterLocomotionRuntimeState(playerObject)!;
    expect(initialFlight).toMatchObject({ mode: "fly", grounded: false, jumpPhase: "none" });

    fireEvent.pointerDown(canvas, { button: 0, clientX: 120, clientY: 90, pointerId: 1 });
    fireEvent.keyDown(window, { code: "Space" });
    mockRuntime.frame?.({}, 0.05);
    const ascending = readDirectorCharacterLocomotionRuntimeState(playerObject)!;

    expect(ascending).toMatchObject({
      mode: "fly",
      grounded: false,
      jumpPhase: "none",
      clipStartedFrame: initialFlight.clipStartedFrame,
    });
    expect(ascending.verticalVelocityMps).toBeGreaterThan(0);
  });

  it("commits the departing actor when the controlled player switches", () => {
    const onTransformCommit = vi.fn();
    const onFinished = vi.fn();
    const rendered = renderController(vi.fn(), vi.fn(), { onFinished, onTransformCommit });
    const canvas = mockRuntime.canvas!;

    fireEvent.pointerDown(canvas, { button: 0, clientX: 120, clientY: 90, pointerId: 1 });
    fireEvent.keyDown(window, { code: "KeyW" });
    mockRuntime.frame?.({}, 0.1);
    mockRuntime.frame?.({}, 0.1);

    const nextPlayer: DirectorObject = {
      ...player,
      id: "character_next",
      name: "角色02",
      transform: { ...player.transform, position: [8, 0, 4] },
    };
    rendered.rerender(<PlayerController {...rendered.props} player={nextPlayer} />);

    expect(onTransformCommit).toHaveBeenCalledWith(player.id, expect.objectContaining({ position: expect.any(Array) }));
    expect(onTransformCommit.mock.calls.some(([id]) => id === nextPlayer.id)).toBe(false);
    expect(onFinished).not.toHaveBeenCalled();
  });

  it("retries Mixamo head discovery after the GLB skeleton mounts", () => {
    const playerObject = new Group();
    playerObject.name = `director-object-${player.id}`;
    mockRuntime.sceneObject = playerObject;
    const onRuntimeStatusChange = vi.fn();
    renderController(vi.fn(), onRuntimeStatusChange, { viewMode: "first" });

    mockRuntime.frame?.({}, 0.1);
    const fallbackHeight = onRuntimeStatusChange.mock.calls.at(-1)?.[0]?.cameraPosition?.[1] as number;

    const head = new Bone();
    head.name = "mixamorigHead";
    head.position.set(0, 4, 0);
    playerObject.add(head);
    playerObject.updateWorldMatrix(true, true);
    mockRuntime.frame?.({}, 0.1);
    mockRuntime.frame?.({}, 0.1);

    const resolvedHeight = onRuntimeStatusChange.mock.calls.at(-1)?.[0]?.cameraPosition?.[1] as number;
    expect(resolvedHeight).toBeGreaterThan(fallbackHeight + 2);
  });

  it("rebases the same actor id after an external Agent or timeline transform", () => {
    const playerObject = new Group();
    playerObject.name = `director-object-${player.id}`;
    mockRuntime.sceneObject = playerObject;
    const onRuntimeStatusChange = vi.fn();
    const rendered = renderController(vi.fn(), onRuntimeStatusChange);
    mockRuntime.frame?.({}, 1 / 60);

    const externallyMovedPlayer: DirectorObject = {
      ...player,
      transform: {
        ...player.transform,
        position: [20, 0, -7],
        rotation: [0, 0.7, 0],
      },
    };
    rendered.rerender(<PlayerController {...rendered.props} player={externallyMovedPlayer} />);
    mockRuntime.frame?.({}, 1 / 60);

    expect(playerObject.position.toArray()).toEqual([20, 0, -7]);
    expect(playerObject.rotation.y).toBeCloseTo(0.7, 6);
    expect(onRuntimeStatusChange.mock.calls.at(-1)?.[0]?.playerPosition).toEqual([20, 0, -7]);
  });

  it("keeps runtime visuals in sync with a scale-only Agent transform", () => {
    const playerObject = new Group();
    playerObject.name = `director-object-${player.id}`;
    mockRuntime.sceneObject = playerObject;
    const rendered = renderController();
    mockRuntime.frame?.({}, 1 / 60);

    const externallyScaledPlayer: DirectorObject = {
      ...player,
      transform: {
        ...player.transform,
        scale: [2, 1.5, 0.5],
      },
    };
    rendered.rerender(<PlayerController {...rendered.props} player={externallyScaledPlayer} />);
    mockRuntime.frame?.({}, 1 / 60);

    expect(playerObject.scale.toArray()).toEqual([2, 1.5, 0.5]);
    expect(playerObject.position.toArray()).toEqual([0, 0, 0]);
  });

  it("uses a stable first-person head anchor instead of copying animated head bob", () => {
    const playerObject = new Group();
    playerObject.name = `director-object-${player.id}`;
    const head = new Bone();
    head.name = "mixamorigHead";
    head.position.set(0, 4, 0);
    playerObject.add(head);
    mockRuntime.sceneObject = playerObject;
    const onRuntimeStatusChange = vi.fn();
    renderController(vi.fn(), onRuntimeStatusChange, { viewMode: "first" });

    mockRuntime.frame?.({}, 0.1);
    const initialHeight = onRuntimeStatusChange.mock.calls.at(-1)?.[0]?.cameraPosition?.[1] as number;
    head.position.y = 7;
    playerObject.updateWorldMatrix(true, true);
    for (let index = 0; index < 4; index += 1) mockRuntime.frame?.({}, 0.1);
    const animatedHeight = onRuntimeStatusChange.mock.calls.at(-1)?.[0]?.cameraPosition?.[1] as number;

    expect(animatedHeight).toBeCloseTo(initialHeight, 6);
  });

  it("invalidates the stable head anchor when the same actor switches assets", () => {
    const playerObject = new Group();
    playerObject.name = `director-object-${player.id}`;
    const firstHead = new Bone();
    firstHead.name = "mixamorigHead";
    firstHead.position.set(0, 4, 0);
    playerObject.add(firstHead);
    mockRuntime.sceneObject = playerObject;
    const onRuntimeStatusChange = vi.fn();
    const rendered = renderController(vi.fn(), onRuntimeStatusChange, {
      player: { ...player, assetRefId: "character_old" },
      viewMode: "first",
    });
    mockRuntime.frame?.({}, 0.1);
    const firstHeight = onRuntimeStatusChange.mock.calls.at(-1)?.[0]?.cameraPosition?.[1] as number;

    playerObject.remove(firstHead);
    const replacementHead = new Bone();
    replacementHead.name = "mixamorigHead";
    replacementHead.position.set(0, 6, 0);
    playerObject.add(replacementHead);
    rendered.rerender(
      <PlayerController {...rendered.props} player={{ ...player, assetRefId: "character_new" }} viewMode="first" />,
    );
    for (let index = 0; index < 5; index += 1) mockRuntime.frame?.({}, 0.1);
    const replacementHeight = onRuntimeStatusChange.mock.calls.at(-1)?.[0]?.cameraPosition?.[1] as number;

    expect(replacementHeight).toBeGreaterThan(firstHeight + 1);
  });

  it("keeps low-pitch third-person shots softly above the stage floor", () => {
    const onRuntimeStatusChange = vi.fn();
    renderController(vi.fn(), onRuntimeStatusChange);
    const canvas = mockRuntime.canvas!;
    fireEvent.pointerDown(canvas, { button: 0, clientX: 120, clientY: 90, pointerId: 1 });
    fireEvent.pointerMove(canvas, { buttons: 1, clientX: 120, clientY: 900, pointerId: 1 });
    for (let index = 0; index < 6; index += 1) mockRuntime.frame?.({}, 0.1);

    const cameraHeight = onRuntimeStatusChange.mock.calls.at(-1)?.[0]?.cameraPosition?.[1] as number;
    expect(cameraHeight).toBeGreaterThan(0.15);
  });

  it("narrows the lens and reports aiming while the right button is held", () => {
    const onRuntimeStatusChange = vi.fn();
    renderController(vi.fn(), onRuntimeStatusChange);
    const canvas = mockRuntime.canvas!;
    const baseFov = mockRuntime.camera!.fov;
    mockRuntime.frame?.({}, 1 / 60);

    fireEvent.pointerDown(canvas, { button: 2, clientX: 100, clientY: 100, pointerId: 3 });
    for (let index = 0; index < 40; index += 1) mockRuntime.frame?.({}, 1 / 30);

    expect(onRuntimeStatusChange.mock.calls.at(-1)?.[0]?.aiming).toBe(true);
    expect(mockRuntime.camera!.fov).toBeLessThan(baseFov * 0.78);

    fireEvent.pointerUp(canvas, { button: 2, clientX: 100, clientY: 100, pointerId: 3 });
    for (let index = 0; index < 40; index += 1) mockRuntime.frame?.({}, 1 / 30);

    expect(onRuntimeStatusChange.mock.calls.at(-1)?.[0]?.aiming).toBe(false);
    expect(mockRuntime.camera!.fov).toBeGreaterThan(baseFov * 0.94);
  });

  it("widens the lens with sustained sprint speed and restores it on exit", () => {
    const playerObject = new Group();
    playerObject.name = `director-object-${player.id}`;
    mockRuntime.sceneObject = playerObject;
    const rendered = renderController();
    const canvas = mockRuntime.canvas!;
    const baseFov = mockRuntime.camera!.fov;

    fireEvent.pointerDown(canvas, { button: 0, clientX: 120, clientY: 90, pointerId: 1 });
    fireEvent.keyDown(window, { code: "ShiftLeft" });
    fireEvent.keyDown(window, { code: "KeyW" });
    for (let index = 0; index < 60; index += 1) mockRuntime.frame?.({}, 1 / 30);

    expect(mockRuntime.camera!.fov).toBeGreaterThan(baseFov + 1);

    rendered.unmount();
    expect(mockRuntime.camera!.fov).toBeCloseTo(baseFov, 6);
  });

  it("dashes on a double-tapped direction and reports a burst above run speed", () => {
    const playerObject = new Group();
    playerObject.name = `director-object-${player.id}`;
    mockRuntime.sceneObject = playerObject;
    renderController();
    const canvas = mockRuntime.canvas!;

    fireEvent.pointerDown(canvas, { button: 0, clientX: 120, clientY: 90, pointerId: 1 });
    fireEvent.keyDown(window, { code: "KeyW" });
    fireEvent.keyUp(window, { code: "KeyW" });
    fireEvent.keyDown(window, { code: "KeyW" });
    for (let index = 0; index < 10; index += 1) mockRuntime.frame?.({}, 1 / 60);

    const runtime = readDirectorCharacterLocomotionRuntimeState(playerObject)!;
    expect(runtime.speedMps).toBeGreaterThan(PLAYER_CONTROLLER_CONFIG.runSpeed);
  });

  it("plays a looping hotkey emote and cancels it on movement input", () => {
    const playerObject = new Group();
    playerObject.name = `director-object-${player.id}`;
    mockRuntime.sceneObject = playerObject;
    const onRuntimeStatusChange = vi.fn();
    renderController(vi.fn(), onRuntimeStatusChange);
    const canvas = mockRuntime.canvas!;

    fireEvent.pointerDown(canvas, { button: 0, clientX: 120, clientY: 90, pointerId: 1 });
    mockRuntime.frame?.({}, 1 / 60);
    fireEvent.keyDown(window, { code: "Digit3" });
    mockRuntime.frame?.({}, 1 / 60);

    expect(readDirectorCharacterLocomotionRuntimeState(playerObject)).toMatchObject({
      mode: "emote",
      emoteClipId: "talk",
    });
    expect(onRuntimeStatusChange.mock.calls.at(-1)?.[0]?.emoteClipId).toBe("talk");

    // A looping performance continues far past a single clip duration.
    for (let index = 0; index < 60; index += 1) mockRuntime.frame?.({}, 0.1);
    expect(readDirectorCharacterLocomotionRuntimeState(playerObject)?.mode).toBe("emote");

    fireEvent.keyDown(window, { code: "KeyW" });
    mockRuntime.frame?.({}, 1 / 60);
    expect(readDirectorCharacterLocomotionRuntimeState(playerObject)?.mode).not.toBe("emote");
    expect(onRuntimeStatusChange.mock.calls.at(-1)?.[0]?.emoteClipId).toBeNull();
    fireEvent.keyUp(window, { code: "KeyW" });
  });

  it("finishes a one-shot emote and returns to idle on its own", () => {
    const playerObject = new Group();
    playerObject.name = `director-object-${player.id}`;
    mockRuntime.sceneObject = playerObject;
    renderController();
    const canvas = mockRuntime.canvas!;

    fireEvent.pointerDown(canvas, { button: 0, clientX: 120, clientY: 90, pointerId: 1 });
    mockRuntime.frame?.({}, 1 / 60);
    fireEvent.keyDown(window, { code: "Digit1" });
    mockRuntime.frame?.({}, 1 / 60);
    expect(readDirectorCharacterLocomotionRuntimeState(playerObject)).toMatchObject({
      mode: "emote",
      emoteClipId: "wave",
    });

    // The packaged wave is ~0.53 s; well after that the actor idles again.
    for (let index = 0; index < 16; index += 1) mockRuntime.frame?.({}, 0.05);
    expect(readDirectorCharacterLocomotionRuntimeState(playerObject)).toMatchObject({
      mode: "idle",
      grounded: true,
    });
  });

  it("starts an emote from a HUD request without keyboard focus", () => {
    const playerObject = new Group();
    playerObject.name = `director-object-${player.id}`;
    mockRuntime.sceneObject = playerObject;
    const rendered = renderController();

    mockRuntime.frame?.({}, 1 / 60);
    rendered.rerender(<PlayerController {...rendered.props} emoteRequest={{ clipId: "clap", nonce: 1 }} />);
    mockRuntime.frame?.({}, 1 / 60);

    expect(readDirectorCharacterLocomotionRuntimeState(playerObject)).toMatchObject({
      mode: "emote",
      emoteClipId: "clap",
    });
  });
});

describe("mesh collider warmup fail-safe", () => {
  it("does not rebuild an unchanged collision version that already failed", () => {
    const ownerState = {
      committedVersionKey: "epoch-a:1",
      degraded: true,
      degradedVersionKey: "epoch-a:2",
      desiredVersionKey: "epoch-a:2",
      generation: 3,
      mountAttempts: 24,
      pending: false,
    };

    resetMeshCollisionOwnerForMotor(ownerState);

    expect(ownerState).toMatchObject({
      committedVersionKey: null,
      degraded: true,
      generation: 4,
      mountAttempts: 0,
      pending: false,
    });

    ownerState.desiredVersionKey = "epoch-a:3";
    resetMeshCollisionOwnerForMotor(ownerState);
    expect(ownerState).toMatchObject({ degraded: false, generation: 5, pending: true });
  });

  it("commits only the latest build after rapid live-scene revisions", () => {
    const motor = {} as NonNullable<Parameters<typeof isCurrentMeshColliderBuild>[2]>;
    const ownerState = { desiredVersionKey: "epoch-a:3", generation: 3 };
    const commits = vi.fn();
    const builds = [
      { generation: 1, motor, versionKey: "epoch-a:1" },
      { generation: 2, motor, versionKey: "epoch-a:2" },
      { generation: 3, motor, versionKey: "epoch-a:3" },
    ];

    for (const build of builds) {
      if (isCurrentMeshColliderBuild(build, ownerState, motor)) commits(build.versionKey);
    }

    expect(commits).toHaveBeenCalledOnce();
    expect(commits).toHaveBeenCalledWith("epoch-a:3");
  });

  it("blocks only while a real physics mesh is actively warming", () => {
    expect(
      shouldBlockForMeshColliderWarmup({
        degraded: false,
        hasMeshEnvironment: true,
        physicsAvailable: true,
        ready: false,
      }),
    ).toBe(true);
  });

  it.each([
    ["Rapier init failed", false, false],
    ["mesh build failed", true, true],
    ["mesh mount timed out", true, true],
  ])("does not permanently lock movement when %s", (_label, physicsAvailable, degraded) => {
    expect(
      shouldBlockForMeshColliderWarmup({
        degraded,
        hasMeshEnvironment: true,
        physicsAvailable,
        ready: false,
      }),
    ).toBe(false);
  });

  it("freezes a hidden-ground authored position across pending frames and resumes once ready", () => {
    const authoredPosition: [number, number, number] = [2, -3.5, 4];
    let state = {
      ...createPlayerLocomotionState(authoredPosition, 0, authoredPosition[1]),
      onGround: false,
      velocity: [0, -7, 0] as [number, number, number],
      jumpBufferTimeRemaining: 0.12,
    };
    const input: PlayerInput = {
      forward: true,
      backward: false,
      left: false,
      right: false,
      sprint: false,
      jump: true,
      jumpPressed: true,
      descend: false,
    };

    for (let frame = 0; frame < 180; frame += 1) {
      const blocked = shouldBlockForMeshColliderWarmup({
        degraded: false,
        hasMeshEnvironment: true,
        physicsAvailable: true,
        ready: false,
      });
      expect(blocked).toBe(true);
      state = freezePlayerLocomotionForMeshColliderWarmup(state, input);
    }

    expect(state.position).toEqual(authoredPosition);
    expect(state.velocity).toEqual([0, 0, 0]);
    expect(state.jumpBufferTimeRemaining).toBe(0);
    expect(state.jumpHeld).toBe(true);
    expect(input.jumpPressed).toBe(false);

    const blockedAfterReady = shouldBlockForMeshColliderWarmup({
      degraded: false,
      hasMeshEnvironment: true,
      physicsAvailable: true,
      ready: true,
    });
    expect(blockedAfterReady).toBe(false);
    const resumed = stepPlayerLocomotion({
      state,
      input: { ...input, jump: false },
      delta: 1 / 30,
      groundHeight: 0,
      groundEnabled: false,
      obstacles: [],
    });
    expect(resumed.position[2]).toBeGreaterThan(state.position[2]);
  });
});
