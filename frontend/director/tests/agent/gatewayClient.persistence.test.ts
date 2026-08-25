import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createInitialDirectorState, useDirectorStore } from "../../src/comprehensive/editor/store/directorStore";
import {
  clearViewportCaptureHandler,
  setViewportCaptureHandler,
} from "../../src/comprehensive/editor/io/captureBridge";
import { getDirectorProjectRevision } from "../../src/comprehensive/editor/schema/directorProjectRevision";
import { getDirectorSessionRuntime } from "../../src/comprehensive/editor/session/directorSessionRuntime";
import { createDefaultScene } from "@director/stage-protocol";

const agentGatewayMocks = vi.hoisted(() => ({
  bootstrap: vi.fn(async () => ({ browserToken: "browser-token" })),
  clear: vi.fn(),
  fetch: vi.fn<typeof fetch>(),
}));

vi.mock("../../src/comprehensive/editor/assistant/agentGatewayClient", () => ({
  bootstrapDirectorAgent: agentGatewayMocks.bootstrap,
  clearDirectorAgentClient: agentGatewayMocks.clear,
  directorAgentFetch: agentGatewayMocks.fetch,
  getDirectorAgentBasePath: () => "/te-man/director/agent",
}));

import { initializeGateway } from "../../src/agent/gatewayClient";

type SocketListener = (event: Event | MessageEvent) => void;

class TestWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: TestWebSocket[] = [];

  readonly listeners = new Map<string, Set<SocketListener>>();
  readonly sent: string[] = [];
  readyState = TestWebSocket.CONNECTING;

  constructor(readonly url: string) {
    TestWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? new Set<SocketListener>();
    listeners.add(listener as SocketListener);
    this.listeners.set(type, listeners);
  }

  send(value: string) {
    this.sent.push(value);
  }

  close() {
    this.readyState = TestWebSocket.CLOSED;
    this.emit("close", new Event("close"));
  }

  open() {
    this.readyState = TestWebSocket.OPEN;
    this.emit("open", new Event("open"));
  }

  receive(value: unknown) {
    this.emit("message", new MessageEvent("message", { data: JSON.stringify(value) }));
  }

  private emit(type: string, event: Event | MessageEvent) {
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }
}

beforeEach(() => {
  TestWebSocket.instances = [];
  agentGatewayMocks.bootstrap.mockClear();
  agentGatewayMocks.clear.mockClear();
  agentGatewayMocks.fetch.mockReset();
  clearViewportCaptureHandler();
  localStorage.clear();
  useDirectorStore.setState({ ...useDirectorStore.getState(), ...createInitialDirectorState() });
  vi.stubGlobal("WebSocket", TestWebSocket);
});

afterEach(() => {
  clearViewportCaptureHandler();
  vi.unstubAllGlobals();
});

