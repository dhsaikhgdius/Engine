import { beforeEach, expect, it, vi } from "vitest";
import { createInitialDirectorState, useDirectorStore } from "../../../../src/comprehensive/editor/store/directorStore";
import { useTimelineRuntimeStore } from "../../../../src/comprehensive/editor/runtime/timelineRuntimeStore";
import {
  applyDirectorPageEvent,
  setDirectorPagePlaybackHandler,
  setDirectorPageViewportHandler,
} from "../../../../src/comprehensive/editor/assistant/pageStateBridge";

beforeEach(() => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...createInitialDirectorState(),
  });
  useTimelineRuntimeStore.getState().reset();
});

it("applies scene-tab scoped transient selection, panel, view, frame, and playback", () => {
  const playback = vi.fn();
  const clear = setDirectorPagePlaybackHandler(playback);
  const objectId = useDirectorStore.getState().project.objects[0]!.id;

  applyDirectorPageEvent({
    sequence: 4,
    sceneId: "shot-a",
    revision: 7,
    tabId: "tab-12345678",
    createdAt: "2026-07-18T12:00:00.000Z",
    state: {
      selectedObjectIds: [objectId, "missing-object", objectId],
      activePanel: "timeline",
      viewMode: "camera",
      currentFrame: 48,
      playing: true,
    },
  });

  expect(useDirectorStore.getState().selectedObjectIds).toEqual([objectId]);
  expect(useDirectorStore.getState().viewMode).toBe("director");
  expect(useTimelineRuntimeStore.getState().selectedTrackKey).toBe(`object:${objectId}`);
  expect(playback).toHaveBeenCalledWith({ currentFrame: 48, playing: true });
  clear();
});

it("does not turn an unknown selection into a valid object", () => {
  applyDirectorPageEvent({
    sequence: 1,
    sceneId: "shot-b",
    revision: 2,
    tabId: "tab-abcdefgh",
    createdAt: "2026-07-18T12:00:00.000Z",
    state: { selectedObjectIds: ["does-not-exist"], activePanel: "scene" },
  });

  expect(useDirectorStore.getState().selectedObjectId).toBeNull();
  expect(useDirectorStore.getState().directorInspectorMode).toBe("scene");
  expect(useTimelineRuntimeStore.getState().selectedTrackKey).toBeNull();
});

it("forwards an agent-authored viewport camera without persisting it in the scene", () => {
  const viewport = vi.fn();
  const clear = setDirectorPageViewportHandler(viewport);
  const snapshot = {
    fov: 42,
    position: [1, 2, 3] as [number, number, number],
    target: [0, 1, 0] as [number, number, number],
  };

  applyDirectorPageEvent({
    sequence: 2,
    sceneId: "shot-c",
    revision: 3,
    tabId: "tab-viewport",
    createdAt: "2026-07-29T12:00:00.000Z",
    state: { viewportCamera: snapshot },
  });

  expect(viewport).toHaveBeenCalledWith(snapshot);
  clear();
});
