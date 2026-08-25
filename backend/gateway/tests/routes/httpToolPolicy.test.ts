// @vitest-environment node

import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultScene } from "@director/stage-protocol";
import type { StageScene } from "@director/stage-protocol";
import { BLENDER_LIVE_CONTRACT } from "../../../../packages/protocol/src/blenderLiveProtocol";
import { resetAgentNaiveBoundaryForTests } from "../../agentNaiveBoundary";
import { AgentToolAuditStore } from "../../agentToolAuditStore";
import type { HttpToolGovernanceDependencies } from "../../agents/httpToolGovernance";
import type { BlenderNativeSession } from "../../dcc/blenderNativeSession";
import { handleBlenderLiveRoute, type BlenderLiveRouteDependencies } from "../../routes/blenderLiveRoutes";
import { handleDccRoute, type DccRouteDependencies } from "../../routes/dccRoutes";
import { handleSceneGenerationRoute } from "../../routes/sceneGenerationRoutes";
import {
  handleStageRoute,
  resetStageSessionLocksForTests,
  type StageRouteDependencies,
} from "../../routes/stageRoutes";

const REVISION_A = `director-project-revision:v1:sha256:${"a".repeat(64)}`;
const sceneEpoch = "82a6f8c1-7cb8-4d6f-a5f2-a4f5654a0420";

const TARGET = {
  token: "target-1",
  client_id: "browser-1",
  instance_id: "scene-1",
  scene_id: "scene-1",
  creative_scope_id: "scene-1",
  contract_version: 2 as const,
};

const temporaryRoots: string[] = [];

async function temporaryAuditStore() {
  const directory = await mkdtemp(resolve(tmpdir(), "director-http-policy-audit-"));
  temporaryRoots.push(directory);
  return new AgentToolAuditStore(directory);
}

function request(headers: Record<string, string> = {}): IncomingMessage {
  return { method: "POST", headers } as unknown as IncomingMessage;
}

function mockResponse() {
  return { end: vi.fn() } as unknown as ServerResponse;
}

function createStageDependencies(body: unknown, governance?: HttpToolGovernanceDependencies) {
  let scene: StageScene = createDefaultScene();
  const json = vi.fn();
  const dependencies: StageRouteDependencies = {
    readBody: vi.fn().mockResolvedValue(body),
    headers: vi.fn(),
    json,
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
    requestWorkbenchCommand: vi.fn().mockResolvedValue({
      client: {},
      target: TARGET,
      response: { success: true, result: { project_revision: REVISION_A, counts: { objects: 0 } } },
    }),
    requestWorkbenchCapture: vi.fn().mockResolvedValue(null),
    requestCreativeWorkspaceCommand: vi.fn().mockResolvedValue(null),
    persistWorkbenchProject: vi.fn().mockResolvedValue(undefined),
    loadDisconnectedWorkbenchSources: vi.fn().mockResolvedValue({ project: null, blenderScene: null }),
    executeVideoModel: vi.fn().mockResolvedValue({ scene, success: true, result: { status: "prepared" } }),
    ...(governance ? { governance } : {}),
  };
  return { dependencies, json };
}

function createBlenderDependencies(body: unknown, governance?: HttpToolGovernanceDependencies) {
  const writes: Array<{ status: number; body: unknown }> = [];
  const jobId = "21c84665-2730-4248-9a0e-45b798b5b3fe";
  const requestId = "63a521f0-7fe3-4fd7-8e06-8457e806c6b3";
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
    snapshot: vi.fn().mockResolvedValue({
      contract: BLENDER_LIVE_CONTRACT,
      sceneEpoch,
      revision: 3,
      sceneName: "Scene",
      frame: 1,
      unit: "meter",
      coordinateSystem: "right-handed-y-up-negative-z-forward",
      objects: [],
      cameras: [],
    }),
    submit: vi.fn().mockResolvedValue({
      contract: BLENDER_LIVE_CONTRACT,
      jobId,
      requestId,
      status: "queued",
    }),
    job: vi.fn().mockResolvedValue({
      contract: BLENDER_LIVE_CONTRACT,
      jobId,
      requestId,
      status: "succeeded",
      revision: 4,
      result: undefined,
      error: null,
    }),
    previewGlb: vi.fn(),
  } as unknown as BlenderNativeSession;
  const dependencies: BlenderLiveRouteDependencies = {
    readBody: vi.fn().mockResolvedValue(body),
    json: (_response, status, responseBody) => writes.push({ status, body: responseBody }),
    session,
    ...(governance ? { governance } : {}),
  };
  return { dependencies, writes, session };
}

