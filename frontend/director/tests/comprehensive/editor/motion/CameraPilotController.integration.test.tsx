import { fireEvent, render } from "@testing-library/react";
import { Object3D, PerspectiveCamera } from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CameraShotSnapshot } from "../../../../src/comprehensive/editor/store/directorStore";
import { CameraPilotController } from "../../../../src/comprehensive/editor/motion/CameraPilotController";

const mockRuntime = vi.hoisted(() => ({
  camera: null as PerspectiveCamera | null,
  canvas: null as HTMLCanvasElement | null,
  frame: null as ((state: unknown, delta: number) => void) | null,
  scene: null as Object3D | null,
}));

vi.mock("@react-three/fiber", () => ({
  useFrame: (frame: (state: unknown, delta: number) => void) => {
    mockRuntime.frame = frame;
  },
  useThree: () => ({
    camera: mockRuntime.camera,
    gl: { domElement: mockRuntime.canvas },
    scene: mockRuntime.scene,
  }),
}));

describe("CameraPilotController pointer confinement", () => {
  beforeEach(() => {
    mockRuntime.camera = new PerspectiveCamera(50, 1, 0.1, 1_000);
    mockRuntime.canvas = document.createElement("canvas");
    mockRuntime.scene = new Object3D();
    document.body.append(mockRuntime.canvas);
    mockRuntime.canvas.requestPointerLock = vi.fn();
    mockRuntime.canvas.setPointerCapture = vi.fn();
    mockRuntime.canvas.releasePointerCapture = vi.fn();
    mockRuntime.canvas.hasPointerCapture = vi.fn(() => true);
  });

  afterEach(() => {
    mockRuntime.canvas?.remove();
    mockRuntime.camera = null;
    mockRuntime.canvas = null;
    mockRuntime.frame = null;
    mockRuntime.scene = null;
    vi.restoreAllMocks();
  });

  it("uses focused drag-look and keyboard control without requesting Pointer Lock", () => {
    const snapshotRef = {
      current: {
        fov: 50,
        position: [0, 2, 8],
        target: [0, 1, 0],
      } satisfies CameraShotSnapshot,
    };
    const onControlActiveChange = vi.fn();
    const { unmount } = render(
      <CameraPilotController
        active
        bankStrength={0.3}
        inertia={0.4}
        lookSmoothing={0.25}
        moveSpeed={6}
        objectKey=""
        onControlActiveChange={onControlActiveChange}
        onExit={vi.fn()}
        onRecord={vi.fn()}
        onTargetStateChange={vi.fn()}
        rotateSensitivity={0.35}
        snapshotRef={snapshotRef}
        zoomSensitivity={0.4}
      />,
    );
    const canvas = mockRuntime.canvas!;
    const beforeTarget = [...snapshotRef.current.target];
    const beforePosition = [...snapshotRef.current.position];

    fireEvent.pointerDown(canvas, { button: 0, clientX: 100, clientY: 80, pointerId: 1 });
    expect(canvas.requestPointerLock).not.toHaveBeenCalled();
    expect(canvas.setPointerCapture).toHaveBeenCalledWith(1);
    expect(onControlActiveChange).toHaveBeenLastCalledWith(true);
    expect(canvas.style.cursor).toBe("none");
    fireEvent.pointerUp(canvas, { button: 0, clientX: 100, clientY: 80, pointerId: 1 });
    expect(canvas.releasePointerCapture).toHaveBeenCalledWith(1);
    expect(canvas.style.cursor).toBe("");

    const movement = new MouseEvent("mousemove", { bubbles: true });
    Object.defineProperties(movement, {
      movementX: { value: 5_000 },
      movementY: { value: 0 },
    });
    window.dispatchEvent(movement);
    for (let index = 0; index < 8; index += 1) mockRuntime.frame?.({}, 0.1);

    expect(snapshotRef.current.target.every((value, index) => Math.abs(value - beforeTarget[index]!) < 0.000001)).toBe(
      true,
    );

    fireEvent.pointerDown(canvas, { button: 0, clientX: 100, clientY: 80, pointerId: 2 });
    fireEvent.pointerMove(canvas, { buttons: 1, clientX: 160, clientY: 90, pointerId: 2 });
    fireEvent.keyDown(window, { code: "KeyW" });
    for (let index = 0; index < 8; index += 1) mockRuntime.frame?.({}, 0.1);
    fireEvent.keyUp(window, { code: "KeyW" });
    fireEvent.pointerUp(canvas, { button: 0, clientX: 160, clientY: 90, pointerId: 2 });

    expect(snapshotRef.current.target).not.toEqual(beforeTarget);
    expect(snapshotRef.current.position).not.toEqual(beforePosition);

    fireEvent.pointerDown(document.body, { button: 0, pointerId: 3 });
    expect(onControlActiveChange).toHaveBeenLastCalledWith(false);

    unmount();
    expect(canvas.style.cursor).toBe("");
    expect(onControlActiveChange).toHaveBeenLastCalledWith(false);
  });

  it("keeps control explicit when Pointer Lock is available", () => {
    const snapshotRef = {
      current: {
        fov: 50,
        position: [0, 2, 8],
        target: [0, 1, 0],
      } satisfies CameraShotSnapshot,
    };
    const onControlActiveChange = vi.fn();
    const onExit = vi.fn();
    const canvas = mockRuntime.canvas!;
    render(
      <CameraPilotController
        active
        bankStrength={0.3}
        inertia={0.4}
        lookSmoothing={0.25}
        moveSpeed={6}
        objectKey=""
        onControlActiveChange={onControlActiveChange}
        onExit={onExit}
        onRecord={vi.fn()}
        onTargetStateChange={vi.fn()}
        rotateSensitivity={0.35}
        snapshotRef={snapshotRef}
        zoomSensitivity={0.4}
      />,
    );

    fireEvent.pointerDown(canvas, { button: 0, clientX: 100, clientY: 80, pointerId: 1 });
    fireEvent.pointerMove(canvas, { buttons: 1, clientX: 140, clientY: 80, pointerId: 1 });
    fireEvent.pointerUp(canvas, { button: 0, clientX: 140, clientY: 80, pointerId: 1 });

    expect(canvas.requestPointerLock).not.toHaveBeenCalled();
    expect(onControlActiveChange).toHaveBeenLastCalledWith(true);
    expect(onExit).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { code: "Escape" });
    expect(onExit).toHaveBeenCalledOnce();
  });

  it("toggles a view-point target lock with F while controls are focused", () => {
    const snapshotRef = {
      current: {
        fov: 50,
        position: [0, 2, 8],
        target: [0, 1, 0],
      } satisfies CameraShotSnapshot,
    };
    const onTargetStateChange = vi.fn();
    const canvas = mockRuntime.canvas!;
    render(
      <CameraPilotController
        active
        bankStrength={0.3}
        inertia={0.4}
        lookSmoothing={0.25}
        moveSpeed={6}
        objectKey=""
        onExit={vi.fn()}
        onRecord={vi.fn()}
        onTargetStateChange={onTargetStateChange}
        rotateSensitivity={0.35}
        snapshotRef={snapshotRef}
        zoomSensitivity={0.4}
      />,
    );

    fireEvent.pointerDown(canvas, { button: 0, clientX: 100, clientY: 80, pointerId: 1 });
    fireEvent.pointerUp(canvas, { button: 0, clientX: 100, clientY: 80, pointerId: 1 });
    fireEvent.keyDown(window, { code: "KeyF" });

    expect(onTargetStateChange).toHaveBeenLastCalledWith({
      hoveredTargetId: null,
      lockedPoint: expect.any(Array),
      lockedTargetId: null,
    });

    fireEvent.keyDown(window, { code: "KeyF" });

    expect(onTargetStateChange).toHaveBeenLastCalledWith({
      hoveredTargetId: null,
      lockedPoint: null,
      lockedTargetId: null,
    });
  });
});
