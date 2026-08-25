import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DirectorTransform } from "../../../../src/comprehensive/editor/schema/directorProject";
import { createInitialDirectorState, useDirectorStore } from "../../../../src/comprehensive/editor/store/directorStore";
import { useRafCoalescedTransformInteraction } from "../../../../src/comprehensive/editor/runtime/useRafCoalescedTransformInteraction";

type FrameCallback = (time: number) => void;

let nextFrameId = 1;
let frameCallbacks: Map<number, FrameCallback>;

function createTransform(x: number): DirectorTransform {
  return {
    position: [x, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  };
}

function runNextAnimationFrame() {
  const entry = frameCallbacks.entries().next().value as [number, FrameCallback] | undefined;
  if (!entry) throw new Error("Expected a scheduled animation frame");
  const [frameId, callback] = entry;
  frameCallbacks.delete(frameId);
  callback(16.67);
}

beforeEach(() => {
  nextFrameId = 1;
  frameCallbacks = new Map();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    const frameId = nextFrameId++;
    frameCallbacks.set(frameId, callback);
    return frameId;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((frameId) => {
    frameCallbacks.delete(frameId);
  });

  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...createInitialDirectorState(),
    undoStack: [],
    redoStack: [],
    undoBatchDepth: 0,
    undoBatchSnapshot: null,
    undoBatchHasTrackedChanges: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("commits only the latest transform sample once per animation frame", () => {
  const commits: DirectorTransform[] = [];
  const { result } = renderHook(() =>
    useRafCoalescedTransformInteraction((transform: DirectorTransform) => {
      commits.push(transform);
      useDirectorStore.getState().updateObjectTransform("char_default_a", transform);
    }),
  );

  act(() => {
    result.current.onMouseDown();
    result.current.onObjectChange(createTransform(1));
    result.current.onObjectChange(createTransform(2));
    result.current.onObjectChange(createTransform(3));
  });

  expect(frameCallbacks).toHaveLength(1);
  expect(commits).toHaveLength(0);

  act(() => runNextAnimationFrame());

  expect(commits.map((transform) => transform.position[0])).toEqual([3]);
  expect(
    useDirectorStore.getState().project.objects.find((item) => item.id === "char_default_a")?.transform.position,
  ).toEqual([3, 0, 0]);

  act(() => result.current.onMouseUp());

  expect(useDirectorStore.getState().undoBatchDepth).toBe(0);
  expect(useDirectorStore.getState().undoStack).toHaveLength(1);
});

it("flushes the final pending transform before closing its undo batch", () => {
  const undoDepthsAtCommit: number[] = [];
  const { result } = renderHook(() =>
    useRafCoalescedTransformInteraction((transform: DirectorTransform) => {
      undoDepthsAtCommit.push(useDirectorStore.getState().undoBatchDepth);
      useDirectorStore.getState().updateObjectTransform("char_default_a", transform);
    }),
  );

  act(() => {
    result.current.onMouseDown();
    result.current.onObjectChange(createTransform(4));
    result.current.onObjectChange(createTransform(5));
    result.current.onMouseUp();
  });

  expect(undoDepthsAtCommit).toEqual([1]);
  expect(frameCallbacks).toHaveLength(0);
  expect(
    useDirectorStore.getState().project.objects.find((item) => item.id === "char_default_a")?.transform.position,
  ).toEqual([5, 0, 0]);
  expect(useDirectorStore.getState().undoBatchDepth).toBe(0);
  expect(useDirectorStore.getState().undoStack).toHaveLength(1);

  act(() => useDirectorStore.getState().undo());

  expect(
    useDirectorStore.getState().project.objects.find((item) => item.id === "char_default_a")?.transform.position,
  ).toEqual([0, 0, 0]);
});
