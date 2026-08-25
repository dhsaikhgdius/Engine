import type { IncomingMessage, ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultScene } from "@director/stage-protocol";
import type { StageScene } from "@director/stage-protocol";
import { BrowserCommandTimeoutError } from "../../browserCommandTimeout";
import { resetAgentNaiveBoundaryForTests } from "../../agentNaiveBoundary";
import { createTestDirectorProject } from "../fixtures/createTestDirectorProject";
import { createDefaultDirectorProject } from "@director/agent-engine/default-project";
import { DIRECTOR_TARGET_QUEUE_WAIT_HEADER, DirectorAgentTargetScheduler } from "../../agents/agentToolScheduler";
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

function mockResponse() {
  return { end: vi.fn() } as unknown as ServerResponse;
}

function schedulableRequest() {
  return Object.assign(new EventEmitter(), { method: "POST", aborted: false }) as IncomingMessage & EventEmitter;
}

function schedulableResponse() {
  return Object.assign(new EventEmitter(), {
    end: vi.fn(),
    setHeader: vi.fn(),
    writableEnded: false,
  }) as unknown as ServerResponse;
}

function createDependencies(body: unknown) {
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
    requestWorkbenchCommand: vi.fn().mockResolvedValue(null),
    requestWorkbenchCapture: vi.fn().mockResolvedValue(null),
    requestCreativeWorkspaceCommand: vi.fn().mockResolvedValue(null),
    persistWorkbenchProject: vi.fn().mockResolvedValue(undefined),
    loadDisconnectedWorkbenchSources: vi.fn().mockResolvedValue({ project: null, blenderScene: null }),
    executeVideoModel: vi.fn().mockResolvedValue({ scene, success: true, result: { status: "prepared" } }),
  };
  return { dependencies, json };
}

