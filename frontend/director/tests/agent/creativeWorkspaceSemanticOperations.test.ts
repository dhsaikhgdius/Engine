import { beforeEach, describe, expect, it } from "vitest";
import JSZip from "jszip";
import { applyDirectorAuthoringActions } from "@director/agent-engine/authoring";
import {
  DirectorCollaborationSession,
  projectForDirectorCollaboration,
} from "../../src/comprehensive/editor/collaboration/directorCollaboration";
import type { PersistentCreativeMediaState } from "../../src/comprehensive/editor/media/persistentCreativeMediaStore";
import { createDefaultDirectorProject } from "@director/agent-engine/default-project";
import {
  useDirectorCreativeWorkspaceStore,
  type DirectorCreativeWorkspaceState,
} from "../../src/comprehensive/editor/workspaces/directorWorkspaceStore";
import { creativeWorkspaceAgentRequestSchema } from "@director/protocol/creativeWorkspaceProtocol";
import {
  executeCreativeWorkspaceCollaborationRequest,
  executeCreativeWorkspaceInterchangeRequest,
  executeCreativeWorkspacePipelineRequest,
  type CreativeWorkspaceSemanticContext,
} from "../../src/agent/creativeWorkspaceSemanticOperations";

const EMPTY_MEDIA: PersistentCreativeMediaState = {
  status: "ready",
  storageMode: "memory",
  warning: null,
  error: null,
  assets: [],
};

function semanticContext(
  options: {
    session?: DirectorCollaborationSession;
    creativeFingerprint?: string;
    project?: ReturnType<typeof createDefaultDirectorProject>;
  } = {},
): CreativeWorkspaceSemanticContext {
  const project = options.project ?? createDefaultDirectorProject();
  return {
    getScopeId: () => "semantic-scene",
    getStageProject: () => project,
    getCreativeState: () => useDirectorCreativeWorkspaceStore.getState(),
    getMediaState: () => EMPTY_MEDIA,
    getCreativeSnapshotFingerprint: () => options.creativeFingerprint ?? "creative-revision:v1:1",
    ...(options.session ? { getCollaborationSession: async () => options.session! } : {}),
  };
}

function sharedCreative(state: DirectorCreativeWorkspaceState) {
  return {
    boardNodes: state.boardNodes,
    boardEdges: state.boardEdges,
    editTracks: state.editTracks,
    editSettings: state.editSettings,
  };
}