beforeEach(() => {
  resetAgentNaiveBoundaryForTests();
  resetStageSessionLocksForTests();
});

afterEach(async () => {
  // Retries absorb the race with a best-effort audit write still landing its temp file.
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  );
});

describe("raw HTTP film-role policy on POST /api/tools", () => {
  it("denies a visual-critic author on director_workbench with 403 and the MCP rejection shape", async () => {
    const { dependencies, json } = createStageDependencies(
      { input: { op: "author", actions: [{ action: "set_scene", patch: { backgroundColor: "#222222" } }] } },
      { filmRoleId: "visual-critic" },
    );

    const handled = await handleStageRoute(
      request(),
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      dependencies,
    );

    expect(handled).toBe(true);
    expect(dependencies.requestWorkbenchCommand).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(expect.anything(), 403, {
      success: false,
      code: "tool_policy_rejected",
      error: "visual-critic is not allowed to execute director_workbench with this operation",
    });
  });

  it("still allows a visual-critic observe on director_workbench", async () => {
    const { dependencies, json } = createStageDependencies(
      { input: { op: "observe", fields: ["counts"] } },
      { filmRoleId: "visual-critic" },
    );

    await handleStageRoute(
      request(),
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      dependencies,
    );

    expect(dependencies.requestWorkbenchCommand).toHaveBeenCalled();
    expect(json).toHaveBeenLastCalledWith(expect.anything(), 200, expect.objectContaining({ success: true }));
  });

  it("keeps the null role unrestricted so existing HTTP authors still pass", async () => {
    const { dependencies, json } = createStageDependencies(
      {
        session_id: "route-agent-session",
        target_token: TARGET.token,
        input: { op: "author", actions: [{ action: "set_scene", patch: { backgroundColor: "#222222" } }] },
      },
      { filmRoleId: null },
    );
    dependencies.requestWorkbenchCommand = vi
      .fn()
      .mockResolvedValueOnce({
        client: {},
        target: TARGET,
        response: { success: true, result: { project_revision: REVISION_A } },
      })
      .mockResolvedValueOnce({
        client: {},
        target: TARGET,
        response: { success: true, result: { changed: true } },
      });

    await handleStageRoute(
      request(),
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      dependencies,
    );

    expect(json).toHaveBeenLastCalledWith(expect.anything(), 200, expect.objectContaining({ success: true }));
  });

  it("denies the same CLI call through role and source headers exactly like MCP", async () => {
    const { dependencies, json } = createStageDependencies({
      session_id: "cli-default",
      input: { op: "author", actions: [{ action: "set_scene", patch: { backgroundColor: "#111111" } }] },
    });

    await handleStageRoute(
      request({ "x-director-film-role": "visual-critic", "x-director-tool-source": "cli" }),
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      dependencies,
    );

    expect(dependencies.requestWorkbenchCommand).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(
      expect.anything(),
      403,
      expect.objectContaining({ success: false, code: "tool_policy_rejected" }),
    );
  });

  it("fails closed with 400 on an unknown film-role header", async () => {
    const { dependencies, json } = createStageDependencies({ input: { op: "observe" } });

    await handleStageRoute(
      request({ "x-director-film-role": "gaffer" }),
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      dependencies,
    );

    expect(dependencies.requestWorkbenchCommand).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(
      expect.anything(),
      400,
      expect.objectContaining({ success: false, code: "invalid_film_role" }),
    );
  });

  it("blocks mutating workbench calls when plan mode is injected", async () => {
    const { dependencies, json } = createStageDependencies(
      { input: { op: "author", actions: [{ action: "set_scene", patch: { backgroundColor: "#333333" } }] } },
      { filmRoleId: null, planMode: true },
    );

    await handleStageRoute(
      request(),
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      dependencies,
    );

    expect(json).toHaveBeenCalledWith(
      expect.anything(),
      403,
      expect.objectContaining({ success: false, code: "plan_mode_blocked" }),
    );
  });

  it("denies a visual-critic blender_native apply while keeping read ops allowed", async () => {
    const denied = createBlenderDependencies(
      {
        input: { op: "apply", operations: [{ op: "create_primitive", id: "critic-cube", primitive: "cube" }] },
        session_id: "critic-session",
      },
      { filmRoleId: "visual-critic" },
    );

    await handleBlenderLiveRoute(
      request(),
      mockResponse(),
      new URL("http://director.test/api/tools/blender_native"),
      denied.dependencies,
    );

    expect(denied.session.submit).not.toHaveBeenCalled();
    expect(denied.writes.at(-1)).toEqual({
      status: 403,
      body: {
        success: false,
        code: "tool_policy_rejected",
        error: "visual-critic is not allowed to execute blender_native with this operation",
      },
    });

    const allowed = createBlenderDependencies({ input: { op: "status" } }, { filmRoleId: "visual-critic" });
    await handleBlenderLiveRoute(
      request(),
      mockResponse(),
      new URL("http://director.test/api/tools/blender_native"),
      allowed.dependencies,
    );
    expect(allowed.writes.at(-1)).toMatchObject({ status: 200, body: { success: true } });
  });

  it("keeps null-role blender_native applies working", async () => {
    const context = createBlenderDependencies(
      { input: { op: "apply", operations: [{ op: "create_primitive", id: "cube-a", primitive: "cube" }] } },
      { filmRoleId: null },
    );

    await handleBlenderLiveRoute(
      request(),
      mockResponse(),
      new URL("http://director.test/api/tools/blender_native"),
      context.dependencies,
    );

    expect(context.session.submit).toHaveBeenCalled();
    expect(context.writes.at(-1)).toMatchObject({ status: 200, body: { success: true } });
  });

  it("applies the same policy to director_dcc", async () => {
    const writes: Array<{ status: number; body: unknown }> = [];
    const dependencies: DccRouteDependencies = {
      readBody: vi.fn().mockResolvedValue({ input: { op: "status" } }),
      json: (_response, status, body) => writes.push({ status, body }),
      getProject: vi.fn().mockResolvedValue(null),
      blender: {
        status: vi.fn().mockResolvedValue({ available: false }),
      } as unknown as DccRouteDependencies["blender"],
      governance: { filmRoleId: "visual-critic" },
    };

    await handleDccRoute(
      request(),
      mockResponse(),
      new URL("http://director.test/api/tools/director_dcc"),
      dependencies,
    );
    expect(writes.at(-1)).toMatchObject({ status: 403, body: { success: false, code: "tool_policy_rejected" } });

    dependencies.governance = { filmRoleId: null };
    await handleDccRoute(
      request(),
      mockResponse(),
      new URL("http://director.test/api/tools/director_dcc"),
      dependencies,
    );
    expect(writes.at(-1)).toMatchObject({ status: 200, body: { success: true } });
  });

  it("applies the same policy to generate_scene", async () => {
    const writes: Array<{ status: number; body: unknown }> = [];
    const handled = await handleSceneGenerationRoute(
      request(),
      mockResponse(),
      new URL("http://director.test/api/tools/generate_scene"),
      {
        readBody: vi.fn().mockResolvedValue({ prompt: "A courtroom" }),
        json: (_response, status, body) => writes.push({ status, body }),
        resolveProvider: vi.fn(),
        governance: { filmRoleId: "visual-critic" },
      },
    );

    expect(handled).toBe(true);
    expect(writes.at(-1)).toMatchObject({ status: 403, body: { success: false, code: "tool_policy_rejected" } });
  });
});

