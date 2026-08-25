// @vitest-environment node

import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultScene } from "@director/stage-protocol";
import type { StageScene } from "@director/stage-protocol";
import { BLENDER_LIVE_CONTRACT } from "../../../../packages/protocol/src/blenderLiveProtocol";
import { filmRoleToolPolicyRejection } from "../../agents/filmRoleToolPolicy";
import type { ToolInvocationAuditEntry } from "../../agents/toolInvocationAuditStore";
import { resetAgentNaiveBoundaryForTests } from "../../agentNaiveBoundary";
import type { BlenderNativeSession } from "../../dcc/blenderNativeSession";
import type { BlenderBridge } from "../../dcc/blenderBridge";
import { handleBlenderLiveRoute, type BlenderLiveRouteDependencies } from "../../routes/blenderLiveRoutes";
import { handleDccRoute, type DccRouteDependencies } from "../../routes/dccRoutes";
import { handleSceneGenerationRoute } from "../../routes/sceneGenerationRoutes";
import {
  handleStageRoute,
  resetStageSessionLocksForTests,
  type StageRouteDependencies,
} from "../../routes/stageRoutes";

const sceneEpoch = "82a6f8c1-7cb8-4d6f-a5f2-a4f5654a0420";

function mockResponse() {
  return { end: vi.fn() } as unknown as ServerResponse;
}

function createStageHarness(body: unknown) {
  let scene: StageScene = createDefaultScene();
  const writes: Array<{ status: number; body: unknown }> = [];
  const audits: ToolInvocationAuditEntry[] = [];
  const dependencies: StageRouteDependencies = {
    readBody: vi.fn().mockResolvedValue(body),
    headers: vi.fn(),
    json: (_response, status, responseBody) => writes.push({ status, body: responseBody }),
    getScene: () => scene,
    replaceScene: (nextScene) => {
      scene = nextScene;
    },
    persistScene: vi.fn().mockResolvedValue(undefined),
    broadcast: vi.fn(),
    broadcastExcept: vi.fn(),
    readPreview: vi.fn().mockResolvedValue(null),
    previewMimeType: () => "image/png",
    requestCapture: vi.fn().mockResolvedValue(null),
    hasConnectedClient: () => false,
    savePreview: vi.fn().mockResolvedValue(undefined),
    previewUrl: () => "http://127.0.0.1:8787/api/preview",
    refsForSession: () => new Map(),
    requestWorkbenchCommand: vi.fn().mockResolvedValue(null),
    requestWorkbenchCapture: vi.fn().mockResolvedValue(null),
    requestCreativeWorkspaceCommand: vi.fn().mockResolvedValue(null),
    persistWorkbenchProject: vi.fn().mockResolvedValue(undefined),
    loadDisconnectedWorkbenchSources: vi.fn().mockResolvedValue({ project: null, blenderScene: null }),
    executeVideoModel: vi.fn().mockResolvedValue({ scene, success: true, result: { status: "prepared" } }),
    recordToolInvocation: (entry) => audits.push(entry),
  };
  return { dependencies, writes, audits };
}

function createBlenderHarness(body: unknown) {
  const writes: Array<{ status: number; body: unknown }> = [];
  const audits: ToolInvocationAuditEntry[] = [];
  const session: BlenderNativeSession = {
    status: vi.fn().mockResolvedValue({
      available: true,
      ok: true,
      contract: BLENDER_LIVE_CONTRACT,
      sceneEpoch,
      blenderVersion: "5.1.2",
      revision: 3,
      busy: false,
    }),
    snapshot: vi.fn(),
    submit: vi.fn(),
    job: vi.fn(),
    previewGlb: vi.fn(),
  };
  const dependencies: BlenderLiveRouteDependencies = {
    readBody: vi.fn().mockResolvedValue(body),
    json: (_response, status, responseBody) => writes.push({ status, body: responseBody }),
    session,
    recordToolInvocation: (entry) => audits.push(entry),
  };
  return { dependencies, session, writes, audits };
}

