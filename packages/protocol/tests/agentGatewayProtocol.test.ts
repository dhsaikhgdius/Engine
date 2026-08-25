import { describe, expect, it } from "vitest";
import { createDefaultDirectorProject } from "@director/agent-engine/default-project";
import { createDefaultScene } from "@director/stage-protocol";
import { createEmptyCreativeWorkspaceAgentSnapshot } from "@director/agent-engine/creative";
import {
  directorCreativeWorkspaceCommandResponseWireSchema,
  directorAgentTargetWireSchema,
  directorGatewayInboundMessageSchema,
  directorPageStateWireSchema,
  directorWorkbenchCommandResponseWireSchema,
  isCurrentDirectorAgentTargetResponse,
  sameDirectorAgentTarget,
} from "../src/agentGatewayProtocol";

const TARGET = {
  token: "target-1",
  client_id: "browser-1",
  instance_id: "scene-1",
  scene_id: "scene-1",
  creative_scope_id: "scene-1",
  contract_version: 2 as const,
};

describe("shared agent gateway websocket protocol", () => {
  it("validates server state and complete-workbench messages at the browser boundary", () => {
    expect(
      directorGatewayInboundMessageSchema.safeParse({
        type: "target-bound",
        target: TARGET,
      }).success,
    ).toBe(true);
    expect(
      directorGatewayInboundMessageSchema.safeParse({
        type: "creative-workspace-command-request",
        requestId: "creative-pipeline-1",
        target: TARGET,
        input: { op: "pipeline", request: { action: "status", run_id: "canvas-run-1" } },
      }).success,
    ).toBe(true);
    expect(
      directorGatewayInboundMessageSchema.safeParse({
        type: "state",
        scene: createDefaultScene(),
        source: "gateway",
      }).success,
    ).toBe(true);
    expect(
      directorGatewayInboundMessageSchema.safeParse({
        type: "workbench-state",
        project: createDefaultDirectorProject(),
        source: "agent",
      }).success,
    ).toBe(true);
    expect(
      directorGatewayInboundMessageSchema.safeParse({
        type: "workbench-command-request",
        requestId: "request-1",
        target: TARGET,
        input: { op: "correct", audit_token: "workbench-audit-1" },
      }).success,
    ).toBe(true);
    expect(
      directorGatewayInboundMessageSchema.safeParse({
        type: "workbench-command-cancel",
        requestId: "request-1",
        target: TARGET,
        reason: "timeout",
      }).success,
    ).toBe(true);
    expect(
      directorGatewayInboundMessageSchema.safeParse({
        type: "workbench-command-request",
        requestId: "request-shot-ir",
        target: TARGET,
        input: { op: "shot_ir", camera_id: "cam_1", frame: 24 },
      }).success,
    ).toBe(true);
  });

  it("rejects malformed projects and unrecognized workbench operations", () => {
    expect(
      directorGatewayInboundMessageSchema.safeParse({
        type: "workbench-state",
        project: { version: 1, objects: "not-an-array" },
      }).success,
    ).toBe(false);
    expect(
      directorGatewayInboundMessageSchema.safeParse({
        type: "workbench-command-request",
        requestId: "request-invalid-shot-ir",
        target: TARGET,
        input: { op: "shot_ir", frame: -1 },
      }).success,
    ).toBe(false);
    expect(
      directorGatewayInboundMessageSchema.safeParse({
        type: "workbench-command-request",
        requestId: "request-2",
        target: TARGET,
        input: { op: "invented-operation" },
      }).success,
    ).toBe(false);
  });

  it("shares the complete workbench response contract with browser and server", () => {
    expect(
      directorWorkbenchCommandResponseWireSchema.safeParse({
        type: "workbench-command-response",
        requestId: "request-3",
        target: TARGET,
        success: true,
        result: { audit_token: "workbench-audit-2" },
        stageScene: createDefaultScene(),
        project: createDefaultDirectorProject(),
      }).success,
    ).toBe(true);
    expect(
      directorWorkbenchCommandResponseWireSchema.safeParse({
        type: "workbench-command-response",
        requestId: "request-4",
        target: TARGET,
        success: true,
        project: { version: 1, cameras: "invalid" },
      }).success,
    ).toBe(false);
  });

  it("validates creative Canvas/Video requests and complete browser responses", () => {
    expect(
      directorGatewayInboundMessageSchema.safeParse({
        type: "creative-workspace-command-request",
        requestId: "creative-request-1",
        target: TARGET,
        input: { op: "observe" },
      }).success,
    ).toBe(true);
    expect(
      directorGatewayInboundMessageSchema.safeParse({
        type: "creative-workspace-command-cancel",
        requestId: "creative-request-1",
        target: TARGET,
        reason: "target_unavailable",
      }).success,
    ).toBe(true);
    expect(
      directorGatewayInboundMessageSchema.safeParse({
        type: "creative-workspace-command-request",
        requestId: "creative-request-2",
        target: TARGET,
        input: {
          op: "execute",
          idempotency_key: "creative-seek-v1",
          expected_snapshot_fingerprint: `sha256:${"1".repeat(64)}`,
          operation: { op: "edit.seek", seconds: 2.5 },
        },
      }).success,
    ).toBe(true);
    expect(
      directorGatewayInboundMessageSchema.safeParse({
        type: "creative-workspace-command-request",
        requestId: "creative-request-invalid",
        target: TARGET,
        input: { op: "execute", operation: { op: "edit.seek", seconds: -1 } },
      }).success,
    ).toBe(false);

    expect(
      directorCreativeWorkspaceCommandResponseWireSchema.safeParse({
        type: "creative-workspace-command-response",
        requestId: "creative-request-1",
        target: TARGET,
        success: true,
        result: { op: "observe", snapshot: createEmptyCreativeWorkspaceAgentSnapshot() },
      }).success,
    ).toBe(true);
    expect(
      directorCreativeWorkspaceCommandResponseWireSchema.safeParse({
        type: "creative-workspace-command-response",
        requestId: "creative-pipeline-capabilities",
        target: TARGET,
        success: true,
        result: {
          op: "pipeline",
          result: {
            success: true,
            action: "capabilities",
            contract: "director-canvas-pipeline-agent-v1",
            actions: ["capabilities", "start", "status", "cancel"],
            execution: "topological-levels-with-bounded-parallelism",
            reference_binding: "direct-upstream-persistent-images",
          },
        },
      }).success,
    ).toBe(true);

    const previewDataUrl = "data:image/png;base64,aGVsbG8=";
    const previewResult = {
      op: "preview" as const,
      preview: {
        success: true as const,
        workspace: "canvas" as const,
        snapshot_fingerprint: `sha256:${"2".repeat(64)}`,
        mime_type: "image/png" as const,
        data_url: previewDataUrl,
        width: 1280,
        height: 720,
        clean_frame: true as const,
        helpers_included: false as const,
        metadata: {
          kind: "canvas_board" as const,
          node_count: 2,
          edge_count: 1,
          media_thumbnail_count: 1,
          world_bounds: { x: 0, y: 0, width: 640, height: 360 },
          render_scale: 1,
        },
      },
    };
    expect(
      directorCreativeWorkspaceCommandResponseWireSchema.safeParse({
        type: "creative-workspace-command-response",
        requestId: "creative-preview-1",
        target: TARGET,
        success: true,
        result: previewResult,
      }).success,
    ).toBe(true);
  });

  it("requires exact target binding on commands and responses", () => {
    expect(directorAgentTargetWireSchema.safeParse(TARGET).success).toBe(true);
    expect(
      directorGatewayInboundMessageSchema.safeParse({
        type: "workbench-command-request",
        requestId: "missing-target",
        input: { op: "observe" },
      }).success,
    ).toBe(false);
    expect(
      directorCreativeWorkspaceCommandResponseWireSchema.safeParse({
        type: "creative-workspace-command-response",
        requestId: "missing-target",
        success: false,
        error: "no target",
      }).success,
    ).toBe(false);
    expect(sameDirectorAgentTarget(TARGET, { ...TARGET })).toBe(true);
    expect(sameDirectorAgentTarget(TARGET, { ...TARGET, token: "rotated-target" })).toBe(false);
    expect(sameDirectorAgentTarget(TARGET, { ...TARGET, scene_id: "scene-2" })).toBe(false);
    expect(sameDirectorAgentTarget(TARGET, { ...TARGET, creative_scope_id: "scope-2" })).toBe(false);
    expect(isCurrentDirectorAgentTargetResponse(TARGET, { ...TARGET }, { ...TARGET })).toBe(true);
    expect(isCurrentDirectorAgentTargetResponse(TARGET, { ...TARGET, token: "rotated-target" }, { ...TARGET })).toBe(
      false,
    );
    expect(
      isCurrentDirectorAgentTargetResponse(TARGET, { ...TARGET }, { ...TARGET, scene_id: "late-response-scene" }),
    ).toBe(false);
  });

  it("validates transient viewport framing as a finite camera snapshot", () => {
    expect(
      directorPageStateWireSchema.safeParse({
        viewportCamera: { fov: 42, position: [1, 2, 3], target: [0, 1, 0] },
      }).success,
    ).toBe(true);
    expect(
      directorPageStateWireSchema.safeParse({
        viewportCamera: { fov: 0, position: [1, 2], target: [0, 1, 0] },
      }).success,
    ).toBe(false);
  });
});
