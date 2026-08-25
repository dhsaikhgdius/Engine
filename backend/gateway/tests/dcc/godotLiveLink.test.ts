import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  DIRECTOR_GODOT_LIVE_LINK_CONTRACT,
  directorGodotLiveLinkPreviewSchema,
  directorGodotLiveLinkSessionSchema,
} from "@director/dcc-protocol";
import type { BlenderBridge } from "../../dcc/blenderBridge";
import { createGodotLiveLinkHub, DirectorGodotLiveLinkError } from "../../dcc/godotLiveLink";
import { handleDccRoute } from "../../routes/dccRoutes";

const repositoryRoot = resolve(__dirname, "..", "..", "..", "..");
const addonDirectory = resolve(repositoryRoot, "integrations", "godot", "addons", "director_bridge");

const IDLE_TIMEOUT_MS = 10_000;

function transform(x: number) {
  return {
    location: [x, 0, 0] as [number, number, number],
    rotationQuaternion: [0, 0, 0, 1] as [number, number, number, number],
    scale: [1, 1, 1] as [number, number, number],
  };
}

function hello(overrides: Record<string, unknown> = {}) {
  return {
    contract: DIRECTOR_GODOT_LIVE_LINK_CONTRACT,
    provider: "godot",
    connectorVersion: "0.3.0",
    hostVersion: "Godot 4.3.0",
    scenePath: "res://director/scenes/director_fixture.tscn",
    ...overrides,
  };
}

function frame(sessionId: string, sequence: number, entities?: unknown[]) {
  return {
    contract: DIRECTOR_GODOT_LIVE_LINK_CONTRACT,
    sessionId,
    sequence,
    atMs: sequence * 100,
    entities: entities ?? [{ directorId: "obj-box", entityType: "object", transform: transform(sequence) }],
  };
}

function expectLiveLinkError(action: () => unknown, code: string, status: number) {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(DirectorGodotLiveLinkError);
    expect((error as DirectorGodotLiveLinkError).code).toBe(code);
    expect((error as DirectorGodotLiveLinkError).status).toBe(status);
    return;
  }
  expect.unreachable(`expected a live-link error with code ${code}`);
}

