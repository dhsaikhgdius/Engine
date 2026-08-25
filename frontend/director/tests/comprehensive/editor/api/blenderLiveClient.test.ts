import { afterEach, describe, expect, it, vi } from "vitest";
import { BLENDER_LIVE_CONTRACT } from "../../../../../../packages/protocol/src/blenderLiveProtocol";

const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../../../../src/comprehensive/editor/api/directorControlPlaneClient", () => ({
  directorControlPlaneFetch: transport.fetch,
}));

import {
  applyBlenderNativeOperations,
  bindBlenderDirectorProject,
  createBlenderBlockoutBatch,
  createBlenderCollectionBatch,
  createBlenderConstraintBatch,
  createBlenderLightBatch,
  createBlenderOpeningBatch,
  createBlenderParentBatch,
  getBlenderLiveScene,
  getBlenderLivePreviewGlb,
  getBlenderLiveStatus,
  inspectBlenderLiveObject,
  pollBlenderLiveLink,
  submitBlenderLiveCommands,
  blenderAssignMaterialOperation,
  blenderAddNlaStripOperation,
  blenderConnectMaterialNodesOperation,
  blenderCreateActionOperation,
  blenderCreateMaterialNodeOperation,
  blenderCreateNlaTrackOperation,
  blenderDeletePoseKeyframesOperation,
  blenderDeleteMaterialNodeOperation,
  blenderDisconnectMaterialNodeInputOperation,
  blenderInsertPoseKeyframesOperation,
  blenderImportMixamoActionOperation,
  blenderMeshEditOperation,
  blenderMeshSelectionOperation,
  blenderProjectUvOperation,
  blenderRemoveNlaStripOperation,
  blenderSelectPoseBonesOperation,
  blenderSetActiveActionOperation,
  blenderSetMaterialNodeInputOperation,
  blenderSetPoseBoneTransformOperation,
  blenderSetSceneFrameOperation,
  blenderUpdateNlaStripOperation,
} from "../../../../src/comprehensive/editor/api/blenderLiveClient";

const requestId = "b4b2ed3d-b25b-4ad0-8db9-f04bcb229fb6";
const sceneEpoch = "48b0d9b3-2bf8-46a7-8832-909d816369e2";

function nativeJob(result: unknown = {}) {
  return {
    contract: BLENDER_LIVE_CONTRACT,
    jobId: requestId,
    requestId,
    status: "succeeded",
    revision: 5,
    result,
    error: null,
  };
}

