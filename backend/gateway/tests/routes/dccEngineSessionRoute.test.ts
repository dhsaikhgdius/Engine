import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { BlenderBridge } from "../../dcc/blenderBridge";
import { createGodotLiveLinkHub } from "../../dcc/godotLiveLink";
import { createUnityLiveLinkHub } from "../../dcc/unityLiveLink";
import { handleDccRoute } from "../../routes/dccRoutes";
import { DIRECTOR_GODOT_LIVE_LINK_CONTRACT } from "@director/dcc-protocol";
import { getDirectorProjectRevision } from "@director/project-schema";
import { createTestDirectorProject } from "../fixtures/createTestDirectorProject";

interface ToolBody {
  result?: Record<string, unknown>;
  capture?: { mimeType: string; dataBase64: string; width: number; height: number };
}

describe("director_dcc Unity engine session", () => {
  it("queues a capture on the open editor session and returns its visible result", async () => {
    const hub = createUnityLiveLinkHub();
    const blender: BlenderBridge = { status: vi.fn(), exportBlend: vi.fn() };

    async function invoke(input: Record<string, unknown>) {
      const json = vi.fn();
      const handled = await handleDccRoute(
        { method: "POST", headers: {} } as IncomingMessage,
        {} as ServerResponse,
        new URL("http://test/api/tools/director_dcc"),
        {
          readBody: vi.fn().mockResolvedValue({ input }),
          json,
          getProject: vi.fn(),
          blender,
          unityLiveLink: hub,
        },
      );
      expect(handled).toBe(true);
      return json.mock.calls.at(-1) as [ServerResponse, number, ToolBody];
    }

    const [, startStatus, startBody] = await invoke({ op: "start_engine_session", provider: "unity" });
    expect(startStatus).toBe(200);
    const { sessionId, token } = startBody.result as { sessionId: string; token: string };

    const [, queueStatus, queueBody] = await invoke({
      op: "engine_session_command",
      provider: "unity",
      session_id: sessionId,
      command: "capture_frame",
      width: 800,
      height: 450,
    });
    expect(queueStatus).toBe(200);
    expect(queueBody.result).toMatchObject({ status: "pending", command: "capture_frame" });
    const commandId = queueBody.result?.commandId as string;

    const delivery = await hub.poll({ sessionId, token, afterSeq: 0, waitMs: 0 });
    expect(delivery.events[0]?.payload).toMatchObject({ kind: "editor_command", commandId });
    const imageBase64 = Buffer.from("fixture-png").toString("base64");
    hub.completeCommand(sessionId, token, {
      commandId,
      command: "capture_frame",
      status: "completed",
      mimeType: "image/png",
      imageBase64,
      width: 800,
      height: 450,
    });

    const [, resultStatus, resultBody] = await invoke({
      op: "engine_session_command_status",
      provider: "unity",
      session_id: sessionId,
      command_id: commandId,
    });
    expect(resultStatus).toBe(200);
    expect(resultBody.result).toMatchObject({ status: "completed", commandId });
    expect(resultBody.capture).toEqual({
      mimeType: "image/png",
      dataBase64: imageBase64,
      width: 800,
      height: 450,
    });
  });
});