describe("Godot live-link hub ordering and preview state", () => {
  function hubWithClock() {
    let atMs = 1_000_000;
    const hub = createGodotLiveLinkHub({ idleTimeoutMs: IDLE_TIMEOUT_MS, now: () => atMs });
    return { hub, advance: (ms: number) => (atMs += ms) };
  }

  it("negotiates a session and serves a schema-valid, never-authoritative preview", () => {
    const { hub } = hubWithClock();
    const session = directorGodotLiveLinkSessionSchema.parse(hub.hello(hello()));
    expect(session.idleTimeoutMs).toBe(IDLE_TIMEOUT_MS);
    expect(session.maxEntitiesPerFrame).toBe(512);

    hub.frame(frame(session.sessionId, 1));
    const preview = directorGodotLiveLinkPreviewSchema.parse(hub.preview());
    expect(preview.authoritative).toBe(false);
    expect(preview.sessions).toHaveLength(1);
    expect(preview.sessions[0]).toMatchObject({
      sessionId: session.sessionId,
      connectorVersion: "0.3.0",
      scenePath: "res://director/scenes/director_fixture.tscn",
      lastSequence: 1,
      frameCount: 1,
    });
  });

  it("accepts strictly increasing sequences with gaps and merges sparse frames per entity", () => {
    const { hub } = hubWithClock();
    const session = hub.hello(hello());
    hub.frame(frame(session.sessionId, 1));
    hub.frame(
      frame(session.sessionId, 5, [
        { directorId: "cam-main", entityType: "camera", transform: transform(5), fovDeg: 45 },
      ]),
    );
    const preview = hub.preview();
    const entities = preview.sessions[0]!.entities;
    expect(entities.map(({ directorId }) => directorId).sort()).toEqual(["cam-main", "obj-box"]);
    expect(entities.find(({ directorId }) => directorId === "obj-box")).toMatchObject({ atSequence: 1 });
    expect(entities.find(({ directorId }) => directorId === "cam-main")).toMatchObject({ atSequence: 5, fovDeg: 45 });
  });

  it("rejects replayed and stale sequences without overwriting newer preview state", () => {
    const { hub } = hubWithClock();
    const session = hub.hello(hello());
    hub.frame(frame(session.sessionId, 7));
    expectLiveLinkError(() => hub.frame(frame(session.sessionId, 7)), "live_link_sequence_stale", 409);
    expectLiveLinkError(() => hub.frame(frame(session.sessionId, 3)), "live_link_sequence_stale", 409);
    const preview = hub.preview();
    expect(preview.sessions[0]!.lastSequence).toBe(7);
    expect(preview.sessions[0]!.frameCount).toBe(1);
    expect(preview.sessions[0]!.entities[0]!.transform.location[0]).toBe(7);
  });

  it("rejects frames for unknown sessions", () => {
    const { hub } = hubWithClock();
    expectLiveLinkError(
      () => hub.frame(frame("00000000-0000-4000-8000-000000000000", 1)),
      "live_link_session_unknown",
      404,
    );
  });

  it("disconnect via idle timeout discards all preview state and rejects late frames", () => {
    const { hub, advance } = hubWithClock();
    const session = hub.hello(hello());
    hub.frame(frame(session.sessionId, 1));
    advance(IDLE_TIMEOUT_MS + 1);
    // A frame arriving after the timeout is the reconnect-after-drop case:
    // the session is gone, its preview state is discarded, and nothing
    // durable remains anywhere (the hub has no project access at all).
    expectLiveLinkError(() => hub.frame(frame(session.sessionId, 2)), "live_link_session_expired", 410);
    expect(hub.preview().sessions).toEqual([]);
  });

  it("disconnect via missed bye sweeps the session out of the preview", () => {
    const { hub, advance } = hubWithClock();
    const session = hub.hello(hello());
    hub.frame(frame(session.sessionId, 1));
    expect(hub.preview().sessions).toHaveLength(1);
    advance(IDLE_TIMEOUT_MS + 1);
    expect(hub.preview().sessions).toEqual([]);
    // A new hello starts cleanly from sequence zero.
    const next = hub.hello(hello());
    expect(next.sessionId).not.toBe(session.sessionId);
    expect(hub.frame(frame(next.sessionId, 1)).accepted).toBe(true);
  });

  it("bye ends the session idempotently and clears its preview state", () => {
    const { hub } = hubWithClock();
    const session = hub.hello(hello());
    hub.frame(frame(session.sessionId, 1));
    const bye = { contract: DIRECTOR_GODOT_LIVE_LINK_CONTRACT, sessionId: session.sessionId, reason: "toggled off" };
    expect(hub.bye(bye)).toMatchObject({ ended: true });
    expect(hub.preview().sessions).toEqual([]);
    expect(hub.bye(bye)).toMatchObject({ ended: false });
  });

  it("caps concurrent sessions with a structured limit error", () => {
    const limited = createGodotLiveLinkHub({ idleTimeoutMs: IDLE_TIMEOUT_MS, maxSessions: 1, now: () => 1 });
    limited.hello(hello());
    expectLiveLinkError(() => limited.hello(hello()), "live_link_session_limit", 429);
  });

  it("rejects malformed messages and camera-only channels on objects", () => {
    const { hub } = hubWithClock();
    expectLiveLinkError(() => hub.hello({ contract: "wrong" }), "live_link_invalid", 400);
    const session = hub.hello(hello());
    expectLiveLinkError(
      () =>
        hub.frame(
          frame(session.sessionId, 1, [
            { directorId: "obj-box", entityType: "object", transform: transform(1), fovDeg: 50 },
          ]),
        ),
      "live_link_invalid",
      400,
    );
    expectLiveLinkError(() => hub.frame(frame(session.sessionId, 0)), "live_link_invalid", 400);
  });
});

