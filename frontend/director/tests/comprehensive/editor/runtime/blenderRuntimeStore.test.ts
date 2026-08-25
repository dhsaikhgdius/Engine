import { beforeEach, expect, it, vi } from "vitest";
import { BLENDER_LIVE_CONTRACT } from "../../../../../../packages/protocol/src/blenderLiveProtocol";
import { useBlenderRuntimeStore } from "../../../../src/comprehensive/editor/runtime/blenderRuntimeStore";

const snapshot = {
  contract: BLENDER_LIVE_CONTRACT,
  projectId: "director-project-a",
  sceneEpoch: "48b0d9b3-2bf8-46a7-8832-909d816369e2",
  revision: 4,
  sceneName: "Scene",
  frame: 1,
  unit: "meter" as const,
  coordinateSystem: "right-handed-y-up-negative-z-forward" as const,
  objects: [],
  cameras: [],
  lights: [],
  selectedObjectIds: [],
  activeObjectId: null,
};

beforeEach(() => useBlenderRuntimeStore.getState().reset());

it("publishes one coherent native snapshot and ignores an unchanged poll", () => {
  const listener = vi.fn();
  const unsubscribe = useBlenderRuntimeStore.subscribe(listener);

  useBlenderRuntimeStore.getState().publishSnapshot(snapshot);
  useBlenderRuntimeStore.getState().publishSnapshot(structuredClone(snapshot));

  expect(listener).toHaveBeenCalledTimes(1);
  expect(useBlenderRuntimeStore.getState().snapshot).toEqual(snapshot);
  unsubscribe();
});

it("publishes same-revision frame and selection changes", () => {
  useBlenderRuntimeStore.getState().publishSnapshot(snapshot);
  useBlenderRuntimeStore.getState().publishSnapshot({
    ...snapshot,
    frame: 24,
    activeObjectId: "rig-a",
    selectedObjectIds: ["rig-a"],
  });

  expect(useBlenderRuntimeStore.getState().snapshot).toMatchObject({
    revision: 4,
    frame: 24,
    activeObjectId: "rig-a",
    selectedObjectIds: ["rig-a"],
  });
});

it("does not let a slower poll replace newer scene evidence", () => {
  useBlenderRuntimeStore.getState().publishSnapshot({ ...snapshot, revision: 5 });
  useBlenderRuntimeStore.getState().publishSnapshot(snapshot);
  useBlenderRuntimeStore.getState().publishStatus({
    available: true,
    ok: true,
    contract: BLENDER_LIVE_CONTRACT,
    projectId: snapshot.projectId,
    sceneEpoch: snapshot.sceneEpoch,
    blenderVersion: "5.1.2",
    revision: 5,
    busy: false,
  });
  useBlenderRuntimeStore.getState().publishStatus({
    available: true,
    ok: true,
    contract: BLENDER_LIVE_CONTRACT,
    projectId: snapshot.projectId,
    sceneEpoch: snapshot.sceneEpoch,
    blenderVersion: "5.1.2",
    revision: 4,
    busy: false,
  });

  expect(useBlenderRuntimeStore.getState().snapshot?.revision).toBe(5);
  expect(useBlenderRuntimeStore.getState().status?.available).toBe(true);
  expect(useBlenderRuntimeStore.getState().status).toMatchObject({
    revision: 5,
  });
});

it("publishes native rig capability evidence by root object", () => {
  useBlenderRuntimeStore.getState().publishNativeRigCapability({
    rootObjectId: "character-root",
    status: "ready",
    compatible: true,
    missingBoneRoles: [],
    mappedBoneCount: 15,
    sceneEpoch: snapshot.sceneEpoch,
    revision: snapshot.revision,
  });

  expect(useBlenderRuntimeStore.getState().nativeRigCapabilities["character-root"]).toMatchObject({
    status: "ready",
    compatible: true,
    mappedBoneCount: 15,
  });
});

it("coordinates explicit refresh requests without letting an older completion finish a newer request", () => {
  const firstRequest = useBlenderRuntimeStore.getState().requestRefresh();
  const secondRequest = useBlenderRuntimeStore.getState().requestRefresh();

  expect(firstRequest).toBe(1);
  expect(secondRequest).toBe(2);
  expect(useBlenderRuntimeStore.getState()).toMatchObject({
    refreshRequestId: 2,
    refreshCompletedId: 0,
  });

  useBlenderRuntimeStore.getState().completeRefresh(firstRequest);
  useBlenderRuntimeStore.getState().completeRefresh(firstRequest - 1);
  expect(useBlenderRuntimeStore.getState().refreshCompletedId).toBe(1);

  useBlenderRuntimeStore.getState().completeRefresh(secondRequest);
  expect(useBlenderRuntimeStore.getState().refreshCompletedId).toBe(2);
});
