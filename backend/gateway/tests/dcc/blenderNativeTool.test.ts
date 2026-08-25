import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  BLENDER_LIVE_CONTRACT,
  type BlenderAgentOperation,
  type BlenderLiveSceneSnapshot,
} from "../../../../packages/protocol/src/blenderLiveProtocol";
import {
  bindBlenderNativeSessionProject,
  deriveBlenderIntentId,
  executeBlenderNativeTool,
  exportBlenderScenePreview,
} from "../../dcc/blenderNativeTool";
import { BlenderNativeSessionError, type BlenderNativeSession } from "../../dcc/blenderNativeSession";

const intentId = "b4b2ed3d-b25b-4ad0-8db9-f04bcb229fb6";
const sceneEpoch = "82a6f8c1-7cb8-4d6f-a5f2-a4f5654a0420";
const nextSceneEpoch = "907d1be9-c19d-4297-8faf-c6f4bcbd8250";

function scene(revision: number, objects: BlenderLiveSceneSnapshot["objects"] = []): BlenderLiveSceneSnapshot {
  return {
    contract: BLENDER_LIVE_CONTRACT,
    sceneEpoch,
    revision,
    sceneName: "Scene",
    frame: 1,
    unit: "meter",
    coordinateSystem: "right-handed-y-up-negative-z-forward",
    objects,
    cameras: [],
    lights: [],
    selectedObjectIds: objects.map((object) => object.id),
    activeObjectId: objects.at(-1)?.id ?? null,
  };
}

