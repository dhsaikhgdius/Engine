// @vitest-environment node

import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultScene } from "@director/stage-protocol";
import type { StageScene } from "@director/stage-protocol";
import { resetAgentNaiveBoundaryForTests } from "../../agentNaiveBoundary";
import { AgentConfirmTokenStore } from "../../agentConfirmTokenStore";
import {
  CONFIRMABLE_TOOL_OPERATIONS,
  confirmableToolOperation,
  evaluateHttpToolConfirmation,
  toolInputCarriesProtocolConfirm,
  type HttpToolGovernanceDependencies,
} from "../../agents/httpToolGovernance";
import { handleAgentConfirmTokenRoute } from "../../routes/agentConfirmTokenRoutes";
import {
  handleStageRoute,
  resetStageSessionLocksForTests,
  type StageRouteDependencies,
} from "../../routes/stageRoutes";

const REVISION_A = `director-project-revision:v1:sha256:${"a".repeat(64)}`;

const TARGET = {
  token: "target-1",
  client_id: "browser-1",
  instance_id: "scene-1",
  scene_id: "scene-1",
  creative_scope_id: "scene-1",
  contract_version: 2 as const,
};

const temporaryRoots: string[] = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(resolve(tmpdir(), "director-confirm-tokens-"));
  temporaryRoots.push(directory);
  return directory;
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

beforeEach(() => {
  resetAgentNaiveBoundaryForTests();
  resetStageSessionLocksForTests();
});

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  );
});

describe("AgentConfirmTokenStore", () => {
  const binding = { tool: "director_workbench", operation: "deliver", role: null, sessionId: "cli-default" };

  it("issues single-use tokens and refuses replays", async () => {
    const store = new AgentConfirmTokenStore(await temporaryDirectory());
    const issued = await store.issue(binding);
    expect(issued.token).toMatch(/^dctk_/);
    expect(issued.ttlMs).toBe(2 * 60_000);

    await expect(store.consume(issued.token, binding)).resolves.toEqual({ ok: true });
    await expect(store.consume(issued.token, binding)).resolves.toEqual({ ok: false, reason: "already_used" });
    await expect(store.consume("dctk_never-issued", binding)).resolves.toEqual({ ok: false, reason: "invalid" });
  });

  it("refuses expired tokens", async () => {
    let clock = Date.parse("2026-08-25T10:00:00.000Z");
    const store = new AgentConfirmTokenStore(await temporaryDirectory(), 2 * 60_000, 500, () => clock);
    const issued = await store.issue(binding);
    clock += 2 * 60_000 + 1;
    await expect(store.consume(issued.token, binding)).resolves.toEqual({ ok: false, reason: "expired" });
  });

  it("binds the token to exact tool + operation + role + session", async () => {
    const store = new AgentConfirmTokenStore(await temporaryDirectory());
    const issued = await store.issue(binding);
    for (const wrong of [
      { ...binding, tool: "director_creative" },
      { ...binding, operation: "interchange.export" },
      { ...binding, role: "stage-director" },
      { ...binding, sessionId: "another-session" },
    ]) {
      await expect(store.consume(issued.token, wrong)).resolves.toEqual({ ok: false, reason: "binding_mismatch" });
    }
    // A mismatch never spends the token; the exact binding still consumes it.
    await expect(store.consume(issued.token, binding)).resolves.toEqual({ ok: true });
  });

  it("persists only SHA-256 hashes, never the raw token", async () => {
    const store = new AgentConfirmTokenStore(await temporaryDirectory());
    const issued = await store.issue(binding);
    const persisted = await readFile(store.filePath, "utf8");
    expect(persisted).not.toContain(issued.token);
    expect(persisted).toContain(createHash("sha256").update(issued.token).digest("hex"));

    // A fresh store instance reloads the hashed record and still consumes once.
    const reloaded = new AgentConfirmTokenStore(store.dataDirectory);
    await expect(reloaded.consume(issued.token, binding)).resolves.toEqual({ ok: true });
  });
});