describe("Godot live-link routes", () => {
  function makeResponse() {
    const writes: Array<{ status: number; body: unknown }> = [];
    const json = (_response: ServerResponse, status: number, body: unknown) => {
      writes.push({ status, body });
    };
    return { writes, json, response: {} as ServerResponse };
  }

  function makeDependencies(hub: ReturnType<typeof createGodotLiveLinkHub> | undefined, body: unknown) {
    const { writes, json, response } = makeResponse();
    const getProject = vi.fn(async () => {
      throw new Error("live-link routes must never read the project");
    });
    const dependencies = {
      readBody: async () => body,
      json,
      getProject,
      blender: {} as BlenderBridge,
      godotLiveLink: hub,
    };
    return { writes, response, dependencies, getProject };
  }

  async function route(method: string, path: string, hub?: ReturnType<typeof createGodotLiveLinkHub>, body?: unknown) {
    const { writes, response, dependencies, getProject } = makeDependencies(hub, body);
    const handled = await handleDccRoute(
      { method } as IncomingMessage,
      response,
      new URL(`http://gateway.local${path}`),
      dependencies,
    );
    return { handled, writes, getProject };
  }

  it("answers hello/frame/preview/bye without ever touching the live project", async () => {
    const hub = createGodotLiveLinkHub({ idleTimeoutMs: IDLE_TIMEOUT_MS });
    const helloRun = await route("POST", "/api/dcc/live-link/godot/hello", hub, hello());
    expect(helloRun.handled).toBe(true);
    expect(helloRun.writes[0]!.status).toBe(200);
    const sessionId = (helloRun.writes[0]!.body as { result: { sessionId: string } }).result.sessionId;

    const frameRun = await route("POST", "/api/dcc/live-link/godot/frame", hub, frame(sessionId, 1));
    expect(frameRun.writes[0]).toMatchObject({ status: 200, body: { success: true } });

    const previewRun = await route("GET", "/api/dcc/live-link/godot/preview", hub);
    expect(previewRun.writes[0]!.status).toBe(200);
    const preview = (previewRun.writes[0]!.body as { result: { authoritative: boolean; sessions: unknown[] } }).result;
    expect(preview.authoritative).toBe(false);
    expect(preview.sessions).toHaveLength(1);

    const byeRun = await route("POST", "/api/dcc/live-link/godot/bye", hub, {
      contract: DIRECTOR_GODOT_LIVE_LINK_CONTRACT,
      sessionId,
    });
    expect(byeRun.writes[0]).toMatchObject({ status: 200, body: { success: true } });

    for (const run of [helloRun, frameRun, previewRun, byeRun]) {
      expect(run.getProject).not.toHaveBeenCalled();
    }
  });

  it("maps hub rejections to structured HTTP errors", async () => {
    const hub = createGodotLiveLinkHub({ idleTimeoutMs: IDLE_TIMEOUT_MS });
    const session = hub.hello(hello());
    hub.frame(frame(session.sessionId, 5));
    const stale = await route("POST", "/api/dcc/live-link/godot/frame", hub, frame(session.sessionId, 5));
    expect(stale.writes[0]).toMatchObject({
      status: 409,
      body: { success: false, code: "live_link_sequence_stale" },
    });

    const unknown = await route(
      "POST",
      "/api/dcc/live-link/godot/frame",
      hub,
      frame("00000000-0000-4000-8000-000000000000", 1),
    );
    expect(unknown.writes[0]).toMatchObject({ status: 404, body: { code: "live_link_session_unknown" } });
  });

  it("enforces methods and reports an unconfigured hub", async () => {
    const hub = createGodotLiveLinkHub();
    const wrongMethod = await route("POST", "/api/dcc/live-link/godot/preview", hub);
    expect(wrongMethod.writes[0]!.status).toBe(405);
    const wrongMethodHello = await route("GET", "/api/dcc/live-link/godot/hello", hub);
    expect(wrongMethodHello.writes[0]!.status).toBe(405);
    const missingHub = await route("POST", "/api/dcc/live-link/godot/hello", undefined, hello());
    expect(missingHub.writes[0]).toMatchObject({ status: 503, body: { code: "live_link_unavailable" } });
  });
});

describe("Godot connector live-link source contract (outbound only)", () => {
  const addonSources = readdirSync(addonDirectory)
    .filter((name) => name.endsWith(".gd"))
    .map((name) => ({ name, text: readFileSync(resolve(addonDirectory, name), "utf8") }));

  it("never opens a listening port or scripting server anywhere in the addon", () => {
    expect(addonSources.length).toBeGreaterThan(0);
    for (const source of addonSources) {
      expect(source.text, source.name).not.toMatch(/TCPServer|UDPServer|WebSocketServer|DTLSServer|\.listen\(/);
    }
  });

  it("speaks the pinned live-link contract against the gateway's token-guarded routes", () => {
    const sender = readFileSync(resolve(addonDirectory, "director_live_link.gd"), "utf8");
    expect(sender).toContain(`LIVE_LINK_CONTRACT := "${DIRECTOR_GODOT_LIVE_LINK_CONTRACT}"`);
    expect(sender).toContain('HELLO_PATH := "/api/dcc/live-link/godot/hello"');
    expect(sender).toContain('FRAME_PATH := "/api/dcc/live-link/godot/frame"');
    expect(sender).toContain('BYE_PATH := "/api/dcc/live-link/godot/bye"');
    // Strictly increasing sequence numbers and env-provided credentials.
    expect(sender).toContain("_sequence += 1");
    expect(sender).toContain('OS.get_environment("DIRECTOR_GATEWAY_TOKEN")');
    expect(sender).not.toMatch(/X-Director-Browser-Token: (?!%s)/);
  });

  it("wires the editor toggle through the sender module without a bespoke transport", () => {
    const plugin = readFileSync(resolve(addonDirectory, "director_bridge.gd"), "utf8");
    expect(plugin).toContain('preload("res://addons/director_bridge/director_live_link.gd")');
    expect(plugin).toContain("HTTPRequest.new()");
    expect(plugin).toContain("DirectorLiveLink.gateway_url()");
    // The plugin sends payloads built by the module; it never assembles its
    // own contract fields or sequence numbers.
    expect(plugin).not.toContain('"sequence"');
    expect(plugin).not.toContain("director-godot-live-link-v1");
  });
});