it("observes an existing scene project before the first autosave instead of causing a stale revision conflict", async () => {
  agentGatewayMocks.fetch.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/scenes/local-stage/project") && (init?.method ?? "GET") === "GET") {
      return new Response(
        JSON.stringify({
          sceneId: "local-stage",
          revision: 42,
          updatedAt: "2026-08-13T00:00:00.000Z",
          updatedBy: "test",
          project: structuredClone(useDirectorStore.getState().project),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ message: "unexpected request" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  });

  const dispose = initializeGateway();
  try {
    await waitFor(() => expect(TestWebSocket.instances).toHaveLength(1));
    const socket = TestWebSocket.instances[0]!;
    socket.open();
    socket.receive({ type: "state", source: "gateway", scene: createDefaultScene() });

    await waitFor(() => expect(agentGatewayMocks.fetch).toHaveBeenCalled());
    const projectRequests = agentGatewayMocks.fetch.mock.calls.filter(([input]) =>
      String(input).endsWith("/scenes/local-stage/project"),
    );
    expect(projectRequests).toHaveLength(1);
    expect(projectRequests[0]?.[1]?.method ?? "GET").toBe("GET");
  } finally {
    dispose();
  }
});

it("accepts a revision conflict when the remote project already matches the current live project", async () => {
  const initialProject = structuredClone(useDirectorStore.getState().project);
  const firstSnapshot = structuredClone(initialProject);
  firstSnapshot.scene.backgroundColor = "#334455";
  const remoteProject = structuredClone(firstSnapshot);
  remoteProject.scene.backgroundColor = "#445566";
  let projectGets = 0;
  let projectPuts = 0;

  agentGatewayMocks.fetch.mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/scenes/local-stage/project") && method === "GET") {
      projectGets += 1;
      return new Response(
        JSON.stringify({
          sceneId: "local-stage",
          revision: projectGets === 1 ? 42 : 43,
          updatedAt: "2026-08-13T00:00:00.000Z",
          updatedBy: "test",
          project: projectGets === 1 ? initialProject : remoteProject,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/scenes/local-stage/project") && method === "PUT") {
      projectPuts += 1;
      if (projectPuts === 1) {
        useDirectorStore.getState().replaceProject(remoteProject);
        return new Response(JSON.stringify({ message: "Scene project revision changed" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          sceneId: "local-stage",
          revision: 44,
          updatedAt: "2026-08-13T00:00:00.000Z",
          updatedBy: "test",
          project: remoteProject,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/api/stage") && method === "PUT") {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ message: "unexpected request" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  });

  const dispose = initializeGateway();
  try {
    await waitFor(() => expect(TestWebSocket.instances).toHaveLength(1));
    TestWebSocket.instances[0]!.open();
    useDirectorStore.getState().replaceProject(initialProject);
    await waitFor(() => expect(projectGets).toBe(1), { timeout: 3_000 });
    useDirectorStore.getState().replaceProject(firstSnapshot);

    await waitFor(() => expect(projectPuts).toBeGreaterThanOrEqual(1), { timeout: 3_000 });
    await waitFor(
      () =>
        expect(getDirectorSessionRuntime()).toMatchObject({
          dirty: false,
          conflict: null,
        }),
      { timeout: 3_000 },
    );
    expect(projectGets).toBeGreaterThanOrEqual(2);
  } finally {
    dispose();
  }
});

it("captures opt-in author evidence against the committed project revision", async () => {
  agentGatewayMocks.fetch.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/scenes/local-stage/project") && (init?.method ?? "GET") === "GET") {
      return new Response(
        JSON.stringify({
          sceneId: "local-stage",
          revision: 42,
          updatedAt: "2026-08-13T00:00:00.000Z",
          updatedBy: "test",
          project: structuredClone(useDirectorStore.getState().project),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const capture = vi.fn(async () => [
    {
      label: "Author evidence",
      dataUrl: "data:image/png;base64,YXV0aG9yLWV2aWRlbmNl",
      meta: {
        mode: "director" as const,
        cameraId: null,
        fov: 50,
        position: [0, 2.2, 9] as [number, number, number],
        target: [0, 1.2, 0] as [number, number, number],
      },
    },
  ]);
  const clearCapture = setViewportCaptureHandler(capture);

  const dispose = initializeGateway();
  try {
    await waitFor(() => expect(TestWebSocket.instances).toHaveLength(1));
    const socket = TestWebSocket.instances[0]!;
    socket.open();
    await waitFor(() => expect(socket.sent.length).toBeGreaterThan(0));
    const hello = socket.sent.map((value) => JSON.parse(value)).find((value) => value.type === "hello");
    const target = {
      token: "author-evidence-target",
      client_id: hello.client_id,
      instance_id: hello.instance_id,
      scene_id: hello.scene_id,
      creative_scope_id: hello.creative_scope_id,
      contract_version: 2 as const,
    };
    socket.receive({ type: "target-bound", target });
    const beforeRevision = getDirectorProjectRevision(useDirectorStore.getState().project);
    socket.receive({
      type: "workbench-command-request",
      requestId: "author-evidence-1",
      target,
      input: {
        op: "author",
        expected_revision: beforeRevision,
        idempotency_key: "author-evidence-1",
        actions: [
          {
            action: "upsert_asset",
            asset: {
              id: "asset-evidence-box",
              kind: "prop",
              sourceType: "model",
              fileName: "evidence-box.glb",
              url: "https://assets.example.test/evidence-box.glb",
            },
          },
          {
            action: "add_object",
            id: "evidence-box",
            name: "Evidence box",
            kind: "prop",
            asset_id: "asset-evidence-box",
          },
        ],
        evidence: {},
      },
    });

    await waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        preset: "current",
        source: "camera-panel",
        renderPass: "clean",
        cleanPlate: true,
        width: 640,
        height: 360,
        signal: expect.any(AbortSignal),
      }),
    );
    await waitFor(() =>
      expect(
        socket.sent.map((value) => JSON.parse(value)).find((value) => value.requestId === "author-evidence-1"),
      ).toBeTruthy(),
    );
    const response = socket.sent
      .map((value) => JSON.parse(value))
      .find((value) => value.requestId === "author-evidence-1");
    expect(response).toMatchObject({
      success: true,
      captureDataUrl: "data:image/png;base64,YXV0aG9yLWV2aWRlbmNl",
      result: {
        evidence: {
          kind: "camera_frame",
          status: "captured",
          width: 640,
          height: 360,
          project_revision: expect.any(String),
        },
      },
    });
    expect(response.result.evidence).not.toHaveProperty("dataUrl");
    expect(response.result.project_revision).not.toBe(beforeRevision);
  } finally {
    dispose();
    clearCapture();
  }
});
