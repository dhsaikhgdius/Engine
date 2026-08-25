import { afterEach, describe, expect, it } from "vitest";
import {
  setDirectorCreativeWorkspaceScope,
  useDirectorCreativeWorkspaceStore,
} from "../../src/comprehensive/editor/workspaces/directorWorkspaceStore";
import { createDefaultDirectorProject, useDirectorStore } from "../../src/comprehensive/editor/store/directorStore";
import { getDirectorProjectRevision } from "@director/project-schema";
import type { DirectorAgentTargetWire } from "@director/protocol/agentGatewayProtocol";
import {
  createGatewayToolRequestEnvelope,
  createDirectorGatewayPresence,
  directorWorkbenchCaptureFailure,
  directorWorkbenchDeliveryFailure,
  directorAgentTargetMatchesBrowserContext,
  viewportCaptureUnavailableResult,
  withStaleAfterCapture,
} from "../../src/agent/gatewayClient";
import { parseDirectorWorkbenchExecutableInput } from "@director/agent-engine/contract";
import {
  DirectorProjectRevisionConflictError,
  runWithDirectorProjectRevision,
} from "../../src/agent/directorRevisionBoundCapture";

afterEach(() => {
  setDirectorCreativeWorkspaceScope("");
});

const TARGET: DirectorAgentTargetWire = {
  token: "target-browser-scene-1",
  client_id: "browser-1",
  instance_id: "scene-1",
  scene_id: "scene-1",
  creative_scope_id: "scene-1",
  contract_version: 2,
};

describe("browser Agent target binding", () => {
  it("matches the complete client, instance, scene, and Creative scope identity", () => {
    const context = { clientId: "browser-1", sceneId: "scene-1", creativeScopeId: "scene-1" };
    expect(directorAgentTargetMatchesBrowserContext(TARGET, context)).toBe(true);
    expect(directorAgentTargetMatchesBrowserContext({ ...TARGET, client_id: "browser-2" }, context)).toBe(false);
    expect(directorAgentTargetMatchesBrowserContext({ ...TARGET, instance_id: "scene-2" }, context)).toBe(false);
    expect(directorAgentTargetMatchesBrowserContext({ ...TARGET, scene_id: "scene-2" }, context)).toBe(false);
    expect(directorAgentTargetMatchesBrowserContext({ ...TARGET, creative_scope_id: "scope-2" }, context)).toBe(false);
  });

  it("automatically attaches the token for Workbench and Creative calls and refuses an unbound call", () => {
    expect(createGatewayToolRequestEnvelope("director_workbench", { op: "observe" }, "browser-ui", TARGET)).toEqual({
      input: { op: "observe" },
      session_id: "browser-ui",
      target_token: TARGET.token,
    });
    expect(createGatewayToolRequestEnvelope("director_creative", { op: "observe" }, "browser-ui", TARGET)).toEqual({
      input: { op: "observe" },
      session_id: "browser-ui",
      target_token: TARGET.token,
    });
    expect(() => createGatewayToolRequestEnvelope("director_workbench", { op: "observe" }, "browser-ui")).toThrow(
      "requires an exact browser target binding",
    );
    expect(createGatewayToolRequestEnvelope("stage_read", { op: "scene_state" }, "browser-ui")).toEqual({
      input: { op: "scene_state" },
      session_id: "browser-ui",
    });
  });

  it("announces the actual normalized Creative workspace scope", () => {
    setDirectorCreativeWorkspaceScope(" scene / alpha ");
    useDirectorCreativeWorkspaceStore.getState().setMode("canvas");

    expect(
      createDirectorGatewayPresence({
        clientId: "browser-1",
        sceneId: "scene / alpha",
        visible: true,
        workspace: "canvas",
        captureReady: true,
      }),
    ).toMatchObject({
      scene_id: "scene / alpha",
      creative_scope_id: "scene_alpha",
      workspace: "canvas",
      capture_ready: true,
    });
  });

  it("maps only capture-host lifecycle failures to capture_unavailable", () => {
    expect(viewportCaptureUnavailableResult(new Error("Viewport capture handler is not registered"))).toMatchObject({
      code: "capture_unavailable",
    });
    expect(
      viewportCaptureUnavailableResult(
        new DOMException("Viewport capture handler was unregistered during capture", "AbortError"),
      ),
    ).toMatchObject({ code: "capture_unavailable" });
    expect(
      viewportCaptureUnavailableResult(new DOMException("Director gateway command cancelled: timeout", "AbortError")),
    ).toBeNull();
    expect(viewportCaptureUnavailableResult(new DOMException("Viewport capture aborted", "AbortError"))).toBeNull();
  });

  it("preserves revision-conflict evidence for deliver and capture failures", () => {
    const expectedRevision = `director-project-revision:v1:sha256:${"a".repeat(64)}`;
    const actualRevision = `director-project-revision:v1:sha256:${"b".repeat(64)}`;
    const currentRevision = `director-project-revision:v1:sha256:${"c".repeat(64)}`;
    const conflict = new DirectorProjectRevisionConflictError(expectedRevision, actualRevision, "during");

    expect(
      directorWorkbenchDeliveryFailure(
        conflict,
        {
          audit_token: "workbench-audit-7",
          project_revision: expectedRevision,
        },
        currentRevision,
      ),
    ).toMatchObject({
      success: false,
      result: {
        audit_token: "workbench-audit-7",
        code: "stale_project_revision",
        expected_revision: expectedRevision,
        actual_revision: actualRevision,
        project_revision: currentRevision,
        ready: false,
        status: "capture-stale",
        capture_verified: false,
      },
    });
    expect(directorWorkbenchCaptureFailure(conflict)).toMatchObject({
      success: false,
      result: {
        code: "stale_project_revision",
        expected_revision: expectedRevision,
        actual_revision: actualRevision,
      },
    });
  });

  it("keeps completed capture evidence when the live scene revision moves afterwards", () => {
    const expectedRevision = `director-project-revision:v1:sha256:${"a".repeat(64)}`;
    const actualRevision = `director-project-revision:v1:sha256:${"b".repeat(64)}`;
    expect(
      withStaleAfterCapture(
        { success: true, result: { label: "机位01", capture_verified: true } },
        expectedRevision,
        actualRevision,
      ),
    ).toMatchObject({
      success: true,
      result: {
        label: "机位01",
        capture_verified: true,
        stale_after_capture: true,
        code: "stale_project_revision",
        expected_revision: expectedRevision,
        actual_revision: actualRevision,
      },
    });
    expect(
      withStaleAfterCapture({ success: true, result: { label: "机位01" } }, expectedRevision, expectedRevision),
    ).toMatchObject({ success: true, result: { label: "机位01" } });
  });

  it("self-binds evidence to the current project revision when expected_revision is omitted", async () => {
    useDirectorStore.getState().replaceProject(createDefaultDirectorProject());
    const executable = parseDirectorWorkbenchExecutableInput({ op: "capture", camera_id: "cam_1", frame: 0 });
    expect(executable).toMatchObject({ success: true });
    if (!executable.success || executable.operation.op !== "capture") throw new Error("unexpected parse result");

    const boundRevision =
      executable.operation.expected_revision ?? getDirectorProjectRevision(useDirectorStore.getState().project);
    await expect(runWithDirectorProjectRevision(boundRevision, async () => "frame")).resolves.toBe("frame");
    expect(boundRevision).toBe(getDirectorProjectRevision(useDirectorStore.getState().project));
  });
});