describe("confirmable operation detection", () => {
  it("maps the closed destructive/publish list and nothing else", () => {
    expect(confirmableToolOperation("director_workbench", { op: "deliver", camera_id: "cam_1" })).toBe("deliver");
    expect(confirmableToolOperation("director_workbench", { op: "observe" })).toBeNull();
    expect(confirmableToolOperation("director_workbench", { op: "author", actions: [] })).toBeNull();
    expect(confirmableToolOperation("director_creative", { op: "interchange", request: { action: "export" } })).toBe(
      "interchange.export",
    );
    expect(confirmableToolOperation("director_creative", { op: "interchange", request: { action: "import" } })).toBe(
      "interchange.import",
    );
    expect(
      confirmableToolOperation("director_creative", { op: "interchange", request: { action: "plan-export" } }),
    ).toBeNull();
    for (const action of ["restore-version", "delete-version", "delete-comment"]) {
      expect(confirmableToolOperation("director_creative", { op: "collaboration", request: { action } })).toBe(
        `collaboration.${action}`,
      );
    }
    expect(
      confirmableToolOperation("director_creative", { op: "collaboration", request: { action: "list-versions" } }),
    ).toBeNull();
    expect(
      confirmableToolOperation("director_creative", { op: "execute", operation: { op: "gallery.media.purge" } }),
    ).toBe("gallery.media.purge");
    expect(
      confirmableToolOperation("director_creative", {
        op: "execute_batch",
        steps: [{ operation: { op: "canvas.production.configure" } }, { operation: { op: "gallery.media.purge" } }],
      }),
    ).toBe("gallery.media.purge");
    expect(
      confirmableToolOperation("director_creative", { op: "execute", operation: { op: "canvas.node.remove" } }),
    ).toBeNull();
    expect(confirmableToolOperation("blender_native", { op: "apply" })).toBeNull();
  });

  it("honors the protocol confirm literal exactly where the schemas define it", () => {
    expect(
      toolInputCarriesProtocolConfirm(
        "director_creative",
        { op: "collaboration", request: { action: "restore-version", confirm: true } },
        "collaboration.restore-version",
      ),
    ).toBe(true);
    expect(
      toolInputCarriesProtocolConfirm(
        "director_creative",
        { op: "collaboration", request: { action: "restore-version" } },
        "collaboration.restore-version",
      ),
    ).toBe(false);
    expect(
      toolInputCarriesProtocolConfirm(
        "director_creative",
        { op: "interchange", request: { action: "import", confirm: true } },
        "interchange.import",
      ),
    ).toBe(true);
    // export has no protocol confirm field, so a stray literal cannot satisfy it.
    expect(
      toolInputCarriesProtocolConfirm(
        "director_creative",
        { op: "interchange", request: { action: "export", confirm: true } },
        "interchange.export",
      ),
    ).toBe(false);
    expect(
      toolInputCarriesProtocolConfirm(
        "director_creative",
        { op: "execute", operation: { op: "gallery.media.purge", confirm: true } },
        "gallery.media.purge",
      ),
    ).toBe(true);
    expect(
      toolInputCarriesProtocolConfirm("director_workbench", { op: "deliver", confirm: true }, "deliver"),
    ).toBe(false);
  });

  it("lets the protocol confirm literal pass the confirmation gate without a token", async () => {
    const rejection = await evaluateHttpToolConfirmation({
      request: request(),
      tool: "director_creative",
      toolInput: { op: "collaboration", request: { action: "restore-version", version_id: "v1", confirm: true } },
      roleId: null,
      source: "http",
      sessionId: "session-1",
    });
    expect(rejection).toBeNull();
  });
});