function cube(id: string): BlenderLiveSceneSnapshot["objects"][number] {
  return {
    id,
    name: "Cube",
    type: "MESH",
    kind: "object",
    position: [0, 0.5, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    localTransform: {
      position: [0, 0.5, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
    dimensions: [1, 1, 1],
    visible: true,
    collections: ["Collection"],
    parentId: null,
    modifierCount: 0,
    constraints: [],
  };
}

function armature(id: string): BlenderLiveSceneSnapshot["objects"][number] {
  return { ...cube(id), name: "Rig", type: "ARMATURE" };
}

describe("deriveBlenderIntentId", () => {
  const operations: BlenderAgentOperation[] = [{ op: "create_primitive", id: "cube-a", primitive: "cube" }];

  it("derives the same protocol-valid UUID for the same observed intent", () => {
    const first = deriveBlenderIntentId(sceneEpoch, 4, operations);
    const second = deriveBlenderIntentId(sceneEpoch, 4, [{ op: "create_primitive", id: "cube-a", primitive: "cube" }]);

    expect(second).toBe(first);
    expect(z.string().uuid().parse(first)).toBe(first);
  });

  it("derives a different intent id when the revision or operations change", () => {
    const base = deriveBlenderIntentId(sceneEpoch, 4, operations);

    expect(deriveBlenderIntentId(sceneEpoch, 5, operations)).not.toBe(base);
    expect(deriveBlenderIntentId(sceneEpoch, 4, [{ op: "delete_object", id: "cube-a" }])).not.toBe(base);
  });
});

describe("executeBlenderNativeTool", () => {
  it("binds the native kernel to the current Director project before scene work", async () => {
    const projectId = "director-reference-project";
    const boundScene = { ...scene(0), projectId };
    const session: BlenderNativeSession = {
      status: vi.fn().mockResolvedValue({
        available: true,
        ok: true,
        contract: BLENDER_LIVE_CONTRACT,
        projectId: "previous-project",
        sceneEpoch,
        blenderVersion: "5.1.2",
        revision: 0,
        busy: false,
      }),
      previewGlb: vi.fn(),
      snapshot: vi.fn().mockResolvedValue(boundScene),
      submit: vi.fn().mockResolvedValue({
        contract: BLENDER_LIVE_CONTRACT,
        jobId: intentId,
        requestId: intentId,
        status: "queued",
      }),
      job: vi.fn().mockResolvedValue({
        contract: BLENDER_LIVE_CONTRACT,
        jobId: intentId,
        requestId: intentId,
        status: "succeeded",
        revision: 0,
        result: null,
        error: null,
      }),
    };

    await expect(bindBlenderNativeSessionProject(session, projectId)).resolves.toEqual(boundScene);
    expect(session.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        operations: [{ op: "bind_director_project", projectId }],
      }),
    );
    expect(session.job).toHaveBeenCalledWith(intentId, { consume: true });
  });

  it("describes typed apply ops locally without submitting to Blender", async () => {
    const session: BlenderNativeSession = {
      status: vi.fn(),
      previewGlb: vi.fn(),
      snapshot: vi.fn(),
      submit: vi.fn(),
      job: vi.fn(),
    };

    const result = await executeBlenderNativeTool(session, {
      op: "describe",
      target: "create_primitive",
    });

    expect(session.submit).not.toHaveBeenCalled();
    expect(session.snapshot).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      described: { target: "apply.create_primitive", kind: "apply_operation" },
    });
  });
  it("observes and binds an unguarded apply intent before native execution", async () => {
    const before = scene(4);
    const after = scene(5, [cube("cube-a")]);
    const session: BlenderNativeSession = {
      status: vi.fn(),
      previewGlb: vi.fn(),
      snapshot: vi.fn().mockResolvedValue(before),
      submit: vi.fn(async (batch) => ({
        contract: BLENDER_LIVE_CONTRACT,
        jobId: batch.requestId,
        requestId: batch.requestId,
        status: "queued" as const,
      })),
      job: vi.fn(async (jobId) => ({
        contract: BLENDER_LIVE_CONTRACT,
        jobId,
        requestId: jobId,
        status: "succeeded" as const,
        revision: 5,
        result: {
          revisionBefore: 4,
          revisionAfter: 5,
          operations: [{ object_id: "cube-a" }],
          snapshotBefore: before,
          snapshotAfter: after,
        },
        error: null,
      })),
    };

    const result = await executeBlenderNativeTool(session, {
      op: "apply",
      operations: [{ op: "create_primitive", id: "cube-a", primitive: "cube" }],
    });

    expect(session.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedSceneEpoch: sceneEpoch,
        expectedRevision: 4,
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      }),
    );
    expect(session.snapshot).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ receipt: { revisionBefore: 4, revisionAfter: 5 } });
  });

  it("replays an exact unguarded apply retry through the derived intent id without resubmitting", async () => {
    const before = scene(4);
    const after = scene(5, [cube("cube-a")]);
    const session: BlenderNativeSession = {
      status: vi.fn(),
      previewGlb: vi.fn(),
      snapshot: vi.fn().mockResolvedValue(before),
      submit: vi.fn(async (batch) => ({
        contract: BLENDER_LIVE_CONTRACT,
        jobId: batch.requestId,
        requestId: batch.requestId,
        status: "queued" as const,
      })),
      job: vi.fn(async (jobId) => ({
        contract: BLENDER_LIVE_CONTRACT,
        jobId,
        requestId: jobId,
        status: "succeeded" as const,
        revision: 5,
        result: {
          revisionBefore: 4,
          revisionAfter: 5,
          operations: [{ object_id: "cube-a" }],
          snapshotBefore: before,
          snapshotAfter: after,
        },
        error: null,
      })),
    };
    const input = {
      op: "apply" as const,
      operations: [{ op: "create_primitive" as const, id: "cube-a", primitive: "cube" as const }],
    };

    const first = await executeBlenderNativeTool(session, input);
    const repeated = await executeBlenderNativeTool(session, input);

    if (!("receipt" in first) || !("receipt" in repeated)) {
      throw new Error("Expected apply effect receipts");
    }
    expect(session.submit).toHaveBeenCalledTimes(1);
    expect(session.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: deriveBlenderIntentId(sceneEpoch, 4, input.operations),
      }),
    );
    expect(session.job).toHaveBeenCalledTimes(1);
    expect(repeated).toMatchObject({ receipt: first.receipt, evidence: first.evidence });
  });

  it("keeps a model-provided intent id when completing the remaining apply guards", async () => {
    const before = scene(4);
    const after = scene(5, [cube("cube-a")]);
    const session: BlenderNativeSession = {
      status: vi.fn(),
      previewGlb: vi.fn(),
      snapshot: vi.fn().mockResolvedValue(before),
      submit: vi.fn(async (batch) => ({
        contract: BLENDER_LIVE_CONTRACT,
        jobId: batch.requestId,
        requestId: batch.requestId,
        status: "queued" as const,
      })),
      job: vi.fn(async (jobId) => ({
        contract: BLENDER_LIVE_CONTRACT,
        jobId,
        requestId: jobId,
        status: "succeeded" as const,
        revision: 5,
        result: {
          revisionBefore: 4,
          revisionAfter: 5,
          operations: [{ object_id: "cube-a" }],
          snapshotBefore: before,
          snapshotAfter: after,
        },
        error: null,
      })),
    };

    const result = await executeBlenderNativeTool(session, {
      op: "apply",
      intentId,
      operations: [{ op: "create_primitive", id: "cube-a", primitive: "cube" }],
    });

    expect(session.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: intentId,
        expectedSceneEpoch: sceneEpoch,
        expectedRevision: 4,
      }),
    );
    if (!("receipt" in result)) throw new Error("Expected apply effect receipt");
    expect(result.receipt.requestId).toBe(intentId);
  });

  it("returns the generated native retry ticket when an apply outcome is unknown", async () => {
    const before = scene(4);
    const session: BlenderNativeSession = {
      status: vi.fn(),
      previewGlb: vi.fn(),
      snapshot: vi.fn().mockResolvedValue(before),
      submit: vi
        .fn()
        .mockRejectedValue(new BlenderNativeSessionError("Native submit timed out.", 504, "blender_timeout")),
      job: vi.fn(),
    };
    const operations: BlenderAgentOperation[] = [{ op: "create_primitive", id: "cube-a", primitive: "cube" }];
    const derivedIntentId = deriveBlenderIntentId(sceneEpoch, 4, operations);

    await expect(executeBlenderNativeTool(session, { op: "apply", operations })).rejects.toMatchObject({
      status: 409,
      code: "outcome_unknown",
      result: {
        operation: "blender_native.apply",
        outcome: "unknown",
        retry_requires_observe: false,
        retry_ticket: {
          input: {
            op: "apply",
            expectedSceneEpoch: sceneEpoch,
            expectedRevision: 4,
            intentId: derivedIntentId,
            operations: [{ op: "create_primitive", id: "cube-a", primitive: "cube" }],
          },
        },
      },
    });
    expect(session.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedSceneEpoch: sceneEpoch,
        expectedRevision: 4,
        requestId: derivedIntentId,
      }),
    );
  });

  it("returns a typed effect receipt and focused evidence without returning the full scene", async () => {
    const before = scene(4);
    const after = scene(5, [cube("cube-a")]);
    const session: BlenderNativeSession = {
      status: vi.fn(),
      previewGlb: vi.fn(),
      snapshot: vi.fn().mockResolvedValue(before),
      submit: vi.fn().mockResolvedValue({
        contract: BLENDER_LIVE_CONTRACT,
        jobId: intentId,
        requestId: intentId,
        status: "queued",
      }),
      job: vi.fn().mockResolvedValue({
        contract: BLENDER_LIVE_CONTRACT,
        jobId: intentId,
        requestId: intentId,
        status: "succeeded",
        revision: 5,
        result: {
          revisionBefore: 4,
          revisionAfter: 5,
          operations: [{ object_id: "cube-a", name: "Cube", kind: "object" }],
          snapshotBefore: before,
          snapshotAfter: after,
        },
        error: null,
      }),
    };

    const result = await executeBlenderNativeTool(session, {
      op: "apply",
      expectedSceneEpoch: sceneEpoch,
      expectedRevision: 4,
      intentId,
      operations: [{ op: "create_primitive", id: "cube-a", primitive: "cube" }],
    });

    expect(session.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: intentId,
        expectedSceneEpoch: sceneEpoch,
        expectedRevision: 4,
      }),
    );
    expect(result).toMatchObject({
      sceneEpoch,
      receipt: {
        sceneEpoch,
        requestId: intentId,
        revisionBefore: 4,
        revisionAfter: 5,
        createdObjectIds: ["cube-a"],
        dirtyObjectIds: ["cube-a"],
        selection: {
          mode: "OBJECT",
          activeObjectId: "cube-a",
          selectedObjectIds: ["cube-a"],
        },
        metrics: { before: { entities: 0 }, after: { entities: 1 } },
        operations: [
          {
            op: "create_primitive",
            createdObjectIds: ["cube-a"],
            dirtyObjectIds: ["cube-a"],
          },
        ],
      },
      evidence: {
        sceneEpoch,
        revision: 5,
        objects: [{ id: "cube-a" }],
        cameras: [],
        lights: [],
      },
    });
    expect(result).not.toHaveProperty("scene");
    if (!("job" in result) || !result.job) throw new Error("Expected apply job");
    expect(result.job.result).not.toHaveProperty("snapshotBefore");
    expect(result.job.result).not.toHaveProperty("snapshotAfter");
    expect(session.snapshot).toHaveBeenCalledTimes(1);
  });

  it("reuses a cached receipt for a repeated intent without submitting the edit twice", async () => {
    const before = scene(4);
    const after = scene(5, [cube("cube-a")]);
    const session: BlenderNativeSession = {
      status: vi.fn(),
      previewGlb: vi.fn(),
      snapshot: vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after),
      submit: vi.fn().mockResolvedValue({
        contract: BLENDER_LIVE_CONTRACT,
        jobId: intentId,
        requestId: intentId,
        status: "queued",
      }),
      job: vi.fn().mockResolvedValue({
        contract: BLENDER_LIVE_CONTRACT,
        jobId: intentId,
        requestId: intentId,
        status: "succeeded",
        revision: 5,
        result: {
          revisionBefore: 4,
          revisionAfter: 5,
          operations: [{ object_id: "cube-a" }],
        },
        error: null,
      }),
    };
    const input = {
      op: "apply" as const,
      expectedSceneEpoch: sceneEpoch,
      expectedRevision: 4,
      intentId,
      operations: [
        {
          op: "create_primitive" as const,
          id: "cube-a",
          primitive: "cube" as const,
        },
      ],
    };

    const first = await executeBlenderNativeTool(session, input);
    const repeated = await executeBlenderNativeTool(session, input);

    if (!("receipt" in first) || !("receipt" in repeated)) {
      throw new Error("Expected apply effect receipts");
    }

    expect(session.submit).toHaveBeenCalledTimes(1);
    expect(session.snapshot).toHaveBeenCalledTimes(2);
    expect(session.job).toHaveBeenCalledTimes(1);
    expect(repeated).toMatchObject({
      receipt: first.receipt,
      evidence: first.evidence,
    });
  });

  it("binds an intent id to one scene epoch, revision and operation batch", async () => {
    const before = scene(4);
    const after = scene(5, [cube("cube-a")]);
    const session: BlenderNativeSession = {
      status: vi.fn(),
      previewGlb: vi.fn(),
      snapshot: vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after),
      submit: vi.fn().mockResolvedValue({
        contract: BLENDER_LIVE_CONTRACT,
        jobId: intentId,
        requestId: intentId,
        status: "queued",
      }),
      job: vi.fn().mockResolvedValue({
        contract: BLENDER_LIVE_CONTRACT,
        jobId: intentId,
        requestId: intentId,
        status: "succeeded",
        revision: 5,
        result: {
          revisionBefore: 4,
          revisionAfter: 5,
          operations: [{ object_id: "cube-a" }],
        },
        error: null,
      }),
    };
    await executeBlenderNativeTool(session, {
      op: "apply",
      expectedSceneEpoch: sceneEpoch,
      expectedRevision: 4,
      intentId,
      operations: [{ op: "create_primitive", id: "cube-a", primitive: "cube" }],
    });

    await expect(
      executeBlenderNativeTool(session, {
        op: "apply",
        expectedSceneEpoch: sceneEpoch,
        expectedRevision: 5,
        intentId,
        operations: [{ op: "delete_object", id: "cube-a" }],
      }),
    ).rejects.toMatchObject({ code: "intent_conflict", status: 409 });
    await expect(
      executeBlenderNativeTool(session, {
        op: "apply",
        expectedSceneEpoch: nextSceneEpoch,
        expectedRevision: 4,
        intentId,
        operations: [{ op: "create_primitive", id: "cube-a", primitive: "cube" }],
      }),
    ).rejects.toMatchObject({ code: "intent_conflict", status: 409 });
    expect(session.submit).toHaveBeenCalledTimes(1);
    expect(session.job).toHaveBeenCalledTimes(1);
  });

  it("attributes native material and UV edits to their mesh object", async () => {
    const current = scene(6, [cube("cube-a")]);
    const materialIntentId = "19012980-b19a-42dc-bfab-f3f7ac1647c0";
    const session: BlenderNativeSession = {
      status: vi.fn(),
      previewGlb: vi.fn(),
      snapshot: vi.fn().mockResolvedValue(current),
      submit: vi.fn().mockResolvedValue({
        contract: BLENDER_LIVE_CONTRACT,
        jobId: materialIntentId,
        requestId: materialIntentId,
        status: "queued",
      }),
      job: vi.fn().mockResolvedValue({
        contract: BLENDER_LIVE_CONTRACT,
        jobId: materialIntentId,
        requestId: materialIntentId,
        status: "succeeded",
        revision: 7,
        result: {
          revisionBefore: 6,
          revisionAfter: 7,
          operations: [
            {
              objectId: "cube-a",
              material: { name: "Warehouse clay", created: true, slotIndex: 0 },
              mode: "OBJECT",
              activeObjectId: "cube-a",
              selectedObjectIds: ["cube-a"],
            },
            {
              objectId: "cube-a",
              method: "SMART",
              uvLayer: {
                name: "UVMap",
                active: true,
                activeRender: true,
                loopCount: 24,
              },
              mode: "OBJECT",
              activeObjectId: "cube-a",
              selectedObjectIds: ["cube-a"],
            },
          ],
          snapshotBefore: current,
          snapshotAfter: { ...current, revision: 7 },
        },
        error: null,
      }),
    };

    const result = await executeBlenderNativeTool(session, {
      op: "apply",
      expectedSceneEpoch: sceneEpoch,
      expectedRevision: 6,
      intentId: materialIntentId,
      operations: [
        {
          op: "assign_material",
          id: "cube-a",
          materialName: "Warehouse clay",
          createIfMissing: true,
          faceScope: "PRESERVE",
          parameters: {
            baseColor: [0.4, 0.42, 0.45],
            roughness: 0.8,
            metallic: 0,
            alpha: 1,
          },
        },
        {
          op: "project_uv",
          id: "cube-a",
          method: "SMART",
          uvLayerName: "UVMap",
          replaceExisting: false,
        },
      ],
    });

    if (!("receipt" in result) || !("evidence" in result) || !result.evidence) {
      throw new Error("Expected native material receipt with focused evidence");
    }
    expect(result.receipt).toMatchObject({
      revisionBefore: 6,
      revisionAfter: 7,
      changedObjectIds: ["cube-a"],
      dirtyObjectIds: ["cube-a"],
      operations: [
        {
          op: "assign_material",
          changedObjectIds: ["cube-a"],
          dirtyObjectIds: ["cube-a"],
        },
        {
          op: "project_uv",
          changedObjectIds: ["cube-a"],
          dirtyObjectIds: ["cube-a"],
        },
      ],
    });
    expect(result.evidence.objects).toEqual([expect.objectContaining({ id: "cube-a" })]);
  });

  it("does not treat a skipped missing material as a mesh edit", async () => {
    const current = scene(6, [cube("cube-a")]);
    const skippedIntentId = "3f0c1a7e-2b64-4d91-9c1a-8e5d6b7a4c21";
    const session: BlenderNativeSession = {
      status: vi.fn(),
      previewGlb: vi.fn(),
      snapshot: vi.fn().mockResolvedValue(current),
      submit: vi.fn().mockResolvedValue({
        contract: BLENDER_LIVE_CONTRACT,
        jobId: skippedIntentId,
        requestId: skippedIntentId,
        status: "queued",
      }),
      job: vi.fn().mockResolvedValue({
        contract: BLENDER_LIVE_CONTRACT,
        jobId: skippedIntentId,
        requestId: skippedIntentId,
        status: "succeeded",
        revision: 6,
        result: {
          revisionBefore: 6,
          revisionAfter: 7,
          operations: [
            {
              objectId: "cube-a",
              skipped: true,
              reason: "unknown_material",
              requestedMaterial: "gold_plaque",
              warning:
                "Unknown Blender material: gold_plaque. This object was skipped; other operations in the batch still applied.",
            },
          ],
        },
        error: null,
      }),
    };

    const result = await executeBlenderNativeTool(session, {
      op: "apply",
      expectedSceneEpoch: sceneEpoch,
      expectedRevision: 6,
      intentId: skippedIntentId,
      operations: [
        {
          op: "assign_material",
          id: "cube-a",
          materialName: "gold_plaque",
          createIfMissing: false,
          faceScope: "ALL",
          parameters: {},
        },
      ],
    });

    if (!("receipt" in result)) {
      throw new Error("Expected native material skip receipt");
    }
    expect(result.receipt).toMatchObject({
      changedObjectIds: [],
      dirtyObjectIds: [],
      warnings: [
        "Unknown Blender material: gold_plaque. This object was skipped; other operations in the batch still applied.",
      ],
      operations: [
        {
          op: "assign_material",
          changedObjectIds: [],
          dirtyObjectIds: [],
          warnings: [
            "Unknown Blender material: gold_plaque. This object was skipped; other operations in the batch still applied.",
          ],
        },
      ],
    });
  });

  it("attributes shared Material Nodes edits to every affected object", async () => {
    const current = scene(8, [cube("cube-a"), cube("cube-b")]);
    const nodeIntentId = "6a1f6da4-0e53-4ba6-9d92-c2e51aac37d2";
    const operations = [
      {
        op: "create_material_node" as const,
        id: "cube-a",
        materialName: "Shared clay",
        nodeRef: "mix-color",
        nodeType: "MIX_COLOR" as const,
      },
      {
        op: "set_material_node_input" as const,
        id: "cube-a",
        materialName: "Shared clay",
        nodeRef: "mix-color",
        inputSocketRef: "Color1",
        value: [0.2, 0.3, 0.4, 1] as [number, number, number, number],
      },
      {
        op: "connect_material_nodes" as const,
        id: "cube-a",
        materialName: "Shared clay",
        from: { nodeRef: "principled", socketRef: "BSDF" },
        to: { nodeRef: "material-output", socketRef: "Surface" },
      },
      {
        op: "disconnect_material_node_input" as const,
        id: "cube-a",
        materialName: "Shared clay",
        nodeRef: "material-output",
        inputSocketRef: "Surface",
      },
      {
        op: "delete_material_node" as const,
        id: "cube-a",
        materialName: "Shared clay",
        nodeRef: "mix-color",
      },
    ];
    const operationResults = operations.map((operation) => ({
      objectId: operation.id,
      materialName: operation.materialName,
      affectedObjectIds: ["cube-a", "cube-b"],
      dirtyObjectIds: ["cube-a", "cube-b"],
    }));
    const session: BlenderNativeSession = {
      status: vi.fn(),
      previewGlb: vi.fn(),
      snapshot: vi.fn().mockResolvedValue(current),
      submit: vi.fn().mockResolvedValue({
        contract: BLENDER_LIVE_CONTRACT,
        jobId: nodeIntentId,
        requestId: nodeIntentId,
        status: "queued",
      }),
      job: vi.fn().mockResolvedValue({
        contract: BLENDER_LIVE_CONTRACT,
        jobId: nodeIntentId,
        requestId: nodeIntentId,
        status: "succeeded",
        revision: 9,
        result: {
          revisionBefore: 8,
          revisionAfter: 9,
          operations: operationResults,
          snapshotBefore: current,
          snapshotAfter: { ...current, revision: 9 },
        },
        error: null,
      }),
    };

    const result = await executeBlenderNativeTool(session, {
      op: "apply",
      expectedSceneEpoch: sceneEpoch,
      expectedRevision: 8,
      intentId: nodeIntentId,
      operations,
    });

    if (!("receipt" in result) || !("evidence" in result) || !result.evidence) {
      throw new Error("Expected Material Nodes receipt with focused evidence");
    }
    expect(result.receipt).toMatchObject({
      revisionBefore: 8,
      revisionAfter: 9,
      changedObjectIds: ["cube-a", "cube-b"],
      dirtyObjectIds: ["cube-a", "cube-b"],
      operations: operations.map((operation) => ({
        op: operation.op,
        changedObjectIds: ["cube-a", "cube-b"],
        dirtyObjectIds: ["cube-a", "cube-b"],
      })),
    });
    expect(result.evidence.objects.map((object) => object.id)).toEqual(["cube-a", "cube-b"]);
  });

  it("uses native operator active, selected and touched ids as dirty evidence", async () => {
    const current = scene(7, [cube("cube-a")]);
    const operatorIntentId = "4bc95bed-34c4-47a8-bb4a-749193f1a24d";
    const session: BlenderNativeSession = {
      status: vi.fn(),
      previewGlb: vi.fn(),
      snapshot: vi.fn().mockResolvedValue(current),
      submit: vi.fn().mockResolvedValue({
        contract: BLENDER_LIVE_CONTRACT,
        jobId: operatorIntentId,
        requestId: operatorIntentId,
        status: "queued",
      }),
      job: vi.fn().mockResolvedValue({
        contract: BLENDER_LIVE_CONTRACT,
        jobId: operatorIntentId,
        requestId: operatorIntentId,
        status: "succeeded",
        revision: 8,
        result: {
          revisionBefore: 7,
          revisionAfter: 8,
          operations: [
            {
              operator: "mesh.subdivide",
              outcome: ["FINISHED"],
              mode: "EDIT",
              activeObjectId: "cube-a",
              selectedObjectIds: ["cube-a"],
              touchedObjectIds: ["cube-a"],
              createdObjectIds: [],
            },
          ],
          snapshotBefore: current,
          snapshotAfter: { ...current, revision: 8 },
        },
        error: null,
      }),
    };

    const result = await executeBlenderNativeTool(session, {
      op: "apply",
      expectedSceneEpoch: sceneEpoch,
      expectedRevision: 7,
      intentId: operatorIntentId,
      operations: [{ op: "invoke_operator", operator: "mesh.subdivide", properties: {} }],
    });

    if (!("receipt" in result) || !("evidence" in result) || !result.evidence) {
      throw new Error("Expected apply effect receipt with evidence");
    }
    expect(result.receipt).toMatchObject({
      changedObjectIds: ["cube-a"],
      dirtyObjectIds: ["cube-a"],
      selection: {
        mode: "EDIT",
        activeObjectId: "cube-a",
        selectedObjectIds: ["cube-a"],
      },
      operations: [{ mode: "EDIT", changedObjectIds: ["cube-a"], warnings: [] }],
    });
    expect(result.evidence.objects).toEqual([expect.objectContaining({ id: "cube-a" })]);
  });

  it("keeps mesh element selection out of content effects while preserving Edit Mode selection", async () => {
    const current = scene(9, [cube("cube-a")]);
    const selectionIntentId = "3217e583-6aec-43ff-9bec-77b951cfb40a";
    const session: BlenderNativeSession = {
      status: vi.fn(),
      previewGlb: vi.fn(),
      snapshot: vi.fn().mockResolvedValue(current),
      submit: vi.fn().mockResolvedValue({
        contract: BLENDER_LIVE_CONTRACT,
        jobId: selectionIntentId,
        requestId: selectionIntentId,
        status: "queued",
      }),
      job: vi.fn().mockResolvedValue({
        contract: BLENDER_LIVE_CONTRACT,
        jobId: selectionIntentId,
        requestId: selectionIntentId,
        status: "succeeded",
        revision: 9,
        result: {
          revisionBefore: 9,
          revisionAfter: 9,
          operations: [
            {
              mode: "OBJECT",
              activeObjectId: "cube-a",
              selectedObjectIds: ["cube-a"],
            },
            {
              objectId: "cube-a",
              domain: "EDGE",
              action: "ALL",
              indices: [],
              mode: "EDIT",
              activeObjectId: "cube-a",
              selectedObjectIds: ["cube-a"],
            },
          ],
        },
        error: null,
      }),
    };

    const result = await executeBlenderNativeTool(session, {
      op: "apply",
      expectedSceneEpoch: sceneEpoch,
      expectedRevision: 9,
      intentId: selectionIntentId,
      operations: [
        {
          op: "set_selection",
          activeId: "cube-a",
          selectedIds: ["cube-a"],
          mode: "OBJECT",
        },
        {
          op: "select_mesh_elements",
          id: "cube-a",
          domain: "EDGE",
          action: "ALL",
          indices: [],
        },
      ],
    });

    expect(result).toMatchObject({
      receipt: {
        revisionBefore: 9,
        revisionAfter: 9,
        createdObjectIds: [],
        changedObjectIds: [],
        deletedObjectIds: [],
        dirtyObjectIds: [],
        selection: {
          mode: "EDIT",
          activeObjectId: "cube-a",
          selectedObjectIds: ["cube-a"],
        },
        operations: [
          {
            op: "set_selection",
            createdObjectIds: [],
            changedObjectIds: [],
            deletedObjectIds: [],
            dirtyObjectIds: [],
            mode: "OBJECT",
          },
          {
            op: "select_mesh_elements",
            createdObjectIds: [],
            changedObjectIds: [],
            deletedObjectIds: [],
            dirtyObjectIds: [],
            mode: "EDIT",
          },
        ],
      },
      evidence: { revision: 9, objects: [], cameras: [], lights: [] },
    });
  });

  it("keeps read, pose selection and frame navigation out of dirty object evidence", async () => {
    const current = scene(12, [armature("rig-a")]);
    const navigated = { ...current, frame: 24 };
    const rigSelectionIntentId = "32fc1e18-a9ea-4bd7-b2d9-fbc1a3154eed";
    const session: BlenderNativeSession = {
      status: vi.fn(),
      previewGlb: vi.fn(),
      snapshot: vi.fn().mockResolvedValue(current),
      submit: vi.fn().mockResolvedValue({
        contract: BLENDER_LIVE_CONTRACT,
        jobId: rigSelectionIntentId,
        requestId: rigSelectionIntentId,
        status: "queued",
      }),
      job: vi.fn().mockResolvedValue({
        contract: BLENDER_LIVE_CONTRACT,
        jobId: rigSelectionIntentId,
        requestId: rigSelectionIntentId,
        status: "succeeded",
        revision: 12,
        result: {
          revisionBefore: 12,
          revisionAfter: 12,
          operations: [
            {
              id: "rig-a",
              mode: "OBJECT",
              activeObjectId: "rig-a",
              selectedObjectIds: ["rig-a"],
            },
            {
              affectedObjectIds: ["rig-a"],
              dirtyObjectIds: [],
              rigSelection: { activeBoneRef: "Head", selectedBoneRefs: ["Head"] },
              mode: "POSE",
              activeObjectId: "rig-a",
              selectedObjectIds: ["rig-a"],
            },
            {
              affectedObjectIds: [],
              dirtyObjectIds: [],
              frame: 24,
              mode: "POSE",
              activeObjectId: "rig-a",
              selectedObjectIds: ["rig-a"],
            },
          ],
          snapshotBefore: current,
          snapshotAfter: navigated,
        },
        error: null,
      }),
    };

    const result = await executeBlenderNativeTool(session, {
      op: "apply",
      expectedSceneEpoch: sceneEpoch,
      expectedRevision: 12,
      intentId: rigSelectionIntentId,
      operations: [
        { op: "inspect_object", id: "rig-a" },
        {
          op: "select_pose_bones",
          id: "rig-a",
          boneRefs: ["Head"],
          activeBoneRef: "Head",
          action: "SET",
        },
        { op: "set_scene_frame", frame: 24 },
      ],
    });

    expect(result).toMatchObject({
      receipt: {
        revisionBefore: 12,
        revisionAfter: 12,
        changedObjectIds: [],
        dirtyObjectIds: [],
        selection: { mode: "POSE", activeObjectId: "rig-a", selectedObjectIds: ["rig-a"] },
        operations: [
          {
            op: "inspect_object",
            changedObjectIds: [],
            dirtyObjectIds: [],
            mode: "OBJECT",
            activeObjectId: "rig-a",
            selectedObjectIds: ["rig-a"],
          },
          {
            op: "select_pose_bones",
            changedObjectIds: [],
            dirtyObjectIds: [],
            mode: "POSE",
            activeObjectId: "rig-a",
            selectedObjectIds: ["rig-a"],
          },
          {
            op: "set_scene_frame",
            changedObjectIds: [],
            dirtyObjectIds: [],
            mode: "POSE",
            activeObjectId: "rig-a",
            selectedObjectIds: ["rig-a"],
          },
        ],
      },
      evidence: { revision: 12, objects: [], cameras: [], lights: [] },
    });
  });

  it("attributes pose, action, Mixamo and NLA mutations to their armature", async () => {
    const current = scene(14, [armature("rig-a"), cube("prop-b")]);
    const next = { ...current, revision: 15, frame: 18 };
    const rigContentIntentId = "7b2f0224-1d91-43e8-8493-a637803cb496";
    const operations = [
      {
        op: "set_pose_bone_transform" as const,
        id: "rig-a",
        boneRef: "Head",
        local: { rotationQuaternion: [1, 0, 0, 0] as [number, number, number, number] },
      },
      {
        op: "apply_pose_offsets" as const,
        id: "rig-a",
        stateToken: "director-state-1",
        resetPose: false,
        bones: [
          {
            boneRef: "Head",
            rotationOffsetQuaternion: [1, 0, 0, 0] as [number, number, number, number],
          },
        ],
      },
      { op: "create_action" as const, id: "rig-a", actionName: "Look" },
      { op: "set_active_action" as const, id: "rig-a", actionName: "Look" },
      {
        op: "insert_pose_keyframes" as const,
        id: "rig-a",
        actionName: "Look",
        frame: 18,
        boneRefs: ["Head"],
        channels: ["ROTATION" as const],
        interpolation: "BEZIER" as const,
      },
      {
        op: "delete_pose_keyframes" as const,
        id: "rig-a",
        actionName: "Look",
        frame: 18,
        boneRefs: ["Head"],
        channels: ["ROTATION" as const],
      },
      {
        op: "import_mixamo_action" as const,
        id: "rig-a",
        motionId: "walk",
        actionName: "Walk",
        rootMotion: "IN_PLACE" as const,
        replaceExisting: false,
      },
      { op: "create_nla_track" as const, id: "rig-a", trackName: "Locomotion" },
      {
        op: "add_nla_strip" as const,
        id: "rig-a",
        trackName: "Locomotion",
        stripName: "Walk Base",
        actionName: "Walk",
        startFrame: 1,
        blendMode: "REPLACE" as const,
        influence: 1,
        repeat: 1,
        scale: 1,
      },
      {
        op: "update_nla_strip" as const,
        id: "rig-a",
        trackName: "Locomotion",
        stripName: "Walk Base",
        blendMode: "ADD" as const,
        influence: 0.5,
      },
      {
        op: "remove_nla_strip" as const,
        id: "rig-a",
        trackName: "Locomotion",
        stripName: "Walk Base",
      },
    ];
    const nativeResults = operations.map(() => ({
      affectedObjectIds: ["rig-a"],
      dirtyObjectIds: ["rig-a"],
      rigSelection: { activeBoneRef: "Head", selectedBoneRefs: ["Head"] },
      mode: "POSE",
      activeObjectId: "rig-a",
      selectedObjectIds: ["prop-b", "rig-a"],
    }));
    const session: BlenderNativeSession = {
      status: vi.fn(),
      previewGlb: vi.fn(),
      snapshot: vi.fn().mockResolvedValue(current),
      submit: vi.fn().mockResolvedValue({
        contract: BLENDER_LIVE_CONTRACT,
        jobId: rigContentIntentId,
        requestId: rigContentIntentId,
        status: "queued",
      }),
      job: vi.fn().mockResolvedValue({
        contract: BLENDER_LIVE_CONTRACT,
        jobId: rigContentIntentId,
        requestId: rigContentIntentId,
        status: "succeeded",
        revision: 15,
        result: {
          revisionBefore: 14,
          revisionAfter: 15,
          operations: nativeResults,
          snapshotBefore: current,
          snapshotAfter: next,
        },
        error: null,
      }),
    };

    const result = await executeBlenderNativeTool(session, {
      op: "apply",
      expectedSceneEpoch: sceneEpoch,
      expectedRevision: 14,
      intentId: rigContentIntentId,
      operations,
    });

    if (!("receipt" in result) || !("evidence" in result)) throw new Error("Expected rig effect receipt");
    expect(result.receipt).toMatchObject({
      revisionBefore: 14,
      revisionAfter: 15,
      changedObjectIds: ["rig-a"],
      dirtyObjectIds: ["rig-a"],
      selection: { mode: "POSE", activeObjectId: "rig-a", selectedObjectIds: ["prop-b", "rig-a"] },
      operations: operations.map((operation) => ({
        op: operation.op,
        changedObjectIds: ["rig-a"],
        dirtyObjectIds: ["rig-a"],
        mode: "POSE",
      })),
    });
    expect(result.evidence.objects).toEqual([expect.objectContaining({ id: "rig-a", type: "ARMATURE" })]);
  });

  it("uses native transaction revisions when reconstructing an intent after the gateway restarts", async () => {
    const current = scene(5, [cube("cube-a")]);
    const session: BlenderNativeSession = {
      status: vi.fn(),
      previewGlb: vi.fn(),
      snapshot: vi.fn().mockResolvedValue(current),
      submit: vi.fn().mockResolvedValue({
        contract: BLENDER_LIVE_CONTRACT,
        jobId: intentId,
        requestId: intentId,
        status: "queued",
      }),
      job: vi.fn().mockResolvedValue({
        contract: BLENDER_LIVE_CONTRACT,
        jobId: intentId,
        requestId: intentId,
        status: "succeeded",
        revision: 5,
        result: {
          revisionBefore: 4,
          revisionAfter: 5,
          operations: [{ object_id: "cube-a", name: "Cube", kind: "object" }],
        },
        error: null,
      }),
    };

    const result = await executeBlenderNativeTool(session, {
      op: "apply",
      expectedSceneEpoch: sceneEpoch,
      expectedRevision: 4,
      intentId,
      operations: [{ op: "create_primitive", id: "cube-a", primitive: "cube" }],
    });

    expect(result).toMatchObject({
      receipt: {
        revisionBefore: 4,
        revisionAfter: 5,
        createdObjectIds: ["cube-a"],
        changedObjectIds: [],
        warnings: [expect.stringContaining("originally committed")],
      },
      evidence: { revision: 5, objects: [{ id: "cube-a" }] },
    });
  });

  it("separates changed and deleted stable IDs and keeps evidence focused on surviving dirty objects", async () => {
    const before = scene(8, [cube("cube-a"), cube("cube-b")]);
    const moved = {
      ...cube("cube-a"),
      position: [2, 0.5, 0] as [number, number, number],
    };
    const after = scene(9, [moved]);
    const session: BlenderNativeSession = {
      status: vi.fn(),
      previewGlb: vi.fn(),
      snapshot: vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after),
      submit: vi.fn().mockResolvedValue({
        contract: BLENDER_LIVE_CONTRACT,
        jobId: intentId,
        requestId: intentId,
        status: "queued",
      }),
      job: vi.fn().mockResolvedValue({
        contract: BLENDER_LIVE_CONTRACT,
        jobId: intentId,
        requestId: intentId,
        status: "succeeded",
        revision: 9,
        result: {
          revisionBefore: 8,
          revisionAfter: 9,
          operations: [{ object_id: "cube-a" }, { object_id: "cube-b" }],
        },
        error: null,
      }),
    };

    const result = await executeBlenderNativeTool(session, {
      op: "apply",
      expectedSceneEpoch: sceneEpoch,
      expectedRevision: 8,
      intentId,
      operations: [
        {
          op: "update_transform",
          id: "cube-a",
          transform: { position: [2, 0.5, 0] },
        },
        { op: "delete_object", id: "cube-b" },
      ],
    });

    expect(result).toMatchObject({
      receipt: {
        revisionBefore: 8,
        revisionAfter: 9,
        createdObjectIds: [],
        changedObjectIds: ["cube-a"],
        deletedObjectIds: ["cube-b"],
        dirtyObjectIds: ["cube-a", "cube-b"],
        operations: [
          { op: "update_transform", changedObjectIds: ["cube-a"] },
          { op: "delete_object", deletedObjectIds: ["cube-b"] },
        ],
      },
      evidence: { revision: 9, objects: [{ id: "cube-a" }] },
    });
  });

  it("receipts camera and light data writes under their stable native IDs", async () => {
    const camera = {
      id: "camera-a",
      name: "Camera",
      position: [0, 2, 8] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      projectionType: "PERSPECTIVE" as const,
      focalLengthMm: 35,
      sensorFit: "AUTO" as const,
      sensorWidthMm: 36,
      sensorHeightMm: 24,
      shiftX: 0,
      shiftY: 0,
      clipStart: 0.1,
      clipEnd: 1_000,
      orthographicScale: 10,
      active: true,
    };
    const light = {
      id: "light-a",
      name: "Light",
      kind: "area" as const,
      position: [4, 6, 4] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      color: [1, 1, 1] as [number, number, number],
      energy: 1_000,
      size: 2,
      visible: true,
    };
    const before = { ...scene(8), cameras: [camera], lights: [light] };
    const after = {
      ...scene(9),
      cameras: [{ ...camera, focalLengthMm: 50 }],
      lights: [{ ...light, energy: 2_000 }],
    };
    const session: BlenderNativeSession = {
      status: vi.fn(),
      previewGlb: vi.fn(),
      snapshot: vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after),
      submit: vi.fn().mockResolvedValue({
        contract: BLENDER_LIVE_CONTRACT,
        jobId: intentId,
        requestId: intentId,
        status: "queued",
      }),
      job: vi.fn().mockResolvedValue({
        contract: BLENDER_LIVE_CONTRACT,
        jobId: intentId,
        requestId: intentId,
        status: "succeeded",
        revision: 9,
        result: {
          revisionBefore: 8,
          revisionAfter: 9,
          operations: [{ object_id: "camera-a" }, { object_id: "light-a" }],
        },
        error: null,
      }),
    };

    const result = await executeBlenderNativeTool(session, {
      op: "apply",
      expectedSceneEpoch: sceneEpoch,
      expectedRevision: 8,
      intentId,
      operations: [
        {
          op: "set_camera_data",
          id: "camera-a",
          projectionType: "PERSPECTIVE",
          focalLengthMm: 50,
          sensorFit: "AUTO",
          sensorWidthMm: 36,
          sensorHeightMm: 24,
          shiftX: 0,
          shiftY: 0,
          clipStart: 0.1,
          clipEnd: 1_000,
          orthographicScale: 10,
        },
        { op: "set_light_data", id: "light-a", kind: "area", color: [1, 1, 1], energy: 2_000, size: 2 },
      ],
    });

    expect(result).toMatchObject({
      receipt: {
        changedObjectIds: ["camera-a", "light-a"],
        dirtyObjectIds: ["camera-a", "light-a"],
        operations: [
          { op: "set_camera_data", changedObjectIds: ["camera-a"] },
          { op: "set_light_data", changedObjectIds: ["light-a"] },
        ],
      },
      evidence: { cameras: [{ id: "camera-a", focalLengthMm: 50 }], lights: [{ id: "light-a", energy: 2_000 }] },
    });
  });

  it("rejects a stale scene epoch before submitting any Blender edit", async () => {
    const session: BlenderNativeSession = {
      status: vi.fn(),
      previewGlb: vi.fn(),
      snapshot: vi.fn().mockResolvedValue({ ...scene(4), sceneEpoch: nextSceneEpoch }),
      submit: vi.fn(),
      job: vi.fn(),
    };

    await expect(
      executeBlenderNativeTool(session, {
        op: "apply",
        expectedSceneEpoch: sceneEpoch,
        expectedRevision: 4,
        intentId,
        operations: [{ op: "create_primitive", id: "cube-a", primitive: "cube" }],
      }),
    ).rejects.toMatchObject({ code: "scene_epoch_conflict", status: 409 });
    expect(session.submit).not.toHaveBeenCalled();
    expect(session.job).not.toHaveBeenCalled();
  });

  it("preserves Blender's structured epoch conflict when the scene changes after submit", async () => {
    const session: BlenderNativeSession = {
      status: vi.fn(),
      previewGlb: vi.fn(),
      snapshot: vi.fn().mockResolvedValue(scene(4)),
      submit: vi.fn().mockResolvedValue({
        contract: BLENDER_LIVE_CONTRACT,
        jobId: intentId,
        requestId: intentId,
        status: "queued",
      }),
      job: vi.fn().mockResolvedValue({
        contract: BLENDER_LIVE_CONTRACT,
        jobId: intentId,
        requestId: intentId,
        status: "failed",
        revision: 4,
        result: null,
        code: "scene_epoch_conflict",
        error: "Scene changed after submit",
      }),
    };

    await expect(
      executeBlenderNativeTool(session, {
        op: "apply",
        expectedSceneEpoch: sceneEpoch,
        expectedRevision: 4,
        intentId,
        operations: [{ op: "create_primitive", id: "cube-a", primitive: "cube" }],
      }),
    ).rejects.toMatchObject({ code: "scene_epoch_conflict", status: 409 });
  });

  it("parses enhanced object inspection evidence without changing the legacy result field", async () => {
    const inspection = {
      id: "cube-a",
      name: "Cube",
      type: "MESH",
      mode: "OBJECT",
      dimensions: [1, 1, 1],
      evaluatedBounds: {
        min: [-0.5, 0, -0.5],
        max: [0.5, 1, 0.5],
        center: [0, 0.5, 0],
        size: [1, 1, 1],
      },
      selection: { selected: true, active: true },
      mesh: {
        vertices: 8,
        edges: 12,
        faces: 6,
        triangles: 12,
        looseVertices: 0,
        boundaryEdges: 0,
        nonManifoldEdges: 0,
        materialSlots: 0,
        uvLayers: [],
        colorAttributes: [],
        shapeKeys: [],
      },
      materialNodes: [],
      animation: {
        action: null,
        fCurveCount: 0,
        keyframeCount: 0,
        driverCount: 0,
        nlaTrackCount: 0,
        nlaStripCount: 0,
      },
      warnings: [],
    };
    const session: BlenderNativeSession = {
      status: vi.fn(),
      previewGlb: vi.fn(),
      snapshot: vi.fn(),
      submit: vi.fn().mockResolvedValue({
        contract: BLENDER_LIVE_CONTRACT,
        jobId: intentId,
        requestId: intentId,
        status: "queued",
      }),
      job: vi.fn().mockResolvedValue({
        contract: BLENDER_LIVE_CONTRACT,
        jobId: intentId,
        requestId: intentId,
        status: "succeeded",
        revision: 5,
        result: { operations: [inspection] },
        error: null,
      }),
    };

    const result = await executeBlenderNativeTool(session, {
      op: "inspect",
      id: "cube-a",
      expectedSceneEpoch: sceneEpoch,
      expectedRevision: 5,
    });

    expect(result).toMatchObject({ result: inspection, inspection });
    expect(result).not.toHaveProperty("job");
    expect(session.submit).toHaveBeenCalledWith(
      expect.objectContaining({ expectedSceneEpoch: sceneEpoch, expectedRevision: 5 }),
    );
    expect(session.snapshot).not.toHaveBeenCalled();
  });

  it("compacts inspect material graphs and fills position", async () => {
    const inspection = {
      id: "cube-a",
      name: "Cube",
      type: "MESH",
      mode: "OBJECT",
      dimensions: [1, 1, 1],
      evaluatedBounds: {
        min: [-0.5, 0, -0.5],
        max: [0.5, 1, 0.5],
        center: [0, 0.5, 0],
        size: [1, 1, 1],
      },
      selection: { selected: true, active: true },
      materialNodes: [],
      materialGraphs: [
        {
          materialName: "roof_tile",
          objectIds: ["cube-a"],
          activeOutputNodeRef: "material-output",
          nodes: [
            {
              nodeRef: "principled",
              name: "principled",
              label: "",
              nodeType: "PRINCIPLED_BSDF",
              blenderType: "ShaderNodeBsdfPrincipled",
              activeOutput: false,
              location: [-200, 100],
              inputs: [
                {
                  socketRef: "Base Color",
                  name: "Base Color",
                  type: "RGBA",
                  linked: false,
                  enabled: true,
                  multiInput: false,
                  defaultValue: [0.35, 0.35, 0.38, 1],
                },
                {
                  socketRef: "BSDF",
                  name: "BSDF",
                  type: "SHADER",
                  linked: true,
                  enabled: true,
                  multiInput: false,
                },
              ],
              outputs: [
                {
                  socketRef: "BSDF",
                  name: "BSDF",
                  type: "SHADER",
                  linked: true,
                  enabled: true,
                  multiInput: false,
                },
              ],
            },
          ],
          links: [
            {
              from: { nodeRef: "principled", socketRef: "BSDF" },
              to: { nodeRef: "material-output", socketRef: "Surface" },
            },
          ],
        },
      ],
      animation: {
        action: null,
        fCurveCount: 0,
        keyframeCount: 0,
        driverCount: 0,
        nlaTrackCount: 0,
        nlaStripCount: 0,
      },
      warnings: [],
    };
    const session: BlenderNativeSession = {
      status: vi.fn(),
      previewGlb: vi.fn(),
      snapshot: vi.fn(),
      submit: vi.fn().mockResolvedValue({
        contract: BLENDER_LIVE_CONTRACT,
        jobId: intentId,
        requestId: intentId,
        status: "queued",
      }),
      job: vi.fn().mockResolvedValue({
        contract: BLENDER_LIVE_CONTRACT,
        jobId: intentId,
        requestId: intentId,
        status: "succeeded",
        revision: 5,
        result: { operations: [inspection] },
        error: null,
      }),
    };

    const result = await executeBlenderNativeTool(session, {
      op: "inspect",
      id: "cube-a",
      expectedSceneEpoch: sceneEpoch,
      expectedRevision: 5,
    });

    if (!("result" in result)) {
      throw new Error("Expected inspect result");
    }
    expect(result.result).toMatchObject({ id: "cube-a", position: [0, 0.5, 0] });
    const graphs = (result.result as { materialGraphs?: Array<{ nodes: Array<{ inputs: unknown[] }> }> })
      .materialGraphs;
    expect(graphs?.[0]?.nodes[0]?.inputs).toEqual([expect.objectContaining({ socketRef: "BSDF", linked: true })]);
    expect(JSON.stringify(result)).not.toContain("defaultValue");
  });

  it("binds an unguarded inspect to the current scene revision before reading the object", async () => {
    const inspection = {
      id: "cube-a",
      name: "Cube",
      type: "MESH",
      mode: "OBJECT",
      dimensions: [1, 1, 1],
      evaluatedBounds: {
        min: [-0.5, 0, -0.5],
        max: [0.5, 1, 0.5],
        center: [0, 0.5, 0],
        size: [1, 1, 1],
      },
      selection: { selected: true, active: true },
      mesh: {
        vertices: 8,
        edges: 12,
        faces: 6,
        triangles: 12,
        looseVertices: 0,
        boundaryEdges: 0,
        nonManifoldEdges: 0,
        materialSlots: 0,
        uvLayers: [],
        colorAttributes: [],
        shapeKeys: [],
      },
      materialNodes: [],
      animation: {
        action: null,
        fCurveCount: 0,
        keyframeCount: 0,
        driverCount: 0,
        nlaTrackCount: 0,
        nlaStripCount: 0,
      },
      warnings: [],
    };
    const session: BlenderNativeSession = {
      status: vi.fn(),
      previewGlb: vi.fn(),
      snapshot: vi.fn().mockResolvedValue(scene(5, [cube("cube-a")])),
      submit: vi.fn().mockResolvedValue({
        contract: BLENDER_LIVE_CONTRACT,
        jobId: intentId,
        requestId: intentId,
        status: "queued",
      }),
      job: vi.fn().mockResolvedValue({
        contract: BLENDER_LIVE_CONTRACT,
        jobId: intentId,
        requestId: intentId,
        status: "succeeded",
        revision: 5,
        result: { operations: [inspection] },
        error: null,
      }),
    };

    const result = await executeBlenderNativeTool(session, { op: "inspect", id: "cube-a" });

    expect(result).toMatchObject({ result: inspection, inspection });
    expect(result).not.toHaveProperty("job");
    expect(session.submit).toHaveBeenCalledWith(
      expect.objectContaining({ expectedSceneEpoch: sceneEpoch, expectedRevision: 5 }),
    );
    expect(session.snapshot).toHaveBeenCalledTimes(1);
  });

  it("exports a GLB preview as raw bytes through the binary endpoint and consumes the native record", async () => {
    const metadata = {
      contract: BLENDER_LIVE_CONTRACT,
      sceneEpoch,
      revision: 12,
      mimeType: "model/gltf-binary" as const,
      byteLength: 4,
    };
    const session: BlenderNativeSession = {
      status: vi.fn(),
      previewGlb: vi.fn().mockResolvedValue({
        bytes: Buffer.from("glTF"),
        sceneEpoch,
        revision: 12,
      }),
      snapshot: vi.fn(),
      submit: vi.fn().mockResolvedValue({
        contract: BLENDER_LIVE_CONTRACT,
        jobId: intentId,
        requestId: intentId,
        status: "queued",
      }),
      job: vi.fn().mockResolvedValue({
        contract: BLENDER_LIVE_CONTRACT,
        jobId: intentId,
        requestId: intentId,
        status: "succeeded",
        revision: 12,
        result: { operations: [metadata] },
        error: null,
      }),
    };

    const result = await exportBlenderScenePreview(session);

    expect(session.submit).toHaveBeenCalledWith(
      expect.objectContaining({ operations: [{ op: "export_scene_preview" }] }),
    );
    expect(session.job).toHaveBeenCalledWith(intentId);
    expect(session.previewGlb).toHaveBeenCalledWith(intentId, { consume: true });
    expect(result.preview).toEqual({
      sceneEpoch,
      revision: 12,
      mimeType: "model/gltf-binary",
      bytes: Buffer.from("glTF"),
      byteLength: 4,
    });
    expect(result.job.result).toEqual({ operations: [metadata] });
    expect(JSON.stringify(result.job)).not.toContain("dataBase64");
  });

  it("rejects a binary preview whose bytes do not match the native byte length", async () => {
    const session: BlenderNativeSession = {
      status: vi.fn(),
      previewGlb: vi.fn().mockResolvedValue({
        bytes: Buffer.from("glTF-truncated"),
        sceneEpoch,
        revision: 12,
      }),
      snapshot: vi.fn(),
      submit: vi.fn().mockResolvedValue({
        contract: BLENDER_LIVE_CONTRACT,
        jobId: intentId,
        requestId: intentId,
        status: "queued",
      }),
      job: vi.fn().mockResolvedValue({
        contract: BLENDER_LIVE_CONTRACT,
        jobId: intentId,
        requestId: intentId,
        status: "succeeded",
        revision: 12,
        result: {
          operations: [
            {
              contract: BLENDER_LIVE_CONTRACT,
              sceneEpoch,
              revision: 12,
              mimeType: "model/gltf-binary",
              byteLength: 4,
            },
          ],
        },
        error: null,
      }),
    };

    await expect(exportBlenderScenePreview(session)).rejects.toMatchObject({
      status: 502,
      code: "blender_preview_invalid",
    });
  });

  it("falls back to the consumed base64 job payload when the native session has no binary endpoint", async () => {
    const detachedMetadata = {
      contract: BLENDER_LIVE_CONTRACT,
      sceneEpoch,
      revision: 12,
      mimeType: "model/gltf-binary" as const,
      byteLength: 4,
    };
    const attachedMetadata = { ...detachedMetadata, dataBase64: "Z2xURg==" };
    const session: BlenderNativeSession = {
      status: vi.fn(),
      previewGlb: vi.fn().mockRejectedValue(new BlenderNativeSessionError("Unknown preview", 404)),
      snapshot: vi.fn(),
      submit: vi.fn().mockResolvedValue({
        contract: BLENDER_LIVE_CONTRACT,
        jobId: intentId,
        requestId: intentId,
        status: "queued",
      }),
      job: vi.fn(async (jobId, options?: { consume?: boolean }) => ({
        contract: BLENDER_LIVE_CONTRACT,
        jobId,
        requestId: jobId,
        status: "succeeded" as const,
        revision: 12,
        result: { operations: [options?.consume ? attachedMetadata : detachedMetadata] },
        error: null,
      })),
    };

    const result = await exportBlenderScenePreview(session);

    expect(session.previewGlb).toHaveBeenCalledWith(intentId, { consume: true });
    expect(session.job).toHaveBeenLastCalledWith(intentId, { consume: true });
    expect(result.preview).toEqual({
      sceneEpoch,
      revision: 12,
      mimeType: "model/gltf-binary",
      bytes: Buffer.from("glTF"),
      byteLength: 4,
    });
    expect(JSON.stringify(result.job)).not.toContain("dataBase64");
  });

  it.each(["capture", "capture_render"] as const)(
    "consumes the terminal %s record so Blender does not retain the PNG payload",
    async (op) => {
      const capture = {
        mimeType: "image/png",
        dataBase64: "aW1hZ2U=",
        width: 640,
        height: 360,
        cameraId: "camera-a",
      };
      const session: BlenderNativeSession = {
        status: vi.fn(),
        previewGlb: vi.fn(),
        snapshot: vi.fn(),
        submit: vi.fn().mockResolvedValue({
          contract: BLENDER_LIVE_CONTRACT,
          jobId: intentId,
          requestId: intentId,
          status: "queued",
        }),
        job: vi.fn().mockResolvedValue({
          contract: BLENDER_LIVE_CONTRACT,
          jobId: intentId,
          requestId: intentId,
          status: "succeeded",
          revision: 5,
          result: { operations: [capture] },
          error: null,
        }),
      };

      const result = await executeBlenderNativeTool(session, {
        op,
        width: 640,
        height: 360,
        transparent: false,
      });

      expect(session.job).toHaveBeenCalledWith(intentId, { consume: true });
      expect(result).toMatchObject({ capture });
      if (!("result" in result)) throw new Error("Expected capture result");
      expect(JSON.stringify(result.result)).not.toContain("dataBase64");
      expect(session.submit).toHaveBeenCalledWith(
        expect.objectContaining({
          operations: [expect.objectContaining({ op: "capture_render", width: 640, height: 360 })],
        }),
      );
    },
  );

  it("rejects quitting Blender before they reach the native session", async () => {
    const session: BlenderNativeSession = {
      status: vi.fn(),
      previewGlb: vi.fn(),
      snapshot: vi.fn(),
      submit: vi.fn(),
      job: vi.fn(),
    };

    await expect(
      executeBlenderNativeTool(session, {
        op: "apply",
        expectedSceneEpoch: sceneEpoch,
        expectedRevision: 1,
        intentId,
        operations: [{ op: "invoke_operator", operator: "wm.quit_blender", properties: {} }],
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "blender_operator_denied",
    });
    expect(session.submit).not.toHaveBeenCalled();
  });

  it("forwards polyhaven_search without a scene epoch", async () => {
    const session: BlenderNativeSession = {
      status: vi.fn(),
      previewGlb: vi.fn(),
      snapshot: vi.fn(),
      submit: vi.fn().mockResolvedValue({
        contract: BLENDER_LIVE_CONTRACT,
        jobId: intentId,
        requestId: intentId,
        status: "queued",
      }),
      job: vi.fn().mockResolvedValue({
        contract: BLENDER_LIVE_CONTRACT,
        jobId: intentId,
        requestId: intentId,
        status: "succeeded",
        revision: 5,
        result: {
          operations: [{ provider: "polyhaven", assets: [{ id: "modern_chair" }], count: 1 }],
        },
        error: null,
      }),
    };

    const result = await executeBlenderNativeTool(session, {
      op: "polyhaven_search",
      query: "chair",
      assetType: "models",
      limit: 20,
    });

    expect(result).toMatchObject({
      result: { provider: "polyhaven", count: 1, assets: [{ id: "modern_chair" }] },
    });
    expect(session.snapshot).not.toHaveBeenCalled();
    expect(session.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        operations: [expect.objectContaining({ op: "polyhaven_search", query: "chair", assetType: "models" })],
      }),
    );
    expect(vi.mocked(session.submit).mock.calls[0]?.[0].expectedSceneEpoch).toBeUndefined();
  });
});