function objectInspection(mode: "OBJECT" | "EDIT" = "EDIT") {
  return {
    id: "mesh-a",
    name: "Mesh A",
    type: "MESH",
    mode,
    dimensions: [2, 1, 3],
    evaluatedBounds: {
      min: [-1, 0, -1.5],
      max: [1, 1, 1.5],
      center: [0, 0.5, 0],
      size: [2, 1, 3],
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
      materialSlots: 1,
      selection: {
        vertices: { count: 0, sample: [] },
        edges: { count: 0, sample: [] },
        faces: { count: 6, sample: [0, 1, 2, 3, 4, 5] },
      },
      uvLayers: ["UVMap"],
      colorAttributes: [],
      shapeKeys: [],
    },
    materialNodes: [],
    materialSlots: [],
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
}

function effectReceipt() {
  return {
    contract: BLENDER_LIVE_CONTRACT,
    sceneEpoch,
    requestId,
    revisionBefore: 4,
    revisionAfter: 5,
    createdObjectIds: [],
    changedObjectIds: ["mesh-a"],
    deletedObjectIds: [],
    dirtyObjectIds: ["mesh-a"],
    selection: {
      mode: "EDIT",
      activeObjectId: "mesh-a",
      selectedObjectIds: ["mesh-a"],
    },
    metrics: {
      before: { entities: 1, objects: 1, cameras: 0, lights: 0 },
      after: { entities: 1, objects: 1, cameras: 0, lights: 0 },
    },
    operations: [
      {
        index: 0,
        op: "invoke_operator",
        createdObjectIds: [],
        changedObjectIds: ["mesh-a"],
        deletedObjectIds: [],
        dirtyObjectIds: ["mesh-a"],
        mode: "EDIT",
        selectedObjectIds: ["mesh-a"],
        activeObjectId: "mesh-a",
        metrics: { created: 0, changed: 1, deleted: 0, dirty: 1 },
        warnings: [],
      },
    ],
    warnings: [],
  };
}

afterEach(() => vi.clearAllMocks());

describe("Blender live client", () => {
  it("reads the native Blender session state", async () => {
    transport.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          result: {
            available: true,
            ok: true,
            contract: BLENDER_LIVE_CONTRACT,
            blenderVersion: "5.1.2",
            revision: 7,
            sceneEpoch,
            busy: false,
          },
        }),
        { status: 200 },
      ),
    );
    await expect(getBlenderLiveStatus()).resolves.toMatchObject({
      available: true,
      revision: 7,
    });
  });

  it("cancels an authoritative scene read through the caller signal", async () => {
    const signal = new AbortController().signal;
    transport.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          result: {
            contract: BLENDER_LIVE_CONTRACT,
            sceneEpoch,
            revision: 7,
            sceneName: "Scene",
            frame: 1,
            unit: "meter",
            coordinateSystem: "right-handed-y-up-negative-z-forward",
            objects: [],
            cameras: [],
            lights: [],
            selectedObjectIds: [],
            activeObjectId: null,
          },
        }),
        { status: 200 },
      ),
    );

    await expect(getBlenderLiveScene({ signal })).resolves.toMatchObject({ revision: 7 });
    expect(transport.fetch).toHaveBeenCalledWith("/api/dcc/blender/scene", { signal });
  });

  it("polls the preview-only live-link feed without a cursor as first contact", async () => {
    transport.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          result: {
            kind: "resync",
            contract: BLENDER_LIVE_CONTRACT,
            sceneEpoch,
            seq: 9,
            reason: "initial",
          },
        }),
        { status: 200 },
      ),
    );

    await expect(pollBlenderLiveLink()).resolves.toMatchObject({ kind: "resync", reason: "initial", seq: 9 });
    expect(transport.fetch).toHaveBeenCalledWith("/api/dcc/blender/live-link", { signal: undefined });
  });

  it("polls the live-link feed with a replay-guard cursor and validates the frames", async () => {
    const signal = new AbortController().signal;
    transport.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          result: {
            kind: "frames",
            contract: BLENDER_LIVE_CONTRACT,
            sceneEpoch,
            seq: 11,
            frames: [
              {
                seq: 11,
                kind: "transform",
                revision: 11,
                frame: 1,
                objects: [{ id: "chair", position: [1, 0, 2], rotation: [0, 0.5, 0], scale: [1, 1, 1] }],
                cameras: [],
                lights: [],
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );

    await expect(pollBlenderLiveLink({ sceneEpoch, since: 10 }, { signal })).resolves.toMatchObject({
      kind: "frames",
      seq: 11,
      frames: [{ seq: 11, objects: [{ id: "chair" }] }],
    });
    expect(transport.fetch).toHaveBeenCalledWith(`/api/dcc/blender/live-link?epoch=${sceneEpoch}&since=10`, {
      signal,
    });
  });

  it("rejects a live-link payload that does not match the shared contract", async () => {
    transport.fetch.mockResolvedValue(
      new Response(JSON.stringify({ success: true, result: { kind: "frames", frames: "nope" } }), { status: 200 }),
    );

    await expect(pollBlenderLiveLink()).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("reads the authenticated binary preview and its authoritative revision", async () => {
    const signal = new AbortController().signal;
    transport.fetch.mockResolvedValue(
      new Response(new Uint8Array([0x67, 0x6c, 0x54, 0x46]), {
        headers: {
          "Content-Type": "model/gltf-binary",
          "X-Blender-Revision": "12",
          "X-Blender-Scene-Epoch": "scene-boot-b",
        },
        status: 200,
      }),
    );

    const preview = await getBlenderLivePreviewGlb({ signal });

    expect(transport.fetch).toHaveBeenCalledWith("/api/dcc/blender/preview.glb", { signal });
    expect(preview.revision).toBe(12);
    expect(preview.sceneEpoch).toBe("scene-boot-b");
    expect(preview.blob.type).toBe("model/gltf-binary");
    await expect(preview.blob.arrayBuffer()).resolves.toHaveProperty("byteLength", 4);
  });

  it("accepts revision zero from a freshly started Blender scene", async () => {
    transport.fetch.mockResolvedValue(
      new Response(new Uint8Array([0x67, 0x6c, 0x54, 0x46]), {
        headers: {
          "X-Blender-Revision": "0",
          "X-Blender-Scene-Epoch": sceneEpoch,
        },
        status: 200,
      }),
    );

    await expect(getBlenderLivePreviewGlb()).resolves.toMatchObject({
      revision: 0,
      sceneEpoch: "48b0d9b3-2bf8-46a7-8832-909d816369e2",
    });
  });

  it("rejects a binary preview without its scene identity receipt", async () => {
    transport.fetch.mockResolvedValue(new Response("glb", { status: 200 }));

    await expect(getBlenderLivePreviewGlb()).rejects.toMatchObject({
      code: "invalid_response",
      status: 200,
    });
  });

  it("rejects a binary preview without the scene epoch receipt", async () => {
    transport.fetch.mockResolvedValue(
      new Response("glb", {
        headers: { "X-Blender-Revision": "12" },
        status: 200,
      }),
    );

    await expect(getBlenderLivePreviewGlb()).rejects.toMatchObject({
      code: "invalid_response",
      status: 200,
    });
  });

  it("builds and submits one replayable native blockout transaction", async () => {
    const batch = createBlenderBlockoutBatch({
      preset: "room",
      expectedSceneEpoch: sceneEpoch,
      expectedRevision: 4,
      width: 8,
      depth: 6,
      height: 3,
    });
    transport.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          result: {
            contract: BLENDER_LIVE_CONTRACT,
            jobId: batch.requestId,
            requestId: batch.requestId,
            status: "queued",
          },
        }),
        { status: 202 },
      ),
    );

    await submitBlenderLiveCommands(batch);
    expect(transport.fetch).toHaveBeenCalledWith(
      "/api/dcc/blender/commands",
      expect.objectContaining({ method: "POST" }),
    );
    const sent = JSON.parse(String(transport.fetch.mock.calls[0]![1].body));
    expect(sent).toMatchObject({
      expectedRevision: 4,
      operations: [
        {
          op: "create_blockout",
          preset: "room",
          width: 8,
          depth: 6,
          height: 3,
        },
      ],
    });
  });

  it("binds the modeling backend to one Director project and returns its scene", async () => {
    transport.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/dcc/blender/commands") {
        const request = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            success: true,
            result: {
              contract: BLENDER_LIVE_CONTRACT,
              jobId: request.requestId,
              requestId: request.requestId,
              status: "queued",
            },
          }),
          { status: 202 },
        );
      }
      if (path.startsWith("/api/dcc/blender/jobs/")) {
        const jobId = path.split("/").at(-1)!;
        return new Response(
          JSON.stringify({
            success: true,
            result: {
              contract: BLENDER_LIVE_CONTRACT,
              jobId,
              requestId: jobId,
              status: "succeeded",
              revision: 0,
              error: null,
            },
          }),
        );
      }
      return new Response(
        JSON.stringify({
          success: true,
          result: {
            contract: BLENDER_LIVE_CONTRACT,
            projectId: "director-project-a",
            sceneEpoch,
            revision: 0,
            sceneName: "Director scene",
            frame: 1,
            unit: "meter",
            coordinateSystem: "right-handed-y-up-negative-z-forward",
            objects: [],
            cameras: [],
            lights: [],
            selectedObjectIds: [],
            activeObjectId: null,
          },
        }),
      );
    });

    await expect(bindBlenderDirectorProject("director-project-a")).resolves.toMatchObject({
      projectId: "director-project-a",
      sceneEpoch,
    });
    const sent = JSON.parse(String(transport.fetch.mock.calls[0]![1].body));
    expect(sent.operations).toEqual([{ op: "bind_director_project", projectId: "director-project-a" }]);
    expect(sent.expectedSceneEpoch).toBeUndefined();
  });

  it("builds native light, Boolean opening, and collection transactions", () => {
    expect(createBlenderLightBatch(2, sceneEpoch)).toMatchObject({
      expectedSceneEpoch: sceneEpoch,
      expectedRevision: 2,
      operations: [{ op: "create_light", kind: "area", energy: 1_000 }],
    });
    expect(
      createBlenderOpeningBatch({
        targetId: "wall-a",
        kind: "window",
        expectedSceneEpoch: sceneEpoch,
        expectedRevision: 3,
      }),
    ).toMatchObject({
      expectedSceneEpoch: sceneEpoch,
      expectedRevision: 3,
      operations: [
        {
          op: "create_opening",
          targetId: "wall-a",
          width: 1.4,
          height: 1.2,
          sillHeight: 0.9,
        },
      ],
    });
    expect(
      createBlenderCollectionBatch({
        objectIds: ["wall-a", "opening-a"],
        collection: "Architecture",
        expectedSceneEpoch: sceneEpoch,
      }),
    ).toMatchObject({
      operations: [{ op: "move_to_collection", collection: "Architecture" }],
    });
  });

  it("builds native parenting and constraint transactions", () => {
    expect(
      createBlenderParentBatch({
        objectId: "chair-a",
        parentId: "room-a",
        expectedSceneEpoch: sceneEpoch,
        expectedRevision: 7,
      }),
    ).toMatchObject({
      expectedRevision: 7,
      operations: [
        {
          op: "set_parent",
          id: "chair-a",
          parentId: "room-a",
          keepWorldTransform: true,
        },
      ],
    });
    expect(
      createBlenderConstraintBatch({
        objectId: "camera-a",
        targetId: "actor-a",
        expectedSceneEpoch: sceneEpoch,
        kind: "track_to",
        influence: 0.8,
      }),
    ).toMatchObject({
      operations: [
        {
          op: "add_constraint",
          id: "camera-a",
          targetId: "actor-a",
          influence: 0.8,
        },
      ],
    });
  });

  it("applies typed native operations at the caller's authoritative revision", async () => {
    transport.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          result: {
            sceneEpoch,
            job: nativeJob(),
            receipt: effectReceipt(),
            evidence: {
              sceneEpoch,
              revision: 5,
              objects: [],
              cameras: [],
              lights: [],
            },
          },
        }),
        { status: 200 },
      ),
    );

    await expect(
      applyBlenderNativeOperations({
        expectedSceneEpoch: sceneEpoch,
        expectedRevision: 4,
        intentId: requestId,
        operations: [
          {
            op: "set_selection",
            selectedIds: ["mesh-a"],
            activeId: "mesh-a",
            mode: "EDIT",
          },
        ],
      }),
    ).resolves.toMatchObject({
      receipt: { revisionBefore: 4, revisionAfter: 5 },
    });

    const sent = JSON.parse(String(transport.fetch.mock.calls[0]![1].body));
    expect(sent).toEqual({
      input: {
        op: "apply",
        expectedSceneEpoch: sceneEpoch,
        expectedRevision: 4,
        intentId: requestId,
        operations: [
          {
            op: "set_selection",
            selectedIds: ["mesh-a"],
            activeId: "mesh-a",
            mode: "EDIT",
          },
        ],
      },
    });
  });

  it("reads typed Blender mesh inspection evidence", async () => {
    const inspection = objectInspection();
    transport.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          result: {
            job: nativeJob(inspection),
            result: inspection,
            inspection,
          },
        }),
        { status: 200 },
      ),
    );

    await expect(
      inspectBlenderLiveObject("mesh-a", {
        expectedSceneEpoch: sceneEpoch,
        expectedRevision: 5,
      }),
    ).resolves.toMatchObject({
      inspection: { id: "mesh-a", mode: "EDIT", mesh: { faces: 6 } },
    });
    expect(JSON.parse(String(transport.fetch.mock.calls[0]![1].body))).toEqual({
      input: {
        op: "inspect",
        id: "mesh-a",
        expectedSceneEpoch: sceneEpoch,
        expectedRevision: 5,
      },
    });
  });

  it("builds compact native mesh selection and modeling operations", () => {
    expect(
      blenderMeshSelectionOperation({
        objectId: "mesh-a",
        domain: "EDGE",
        action: "RESET",
      }),
    ).toEqual({
      op: "select_mesh_elements",
      id: "mesh-a",
      domain: "EDGE",
      indices: [],
      action: "NONE",
    });

    expect(
      blenderMeshEditOperation("mesh-a", {
        tool: "subdivide",
        cuts: 2,
        smoothness: 0.25,
      }),
    ).toMatchObject({
      op: "invoke_operator",
      operator: "mesh.subdivide",
      properties: { number_cuts: 2, smoothness: 0.25 },
      context: { selectedIds: ["mesh-a"], activeId: "mesh-a", mode: "EDIT" },
    });
    expect(
      blenderMeshEditOperation("mesh-a", {
        tool: "extrude",
        distance: 0.4,
      }),
    ).toMatchObject({
      operator: "mesh.extrude_region_shrink_fatten",
      properties: { TRANSFORM_OT_shrink_fatten: { value: 0.4 } },
    });
    expect(
      blenderMeshEditOperation("mesh-a", {
        tool: "inset",
        thickness: 0.1,
        depth: 0.02,
      }),
    ).toMatchObject({
      operator: "mesh.inset",
      properties: { thickness: 0.1, depth: 0.02 },
    });
    expect(
      blenderMeshEditOperation("mesh-a", {
        tool: "bevel",
        offset: 0.05,
        segments: 3,
      }),
    ).toMatchObject({
      operator: "mesh.bevel",
      properties: { offset: 0.05, segments: 3 },
    });
  });

  it("builds semantic native material and UV operations", () => {
    expect(
      blenderAssignMaterialOperation({
        objectId: "mesh-a",
        materialName: "Concrete",
        createIfMissing: true,
        faceScope: "SELECTED",
        parameters: {
          baseColor: [0.5, 0.6, 0.7],
          roughness: 0.8,
          metallic: 0.1,
          alpha: 0.9,
        },
      }),
    ).toEqual({
      op: "assign_material",
      id: "mesh-a",
      materialName: "Concrete",
      createIfMissing: true,
      faceScope: "SELECTED",
      parameters: {
        baseColor: [0.5, 0.6, 0.7],
        roughness: 0.8,
        metallic: 0.1,
        alpha: 0.9,
      },
    });
    expect(
      blenderProjectUvOperation({
        objectId: "mesh-a",
        method: "CUBE",
        uvLayerName: "Architecture UV",
        replaceExisting: false,
      }),
    ).toEqual({
      op: "project_uv",
      id: "mesh-a",
      method: "CUBE",
      uvLayerName: "Architecture UV",
      replaceExisting: false,
    });
  });

  it("builds typed material node graph operations", () => {
    expect(
      blenderCreateMaterialNodeOperation({
        objectId: "mesh-a",
        materialName: "Concrete",
        nodeRef: "node-mapping",
        nodeType: "MAPPING",
        location: [-240, 80],
        label: "Scale texture",
      }),
    ).toEqual({
      op: "create_material_node",
      id: "mesh-a",
      materialName: "Concrete",
      nodeRef: "node-mapping",
      nodeType: "MAPPING",
      location: [-240, 80],
      label: "Scale texture",
    });
    expect(
      blenderSetMaterialNodeInputOperation({
        objectId: "mesh-a",
        materialName: "Concrete",
        nodeRef: "node-principled",
        inputSocketRef: "Roughness",
        value: 0.62,
      }),
    ).toEqual({
      op: "set_material_node_input",
      id: "mesh-a",
      materialName: "Concrete",
      nodeRef: "node-principled",
      inputSocketRef: "Roughness",
      value: 0.62,
    });
    expect(
      blenderConnectMaterialNodesOperation({
        objectId: "mesh-a",
        materialName: "Concrete",
        from: { nodeRef: "node-principled", socketRef: "BSDF" },
        to: { nodeRef: "node-output", socketRef: "Surface" },
      }),
    ).toEqual({
      op: "connect_material_nodes",
      id: "mesh-a",
      materialName: "Concrete",
      from: { nodeRef: "node-principled", socketRef: "BSDF" },
      to: { nodeRef: "node-output", socketRef: "Surface" },
    });
    expect(
      blenderDisconnectMaterialNodeInputOperation({
        objectId: "mesh-a",
        materialName: "Concrete",
        nodeRef: "node-output",
        inputSocketRef: "Surface",
      }),
    ).toEqual({
      op: "disconnect_material_node_input",
      id: "mesh-a",
      materialName: "Concrete",
      nodeRef: "node-output",
      inputSocketRef: "Surface",
    });
    expect(
      blenderDeleteMaterialNodeOperation({
        objectId: "mesh-a",
        materialName: "Concrete",
        nodeRef: "node-mapping",
      }),
    ).toEqual({
      op: "delete_material_node",
      id: "mesh-a",
      materialName: "Concrete",
      nodeRef: "node-mapping",
    });
  });

  it("builds the public typed Rig, Pose, Action, and keyframe operations", () => {
    expect(
      blenderSelectPoseBonesOperation({
        objectId: "rig-a",
        boneRefs: ["spine"],
        activeBoneRef: "spine",
        action: "SET",
      }),
    ).toEqual({
      op: "select_pose_bones",
      id: "rig-a",
      boneRefs: ["spine"],
      activeBoneRef: "spine",
      action: "SET",
    });
    expect(
      blenderSetPoseBoneTransformOperation({
        objectId: "rig-a",
        boneRef: "spine",
        local: { rotationQuaternion: [1, 0, 0, 0] },
      }),
    ).toEqual({
      op: "set_pose_bone_transform",
      id: "rig-a",
      boneRef: "spine",
      local: { rotationQuaternion: [1, 0, 0, 0] },
    });
    expect(blenderCreateActionOperation("rig-a", "Blocking")).toEqual({
      op: "create_action",
      id: "rig-a",
      actionName: "Blocking",
    });
    expect(blenderSetActiveActionOperation("rig-a", "Blocking")).toEqual({
      op: "set_active_action",
      id: "rig-a",
      actionName: "Blocking",
    });
    expect(blenderSetSceneFrameOperation(24)).toEqual({ op: "set_scene_frame", frame: 24 });
    expect(
      blenderInsertPoseKeyframesOperation({
        objectId: "rig-a",
        actionName: "Blocking",
        frame: 24,
        boneRefs: ["spine"],
        channels: ["ROTATION"],
        interpolation: "BEZIER",
      }),
    ).toEqual({
      op: "insert_pose_keyframes",
      id: "rig-a",
      actionName: "Blocking",
      frame: 24,
      boneRefs: ["spine"],
      channels: ["ROTATION"],
      interpolation: "BEZIER",
    });
    expect(
      blenderDeletePoseKeyframesOperation({
        objectId: "rig-a",
        actionName: "Blocking",
        frame: 24,
        boneRefs: ["spine"],
        channels: ["ROTATION"],
      }),
    ).toEqual({
      op: "delete_pose_keyframes",
      id: "rig-a",
      actionName: "Blocking",
      frame: 24,
      boneRefs: ["spine"],
      channels: ["ROTATION"],
    });
  });

  it("builds catalog-bound Mixamo and typed NLA operations", () => {
    expect(
      blenderImportMixamoActionOperation({
        objectId: "rig-a",
        motionId: "walk",
        rootMotion: "IN_PLACE",
        replaceExisting: true,
      }),
    ).toEqual({
      op: "import_mixamo_action",
      id: "rig-a",
      motionId: "walk",
      rootMotion: "IN_PLACE",
      replaceExisting: true,
    });
    expect(blenderCreateNlaTrackOperation("rig-a", "Locomotion")).toEqual({
      op: "create_nla_track",
      id: "rig-a",
      trackName: "Locomotion",
    });
    expect(
      blenderAddNlaStripOperation({
        objectId: "rig-a",
        trackName: "Locomotion",
        stripName: "Walk 01",
        actionName: "Mixamo Walk Forward",
        startFrame: 12,
        blendMode: "REPLACE",
        influence: 1,
        repeat: 2,
      }),
    ).toEqual({
      op: "add_nla_strip",
      id: "rig-a",
      trackName: "Locomotion",
      stripName: "Walk 01",
      actionName: "Mixamo Walk Forward",
      startFrame: 12,
      blendMode: "REPLACE",
      influence: 1,
      repeat: 2,
      scale: 1,
    });
    expect(
      blenderUpdateNlaStripOperation({
        objectId: "rig-a",
        trackName: "Locomotion",
        stripName: "Walk 01",
        blendMode: "ADD",
        influence: 0.6,
        repeat: 3,
      }),
    ).toEqual({
      op: "update_nla_strip",
      id: "rig-a",
      trackName: "Locomotion",
      stripName: "Walk 01",
      blendMode: "ADD",
      influence: 0.6,
      repeat: 3,
    });
    expect(blenderRemoveNlaStripOperation("rig-a", "Locomotion", "Walk 01")).toEqual({
      op: "remove_nla_strip",
      id: "rig-a",
      trackName: "Locomotion",
      stripName: "Walk 01",
    });
  });
});