describe("creative workspace semantic operations", () => {
  beforeEach(() => {
    useDirectorCreativeWorkspaceStore.getState().resetCreativeWorkspaces();
  });

  it("validates the nested interchange, collaboration, and pipeline contracts strictly", () => {
    expect(
      creativeWorkspaceAgentRequestSchema.safeParse({
        op: "interchange",
        request: { action: "plan-export", format: "otio", workspace: "video" },
      }).success,
    ).toBe(true);
    expect(
      creativeWorkspaceAgentRequestSchema.safeParse({
        op: "interchange",
        request: { action: "export", plan_id: "guessed", expected_guard_fingerprint: "guessed" },
      }).success,
    ).toBe(false);
    expect(
      creativeWorkspaceAgentRequestSchema.safeParse({
        op: "collaboration",
        request: {
          action: "add-comment",
          anchor: { type: "scene", scene_id: "semantic-scene" },
          body: "Check continuity.",
          unexpected: true,
        },
      }).success,
    ).toBe(false);
    expect(
      creativeWorkspaceAgentRequestSchema.safeParse({
        op: "pipeline",
        request: {
          action: "start",
          target_node_ids: ["image-1"],
          force_node_ids: [],
          max_parallel: 3,
          await_completion: false,
        },
      }).success,
    ).toBe(true);
    expect(
      creativeWorkspaceAgentRequestSchema.safeParse({
        op: "pipeline",
        request: {
          action: "start",
          target_node_ids: ["image-1", "image-1"],
        },
      }).success,
    ).toBe(false);
  });

  it("starts and observes a durable Canvas pipeline through the Agent semantic surface", async () => {
    const fingerprint = "creative-revision:v1:2";
    const node = useDirectorCreativeWorkspaceStore.getState().addBoardNode({
      kind: "note",
      title: "Agent pipeline brief",
      body: "Pass this context downstream.",
      x: 40,
      y: 40,
    })!;
    const context = semanticContext({ creativeFingerprint: fingerprint });
    const capabilities = await executeCreativeWorkspacePipelineRequest(
      { op: "pipeline", request: { action: "capabilities" } },
      context,
    );
    expect(capabilities).toMatchObject({
      result: {
        success: true,
        action: "capabilities",
        contract: "director-canvas-pipeline-agent-v1",
        actions: ["capabilities", "start", "status", "cancel"],
      },
    });

    const request = {
      op: "pipeline" as const,
      request: {
        action: "start" as const,
        target_node_ids: [node.id],
        force_node_ids: [],
        max_parallel: 2,
        await_completion: true,
        expected_snapshot_fingerprint: fingerprint,
        idempotency_key: "semantic-pipeline-start-v1",
      },
    };
    const started = await executeCreativeWorkspacePipelineRequest(request, context);
    expect(started).toMatchObject({
      result: {
        success: true,
        action: "start",
        run: {
          status: "succeeded",
          node_runs: [expect.objectContaining({ node_id: node.id, status: "passthrough" })],
        },
      },
    });
    if (!started.result.success || started.result.action !== "start") throw new Error("missing pipeline receipt");
    const replayed = await executeCreativeWorkspacePipelineRequest(request, context);
    expect(replayed).toMatchObject({
      result: {
        success: true,
        action: "start",
        run: { id: started.result.run.id },
        idempotency: { replayed: true },
      },
    });
    const conflicting = await executeCreativeWorkspacePipelineRequest(
      { ...request, request: { ...request.request, target_node_ids: [], max_parallel: 3 } },
      context,
    );
    expect(conflicting).toMatchObject({ result: { success: false, action: "start", code: "conflict" } });

    const status = await executeCreativeWorkspacePipelineRequest(
      { op: "pipeline", request: { action: "status", run_id: started.result.run.id } },
      context,
    );
    expect(status).toMatchObject({
      result: { success: true, action: "status", run: { id: started.result.run.id, status: "succeeded" } },
    });
    expect(useDirectorCreativeWorkspaceStore.getState().boardPipelineRuns.at(-1)).toMatchObject({
      id: started.result.run.id,
      status: "succeeded",
      agentRequest: {
        idempotencyKey: request.request.idempotency_key,
        targetNodeIds: request.request.target_node_ids,
        maxParallel: 2,
      },
    });
  });

  it("rejects stale or unknown Canvas pipeline starts before provider submission", async () => {
    const fingerprint = "creative-revision:v1:3";
    const context = semanticContext({ creativeFingerprint: fingerprint });
    const stale = await executeCreativeWorkspacePipelineRequest(
      {
        op: "pipeline",
        request: {
          action: "start",
          target_node_ids: [],
          force_node_ids: [],
          max_parallel: 4,
          await_completion: false,
          expected_snapshot_fingerprint: "creative-revision:v1:4",
          idempotency_key: "semantic-pipeline-stale-v1",
        },
      },
      context,
    );
    expect(stale).toMatchObject({ result: { success: false, action: "start", code: "stale_guard" } });

    const unknown = await executeCreativeWorkspacePipelineRequest(
      {
        op: "pipeline",
        request: {
          action: "start",
          target_node_ids: ["missing-node"],
          force_node_ids: [],
          max_parallel: 4,
          await_completion: false,
          expected_snapshot_fingerprint: fingerprint,
          idempotency_key: "semantic-pipeline-unknown-v1",
        },
      },
      context,
    );
    expect(unknown).toMatchObject({ result: { success: false, action: "start", code: "not_found" } });
  });

  it("plans and exports a bounded Video OTIO payload for the current revision", async () => {
    const context = semanticContext();
    const capabilities = await executeCreativeWorkspaceInterchangeRequest(
      { op: "interchange", request: { action: "capabilities" } },
      context,
    );
    expect(capabilities).toMatchObject({
      result: {
        success: true,
        import_mode: "agent-transfer",
        actions: ["capabilities", "plan-export", "export", "plan-import", "import"],
        formats: expect.arrayContaining([
          expect.objectContaining({ id: "obj", payload_encoding: "base64" }),
          expect.objectContaining({ id: "stl", payload_encoding: "base64" }),
        ]),
      },
    });

    const planned = await executeCreativeWorkspaceInterchangeRequest(
      {
        op: "interchange",
        request: {
          action: "plan-export",
          format: "otio",
          workspace: "video",
          max_inline_bytes: 64 * 1024,
        },
      },
      context,
    );
    expect(planned.result.success).toBe(true);
    if (!planned.result.success || planned.result.action !== "plan-export") throw new Error("missing plan");

    const exported = await executeCreativeWorkspaceInterchangeRequest(
      {
        op: "interchange",
        request: {
          action: "export",
          plan_id: planned.result.plan.plan_id,
          expected_guard_fingerprint: planned.result.plan.guard.fingerprint,
        },
      },
      context,
    );
    expect(exported).toMatchObject({
      result: {
        success: true,
        action: "export",
        receipt: {
          contract: "director-interchange-export-v1",
          format: "otio",
          workspace: "video",
          payload_encoding: "utf8",
          guard: planned.result.plan.guard,
        },
      },
    });
    if (!exported.result.success || exported.result.action !== "export") throw new Error("missing receipt");
    expect(exported.result.receipt.payload).toContain('"OTIO_SCHEMA": "Timeline.1"');
    expect(exported.result.receipt.byte_length).toBeGreaterThan(0);
  });

  it("plans and exports an exact Stage primitive selection as an OBJ archive", async () => {
    const project = applyDirectorAuthoringActions(createDefaultDirectorProject(), [
      {
        action: "add_object",
        id: "agent-export-box",
        name: "Agent Export Box",
        kind: "prop",
        geometry_type: "box",
        transform: { position: [1, 0, 2], rotation: [0, 0.2, 0], scale: [2, 1, 3] },
      },
    ]).project;
    const context = semanticContext({ project });
    const planned = await executeCreativeWorkspaceInterchangeRequest(
      {
        op: "interchange",
        request: {
          action: "plan-export",
          format: "obj",
          workspace: "stage",
          object_ids: ["agent-export-box"],
          max_inline_bytes: 512 * 1024,
        },
      },
      context,
    );
    expect(planned).toMatchObject({
      result: {
        success: true,
        action: "plan-export",
        plan: {
          format: "obj",
          file_name: "director-stage-obj.zip",
          mime_type: "application/zip",
          payload_encoding: "base64",
          object_ids: ["agent-export-box"],
        },
      },
    });
    if (!planned.result.success || planned.result.action !== "plan-export") throw new Error("missing plan");

    const exported = await executeCreativeWorkspaceInterchangeRequest(
      {
        op: "interchange",
        request: {
          action: "export",
          plan_id: planned.result.plan.plan_id,
          expected_guard_fingerprint: planned.result.plan.guard.fingerprint,
        },
      },
      context,
    );
    if (!exported.result.success || exported.result.action !== "export") throw new Error("missing receipt");
    expect(exported.result.receipt).toMatchObject({ format: "obj", payload_encoding: "base64" });
    expect(exported.result.receipt.warnings.join(" ")).toContain("static primitive geometry");
    const zip = await JSZip.loadAsync(Buffer.from(exported.result.receipt.payload, "base64"));
    const manifest = JSON.parse(await zip.file("director-export.json")!.async("string"));
    expect(manifest).toMatchObject({
      format: "obj",
      scope: { mode: "selection", includedObjectIds: ["agent-export-box"] },
      coordinateSystem: { metersPerUnit: 1, upAxis: "Y", handedness: "right" },
    });
    expect(zip.file("director-scene.obj")).not.toBeNull();
  });

  it("exports successfully when the workspace changes during payload serialization", async () => {
    let fingerprintCalls = 0;
    const base = semanticContext();
    const context: CreativeWorkspaceSemanticContext = {
      ...base,
      getCreativeSnapshotFingerprint: () => {
        fingerprintCalls += 1;
        return fingerprintCalls <= 2 ? "creative-revision:v1:during-a" : "creative-revision:v1:during-b";
      },
    };

    const planned = await executeCreativeWorkspaceInterchangeRequest(
      {
        op: "interchange",
        request: { action: "plan-export", format: "otio", workspace: "video", max_inline_bytes: 64 * 1024 },
      },
      context,
    );
    if (!planned.result.success || planned.result.action !== "plan-export") throw new Error("missing plan");
    expect(planned.result.plan.guard.fingerprint).toBe("creative-revision:v1:during-a");

    const exported = await executeCreativeWorkspaceInterchangeRequest(
      {
        op: "interchange",
        request: {
          action: "export",
          plan_id: planned.result.plan.plan_id,
          expected_guard_fingerprint: planned.result.plan.guard.fingerprint,
        },
      },
      context,
    );
    expect(exported).toMatchObject({
      result: {
        success: true,
        action: "export",
        receipt: { guard: { kind: "creative_snapshot", fingerprint: "creative-revision:v1:during-a" } },
      },
    });
    expect(fingerprintCalls).toBe(2);
  });

  it("rejects unsupported workspace/format pairs and stale export plans without serializing", async () => {
    let fingerprint = "creative-revision:v1:5";
    const base = semanticContext({ creativeFingerprint: fingerprint });
    const context: CreativeWorkspaceSemanticContext = {
      ...base,
      getCreativeSnapshotFingerprint: () => fingerprint,
    };
    const unsupported = await executeCreativeWorkspaceInterchangeRequest(
      {
        op: "interchange",
        request: { action: "plan-export", format: "glb", workspace: "video", max_inline_bytes: 4_096 },
      },
      context,
    );
    expect(unsupported).toMatchObject({ result: { success: false, code: "unsupported" } });

    const unsupportedScope = await executeCreativeWorkspaceInterchangeRequest(
      {
        op: "interchange",
        request: {
          action: "plan-export",
          format: "gltf",
          workspace: "stage",
          object_ids: ["char_default_a"],
          max_inline_bytes: 4_096,
        },
      },
      context,
    );
    expect(unsupportedScope).toMatchObject({ result: { success: false, code: "unsupported" } });

    const planned = await executeCreativeWorkspaceInterchangeRequest(
      {
        op: "interchange",
        request: { action: "plan-export", format: "otio", workspace: "video", max_inline_bytes: 64 * 1024 },
      },
      context,
    );
    if (!planned.result.success || planned.result.action !== "plan-export") throw new Error("missing plan");
    fingerprint = "creative-revision:v1:6";
    const stale = await executeCreativeWorkspaceInterchangeRequest(
      {
        op: "interchange",
        request: {
          action: "export",
          plan_id: planned.result.plan.plan_id,
          expected_guard_fingerprint: planned.result.plan.guard.fingerprint,
        },
      },
      context,
    );
    expect(stale).toMatchObject({
      result: { success: false, code: "stale_guard", current_guard: { fingerprint } },
    });
  });

  it("observes a bound Yjs room, adds an anchored comment, and lists it", async () => {
    let id = 0;
    const session = new DirectorCollaborationSession({
      scopeId: "semantic-scene",
      identity: { id: "agent-review", name: "Director Agent", color: "#7c5cff" },
      now: () => new Date("2026-08-03T08:00:00.000Z"),
      createId: (prefix) => `${prefix}-${++id}`,
    });
    const project = createDefaultDirectorProject();
    const creative = useDirectorCreativeWorkspaceStore.getState();
    session.setSharedState({ stage: projectForDirectorCollaboration(project), creative: sharedCreative(creative) });
    const context = semanticContext({ session });

    const observed = await executeCreativeWorkspaceCollaborationRequest(
      { op: "collaboration", request: { action: "observe" } },
      context,
    );
    expect(observed).toMatchObject({
      result: {
        success: true,
        state: { room_id: "semantic-scene", ready: true, agent_identity: { id: "agent-review" } },
      },
    });
    if (!observed.result.success || observed.result.action !== "observe") throw new Error("missing state");
    const request = {
      op: "collaboration" as const,
      request: {
        action: "add-comment" as const,
        anchor: { type: "object" as const, scene_id: "semantic-scene", object_id: project.objects[0]!.id },
        body: "Move this character closer to the fountain.",
        expected_collaboration_fingerprint: observed.result.state.collaboration_fingerprint,
        idempotency_key: "semantic-comment-add-v1",
      },
    };
    const added = await executeCreativeWorkspaceCollaborationRequest(request, context);
    expect(added).toMatchObject({
      result: {
        success: true,
        receipt: {
          comment: { anchor: request.request.anchor, author: { id: "agent-review" } },
        },
      },
    });
    if (!added.result.success || !("receipt" in added.result)) throw new Error("Expected an add-comment receipt");
    const addedReceipt = added.result.receipt;
    if (addedReceipt.contract !== "director-collaboration-comment-v1") {
      throw new Error("Expected a comment receipt");
    }
    expect(addedReceipt.after_fingerprint).not.toBe(observed.result.state.collaboration_fingerprint);

    // Retry the exact first request even though the fingerprint advanced after the write.
    const replayed = await executeCreativeWorkspaceCollaborationRequest(request, context);
    expect(replayed).toMatchObject({
      result: {
        success: true,
        receipt: { comment: { id: addedReceipt.comment.id }, idempotency: { replayed: true } },
      },
    });

    const listed = await executeCreativeWorkspaceCollaborationRequest(
      { op: "collaboration", request: { action: "list-comments", status: "open" } },
      context,
    );
    expect(listed).toMatchObject({
      result: { success: true, comments: [expect.objectContaining({ body: request.request.body })] },
    });
    session.destroy();
  });

  it("lists and compares exact version IDs and refuses invalid or stale comment anchors", async () => {
    const session = new DirectorCollaborationSession({
      scopeId: "semantic-scene",
      identity: { id: "agent-review", name: "Director Agent", color: "#7c5cff" },
      createId: (prefix) => `${prefix}-fixed`,
    });
    const project = createDefaultDirectorProject();
    const creative = useDirectorCreativeWorkspaceStore.getState();
    session.setSharedState({ stage: projectForDirectorCollaboration(project), creative: sharedCreative(creative) });
    const version = session.createVersionSnapshot({ name: "Blocking v1" });
    const context = semanticContext({ session });

    const versions = await executeCreativeWorkspaceCollaborationRequest(
      { op: "collaboration", request: { action: "list-versions" } },
      context,
    );
    expect(versions).toMatchObject({ result: { success: true, versions: [{ id: version.id, name: "Blocking v1" }] } });
    const compared = await executeCreativeWorkspaceCollaborationRequest(
      {
        op: "collaboration",
        request: { action: "compare", before_version_id: version.id },
      },
      context,
    );
    expect(compared).toMatchObject({
      result: { success: true, comparison: { before_version_id: version.id, after_version_id: null } },
    });

    const observed = await executeCreativeWorkspaceCollaborationRequest(
      { op: "collaboration", request: { action: "observe" } },
      context,
    );
    if (!observed.result.success || observed.result.action !== "observe") throw new Error("missing state");
    const invalid = await executeCreativeWorkspaceCollaborationRequest(
      {
        op: "collaboration",
        request: {
          action: "add-comment",
          anchor: { type: "object", scene_id: "semantic-scene", object_id: "missing-object" },
          body: "This must not be accepted.",
          expected_collaboration_fingerprint: observed.result.state.collaboration_fingerprint,
          idempotency_key: "semantic-comment-invalid-v1",
        },
      },
      context,
    );
    expect(invalid).toMatchObject({ result: { success: false, code: "invalid_anchor" } });
    session.destroy();
  });

  it("resolves comments and creates, restores, and deletes named versions", async () => {
    let id = 0;
    const session = new DirectorCollaborationSession({
      scopeId: "semantic-scene",
      identity: { id: "agent-review", name: "Director Agent", color: "#7c5cff" },
      now: () => new Date("2026-08-03T09:00:00.000Z"),
      createId: (prefix) => `${prefix}-${++id}`,
    });
    const project = createDefaultDirectorProject();
    const creative = useDirectorCreativeWorkspaceStore.getState();
    session.setSharedState({ stage: projectForDirectorCollaboration(project), creative: sharedCreative(creative) });
    const context = semanticContext({ session });

    const observed = await executeCreativeWorkspaceCollaborationRequest(
      { op: "collaboration", request: { action: "observe" } },
      context,
    );
    if (!observed.result.success || observed.result.action !== "observe") throw new Error("missing state");
    const fingerprint = observed.result.state.collaboration_fingerprint;

    const added = await executeCreativeWorkspaceCollaborationRequest(
      {
        op: "collaboration",
        request: {
          action: "add-comment",
          anchor: { type: "object", scene_id: "semantic-scene", object_id: project.objects[0]!.id },
          body: "Review this prop.",
          expected_collaboration_fingerprint: fingerprint,
          idempotency_key: "semantic-comment-resolve-v1",
        },
      },
      context,
    );
    if (!added.result.success || !("receipt" in added.result) || !("comment" in added.result.receipt)) {
      throw new Error("Expected an add-comment receipt");
    }
    const commentId = added.result.receipt.comment.id;
    const afterAddFingerprint = added.result.receipt.after_fingerprint;

    const resolved = await executeCreativeWorkspaceCollaborationRequest(
      {
        op: "collaboration",
        request: {
          action: "resolve-comment",
          comment_id: commentId,
          expected_collaboration_fingerprint: afterAddFingerprint,
          idempotency_key: "semantic-comment-resolve-write-v1",
        },
      },
      context,
    );
    expect(resolved).toMatchObject({
      result: { success: true, receipt: { comment: { id: commentId, status: "resolved" } } },
    });
    if (!resolved.result.success || !("receipt" in resolved.result)) throw new Error("Expected resolve receipt");

    const created = await executeCreativeWorkspaceCollaborationRequest(
      {
        op: "collaboration",
        request: {
          action: "create-version",
          name: "Agent Snapshot",
          expected_collaboration_fingerprint: resolved.result.receipt.after_fingerprint,
          idempotency_key: "semantic-version-create-v1",
        },
      },
      context,
    );
    expect(created).toMatchObject({
      result: { success: true, receipt: { version: { name: "Agent Snapshot" } } },
    });
    if (
      !created.result.success ||
      !("receipt" in created.result) ||
      created.result.receipt.contract !== "director-collaboration-version-v1" ||
      !created.result.receipt.version_id
    ) {
      throw new Error("Expected create-version receipt");
    }
    const versionId = created.result.receipt.version_id;

    const restored = await executeCreativeWorkspaceCollaborationRequest(
      {
        op: "collaboration",
        request: {
          action: "restore-version",
          version_id: versionId,
          confirm: true,
          expected_collaboration_fingerprint: created.result.receipt.after_fingerprint,
          idempotency_key: "semantic-version-restore-v1",
        },
      },
      context,
    );
    expect(restored).toMatchObject({
      result: { success: true, receipt: { version_id: versionId } },
    });
    if (!restored.result.success || !("receipt" in restored.result)) throw new Error("Expected restore receipt");

    const deleted = await executeCreativeWorkspaceCollaborationRequest(
      {
        op: "collaboration",
        request: {
          action: "delete-version",
          version_id: versionId,
          confirm: true,
          expected_collaboration_fingerprint: restored.result.receipt.after_fingerprint,
          idempotency_key: "semantic-version-delete-v1",
        },
      },
      context,
    );
    expect(deleted).toMatchObject({
      result: { success: true, receipt: { version_id: versionId } },
    });
    session.destroy();
  });
});