describe("stage routes", () => {
  beforeEach(() => {
    resetAgentNaiveBoundaryForTests();
    resetStageSessionLocksForTests();
  });
  it("rejects a non-object tool envelope at the HTTP boundary", async () => {
    const { dependencies, json } = createDependencies([]);
    const handled = await handleStageRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/stage_scene"),
      dependencies,
    );

    expect(handled).toBe(true);
    expect(json).toHaveBeenCalledWith(
      expect.anything(),
      400,
      expect.objectContaining({
        error: "Tool request body must be a JSON object.",
      }),
    );
  });

  it("executes a validated direct stage-tool input through the shared command engine", async () => {
    const { dependencies, json } = createDependencies({ op: "scene_state" });
    const handled = await handleStageRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/stage_read"),
      dependencies,
    );

    expect(handled).toBe(true);
    expect(json).toHaveBeenCalledWith(expect.anything(), 200, expect.objectContaining({ success: true }));
  });

  it("forwards a validated creative-workspace observation to the active browser", async () => {
    const { dependencies, json } = createDependencies({ op: "observe" });
    dependencies.requestCreativeWorkspaceCommand = vi.fn().mockResolvedValue({
      client: {},
      target: TARGET,
      response: {
        success: true,
        result: {
          op: "observe",
          snapshot: { version: 1, snapshot_fingerprint: `sha256:${"1".repeat(64)}` },
        },
      },
    });

    const handled = await handleStageRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/director_creative"),
      dependencies,
    );

    expect(handled).toBe(true);
    expect(dependencies.requestCreativeWorkspaceCommand).toHaveBeenCalledWith({ op: "observe" }, undefined, undefined);
    expect(json).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        success: true,
        result: expect.objectContaining({ op: "observe" }),
      }),
    );
  });

  it("returns a Creative preview as an attached image without duplicating base64 in text result", async () => {
    const fingerprint = `sha256:${"2".repeat(64)}`;
    const input = { op: "preview", workspace: "canvas", expected_snapshot_fingerprint: fingerprint } as const;
    const dataUrl = "data:image/png;base64,aGVsbG8=";
    const { dependencies, json } = createDependencies({ input, target_token: TARGET.token });
    dependencies.requestCreativeWorkspaceCommand = vi.fn().mockResolvedValue({
      client: {},
      target: TARGET,
      response: {
        success: true,
        result: {
          op: "preview",
          preview: {
            success: true,
            workspace: "canvas",
            snapshot_fingerprint: fingerprint,
            mime_type: "image/png",
            data_url: dataUrl,
            width: 1280,
            height: 720,
            clean_frame: true,
            helpers_included: false,
            metadata: {
              kind: "canvas_board",
              node_count: 2,
              edge_count: 1,
              media_thumbnail_count: 1,
              world_bounds: { x: 0, y: 0, width: 640, height: 360 },
              render_scale: 1,
            },
          },
        },
      },
    });

    await handleStageRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/director_creative"),
      dependencies,
    );

    expect(dependencies.requestCreativeWorkspaceCommand).toHaveBeenCalledWith(input, undefined, TARGET.token);
    expect(dependencies.savePreview).toHaveBeenCalledWith({ mimeType: "image/png", data: "aGVsbG8=" });
    const responseBody = json.mock.calls.at(-1)?.[2] as {
      capture?: { mimeType: string; data: string };
      result?: { preview?: Record<string, unknown> };
    };
    expect(responseBody.capture).toEqual({ mimeType: "image/png", data: "aGVsbG8=" });
    expect(responseBody.result?.preview).toMatchObject({ success: true, image_attached: true });
    expect(responseBody.result?.preview).not.toHaveProperty("data_url");
  });

  it("rejects an invalid creative-workspace operation before websocket forwarding", async () => {
    const { dependencies, json } = createDependencies({
      op: "execute",
      idempotency_key: "route-invalid-v1",
      operation: { op: "edit.seek", seconds: -1 },
    });

    const handled = await handleStageRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/director_creative"),
      dependencies,
    );

    expect(handled).toBe(true);
    expect(dependencies.requestCreativeWorkspaceCommand).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(
      expect.anything(),
      400,
      expect.objectContaining({ success: false, error: expect.stringContaining("director_creative input is invalid") }),
    );
  });

  it("allows read-only workbench catalog discovery before a target is bound", async () => {
    const { dependencies, json } = createDependencies({
      op: "catalog",
      catalog: "character_assets",
      query: "Abe",
      limit: 1,
    });
    dependencies.requestWorkbenchCommand = vi.fn().mockResolvedValue({
      client: {},
      target: TARGET,
      response: {
        success: true,
        result: { catalog: "character_assets", total: 1, items: [{ id: "director:hero" }] },
      },
    });

    await handleStageRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      dependencies,
    );

    expect(dependencies.requestWorkbenchCommand).toHaveBeenCalledWith(
      { op: "catalog", catalog: "character_assets", query: "Abe", offset: 0, limit: 1 },
      undefined,
      undefined,
    );
    expect(json).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({ success: true, result: expect.objectContaining({ catalog: "character_assets" }) }),
    );
  });

  it("serves observe from a persisted project when no Stage tab is connected", async () => {
    const project = createDefaultDirectorProject();
    const { dependencies, json } = createDependencies({
      op: "observe",
      fields: ["counts", "ui"],
    });
    dependencies.requestWorkbenchCommand = vi.fn().mockResolvedValue(null);
    dependencies.loadDisconnectedWorkbenchSources = vi.fn().mockResolvedValue({
      project,
      blenderScene: null,
    });

    await handleStageRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      dependencies,
    );

    expect(json).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        success: true,
        result: expect.objectContaining({
          workbench_connected: false,
          source: "persisted_project",
          counts: expect.objectContaining({ objects: project.objects.length }),
          ui: null,
        }),
      }),
    );
  });

  it("serves audit from a persisted project when discovery finds no Stage tab", async () => {
    const { dependencies, json } = createDependencies({ op: "audit" });
    dependencies.requestWorkbenchCommand = vi.fn().mockResolvedValue(null);
    dependencies.loadDisconnectedWorkbenchSources = vi.fn().mockResolvedValue({
      project: createDefaultDirectorProject(),
      blenderScene: null,
    });

    await handleStageRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      dependencies,
    );

    expect(json).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        success: true,
        result: expect.objectContaining({
          workbench_connected: false,
          source: "persisted_project",
          ready: expect.any(Boolean),
        }),
      }),
    );
  });

  it("still rejects mutations when no Stage tab is connected", async () => {
    const { dependencies, json } = createDependencies({
      session_id: "disconnected-mutation",
      op: "undo",
      unconditional: true,
    });
    dependencies.requestWorkbenchCommand = vi.fn().mockResolvedValue(null);

    await handleStageRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      dependencies,
    );

    expect(json).toHaveBeenCalledWith(
      expect.anything(),
      503,
      expect.objectContaining({
        success: false,
        code: "workbench_unavailable",
        error: expect.stringContaining("blender_native"),
      }),
    );
  });

  it("assigns a durable retry key to a naive generation submission without a project preflight", async () => {
    const { dependencies, json } = createDependencies({
      session_id: "route-generation-session",
      target_token: TARGET.token,
      input: {
        op: "generation",
        command: {
          action: "submit",
          kind: "image.generate",
          workflow_id: "comfy-workflow-main",
          prompt: "A detailed production city establishing shot",
        },
      },
    });
    dependencies.requestWorkbenchCommand = vi.fn().mockResolvedValue({
      client: {},
      target: TARGET,
      response: { success: true, result: { accepted: true, jobs: [{ id: "generation-job-1" }] } },
    });

    await handleStageRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      dependencies,
    );

    expect(dependencies.requestWorkbenchCommand).toHaveBeenCalledTimes(1);
    expect(dependencies.requestWorkbenchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        op: "generation",
        command: expect.objectContaining({
          action: "submit",
          idempotency_key: expect.stringMatching(/^agent-intent:/),
        }),
      }),
      undefined,
      TARGET.token,
    );
    expect(json).toHaveBeenLastCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        success: true,
        agent_boundary: expect.objectContaining({ guard: { mode: "durable_job", source: "gateway" } }),
      }),
    );
  });

  it("preflights and keys a naive generated 3D promotion on the exact project target", async () => {
    const { dependencies, json } = createDependencies({
      session_id: "route-generated-promote-session",
      target_token: TARGET.token,
      input: { op: "generated_3d", command: { action: "promote", job_id: "generated-job-1" } },
    });
    dependencies.requestWorkbenchCommand = vi
      .fn()
      .mockResolvedValueOnce({
        client: {},
        target: TARGET,
        response: { success: true, result: { project_revision: REVISION_A, characters: [] } },
      })
      .mockResolvedValueOnce({
        client: {},
        target: TARGET,
        response: { success: true, result: { generated_3d: { job_id: "generated-job-1" } } },
      });

    await handleStageRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      dependencies,
    );

    expect(dependencies.requestWorkbenchCommand).toHaveBeenCalledTimes(2);
    expect(dependencies.requestWorkbenchCommand).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        op: "generated_3d",
        command: expect.objectContaining({
          action: "promote",
          expected_revision: REVISION_A,
          idempotency_key: expect.stringMatching(/^agent-intent:/),
        }),
      }),
      undefined,
      TARGET.token,
    );
    expect(json).toHaveBeenLastCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        success: true,
        agent_boundary: expect.objectContaining({ operation: "generated_3d.promote" }),
      }),
    );
  });

  it("returns an explicitly requested audit result without adding a review workflow", async () => {
    const { dependencies, json } = createDependencies({
      target_token: TARGET.token,
      input: { op: "audit", include_spatial: true },
    });
    dependencies.requestWorkbenchCommand = vi.fn().mockResolvedValue({
      client: {},
      target: TARGET,
      response: {
        success: true,
        result: { ready: true, error_count: 0, warning_count: 1, audit_token: "workbench-audit-route" },
      },
    });

    await handleStageRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      dependencies,
    );

    expect(json).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        success: true,
        result: expect.objectContaining({ ready: true, audit_token: "workbench-audit-route" }),
        feedback: expect.objectContaining({
          scene_hint: expect.objectContaining({
            validation: expect.objectContaining({ ready: true, error_count: 0 }),
          }),
        }),
      }),
    );
    const body = json.mock.calls.at(-1)?.[2] as Record<string, unknown>;
    expect(body.feedback).not.toHaveProperty("readiness");
  });

  it("discovers and locks a target before forwarding a workspace mutation", async () => {
    const fingerprint = `sha256:${"1".repeat(64)}`;
    const { dependencies, json } = createDependencies({
      op: "execute",
      idempotency_key: "route-target-v1",
      expected_snapshot_fingerprint: fingerprint,
      operation: { op: "edit.seek", seconds: 1 },
    });
    dependencies.requestCreativeWorkspaceCommand = vi
      .fn()
      .mockResolvedValueOnce({
        client: {},
        target: TARGET,
        response: { success: true, result: { op: "observe", snapshot: { snapshot_fingerprint: fingerprint } } },
      })
      .mockResolvedValueOnce({
        client: {},
        target: TARGET,
        response: { success: true, result: { op: "execute", execution: { success: true } } },
      });
    await handleStageRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/director_creative"),
      dependencies,
    );
    expect(dependencies.requestCreativeWorkspaceCommand).toHaveBeenNthCalledWith(1, { op: "observe" });
    expect(dependencies.requestCreativeWorkspaceCommand).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ op: "execute", idempotency_key: "route-target-v1" }),
      undefined,
      TARGET.token,
    );
    expect(json).toHaveBeenLastCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({ success: true, target: TARGET }),
    );
  });

  it("discovers and forwards the exact target for interchange and collaboration semantics", async () => {
    const interchange = {
      op: "interchange",
      request: { action: "plan-export", format: "otio", workspace: "video" },
    } as const;
    const missing = createDependencies(interchange);
    missing.dependencies.requestCreativeWorkspaceCommand = vi
      .fn()
      .mockResolvedValueOnce({
        client: {},
        target: TARGET,
        response: { success: true, result: { op: "observe", snapshot: { snapshot_fingerprint: "creative-v1" } } },
      })
      .mockResolvedValueOnce({
        client: {},
        target: TARGET,
        response: { success: true, result: { op: "interchange", result: { success: true } } },
      });
    await handleStageRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/director_creative"),
      missing.dependencies,
    );
    expect(missing.dependencies.requestCreativeWorkspaceCommand).toHaveBeenNthCalledWith(1, { op: "observe" });
    expect(missing.dependencies.requestCreativeWorkspaceCommand).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        op: "interchange",
        request: expect.objectContaining(interchange.request),
      }),
      undefined,
      TARGET.token,
    );

    const collaboration = {
      op: "collaboration",
      request: { action: "list-versions" },
    } as const;
    const exact = createDependencies({ input: collaboration, target_token: TARGET.token });
    exact.dependencies.requestCreativeWorkspaceCommand = vi.fn().mockResolvedValue({
      client: {},
      target: TARGET,
      response: {
        success: true,
        result: {
          op: "collaboration",
          result: {
            success: true,
            action: "list-versions",
            collaboration_fingerprint: `sha256:${"4".repeat(64)}`,
            versions: [],
          },
        },
      },
    });
    await handleStageRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/director_creative"),
      exact.dependencies,
    );
    expect(exact.dependencies.requestCreativeWorkspaceCommand).toHaveBeenCalledWith(
      collaboration,
      undefined,
      TARGET.token,
    );
  });

  it("discovers and forwards the exact target for Canvas pipeline semantics", async () => {
    const pipeline = {
      op: "pipeline",
      request: { action: "status", run_id: "canvas-run-1" },
    } as const;
    const missing = createDependencies(pipeline);
    missing.dependencies.requestCreativeWorkspaceCommand = vi
      .fn()
      .mockResolvedValueOnce({
        client: {},
        target: TARGET,
        response: { success: true, result: { op: "observe", snapshot: { snapshot_fingerprint: "creative-v1" } } },
      })
      .mockResolvedValueOnce({
        client: {},
        target: TARGET,
        response: { success: false, error: "No run", result: { op: "pipeline", result: { code: "not_found" } } },
      });
    await handleStageRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/director_creative"),
      missing.dependencies,
    );
    expect(missing.dependencies.requestCreativeWorkspaceCommand).toHaveBeenNthCalledWith(1, { op: "observe" });
    expect(missing.dependencies.requestCreativeWorkspaceCommand).toHaveBeenNthCalledWith(
      2,
      pipeline,
      undefined,
      TARGET.token,
    );

    const exact = createDependencies({ input: pipeline, target_token: TARGET.token });
    exact.dependencies.requestCreativeWorkspaceCommand = vi.fn().mockResolvedValue({
      client: {},
      target: TARGET,
      response: {
        success: false,
        error: "No Canvas pipeline run exists.",
        result: {
          op: "pipeline",
          result: {
            success: false,
            action: "status",
            code: "not_found",
            error: "No Canvas pipeline run exists.",
            suggested_next: "Start a pipeline run.",
          },
        },
      },
    });
    await handleStageRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/director_creative"),
      exact.dependencies,
    );
    expect(exact.dependencies.requestCreativeWorkspaceCommand).toHaveBeenCalledWith(pipeline, undefined, TARGET.token);
  });

  it("never falls back to another tab when a bound target has disconnected", async () => {
    const { dependencies, json } = createDependencies({
      target_token: "stale-target",
      input: { op: "audit", scope: "all", quality_profile: "production" },
    });
    await handleStageRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/director_creative"),
      dependencies,
    );
    expect(dependencies.requestCreativeWorkspaceCommand).toHaveBeenCalledWith(
      { op: "audit", scope: "all", quality_profile: "production" },
      undefined,
      "stale-target",
    );
    expect(json).toHaveBeenCalledWith(expect.anything(), 409, expect.objectContaining({ code: "target_unavailable" }));
  });

  it.each([
    {
      name: "patch",
      input: { op: "patch", patches: [{ op: "replace", path: "/project/name", value: "Agent edit" }] },
    },
    {
      name: "author",
      input: {
        op: "author",
        actions: [{ action: "set_scene", patch: { backgroundColor: "#222222" } }],
      },
    },
    { name: "correct", input: { op: "correct", audit_token: "workbench-audit-route" } },
    { name: "replace_project", input: { op: "replace_project", project: createTestDirectorProject() } },
    { name: "undo", input: { op: "undo" } },
  ] as const)("forwards a direct $name mutation to the exact HTTP target", async ({ input }) => {
    const { dependencies, json } = createDependencies({
      session_id: "route-agent-session",
      target_token: TARGET.token,
      input,
    });
    dependencies.requestWorkbenchCommand = vi
      .fn()
      .mockResolvedValueOnce({
        client: {},
        target: TARGET,
        response: { success: true, result: { project_revision: REVISION_A, characters: [] } },
      })
      .mockResolvedValueOnce({
        client: {},
        target: TARGET,
        response: { success: true, result: { changed: true } },
      });

    await handleStageRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      dependencies,
    );

    expect(dependencies.requestWorkbenchCommand).toHaveBeenCalledTimes(2);
    expect(dependencies.requestWorkbenchCommand).toHaveBeenNthCalledWith(
      1,
      { op: "observe", fields: ["counts", "characters"] },
      undefined,
      TARGET.token,
    );
    const forwarded = vi.mocked(dependencies.requestWorkbenchCommand).mock.calls[1]?.[0];
    expect(forwarded).toMatchObject({ op: input.op, expected_revision: REVISION_A });
    expect(forwarded).toHaveProperty("idempotency_key", expect.stringMatching(/^agent-intent:/));
    expect(json).toHaveBeenLastCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        success: true,
        target: TARGET,
        agent_boundary: expect.objectContaining({ policy: "director-agent-public-boundary-v2" }),
      }),
    );
  });

  it("lets a possessed session drive its own character while blocking the rest of the stage", async () => {
    const possessedCharacters = [
      {
        id: "hero",
        kind: "character",
        agent_binding: { session_id: "dsh-possessed", profile_id: null, role_id: null, mode: "possess" },
      },
      { id: "villain", kind: "character" },
    ];
    const preflight = {
      client: {},
      target: TARGET,
      response: { success: true, result: { project_revision: REVISION_A, characters: possessedCharacters } },
    };

    const allowed = createDependencies({
      session_id: "dsh-possessed",
      target_token: TARGET.token,
      input: {
        op: "author",
        actions: [{ action: "set_character_motion", object_id: "hero", clip_id: "walk" }],
      },
    });
    allowed.dependencies.requestWorkbenchCommand = vi
      .fn()
      .mockResolvedValueOnce(preflight)
      .mockResolvedValueOnce({
        client: {},
        target: TARGET,
        response: { success: true, result: { updated: { object_ids: ["hero"] } } },
      });
    await handleStageRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      allowed.dependencies,
    );
    expect(allowed.dependencies.requestWorkbenchCommand).toHaveBeenCalledTimes(2);
    expect(allowed.json).toHaveBeenLastCalledWith(expect.anything(), 200, expect.objectContaining({ success: true }));

    const crossCharacter = createDependencies({
      session_id: "dsh-possessed",
      target_token: TARGET.token,
      input: {
        op: "author",
        actions: [{ action: "set_character_motion", object_id: "villain", clip_id: "walk" }],
      },
    });
    crossCharacter.dependencies.requestWorkbenchCommand = vi.fn().mockResolvedValue(preflight);
    await handleStageRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      crossCharacter.dependencies,
    );
    expect(crossCharacter.dependencies.requestWorkbenchCommand).toHaveBeenCalledTimes(1);
    expect(crossCharacter.json).toHaveBeenLastCalledWith(
      expect.anything(),
      403,
      expect.objectContaining({
        success: false,
        code: "possession_scope_violation",
        error: expect.stringContaining('"villain"'),
      }),
    );

    const globalMutation = createDependencies({
      session_id: "dsh-possessed",
      target_token: TARGET.token,
      input: { op: "replace_project", project: createTestDirectorProject() },
    });
    globalMutation.dependencies.requestWorkbenchCommand = vi.fn().mockResolvedValue(preflight);
    await handleStageRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      globalMutation.dependencies,
    );
    expect(globalMutation.dependencies.requestWorkbenchCommand).toHaveBeenCalledTimes(1);
    expect(globalMutation.json).toHaveBeenLastCalledWith(
      expect.anything(),
      403,
      expect.objectContaining({ success: false, code: "possession_scope_violation" }),
    );

    // A different, unpossessed session keeps full stage-wide authoring against
    // the same observed characters.
    const unpossessed = createDependencies({
      session_id: "dsh-free-director",
      target_token: TARGET.token,
      input: {
        op: "author",
        actions: [{ action: "set_character_motion", object_id: "villain", clip_id: "walk" }],
      },
    });
    unpossessed.dependencies.requestWorkbenchCommand = vi
      .fn()
      .mockResolvedValueOnce(preflight)
      .mockResolvedValueOnce({
        client: {},
        target: TARGET,
        response: { success: true, result: { updated: { object_ids: ["villain"] } } },
      });
    await handleStageRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      unpossessed.dependencies,
    );
    expect(unpossessed.dependencies.requestWorkbenchCommand).toHaveBeenCalledTimes(2);
    expect(unpossessed.json).toHaveBeenLastCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({ success: true }),
    );
  });

  it("resolves possession before dispatching a guard-carrying mutation", async () => {
    const { dependencies, json } = createDependencies({
      session_id: "dsh-possessed",
      target_token: TARGET.token,
      input: { op: "undo", expected_revision: REVISION_A },
    });
    dependencies.requestWorkbenchCommand = vi.fn().mockResolvedValue({
      client: {},
      target: TARGET,
      response: {
        success: true,
        result: {
          characters: [
            {
              id: "hero",
              kind: "character",
              agent_binding: { session_id: "dsh-possessed", profile_id: null, role_id: null, mode: "possess" },
            },
          ],
        },
      },
    });

    await handleStageRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      dependencies,
    );

    expect(dependencies.requestWorkbenchCommand).toHaveBeenCalledTimes(1);
    expect(dependencies.requestWorkbenchCommand).toHaveBeenNthCalledWith(
      1,
      { op: "observe", fields: ["characters"] },
      undefined,
      TARGET.token,
    );
    expect(json).toHaveBeenLastCalledWith(
      expect.anything(),
      403,
      expect.objectContaining({
        success: false,
        code: "possession_scope_violation",
        error: expect.stringContaining("unbind_character_agent"),
      }),
    );
  });

  it("rejects mutations toward a tab with a stale workbench contract before dispatch", async () => {
    const { dependencies, json } = createDependencies({
      session_id: "route-stale-contract-session",
      target_token: TARGET.token,
      input: {
        op: "author",
        actions: [{ action: "set_scene", patch: { backgroundColor: "#222222" } }],
      },
    });
    dependencies.isTargetContractStale = vi.fn().mockReturnValue(true);

    await handleStageRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      dependencies,
    );

    expect(dependencies.requestWorkbenchCommand).not.toHaveBeenCalled();
    expect(json).toHaveBeenLastCalledWith(
      expect.anything(),
      409,
      expect.objectContaining({
        success: false,
        code: "workbench_contract_stale",
        error: expect.stringContaining("Reload that Director tab"),
      }),
    );
  });

  it("forwards an explicit unconditional write unchanged", async () => {
    const { dependencies, json } = createDependencies({
      session_id: "route-unconditional-session",
      target_token: TARGET.token,
      input: { op: "undo", unconditional: true },
    });
    dependencies.requestWorkbenchCommand = vi
      .fn()
      .mockResolvedValueOnce({
        client: {},
        target: TARGET,
        response: { success: true, result: { characters: [] } },
      })
      .mockResolvedValueOnce({
        client: {},
        target: TARGET,
        response: { success: true, result: { changed: true } },
      });

    await handleStageRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      dependencies,
    );

    // The unconditional write skips the revision preflight but still resolves
    // character possession before dispatch.
    expect(dependencies.requestWorkbenchCommand).toHaveBeenCalledTimes(2);
    expect(dependencies.requestWorkbenchCommand).toHaveBeenNthCalledWith(
      1,
      { op: "observe", fields: ["characters"] },
      undefined,
      TARGET.token,
    );
    const forwarded = vi.mocked(dependencies.requestWorkbenchCommand).mock.calls[1]?.[0];
    expect(forwarded).toMatchObject({
      op: "undo",
      unconditional: true,
    });
    expect(forwarded).not.toHaveProperty("expected_revision");
    expect(forwarded).toHaveProperty("idempotency_key", expect.stringMatching(/^agent-intent:/));
    expect(json).toHaveBeenLastCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({ success: true, agent_boundary: expect.any(Object) }),
    );
  });

  it("reports an unknown edit outcome when the exact target disconnects", async () => {
    const { dependencies, json } = createDependencies({
      session_id: "route-unconditional-target-loss",
      target_token: TARGET.token,
      input: { op: "undo", unconditional: true },
    });
    dependencies.requestWorkbenchCommand = vi
      .fn()
      .mockResolvedValueOnce({
        client: {},
        target: TARGET,
        response: { success: true, result: { characters: [] } },
      })
      .mockResolvedValueOnce(null);

    await handleStageRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      dependencies,
    );

    expect(json).toHaveBeenLastCalledWith(
      expect.anything(),
      409,
      expect.objectContaining({
        code: "outcome_unknown",
        error: expect.stringContaining("retry the same intent"),
        result: expect.objectContaining({ outcome: "unknown", retry_requires_observe: false }),
      }),
    );
  });

  it("does not automatically replay a timed-out mutation", async () => {
    const input = {
      op: "author" as const,
      actions: [{ action: "set_scene" as const, patch: { backgroundColor: "#111827" } }],
    };
    const { dependencies, json } = createDependencies({
      target_token: TARGET.token,
      input,
    });
    dependencies.requestWorkbenchCommand = vi
      .fn()
      .mockResolvedValueOnce({
        client: {},
        target: TARGET,
        response: { success: true, result: { project_revision: REVISION_A, characters: [] } },
      })
      .mockRejectedValueOnce(new BrowserCommandTimeoutError("workbench", "author", 8_000));

    await handleStageRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      dependencies,
    );

    expect(dependencies.requestWorkbenchCommand).toHaveBeenCalledTimes(2);
    expect(dependencies.requestWorkbenchCommand).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ op: "author", expected_revision: REVISION_A, idempotency_key: expect.any(String) }),
      undefined,
      TARGET.token,
    );
    expect(json).toHaveBeenLastCalledWith(
      expect.anything(),
      409,
      expect.objectContaining({ code: "outcome_unknown", success: false }),
    );
  });

  it("reports target loss after one direct mutation dispatch", async () => {
    const { dependencies, json } = createDependencies({
      session_id: "route-target-loss-session",
      target_token: TARGET.token,
      input: {
        op: "author",
        actions: [{ action: "set_scene", patch: { backgroundColor: "#0f172a" } }],
      },
    });
    dependencies.requestWorkbenchCommand = vi
      .fn()
      .mockResolvedValueOnce({
        client: {},
        target: TARGET,
        response: { success: true, result: { project_revision: REVISION_A, characters: [] } },
      })
      .mockResolvedValueOnce(null);

    await handleStageRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      dependencies,
    );

    expect(dependencies.requestWorkbenchCommand).toHaveBeenCalledTimes(2);
    expect(json).toHaveBeenLastCalledWith(
      expect.anything(),
      409,
      expect.objectContaining({
        success: false,
        code: "outcome_unknown",
        result: expect.objectContaining({ outcome: "unknown", retry_requires_observe: false }),
      }),
    );
  });

  it("preflights and keys a Production mutation before exact-target dispatch", async () => {
    const { dependencies, json } = createDependencies({
      session_id: "route-production-session",
      target_token: TARGET.token,
      input: {
        op: "production",
        command: { action: "rename_scene", scene_id: "scene-a", title: "Opening" },
      },
    });
    dependencies.requestWorkbenchCommand = vi
      .fn()
      .mockResolvedValueOnce({
        client: {},
        target: TARGET,
        response: { success: true, result: { production_revision: 7 } },
      })
      .mockResolvedValueOnce({
        client: {},
        target: TARGET,
        response: { success: true, result: { characters: [] } },
      })
      .mockResolvedValueOnce({
        client: {},
        target: TARGET,
        response: { success: true, result: { production_revision: 8 } },
      });

    await handleStageRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      dependencies,
    );

    expect(dependencies.requestWorkbenchCommand).toHaveBeenNthCalledWith(
      1,
      { op: "production", command: { action: "observe" } },
      undefined,
      TARGET.token,
    );
    // The production observe carries no character summaries, so possession is
    // resolved through a dedicated bounded observe before dispatch.
    expect(dependencies.requestWorkbenchCommand).toHaveBeenNthCalledWith(
      2,
      { op: "observe", fields: ["characters"] },
      undefined,
      TARGET.token,
    );
    expect(dependencies.requestWorkbenchCommand).toHaveBeenNthCalledWith(
      3,
      {
        op: "production",
        command: expect.objectContaining({
          action: "rename_scene",
          expected_revision: 7,
          idempotency_key: expect.stringMatching(/^agent-intent:/),
        }),
      },
      undefined,
      TARGET.token,
    );
    expect(json).toHaveBeenLastCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        success: true,
        agent_boundary: expect.objectContaining({
          operation: "production.rename_scene",
          guard: expect.objectContaining({ field: "expected_production_revision" }),
        }),
      }),
    );
  });

  it("forwards a flattened raw HTTP envelope directly", async () => {
    const { dependencies, json } = createDependencies({
      session_id: "raw-http-session",
      target_token: TARGET.token,
      op: "undo",
    });
    dependencies.requestWorkbenchCommand = vi
      .fn()
      .mockResolvedValueOnce({
        client: {},
        target: TARGET,
        response: { success: true, result: { project_revision: REVISION_A, characters: [] } },
      })
      .mockResolvedValueOnce({
        client: {},
        target: TARGET,
        response: { success: true, result: { changed: true } },
      });

    await handleStageRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      dependencies,
    );

    expect(dependencies.requestWorkbenchCommand).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ op: "undo", expected_revision: REVISION_A, idempotency_key: expect.any(String) }),
      undefined,
      TARGET.token,
    );
    expect(json).toHaveBeenLastCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({ success: true, target: TARGET }),
    );
  });

  it("rejects a workbench response from a different target", async () => {
    const { dependencies, json } = createDependencies({
      target_token: TARGET.token,
      input: { op: "undo" },
    });
    dependencies.requestWorkbenchCommand = vi.fn().mockResolvedValue({
      client: {},
      target: { ...TARGET, token: "different-target" },
      response: { success: true, result: { project_revision: REVISION_A } },
    });

    await handleStageRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      dependencies,
    );

    expect(dependencies.requestWorkbenchCommand).toHaveBeenCalledTimes(1);
    expect(json).toHaveBeenLastCalledWith(
      expect.anything(),
      409,
      expect.objectContaining({ success: false, code: "target_mismatch" }),
    );
  });

  it("forwards correct to the browser workbench and persists its validated project", async () => {
    const { dependencies, json } = createDependencies({
      target_token: TARGET.token,
      input: {
        op: "correct",
        audit_token: "workbench-audit-7",
        expected_revision: REVISION_A,
        idempotency_key: "workbench-correct-explicit-v1",
      },
    });
    const project = createTestDirectorProject();
    const nextScene = createDefaultScene();
    dependencies.requestWorkbenchCommand = vi.fn().mockResolvedValue({
      client: {},
      target: TARGET,
      response: {
        success: true,
        result: {
          corrected_action_count: 1,
          audit_token: "workbench-audit-8",
          turn_id: "workbench-turn-8",
        },
        stageScene: nextScene,
        project,
      },
    });

    const handled = await handleStageRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      dependencies,
    );

    expect(handled).toBe(true);
    expect(dependencies.requestWorkbenchCommand).toHaveBeenCalledWith(
      {
        op: "correct",
        audit_token: "workbench-audit-7",
        expected_revision: REVISION_A,
        idempotency_key: "workbench-correct-explicit-v1",
      },
      undefined,
      TARGET.token,
    );
    expect(dependencies.persistWorkbenchProject).toHaveBeenCalledWith(project, expect.anything());
    expect(json).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        success: true,
        result: expect.objectContaining({
          audit_token: "workbench-audit-8",
          corrected_action_count: 1,
        }),
      }),
    );
  });

  it.each(["stale_project_revision", "stale_production_revision"])(
    "maps %s workbench conflicts to HTTP 409",
    async (code) => {
      const { dependencies, json } = createDependencies({
        target_token: TARGET.token,
        input: {
          op: "undo",
          expected_revision: REVISION_A,
        },
      });
      dependencies.requestWorkbenchCommand = vi.fn().mockResolvedValue({
        client: {},
        target: TARGET,
        response: { success: false, error: "conflict", result: { code } },
      });

      await handleStageRoute(
        { method: "POST" } as IncomingMessage,
        mockResponse(),
        new URL("http://director.test/api/tools/director_workbench"),
        dependencies,
      );

      expect(json).toHaveBeenLastCalledWith(expect.anything(), 409, expect.objectContaining({ success: false, code }));
    },
  );

  it("forwards a strictly validated production Shot IR read through the HTTP workbench route", async () => {
    const { dependencies, json } = createDependencies({
      target_token: TARGET.token,
      input: { op: "shot_ir", take_id: "take_1", coverage_shot_id: "coverage_1", frame: 12 },
    });
    dependencies.requestWorkbenchCommand = vi.fn().mockResolvedValue({
      client: {},
      target: TARGET,
      response: {
        success: true,
        result: {
          schemaVersion: 1,
          id: "shot-ir-cam_1-f12",
          revisionFingerprint: "fnv1a32:01234567",
          camera: { id: "cam_1" },
          frame: 12,
        },
      },
    });

    const handled = await handleStageRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      dependencies,
    );

    expect(handled).toBe(true);
    expect(dependencies.requestWorkbenchCommand).toHaveBeenCalledWith(
      { op: "shot_ir", take_id: "take_1", coverage_shot_id: "coverage_1", frame: 12 },
      undefined,
      TARGET.token,
    );
    expect(json).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        success: true,
        result: expect.objectContaining({
          revisionFingerprint: "fnv1a32:01234567",
        }),
      }),
    );
  });

  it("forwards a naive evidence capture directly without a preflight observation", async () => {
    const input = { op: "capture", camera_id: "cam_1", frame: 0 } as const;
    const { dependencies, json } = createDependencies({ input, target_token: TARGET.token });
    dependencies.requestWorkbenchCapture = vi.fn().mockResolvedValue({
      client: {},
      target: TARGET,
      response: {
        success: true,
        result: {
          label: "capture",
          project_revision_before: REVISION_A,
          project_revision: REVISION_A,
        },
        captureDataUrl: "data:image/png;base64,aGVsbG8=",
      },
    });

    const handled = await handleStageRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      dependencies,
    );

    expect(handled).toBe(true);
    expect(dependencies.requestWorkbenchCommand).not.toHaveBeenCalled();
    expect(dependencies.requestWorkbenchCapture).toHaveBeenCalledWith(input, undefined, TARGET.token);
    expect(json).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        success: true,
        result: expect.objectContaining({ project_revision: REVISION_A }),
      }),
    );
  });

  it("routes a multi-pass shot package through the capture-capable browser path", async () => {
    const input = {
      op: "shot_package",
      expected_revision: `director-project-revision:v1:sha256:${"a".repeat(64)}`,
      coverage_shot_id: "coverage_1",
      frame: 12,
      width: 1280,
      height: 720,
      render_passes: ["clean", "normal"],
    } as const;
    const { dependencies, json } = createDependencies({ input, target_token: TARGET.token });
    dependencies.requestWorkbenchCapture = vi.fn().mockResolvedValue({
      client: {},
      target: TARGET,
      response: {
        success: true,
        result: {
          manifest: { packageId: "director-package:abc", artifacts: [{ renderPass: "clean" }] },
          files: [{ renderPass: "clean", path: "passes/clean/frame-000012.png" }],
        },
        captureDataUrl: "data:image/png;base64,aGVsbG8=",
      },
    });

    const handled = await handleStageRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      dependencies,
    );

    expect(handled).toBe(true);
    expect(dependencies.requestWorkbenchCapture).toHaveBeenCalledWith(input, undefined, TARGET.token);
    expect(dependencies.requestWorkbenchCommand).not.toHaveBeenCalled();
    expect(dependencies.savePreview).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: "image/png", data: "aGVsbG8=" }),
    );
    expect(json).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        success: true,
        result: expect.objectContaining({ manifest: expect.objectContaining({ packageId: "director-package:abc" }) }),
      }),
    );
  });

  it("preserves machine-readable capture recovery from an exact non-Stage target", async () => {
    const input = {
      op: "capture",
      camera_id: "cam_1",
      frame: 0,
      expected_revision: `director-project-revision:v1:sha256:${"b".repeat(64)}`,
      render_pass: "clean",
    } as const;
    const { dependencies, json } = createDependencies({ input, target_token: TARGET.token });
    dependencies.requestWorkbenchCapture = vi.fn().mockResolvedValue({
      client: {},
      target: TARGET,
      response: {
        success: false,
        error: "Viewport capture handler is not registered",
        result: {
          code: "capture_unavailable",
          suggested_next: "Switch this exact target to 3D Stage, then observe again.",
        },
      },
    });

    await handleStageRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      dependencies,
    );

    expect(dependencies.requestWorkbenchCapture).toHaveBeenCalledWith(input, undefined, TARGET.token);
    expect(dependencies.requestWorkbenchCommand).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(
      expect.anything(),
      400,
      expect.objectContaining({
        success: false,
        code: "capture_unavailable",
        target: TARGET,
        result: expect.objectContaining({
          code: "capture_unavailable",
          suggested_next: expect.stringContaining("3D Stage"),
        }),
      }),
    );
  });

  it("keeps the scene and recovery code in a cancelled command response", async () => {
    const { dependencies, json } = createDependencies({
      input: { op: "audit" },
      target_token: TARGET.token,
    });
    dependencies.requestWorkbenchCommand = vi
      .fn()
      .mockRejectedValue(new BrowserCommandTimeoutError("workbench", "audit", 15_000));

    const handled = await handleStageRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      dependencies,
    );

    expect(handled).toBe(true);
    expect(json).toHaveBeenCalledWith(
      expect.anything(),
      504,
      expect.objectContaining({
        scene: expect.objectContaining({ recordAspect: "16:9" }),
        success: false,
        code: "command_timeout",
        result: expect.objectContaining({ outcome: "cancelled", retry_requires_observe: true }),
      }),
    );
  });
});