describe("director_dcc Godot engine workshop", () => {
  it("syncs an engine-authoritative snapshot into Director's review projection", async () => {
    const hub = createGodotLiveLinkHub();
    const project = createTestDirectorProject();
    project.objects.push({
      id: "review-object",
      name: "Review Object",
      kind: "prop",
      visible: true,
      locked: false,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    });
    const preview = hub.hello({
      contract: DIRECTOR_GODOT_LIVE_LINK_CONTRACT,
      provider: "godot",
      connectorVersion: "0.3.0",
      hostVersion: "Godot 4.3",
      scenePath: "res://main.tscn",
    });
    hub.frame({
      contract: DIRECTOR_GODOT_LIVE_LINK_CONTRACT,
      sessionId: preview.sessionId,
      sequence: 1,
      entities: [
        {
          directorId: project.objects[0]!.id,
          entityType: "object",
          transform: {
            location: [1, 2, 3],
            rotationQuaternion: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
        },
        {
          directorId: "engine-only-node",
          entityType: "object",
          transform: {
            location: [2, 0, 1],
            rotationQuaternion: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
        },
      ],
    });
    const applyAuthoring = vi.fn().mockResolvedValue({ success: true });

    async function invoke(input: Record<string, unknown>) {
      const json = vi.fn();
      await handleDccRoute(
        { method: "POST", headers: {} } as IncomingMessage,
        {} as ServerResponse,
        new URL("http://test/api/tools/director_dcc"),
        {
          readBody: vi.fn().mockResolvedValue({ input }),
          json,
          getProject: vi.fn().mockResolvedValue(project),
          blender: { status: vi.fn(), exportBlend: vi.fn() } as BlenderBridge,
          godotLiveLink: hub,
          applyAuthoring,
        },
      );
      return json.mock.calls.at(-1) as [ServerResponse, number, ToolBody];
    }

    const [, startStatus, startBody] = await invoke({
      op: "start_engine_session",
      provider: "godot",
      authority: "engine",
      allow_code: true,
    });
    expect(startStatus).toBe(200);
    const sessionId = startBody.result?.sessionId as string;

    const [, commandStatus, commandBody] = await invoke({
      op: "engine_session_command",
      provider: "godot",
      session_id: sessionId,
      command: "sync_scene",
    });
    expect(commandStatus).toBe(200);
    const commandId = commandBody.result?.commandId as string;

    const [, syncStatus, syncBody] = await invoke({
      op: "sync_engine_session_to_director",
      provider: "godot",
      session_id: sessionId,
      command_id: commandId,
      expected_revision: getDirectorProjectRevision(project),
      idempotency_key: "godot-review-sync-1",
    });
    expect(syncStatus).toBe(200);
    expect(syncBody.result).toMatchObject({
      provider: "godot",
      authority: "engine",
      syncedEntityCount: 1,
      skippedEntityCount: 1,
    });
    expect(applyAuthoring).toHaveBeenCalledWith(
      expect.objectContaining({
        op: "replace_project",
        project: expect.objectContaining({
          engineWorkspace: expect.objectContaining({ provider: "godot", authority: "engine" }),
          objects: expect.arrayContaining([
            expect.objectContaining({
              id: project.objects[0]!.id,
              transform: expect.objectContaining({ position: [1, 2, 3] }),
            }),
          ]),
        }),
      }),
    );
  });
});

describe("director_dcc Unreal engine workshop", () => {
  it("routes opt-in Editor Python through the existing live-preview connection", async () => {
    const session = {
      contract: "director-unreal-live-preview-status-v1" as const,
      sessionId: "unreal-session-1",
      port: 42_813,
      allowCode: true,
      authority: "engine" as const,
      openedAtMs: 1,
      summary: {
        contract: "director-unreal-live-preview-session-v1" as const,
        provider: "unreal" as const,
        protocol: "director-unreal-live-preview-v1" as const,
        forwardedFrameCount: 0,
        droppedFrameCount: 0,
        ignoredInboundByteCount: 0,
        closed: false,
        disconnectReason: null,
        disconnectDetail: null,
      },
    };
    const command = {
      provider: "unreal" as const,
      sessionId: session.sessionId,
      commandId: "11111111-1111-4111-8111-111111111111",
      command: "execute_code" as const,
      status: "pending" as const,
      requestedAt: new Date(1).toISOString(),
      completedAt: null,
    };
    const hub = {
      open: vi.fn().mockResolvedValue(session),
      frame: vi.fn(),
      requestCommand: vi.fn().mockReturnValue(command),
      commandStatus: vi.fn().mockReturnValue(command),
      status: vi.fn().mockReturnValue([session]),
      read: vi.fn().mockReturnValue(session),
      close: vi.fn().mockResolvedValue(session),
    };

    async function invoke(input: Record<string, unknown>) {
      const json = vi.fn();
      await handleDccRoute(
        { method: "POST", headers: {} } as IncomingMessage,
        {} as ServerResponse,
        new URL("http://test/api/tools/director_dcc"),
        {
          readBody: vi.fn().mockResolvedValue({ input }),
          json,
          getProject: vi.fn(),
          blender: { status: vi.fn(), exportBlend: vi.fn() } as BlenderBridge,
          unrealLivePreview: hub,
        },
      );
      return json.mock.calls.at(-1) as [ServerResponse, number, ToolBody];
    }

    const [, startStatus] = await invoke({
      op: "start_engine_session",
      provider: "unreal",
      port: 42_813,
      allow_code: true,
      authority: "engine",
    });
    expect(startStatus).toBe(200);
    expect(hub.open).toHaveBeenCalledWith({ port: 42_813, allowCode: true, authority: "engine" });

    const [, commandStatus] = await invoke({
      op: "engine_session_command",
      provider: "unreal",
      session_id: session.sessionId,
      command: "execute_code",
      code: 'print("ready")',
    });
    expect(commandStatus).toBe(200);
    expect(hub.requestCommand).toHaveBeenCalledWith(session.sessionId, {
      command: "execute_code",
      code: 'print("ready")',
    });
  });
});