describe("confirmation boundary on POST /api/tools", () => {
  async function confirmStore() {
    return new AgentConfirmTokenStore(await temporaryDirectory());
  }

  it("rejects deliver without confirmation with 403 confirm_required and an issue-on-deny payload", async () => {
    const confirmTokens = await confirmStore();
    const { dependencies, json } = createStageDependencies(
      { session_id: "cli-default", input: { op: "deliver", camera_id: "cam_1" } },
      { filmRoleId: null, confirmTokens },
    );

    await handleStageRoute(
      request(),
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      dependencies,
    );

    expect(dependencies.requestWorkbenchCommand).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(
      expect.anything(),
      403,
      expect.objectContaining({
        success: false,
        code: "confirm_required",
        confirm: expect.objectContaining({
          tool: "director_workbench",
          operation: "deliver",
          issue_endpoint: "POST /api/agent/confirm-token",
          issue_body: { tool: "director_workbench", operation: "deliver", session_id: "cli-default" },
          single_use: true,
        }),
      }),
    );
  });

  it("rejects interchange export and collaboration restore-version without confirmation", async () => {
    const confirmTokens = await confirmStore();
    for (const input of [
      { op: "interchange", request: { action: "export", format: "otioz" } },
      { op: "collaboration", request: { action: "restore-version", version_id: "v1" } },
    ]) {
      const { dependencies, json } = createStageDependencies(
        { session_id: "cli-default", input },
        { filmRoleId: null, confirmTokens },
      );
      await handleStageRoute(
        request(),
        mockResponse(),
        new URL("http://director.test/api/tools/director_creative"),
        dependencies,
      );
      expect(dependencies.requestCreativeWorkspaceCommand).not.toHaveBeenCalled();
      expect(json).toHaveBeenCalledWith(
        expect.anything(),
        403,
        expect.objectContaining({ success: false, code: "confirm_required" }),
      );
    }
  });

  it("executes deliver with a valid confirm_token and spends the token on first use", async () => {
    const confirmTokens = await confirmStore();
    const issued = await confirmTokens.issue({
      tool: "director_workbench",
      operation: "deliver",
      role: null,
      sessionId: "cli-default",
    });
    const { dependencies, json } = createStageDependencies(
      {
        session_id: "cli-default",
        target_token: TARGET.token,
        confirm_token: issued.token,
        input: { op: "deliver", camera_id: "cam_1" },
      },
      { filmRoleId: null, confirmTokens },
    );

    await handleStageRoute(
      request(),
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      dependencies,
    );

    expect(dependencies.requestWorkbenchCommand).toHaveBeenCalled();
    expect(json).toHaveBeenLastCalledWith(expect.anything(), 200, expect.objectContaining({ success: true }));

    // Reusing the spent token is refused without executing anything.
    const replay = createStageDependencies(
      {
        session_id: "cli-default",
        target_token: TARGET.token,
        confirm_token: issued.token,
        input: { op: "deliver", camera_id: "cam_1" },
      },
      { filmRoleId: null, confirmTokens },
    );
    await handleStageRoute(
      request(),
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      replay.dependencies,
    );
    expect(replay.dependencies.requestWorkbenchCommand).not.toHaveBeenCalled();
    expect(replay.json).toHaveBeenCalledWith(
      expect.anything(),
      403,
      expect.objectContaining({
        success: false,
        code: "confirm_required",
        error: expect.stringContaining("already_used"),
      }),
    );
  });

  it("accepts the x-director-confirm-token header as the token carrier", async () => {
    const confirmTokens = await confirmStore();
    const issued = await confirmTokens.issue({
      tool: "director_workbench",
      operation: "deliver",
      role: null,
      sessionId: "cli-default",
    });
    const { dependencies, json } = createStageDependencies(
      { session_id: "cli-default", target_token: TARGET.token, input: { op: "deliver", camera_id: "cam_1" } },
      { filmRoleId: null, confirmTokens },
    );

    await handleStageRoute(
      request({ "x-director-confirm-token": issued.token }),
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      dependencies,
    );

    expect(dependencies.requestWorkbenchCommand).toHaveBeenCalled();
    expect(json).toHaveBeenLastCalledWith(expect.anything(), 200, expect.objectContaining({ success: true }));
  });

  it("keeps the role policy first: a visual-critic deliver is tool_policy_rejected even with a token", async () => {
    const confirmTokens = await confirmStore();
    const issued = await confirmTokens.issue({
      tool: "director_workbench",
      operation: "deliver",
      role: "visual-critic",
      sessionId: "cli-default",
    });
    const { dependencies, json } = createStageDependencies(
      { session_id: "cli-default", confirm_token: issued.token, input: { op: "deliver", camera_id: "cam_1" } },
      { filmRoleId: "visual-critic", confirmTokens },
    );

    await handleStageRoute(
      request(),
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
    // The policy rejection never consumed the token.
    await expect(
      confirmTokens.consume(issued.token, {
        tool: "director_workbench",
        operation: "deliver",
        role: "visual-critic",
        sessionId: "cli-default",
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("refuses a token bound to another role or session", async () => {
    const confirmTokens = await confirmStore();
    const issued = await confirmTokens.issue({
      tool: "director_workbench",
      operation: "deliver",
      role: null,
      sessionId: "someone-else",
    });
    const { dependencies, json } = createStageDependencies(
      { session_id: "cli-default", confirm_token: issued.token, input: { op: "deliver", camera_id: "cam_1" } },
      { filmRoleId: null, confirmTokens },
    );

    await handleStageRoute(
      request(),
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      dependencies,
    );

    expect(dependencies.requestWorkbenchCommand).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(
      expect.anything(),
      403,
      expect.objectContaining({ code: "confirm_required", error: expect.stringContaining("binding_mismatch") }),
    );
  });
});

describe("POST /api/agent/confirm-token", () => {
  function createRouteContext(body: unknown, store: AgentConfirmTokenStore) {
    const writes: Array<{ status: number; body: unknown }> = [];
    return {
      writes,
      dependencies: {
        readBody: vi.fn().mockResolvedValue(body),
        json: (_response: ServerResponse, status: number, responseBody: unknown) =>
          writes.push({ status, body: responseBody }),
        store,
      },
    };
  }

  it("issues a short-lived single-use token bound to the resolved role", async () => {
    const store = new AgentConfirmTokenStore(await temporaryDirectory());
    const { dependencies, writes } = createRouteContext(
      { tool: "director_creative", operation: "interchange.export", session_id: "mcp-1" },
      store,
    );

    const handled = await handleAgentConfirmTokenRoute(
      request({ "x-director-film-role": "editor" }),
      mockResponse(),
      new URL("http://director.test/api/agent/confirm-token"),
      dependencies,
    );

    expect(handled).toBe(true);
    expect(writes.at(-1)).toMatchObject({
      status: 201,
      body: {
        success: true,
        result: {
          tool: "director_creative",
          operation: "interchange.export",
          role: "editor",
          session_id: "mcp-1",
          single_use: true,
          ttl_ms: 2 * 60_000,
        },
      },
    });
    const result = (writes.at(-1)?.body as { result: { confirm_token: string } }).result;
    await expect(
      store.consume(result.confirm_token, {
        tool: "director_creative",
        operation: "interchange.export",
        role: "editor",
        sessionId: "mcp-1",
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("refuses operations outside the closed confirmable list", async () => {
    const store = new AgentConfirmTokenStore(await temporaryDirectory());
    const { dependencies, writes } = createRouteContext({ tool: "director_workbench", operation: "author" }, store);

    await handleAgentConfirmTokenRoute(
      request(),
      mockResponse(),
      new URL("http://director.test/api/agent/confirm-token"),
      dependencies,
    );

    expect(writes.at(-1)).toMatchObject({
      status: 400,
      body: { success: false, code: "not_confirmable", confirmable_operations: CONFIRMABLE_TOOL_OPERATIONS },
    });
  });

  it("fails closed on an unknown film-role header", async () => {
    const store = new AgentConfirmTokenStore(await temporaryDirectory());
    const { dependencies, writes } = createRouteContext(
      { tool: "director_workbench", operation: "deliver" },
      store,
    );

    await handleAgentConfirmTokenRoute(
      request({ "x-director-film-role": "gaffer" }),
      mockResponse(),
      new URL("http://director.test/api/agent/confirm-token"),
      dependencies,
    );

    expect(writes.at(-1)).toMatchObject({ status: 400, body: { success: false, code: "invalid_film_role" } });
  });
});