describe("target scheduling", () => {
  beforeEach(() => {
    resetAgentNaiveBoundaryForTests();
    resetStageSessionLocksForTests();
  });

  it("holds a later cross-session read behind an exclusive mutation on the same target", async () => {
    const targetScheduler = new DirectorAgentTargetScheduler(4);
    const writer = createDependencies({
      session_id: "writer-session",
      target_token: TARGET.token,
      input: { op: "undo", unconditional: true },
    });
    const reader = createDependencies({
      session_id: "reader-session",
      target_token: TARGET.token,
      input: { op: "observe", fields: ["counts"] },
    });
    writer.dependencies.targetScheduler = targetScheduler;
    reader.dependencies.targetScheduler = targetScheduler;

    let releaseWriter!: () => void;
    const writerBlocked = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    let markWriterStarted!: () => void;
    const writerStarted = new Promise<void>((resolve) => {
      markWriterStarted = resolve;
    });
    writer.dependencies.requestWorkbenchCommand = vi.fn(async () => {
      markWriterStarted();
      await writerBlocked;
      return { client: {}, target: TARGET, response: { success: true, result: { changed: true } } };
    });
    reader.dependencies.requestWorkbenchCommand = vi.fn().mockResolvedValue({
      client: {},
      target: TARGET,
      response: { success: true, result: { counts: { objects: 1 } } },
    });

    const writerResponse = schedulableResponse();
    const writerRun = handleStageRoute(
      schedulableRequest(),
      writerResponse,
      new URL("http://director.test/api/tools/director_workbench"),
      writer.dependencies,
    );
    await writerStarted;
    const readerResponse = schedulableResponse();
    const readerRun = handleStageRoute(
      schedulableRequest(),
      readerResponse,
      new URL("http://director.test/api/tools/director_workbench"),
      reader.dependencies,
    );

    await Promise.resolve();
    expect(reader.dependencies.requestWorkbenchCommand).not.toHaveBeenCalled();

    releaseWriter();
    await Promise.all([writerRun, readerRun]);
    expect(reader.dependencies.requestWorkbenchCommand).toHaveBeenCalledTimes(1);
    expect(readerResponse.setHeader).toHaveBeenCalledWith(DIRECTOR_TARGET_QUEUE_WAIT_HEADER, expect.any(String));
  });

  it("queues a same-session bound read behind a mutation instead of returning session_busy", async () => {
    const targetScheduler = new DirectorAgentTargetScheduler(4);
    const writer = createDependencies({
      session_id: "hosted-session",
      target_token: TARGET.token,
      input: { op: "undo", unconditional: true },
    });
    const reader = createDependencies({
      session_id: "hosted-session",
      target_token: TARGET.token,
      input: { op: "query_objects", spatial: { mode: "radius", center: [0, 0, 0], radius_m: 15 } },
    });
    writer.dependencies.targetScheduler = targetScheduler;
    reader.dependencies.targetScheduler = targetScheduler;

    let releaseWriter!: () => void;
    const writerBlocked = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    let markWriterStarted!: () => void;
    const writerStarted = new Promise<void>((resolve) => {
      markWriterStarted = resolve;
    });
    writer.dependencies.requestWorkbenchCommand = vi.fn(async () => {
      markWriterStarted();
      await writerBlocked;
      return { client: {}, target: TARGET, response: { success: true, result: { changed: true } } };
    });
    reader.dependencies.requestWorkbenchCommand = vi.fn().mockResolvedValue({
      client: {},
      target: TARGET,
      response: { success: true, result: { mode: "radius", objects: [] } },
    });

    const writerRun = handleStageRoute(
      schedulableRequest(),
      schedulableResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      writer.dependencies,
    );
    await writerStarted;
    const readerResponse = schedulableResponse();
    const readerJson = vi.fn();
    reader.dependencies.json = readerJson;
    const readerRun = handleStageRoute(
      schedulableRequest(),
      readerResponse,
      new URL("http://director.test/api/tools/director_workbench"),
      reader.dependencies,
    );

    await Promise.resolve();
    expect(reader.dependencies.requestWorkbenchCommand).not.toHaveBeenCalled();
    expect(readerJson).not.toHaveBeenCalled();

    releaseWriter();
    await Promise.all([writerRun, readerRun]);
    expect(reader.dependencies.requestWorkbenchCommand).toHaveBeenCalledTimes(1);
    expect(readerJson.mock.calls.at(-1)?.[2]).toEqual(
      expect.objectContaining({ success: true, result: expect.objectContaining({ mode: "radius" }) }),
    );
    expect(readerJson.mock.calls.at(-1)?.[2]).not.toEqual(expect.objectContaining({ code: "session_busy" }));
  });

  it("drops an aborted queued request before browser dispatch", async () => {
    const targetScheduler = new DirectorAgentTargetScheduler(1);
    const blocker = await targetScheduler.acquire(TARGET.token, "exclusive");
    const queued = createDependencies({
      session_id: "cancelled-reader-session",
      target_token: TARGET.token,
      input: { op: "observe", fields: ["counts"] },
    });
    queued.dependencies.targetScheduler = targetScheduler;
    const request = schedulableRequest();
    const run = handleStageRoute(
      request,
      schedulableResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      queued.dependencies,
    );

    await Promise.resolve();
    request.aborted = true;
    request.emit("aborted");
    await run;
    blocker.release();

    expect(queued.dependencies.requestWorkbenchCommand).not.toHaveBeenCalled();
  });
});

