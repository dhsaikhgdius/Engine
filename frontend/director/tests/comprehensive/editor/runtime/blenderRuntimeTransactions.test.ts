import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BLENDER_LIVE_CONTRACT,
  type BlenderLiveSceneSnapshot,
  type BlenderNativeApplyResult,
} from "../../../../../../packages/protocol/src/blenderLiveProtocol";
import {
  applyBlenderRuntimeOperations,
  projectBlenderRuntimeTransaction,
} from "../../../../src/comprehensive/editor/runtime/blenderRuntimeTransactions";
import { useBlenderRuntimeStore } from "../../../../src/comprehensive/editor/runtime/blenderRuntimeStore";

const applyBlenderNativeOperationsMock = vi.hoisted(() => vi.fn());

vi.mock("../../../../src/comprehensive/editor/api/blenderLiveClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/comprehensive/editor/api/blenderLiveClient")>()),
  applyBlenderNativeOperations: applyBlenderNativeOperationsMock,
}));

const sceneEpoch = "48b0d9b3-2bf8-46a7-8832-909d816369e2";
const object = {
  id: "cube-a",
  name: "Cube",
  type: "MESH",
  kind: "object",
  position: [0, 0, 0] as [number, number, number],
  rotation: [0, 0, 0] as [number, number, number],
  scale: [1, 1, 1] as [number, number, number],
  localTransform: {
    position: [0, 0, 0] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
    scale: [1, 1, 1] as [number, number, number],
  },
  dimensions: [1, 1, 1] as [number, number, number],
  visible: true,
  collections: ["Scene Collection"],
  parentId: null,
  modifierCount: 0,
  constraints: [],
};

const snapshot: BlenderLiveSceneSnapshot = {
  contract: BLENDER_LIVE_CONTRACT,
  projectId: "director-project-a",
  sceneEpoch,
  revision: 4,
  contentRevision: 4,
  sceneName: "Scene",
  frame: 1,
  unit: "meter",
  coordinateSystem: "right-handed-y-up-negative-z-forward",
  objects: [object],
  cameras: [],
  lights: [],
  selectedObjectIds: [object.id],
  activeObjectId: object.id,
};

function result(
  options: {
    revisionAfter?: number;
    changedObject?: typeof object;
    deletedObjectIds?: string[];
  } = {},
): BlenderNativeApplyResult {
  const revisionAfter = options.revisionAfter ?? 5;
  const requestId = "63a521f0-7fe3-4fd7-8e06-8457e806c6b3";
  return {
    sceneEpoch,
    job: {
      contract: BLENDER_LIVE_CONTRACT,
      jobId: "f77b2668-c080-4773-bf54-7b7d536ec2d4",
      requestId,
      status: "succeeded",
      revision: revisionAfter,
      error: null,
    },
    receipt: {
      contract: BLENDER_LIVE_CONTRACT,
      sceneEpoch,
      requestId,
      revisionBefore: 4,
      revisionAfter,
      createdObjectIds: [],
      changedObjectIds: options.changedObject ? [options.changedObject.id] : [],
      deletedObjectIds: options.deletedObjectIds ?? [],
      dirtyObjectIds: options.changedObject ? [options.changedObject.id] : [],
      selection: { mode: "OBJECT", activeObjectId: object.id, selectedObjectIds: [object.id] },
      metrics: {
        before: { entities: 1, objects: 1, cameras: 0, lights: 0 },
        after: { entities: 1, objects: 1, cameras: 0, lights: 0 },
      },
      operations: [],
      warnings: [],
    },
    evidence: {
      sceneEpoch,
      revision: revisionAfter,
      objects: options.changedObject ? [options.changedObject] : [],
      cameras: [],
      lights: [],
    },
  };
}

describe("Blender runtime transactions", () => {
  beforeEach(() => {
    applyBlenderNativeOperationsMock.mockReset();
    useBlenderRuntimeStore.getState().reset();
  });

  it("projects transform evidence without invalidating the content revision", () => {
    const changedObject = {
      ...object,
      position: [3, 0, 2] as [number, number, number],
      localTransform: { ...object.localTransform, position: [3, 0, 2] as [number, number, number] },
    };
    const projected = projectBlenderRuntimeTransaction(snapshot, result({ changedObject }), [
      { op: "update_transform", id: object.id, transform: { position: changedObject.position } },
    ]);

    expect(projected).toMatchObject({ revision: 5, contentRevision: 4 });
    expect(projected?.objects[0]?.position).toEqual([3, 0, 2]);
  });

  it("projects frame, deletion, and visible-content revision changes", () => {
    const projected = projectBlenderRuntimeTransaction(snapshot, result({ deletedObjectIds: [object.id] }), [
      { op: "set_scene_frame", frame: 24 },
      { op: "delete_object", id: object.id },
    ]);

    expect(projected).toMatchObject({ revision: 5, contentRevision: 5, frame: 24, objects: [] });
  });

  it("does not project a receipt over a different observed revision", () => {
    expect(projectBlenderRuntimeTransaction({ ...snapshot, revision: 5 }, result(), [])).toBeNull();
  });

  it("announces the transaction before publishing its projected snapshot", async () => {
    applyBlenderNativeOperationsMock.mockResolvedValue(result());
    useBlenderRuntimeStore.getState().publishSnapshot(snapshot);
    let revisionVisibleBeforePublish: number | null = null;

    const committed = await applyBlenderRuntimeOperations({
      expectedSceneEpoch: sceneEpoch,
      expectedRevision: 4,
      operations: [{ op: "delete_object", id: object.id }],
      beforePublish: () => {
        revisionVisibleBeforePublish = useBlenderRuntimeStore.getState().snapshot?.revision ?? null;
      },
    });

    expect(revisionVisibleBeforePublish).toBe(4);
    expect(committed.projectedSnapshot?.revision).toBe(5);
    expect(useBlenderRuntimeStore.getState().snapshot?.revision).toBe(5);
  });
});