describe("unified tool audit trail across entry points", () => {
  it("records rejections and successes with source tags and reconstructs a session chain", async () => {
    const auditStore = await temporaryAuditStore();

    const denied = createStageDependencies(
      {
        session_id: "mcp-chain-session",
        input: { op: "author", actions: [{ action: "set_scene", patch: { backgroundColor: "#000000" } }] },
      },
      { filmRoleId: "visual-critic", auditStore },
    );
    await handleStageRoute(
      request({ "x-director-tool-source": "mcp" }),
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      denied.dependencies,
    );

    const observed = createStageDependencies(
      { session_id: "mcp-chain-session", input: { op: "observe", fields: ["counts"] } },
      { filmRoleId: "visual-critic", auditStore },
    );
    await handleStageRoute(
      request({ "x-director-tool-source": "mcp" }),
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      observed.dependencies,
    );

    const cliDenied = createStageDependencies(
      {
        session_id: "cli-default",
        input: { op: "author", actions: [{ action: "set_scene", patch: { backgroundColor: "#ffffff" } }] },
      },
      { auditStore },
    );
    await handleStageRoute(
      request({ "x-director-film-role": "visual-critic", "x-director-tool-source": "cli" }),
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      cliDenied.dependencies,
    );

    await vi.waitFor(async () => {
      expect(await auditStore.list()).toHaveLength(3);
    });

    const chain = await auditStore.list({ sessionId: "mcp-chain-session" });
    expect(chain.map((record) => `${record.operation}:${record.outcome}:${record.source}`)).toEqual([
      "author:rejected:mcp",
      "observe:success:mcp",
    ]);
    expect(chain[0]).toMatchObject({ role: "visual-critic", code: "tool_policy_rejected", tool: "director_workbench" });
    expect(chain[1]).toMatchObject({ revision_after: REVISION_A });

    const cliRecords = await auditStore.list({ sessionId: "cli-default" });
    expect(cliRecords).toMatchObject([
      { outcome: "rejected", source: "cli", role: "visual-critic", code: "tool_policy_rejected" },
    ]);
  });

  it("records blender_native receipts with native revision evidence", async () => {
    const auditStore = await temporaryAuditStore();
    const context = createBlenderDependencies(
      {
        input: { op: "apply", operations: [{ op: "create_primitive", id: "cube-a", primitive: "cube" }] },
        session_id: "cli-blender",
      },
      { filmRoleId: null, auditStore },
    );

    await handleBlenderLiveRoute(
      request({ "x-director-tool-source": "cli" }),
      mockResponse(),
      new URL("http://director.test/api/tools/blender_native"),
      context.dependencies,
    );

    await vi.waitFor(async () => {
      expect(await auditStore.list()).toHaveLength(1);
    });
    expect((await auditStore.list())[0]).toMatchObject({
      tool: "blender_native",
      operation: "apply",
      outcome: "success",
      source: "cli",
      session_id: "cli-blender",
      revision_before: 3,
      revision_after: 3,
    });
  });

  it("never fails the tool call when the audit write throws", async () => {
    const auditStore = {
      record: vi.fn().mockRejectedValue(new Error("disk full")),
    } as unknown as AgentToolAuditStore;
    const { dependencies, json } = createStageDependencies(
      { input: { op: "observe", fields: ["counts"] } },
      { filmRoleId: null, auditStore },
    );

    await handleStageRoute(
      request(),
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      dependencies,
    );

    expect(json).toHaveBeenLastCalledWith(expect.anything(), 200, expect.objectContaining({ success: true }));
    await vi.waitFor(() => {
      expect(vi.mocked(auditStore.record)).toHaveBeenCalled();
    });
  });
});