describe("agent boundary hardening", () => {
  beforeEach(() => {
    resetAgentNaiveBoundaryForTests();
    resetStageSessionLocksForTests();
  });

  async function postWorkbench(body: unknown) {
    const { dependencies, json } = createDependencies(body);
    const handled = await handleStageRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      dependencies,
    );
    expect(handled).toBe(true);
    return {
      dependencies,
      json,
      body: json.mock.calls.at(-1)?.[2] as Record<string, unknown>,
      status: json.mock.calls.at(-1)?.[1],
    };
  }

  it("serves describe gateway-locally without any browser round trip", async () => {
    const { dependencies, json, body } = await postWorkbench({
      session_id: "describe-session",
      input: { op: "describe", target: "capture" },
    });
    expect(dependencies.requestWorkbenchCommand).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        success: true,
        result: expect.objectContaining({ kind: "operation", target: "capture" }),
      }),
    );
    expect(body.scene).toBeDefined();
    expect((body.result as Record<string, unknown>).json_schema).toBeDefined();
  });

  it("serves creative describe gateway-locally without a browser target", async () => {
    const { dependencies, json } = createDependencies({
      session_id: "creative-describe-session",
      input: { op: "describe", target: "interchange" },
    });
    await handleStageRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/director_creative"),
      dependencies,
    );

    expect(dependencies.requestCreativeWorkspaceCommand).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        success: true,
        result: expect.objectContaining({ target: "interchange", kind: "operation" }),
      }),
    );
  });

  it("describes one author action and rejects unknown targets with guidance", async () => {
    const action = await postWorkbench({ input: { op: "describe", target: "author.add_object" } });
    expect(action.status).toBe(200);
    expect((action.body.result as Record<string, unknown>).kind).toBe("author_action");

    const unknown = await postWorkbench({ input: { op: "describe", target: "teleport" } });
    expect(unknown.status).toBe(400);
    expect(String(unknown.body.error)).toContain("Valid operations");
    expect(unknown.dependencies.requestWorkbenchCommand).not.toHaveBeenCalled();
  });

  it("allows overlapping read-only workbench calls in the same session", async () => {
    let releaseFirst: (value: null) => void = () => {};
    const firstGate = new Promise<null>((resolve) => {
      releaseFirst = resolve;
    });
    const { dependencies: first, json: firstJson } = createDependencies({
      session_id: "busy-session",
      input: { op: "observe" },
    });
    first.requestWorkbenchCommand = vi.fn().mockImplementation(() => firstGate);
    const firstCall = handleStageRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      first,
    );
    await vi.waitFor(() => expect(first.requestWorkbenchCommand).toHaveBeenCalled());

    const second = await postWorkbench({
      session_id: "busy-session",
      input: { op: "query_objects", spatial: { mode: "radius", center: [0, 0, 0], radius_m: 15 } },
    });
    expect(second.body.code).not.toBe("session_busy");
    expect(second.dependencies.requestWorkbenchCommand).toHaveBeenCalled();

    const otherSession = await postWorkbench({ session_id: "calm-session", input: { op: "observe" } });
    expect(otherSession.body.code).not.toBe("session_busy");

    releaseFirst(null);
    await firstCall;
    expect(firstJson).toHaveBeenCalled();
  });

  it("queues an untargeted mutation behind an in-flight read instead of returning session_busy", async () => {
    let releaseRead: (value: null) => void = () => {};
    const readGate = new Promise<null>((resolve) => {
      releaseRead = resolve;
    });
    const { dependencies: reading } = createDependencies({
      session_id: "busy-session",
      input: { op: "observe" },
    });
    reading.requestWorkbenchCommand = vi.fn().mockImplementation(() => readGate);
    const readCall = handleStageRoute(
      schedulableRequest(),
      schedulableResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      reading,
    );
    await vi.waitFor(() => expect(reading.requestWorkbenchCommand).toHaveBeenCalled());

    const { dependencies: writing, json: writeJson } = createDependencies({
      session_id: "busy-session",
      input: { op: "author", actions: [{ action: "start_scene" }] },
    });
    writing.requestWorkbenchCommand = vi.fn().mockResolvedValue({
      client: {},
      target: TARGET,
      response: { success: true, result: { changed: true } },
    });
    const writeCall = handleStageRoute(
      schedulableRequest(),
      schedulableResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      writing,
    );
    await Promise.resolve();
    expect(writing.requestWorkbenchCommand).not.toHaveBeenCalled();
    expect(writeJson).not.toHaveBeenCalled();

    releaseRead(null);
    await Promise.all([readCall, writeCall]);
    expect(writing.requestWorkbenchCommand).toHaveBeenCalled();
    expect(writeJson.mock.calls.at(-1)?.[2]).not.toEqual(expect.objectContaining({ code: "session_busy" }));
  });

  it("releases the session lock when the forwarded command times out", async () => {
    const { dependencies, json } = createDependencies({ session_id: "timeout-session", input: { op: "observe" } });
    dependencies.requestWorkbenchCommand = vi
      .fn()
      .mockRejectedValueOnce(new BrowserCommandTimeoutError("workbench", "observe", 8_000));
    const handled = await handleStageRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      dependencies,
    );
    expect(handled).toBe(true);
    expect(json).toHaveBeenCalled();

    const followUp = await postWorkbench({ session_id: "timeout-session", input: { op: "observe" } });
    expect(followUp.body.code).not.toBe("session_busy");
  });

  it("locks director_creative sessions independently from director_workbench sessions", async () => {
    let releaseCreative: (value: null) => void = () => {};
    const creativeGate = new Promise<null>((resolve) => {
      releaseCreative = resolve;
    });
    const { dependencies: creative } = createDependencies({ session_id: "shared-session", input: { op: "observe" } });
    creative.requestCreativeWorkspaceCommand = vi.fn().mockImplementation(() => creativeGate);
    const creativeCall = handleStageRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/director_creative"),
      creative,
    );
    await vi.waitFor(() => expect(creative.requestCreativeWorkspaceCommand).toHaveBeenCalled());

    const workbench = await postWorkbench({ session_id: "shared-session", input: { op: "observe" } });
    expect(workbench.body.code).not.toBe("session_busy");

    releaseCreative(null);
    await creativeCall;
  });

  it("omits the scene for opted-in callers and keeps it by default", async () => {
    const remote = {
      client: {},
      target: TARGET,
      response: { success: true, result: { project_revision: REVISION_A } },
    };

    const lean = await (async () => {
      const { dependencies, json } = createDependencies({
        session_id: "lean-session",
        omit_scene: true,
        input: { op: "observe" },
      });
      dependencies.requestWorkbenchCommand = vi.fn().mockResolvedValue(remote);
      await handleStageRoute(
        { method: "POST" } as IncomingMessage,
        mockResponse(),
        new URL("http://director.test/api/tools/director_workbench"),
        dependencies,
      );
      return json.mock.calls.at(-1)?.[2] as Record<string, unknown>;
    })();
    expect(lean.success).toBe(true);
    expect("scene" in lean).toBe(false);

    const leanDescribe = await postWorkbenchWithFlag({ op: "describe", target: "capture" }, true);
    expect("scene" in leanDescribe).toBe(false);

    const full = await (async () => {
      const { dependencies, json } = createDependencies({ session_id: "full-session", input: { op: "observe" } });
      dependencies.requestWorkbenchCommand = vi.fn().mockResolvedValue(remote);
      await handleStageRoute(
        { method: "POST" } as IncomingMessage,
        mockResponse(),
        new URL("http://director.test/api/tools/director_workbench"),
        dependencies,
      );
      return json.mock.calls.at(-1)?.[2] as Record<string, unknown>;
    })();
    expect(full.scene).toBeDefined();
  });

  async function postWorkbenchWithFlag(input: unknown, omitScene: boolean) {
    const { dependencies, json } = createDependencies({ omit_scene: omitScene, input });
    await handleStageRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/tools/director_workbench"),
      dependencies,
    );
    return json.mock.calls.at(-1)?.[2] as Record<string, unknown>;
  }
});