describe("gateway HTTP tool boundary role policy", () => {
  beforeEach(() => {
    resetAgentNaiveBoundaryForTests();
    resetStageSessionLocksForTests();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects visual-critic authoring on HTTP director_workbench exactly like MCP, before any browser call", async () => {
    vi.stubEnv("DIRECTOR_FILM_ROLE", "visual-critic");
    const input = { op: "author", action: "add_object" };
    const { dependencies, writes, audits } = createStageHarness({ input });

    const handled = await handleStageRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      dependencies,
    );

    expect(handled).toBe(true);
    expect(writes.at(-1)).toEqual({
      status: 403,
      body: filmRoleToolPolicyRejection("visual-critic", "director_workbench", input),
    });
    expect(dependencies.requestWorkbenchCommand).not.toHaveBeenCalled();
    expect(dependencies.requestWorkbenchCapture).not.toHaveBeenCalled();
    expect(audits).toEqual([
      expect.objectContaining({
        tool: "director_workbench",
        operation: "author.add_object",
        role: "visual-critic",
        session_id: "http-default",
        source: "http",
        outcome: "rejected",
        http_status: 403,
        error_code: "tool_policy_rejected",
      }),
    ]);
  });

  it("keeps visual-critic evidence operations available over HTTP", async () => {
    vi.stubEnv("DIRECTOR_FILM_ROLE", "visual-critic");
    const { dependencies, writes } = createStageHarness({ input: { op: "capture" } });

    await handleStageRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      dependencies,
    );

    expect(writes.at(-1)?.status).not.toBe(403);
    expect(writes.at(-1)?.body).not.toMatchObject({ code: "tool_policy_rejected" });
  });

  it("rejects the generation operator's Blender native edit via HTTP without touching the kernel", async () => {
    vi.stubEnv("DIRECTOR_FILM_ROLE", "generation-operator");
    const nativeEdit = {
      op: "apply",
      expectedSceneEpoch: sceneEpoch,
      expectedRevision: 3,
      operations: [{ op: "create_primitive", primitive: "cube", id: "operator-must-not-write" }],
    };
    const { dependencies, session, writes, audits } = createBlenderHarness({
      input: nativeEdit,
      session_id: "dsh-session-1",
    });

    const handled = await handleBlenderLiveRoute(
      { method: "POST", headers: {} } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/blender_native"),
      dependencies,
    );

    expect(handled).toBe(true);
    expect(writes.at(-1)).toEqual({
      status: 403,
      body: filmRoleToolPolicyRejection("generation-operator", "blender_native", nativeEdit),
    });
    expect(session.snapshot).not.toHaveBeenCalled();
    expect(session.submit).not.toHaveBeenCalled();
    expect(audits).toEqual([
      expect.objectContaining({
        tool: "blender_native",
        operation: "apply",
        role: "generation-operator",
        source: "dsh",
        outcome: "rejected",
        http_status: 403,
      }),
    ]);
  });

  it("allows the generation operator's read-only Blender status and audits the success", async () => {
    vi.stubEnv("DIRECTOR_FILM_ROLE", "generation-operator");
    const { dependencies, session, writes, audits } = createBlenderHarness({
      input: { op: "status" },
      session_id: "cli-default",
    });

    await handleBlenderLiveRoute(
      { method: "POST", headers: {} } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/blender_native"),
      dependencies,
    );

    expect(session.status).toHaveBeenCalled();
    expect(writes.at(-1)?.status).toBe(200);
    expect(audits).toEqual([
      expect.objectContaining({
        tool: "blender_native",
        operation: "status",
        source: "cli",
        outcome: "succeeded",
        http_status: 200,
      }),
    ]);
  });

  it("rejects director_dcc for stage authors because the role cannot see the tool on MCP", async () => {
    vi.stubEnv("DIRECTOR_FILM_ROLE", "stage-director");
    const writes: Array<{ status: number; body: unknown }> = [];
    const audits: ToolInvocationAuditEntry[] = [];
    const blender = { status: vi.fn() } as unknown as BlenderBridge;
    const dependencies: DccRouteDependencies = {
      readBody: vi.fn().mockResolvedValue({ input: { op: "status" }, session_id: "mcp-77-abc" }),
      json: (_response, status, body) => writes.push({ status, body }),
      getProject: vi.fn(),
      blender,
      recordToolInvocation: (entry) => audits.push(entry),
    };

    const handled = await handleDccRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/director_dcc"),
      dependencies,
    );

    expect(handled).toBe(true);
    expect(writes.at(-1)).toMatchObject({ status: 403, body: { success: false, code: "tool_policy_rejected" } });
    expect(blender.status).not.toHaveBeenCalled();
    expect(dependencies.getProject).not.toHaveBeenCalled();
    expect(audits).toEqual([
      expect.objectContaining({ tool: "director_dcc", source: "mcp", outcome: "rejected", http_status: 403 }),
    ]);
  });

  it("keeps director_dcc available without a role", async () => {
    const writes: Array<{ status: number; body: unknown }> = [];
    const blender = {
      status: vi.fn().mockResolvedValue({ available: false, reason: "offline" }),
    } as unknown as BlenderBridge;
    const dependencies: DccRouteDependencies = {
      readBody: vi.fn().mockResolvedValue({ input: { op: "status" } }),
      json: (_response, status, body) => writes.push({ status, body }),
      getProject: vi.fn(),
      blender,
    };

    await handleDccRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/director_dcc"),
      dependencies,
    );

    expect(writes.at(-1)?.status).toBe(200);
    expect(blender.status).toHaveBeenCalled();
  });

  it("rejects generate_scene for restricted roles before resolving any model provider", async () => {
    vi.stubEnv("DIRECTOR_FILM_ROLE", "stage-director");
    const writes: Array<{ status: number; body: unknown }> = [];
    const audits: ToolInvocationAuditEntry[] = [];
    const resolveProvider = vi.fn();
    const handled = await handleSceneGenerationRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/generate_scene"),
      {
        readBody: vi.fn().mockResolvedValue({ prompt: "a loft", session_id: "http-default" }),
        json: (_response, status, body) => writes.push({ status, body }),
        resolveProvider,
        recordToolInvocation: (entry) => audits.push(entry),
      },
    );

    expect(handled).toBe(true);
    expect(writes.at(-1)).toMatchObject({ status: 403, body: { success: false, code: "tool_policy_rejected" } });
    expect(resolveProvider).not.toHaveBeenCalled();
    expect(audits).toEqual([
      expect.objectContaining({ tool: "generate_scene", source: "http", outcome: "rejected", http_status: 403 }),
    ]);
  });

  it("allows tools without a role but blocks mutating operations in plan mode", async () => {
    const allowed = createStageHarness({ input: { op: "scene_state" }, session_id: "cli-default" });
    await handleStageRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/stage_read"),
      allowed.dependencies,
    );
    expect(allowed.writes.at(-1)).toMatchObject({ status: 200, body: { success: true } });
    expect(allowed.audits).toEqual([
      expect.objectContaining({
        tool: "stage_read",
        operation: "scene_state",
        role: null,
        source: "cli",
        outcome: "succeeded",
        http_status: 200,
      }),
    ]);

    vi.stubEnv("DIRECTOR_PLAN_MODE", "1");
    const blocked = createStageHarness({ input: { op: "author", action: "add_object" } });
    await handleStageRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      blocked.dependencies,
    );
    expect(blocked.writes.at(-1)).toMatchObject({ status: 403, body: { code: "plan_mode_blocked" } });
    expect(blocked.dependencies.requestWorkbenchCommand).not.toHaveBeenCalled();
    expect(blocked.audits).toEqual([
      expect.objectContaining({ outcome: "rejected", error_code: "plan_mode_blocked", http_status: 403 }),
    ]);

    const observe = createStageHarness({ input: { op: "observe" } });
    await handleStageRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      observe.dependencies,
    );
    expect(observe.writes.at(-1)?.body).not.toMatchObject({ code: "plan_mode_blocked" });
  });

  it("fails closed on an unknown DIRECTOR_FILM_ROLE", async () => {
    vi.stubEnv("DIRECTOR_FILM_ROLE", "gaffer");
    const { dependencies, writes } = createStageHarness({ input: { op: "observe" } });

    await handleStageRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      dependencies,
    );

    expect(writes.at(-1)).toMatchObject({ status: 403, body: { success: false, code: "tool_policy_rejected" } });
    expect(dependencies.requestWorkbenchCommand).not.toHaveBeenCalled();
  });
});
