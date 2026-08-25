import { act, fireEvent, render } from "@testing-library/react";
import type { MutableRefObject } from "react";
import { PerspectiveCamera, Vector3 } from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fiberMocks = vi.hoisted(() => ({ useFrame: vi.fn(), useThree: vi.fn() }));
vi.mock("@react-three/fiber", () => fiberMocks);

import { DirectorKeyboardController, applyDirectorViewLook, getDirectorLookIntent, getDirectorMovementIntent } from "../../../../src/comprehensive/editor/canvas/DirectorKeyboardController";

let camera: PerspectiveCamera;
let frame: (_state: unknown, delta: number) => void;
let controlsRef: MutableRefObject<OrbitControlsImpl | null>;
let invalidate: ReturnType<typeof vi.fn>;

beforeEach(() => {
  camera = new PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 2, 5);
  camera.lookAt(0, 2, 0);
  camera.updateMatrixWorld();
  controlsRef = {
    current: { target: new Vector3(0, 2, 0), update: vi.fn() } as unknown as OrbitControlsImpl,
  };
  invalidate = vi.fn();
  fiberMocks.useThree.mockReturnValue({ camera, invalidate });
  fiberMocks.useFrame.mockImplementation((callback: typeof frame) => {
    frame = callback;
  });
});

describe("DirectorKeyboardController", () => {
  it("maps physical movement keys", () => {
    expect(getDirectorMovementIntent(new Set(["KeyW", "KeyD", "KeyE"]))).toEqual({
      forward: 1,
      strafe: 1,
      vertical: 1,
    });
  });

  it("moves the director camera and orbit target together", () => {
    render(<DirectorKeyboardController active controlsRef={controlsRef} moveSpeed={10} />);
    const originalOffset = camera.position.clone().sub(controlsRef.current!.target);
    fireEvent.keyDown(window, { code: "KeyW" });
    act(() => frame({}, 0.1));
    expect(camera.position.z).toBeCloseTo(4.5);
    expect(camera.position.clone().sub(controlsRef.current!.target)).toEqual(originalOffset);
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it("commits one settled snapshot after a keyboard move ends", () => {
    const onInteractionEnd = vi.fn();
    render(
      <DirectorKeyboardController
        active
        controlsRef={controlsRef}
        moveSpeed={10}
        onInteractionEnd={onInteractionEnd}
      />,
    );

    fireEvent.keyDown(window, { code: "KeyW" });
    act(() => frame({}, 0.016));
    act(() => frame({}, 0.016));
    expect(onInteractionEnd).not.toHaveBeenCalled();

    fireEvent.keyUp(window, { code: "KeyW" });
    expect(onInteractionEnd).toHaveBeenCalledTimes(1);
  });

  it("ignores editable controls", () => {
    const input = document.createElement("input");
    document.body.append(input);
    render(<DirectorKeyboardController active controlsRef={controlsRef} moveSpeed={10} />);
    fireEvent.keyDown(input, { code: "KeyW" });
    act(() => frame({}, 0.1));
    expect(camera.position).toEqual(new Vector3(0, 2, 5));
    input.remove();
  });

  it("maps arrow keys to look, not fly", () => {
    expect(getDirectorLookIntent(new Set(["ArrowRight", "ArrowUp"]))).toEqual({ yaw: 1, pitch: 1 });
    expect(getDirectorMovementIntent(new Set(["ArrowRight"]))).toEqual({
      forward: 0,
      strafe: 0,
      vertical: 0,
    });
  });

  it("looks left and right from the current viewpoint without moving the camera", () => {
    render(<DirectorKeyboardController active controlsRef={controlsRef} moveSpeed={10} />);
    const cameraPosition = camera.position.clone();
    fireEvent.keyDown(window, { code: "ArrowRight" });
    act(() => frame({}, 0.1));
    expect(camera.position).toEqual(cameraPosition);
    expect(controlsRef.current!.target.x).toBeGreaterThan(0);
    expect(controlsRef.current!.target.z).toBeCloseTo(0, 1);
  });

  it("looks up by raising the look-at point from the current viewpoint", () => {
    const position = new Vector3(0, 5, 5);
    const target = new Vector3(0, 0, 0);
    applyDirectorViewLook(position, target, 0, 0.2);
    expect(position).toEqual(new Vector3(0, 5, 5));
    expect(target.y).toBeGreaterThan(0);
  });

  it("clamps pitch before the view flips through the poles", () => {
    const position = new Vector3(0, 2, 5);
    const target = new Vector3(0, 2, 0);
    applyDirectorViewLook(position, target, 0, 10);
    expect(position).toEqual(new Vector3(0, 2, 5));
    expect(target.y).toBeGreaterThan(position.y);
    expect(target.distanceTo(position)).toBeCloseTo(5);
  });

  it("does not fly with WASD when move is disabled", () => {
    render(
      <DirectorKeyboardController active controlsRef={controlsRef} moveEnabled={false} moveSpeed={10} />,
    );
    fireEvent.keyDown(window, { code: "KeyW" });
    act(() => frame({}, 0.1));
    expect(camera.position).toEqual(new Vector3(0, 2, 5));
  });

  it("leaves arrow keys to timeline and panel chrome", () => {
    const slider = document.createElement("div");
    slider.setAttribute("role", "slider");
    document.body.append(slider);
    render(<DirectorKeyboardController active controlsRef={controlsRef} moveSpeed={10} />);
    fireEvent.keyDown(slider, { code: "ArrowRight" });
    act(() => frame({}, 0.1));
    expect(camera.position).toEqual(new Vector3(0, 2, 5));
    expect(controlsRef.current!.target).toEqual(new Vector3(0, 2, 0));
    slider.remove();
  });
});
