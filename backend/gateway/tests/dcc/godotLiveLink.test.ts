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

/** A syntactically valid session credential that no live session holds. */
const UNKNOWN_SESSION = { sessionId: "00000000-0000-4000-8000-000000000000", sessionToken: "0".repeat(32) };

type SessionGrant = { sessionId: string; sessionToken: string };

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
    connectorVersion: "0.4.0",
    hostVersion: "Godot 4.3.0",
    scenePath: "res://director/scenes/director_fixture.tscn",
    ...overrides,
  };
}

function frame(session: SessionGrant, sequence: number, entities?: unknown[]) {
  return {
    contract: DIRECTOR_GODOT_LIVE_LINK_CONTRACT,
    sessionId: session.sessionId,
    sessionToken: session.sessionToken,
    sequence,
    atMs: sequence * 100,
    entities: entities ?? [{ directorId: "obj-box", entityType: "object", transform: transform(sequence) }],
  };
}

function bye(session: SessionGrant, reason?: string) {
  return {
    contract: DIRECTOR_GODOT_LIVE_LINK_CONTRACT,
    sessionId: session.sessionId,
    sessionToken: session.sessionToken,
    ...(reason ? { reason } : {}),
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

  it("negotiates a session grant with a per-session token and serves a never-authoritative preview", () => {
    const { hub } = hubWithClock();
    const session = directorGodotLiveLinkSessionSchema.parse(hub.hello(hello()));
    expect(session.idleTimeoutMs).toBe(IDLE_TIMEOUT_MS);
    expect(session.maxEntitiesPerFrame).toBe(512);
    expect(session.sessionToken.length).toBeGreaterThanOrEqual(24);

    hub.frame(frame(session, 1));
    const preview = directorGodotLiveLinkPreviewSchema.parse(hub.preview());
    expect(preview.authoritative).toBe(false);
    expect(preview.sessions).toHaveLength(1);
    expect(preview.sessions[0]).toMatchObject({
      sessionId: session.sessionId,
      connectorVersion: "0.4.0",
      scenePath: "res://director/scenes/director_fixture.tscn",
      lastSequence: 1,
      frameCount: 1,
    });
    // The observable snapshot must never leak the per-session secret.
    expect(JSON.stringify(preview)).not.toContain(session.sessionToken);
  });

  it("accepts strictly increasing sequences with gaps and merges sparse frames per entity", () => {
    const { hub } = hubWithClock();
    const session = hub.hello(hello());
    hub.frame(frame(session, 1));
    hub.frame(
      frame(session, 5, [{ directorId: "cam-main", entityType: "camera", transform: transform(5), fovDeg: 45 }]),
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
    hub.frame(frame(session, 7));
    expectLiveLinkError(() => hub.frame(frame(session, 7)), "live_link_sequence_stale", 409);
    expectLiveLinkError(() => hub.frame(frame(session, 3)), "live_link_sequence_stale", 409);
    const preview = hub.preview();
    expect(preview.sessions[0]!.lastSequence).toBe(7);
    expect(preview.sessions[0]!.frameCount).toBe(1);
    expect(preview.sessions[0]!.entities[0]!.transform.location[0]).toBe(7);
  });

  it("rejects frames for unknown sessions", () => {
    const { hub } = hubWithClock();
    expectLiveLinkError(() => hub.frame(frame(UNKNOWN_SESSION, 1)), "live_link_session_unknown", 404);
  });

  it("rejects frames and byes whose session token does not match (session ids are observable)", () => {
    const { hub } = hubWithClock();
    const victim = hub.hello(hello());
    hub.frame(frame(victim, 1));
    // An attacker reads the sessionId from the preview snapshot but cannot
    // know the token, and must not be able to inject frames or end the link.
    const attacker: SessionGrant = { sessionId: victim.sessionId, sessionToken: "x".repeat(32) };
    expectLiveLinkError(() => hub.frame(frame(attacker, 2)), "live_link_token_invalid", 401);
    expectLiveLinkError(() => hub.bye(bye(attacker, "hijack attempt")), "live_link_token_invalid", 401);
    // The victim session is untouched by either attempt.
    const preview = hub.preview();
    expect(preview.sessions[0]!.lastSequence).toBe(1);
    expect(hub.frame(frame(victim, 2)).accepted).toBe(true);
  });

  it("never accepts one session's token for another live session", () => {
    const { hub } = hubWithClock();
    const first = hub.hello(hello());
    const second = hub.hello(hello());
    const crossed: SessionGrant = { sessionId: second.sessionId, sessionToken: first.sessionToken };
    expectLiveLinkError(() => hub.frame(frame(crossed, 1)), "live_link_token_invalid", 401);
    expect(hub.frame(frame(second, 1)).accepted).toBe(true);
  });

  it("disconnect via idle timeout discards all preview state and rejects late frames", () => {
    const { hub, advance } = hubWithClock();
    const session = hub.hello(hello());
    hub.frame(frame(session, 1));
    advance(IDLE_TIMEOUT_MS + 1);
    // A frame arriving after the timeout is the reconnect-after-drop case:
    // the session is gone, its preview state is discarded, and nothing
    // durable remains anywhere (the hub has no project access at all).
    expectLiveLinkError(() => hub.frame(frame(session, 2)), "live_link_session_expired", 410);
    expect(hub.preview().sessions).toEqual([]);
  });

  it("disconnect via missed bye sweeps the session out of the preview", () => {
    const { hub, advance } = hubWithClock();
    const session = hub.hello(hello());
    hub.frame(frame(session, 1));
    expect(hub.preview().sessions).toHaveLength(1);
    advance(IDLE_TIMEOUT_MS + 1);
    expect(hub.preview().sessions).toEqual([]);
    // A new hello starts cleanly from sequence zero with a fresh token.
    const next = hub.hello(hello());
    expect(next.sessionId).not.toBe(session.sessionId);
    expect(next.sessionToken).not.toBe(session.sessionToken);
    expect(hub.frame(frame(next, 1)).accepted).toBe(true);
  });

  it("bye ends the session idempotently and a replayed bye or frame finds nothing", () => {
    const { hub } = hubWithClock();
    const session = hub.hello(hello());
    hub.frame(frame(session, 1));
    expect(hub.bye(bye(session, "toggled off"))).toMatchObject({ ended: true });
    expect(hub.preview().sessions).toEqual([]);
    // Replay of the bye (same valid credentials) is idempotent, and a replayed
    // frame cannot resurrect the session.
    expect(hub.bye(bye(session, "toggled off"))).toMatchObject({ ended: false });
    expectLiveLinkError(() => hub.frame(frame(session, 2)), "live_link_session_unknown", 404);
  });

  it("caps concurrent sessions with a structured limit error and frees capacity via the idle sweep", () => {
    let atMs = 1;
    const limited = createGodotLiveLinkHub({ idleTimeoutMs: IDLE_TIMEOUT_MS, maxSessions: 2, now: () => atMs });
    limited.hello(hello());
    limited.hello(hello());
    expectLiveLinkError(() => limited.hello(hello()), "live_link_session_limit", 429);
    // After the idle TTL the abandoned sessions are swept and hello succeeds.
    atMs += IDLE_TIMEOUT_MS + 1;
    expect(limited.hello(hello()).sessionId).toBeTruthy();
  });

  it("rejects malformed messages, camera-only channels on objects, and oversized frames", () => {
    const { hub } = hubWithClock();
    expectLiveLinkError(() => hub.hello({ contract: "wrong" }), "live_link_invalid", 400);
    const session = hub.hello(hello());
    expectLiveLinkError(
      () =>
        hub.frame(
          frame(session, 1, [{ directorId: "obj-box", entityType: "object", transform: transform(1), fovDeg: 50 }]),
        ),
      "live_link_invalid",
      400,
    );
    expectLiveLinkError(() => hub.frame(frame(session, 0)), "live_link_invalid", 400);
    // A frame without its session token is malformed at the schema boundary.
    const missingToken = frame(session, 1) as Record<string, unknown>;
    delete missingToken.sessionToken;
    expectLiveLinkError(() => hub.frame(missingToken), "live_link_invalid", 400);
    // 513 entities exceed the per-frame wire cap.
    const oversized = Array.from({ length: 513 }, (_, index) => ({
      directorId: `obj-${index}`,
      entityType: "object",
      transform: transform(index),
    }));
    expectLiveLinkError(() => hub.frame(frame(session, 1, oversized)), "live_link_invalid", 400);
    // A sequence beyond the wire maximum is malformed, not stale.
    expectLiveLinkError(() => hub.frame(frame(session, 1_000_000_000_001)), "live_link_invalid", 400);
  });

  it("keeps duplicate directorIds within one frame last-wins (a duplicated node never splits state)", () => {
    const { hub } = hubWithClock();
    const session = hub.hello(hello());
    const ack = hub.frame(
      frame(session, 1, [
        { directorId: "obj-box", entityType: "object", transform: transform(1) },
        { directorId: "obj-box", entityType: "object", transform: transform(9) },
      ]),
    );
    expect(ack.droppedEntityCount).toBe(0);
    const entities = hub.preview().sessions[0]!.entities;
    expect(entities).toHaveLength(1);
    expect(entities[0]!.transform.location[0]).toBe(9);
  });

  it("drops unseen entities past the per-session cap with an honest count while seen ones keep updating", () => {
    const { hub } = hubWithClock();
    const session = hub.hello(hello());
    // Fill the 2 048-entity session budget in four 512-entity frames.
    for (let batch = 0; batch < 4; batch += 1) {
      const entities = Array.from({ length: 512 }, (_, index) => ({
        directorId: `obj-${batch * 512 + index}`,
        entityType: "object",
        transform: transform(batch),
      }));
      expect(hub.frame(frame(session, batch + 1, entities)).droppedEntityCount).toBe(0);
    }
    // A fifth frame mixes one known entity with unseen ones: the known entity
    // still updates, the unseen ones are dropped, and the ack says how many.
    const mixed = [
      { directorId: "obj-0", entityType: "object", transform: transform(99) },
      ...Array.from({ length: 511 }, (_, index) => ({
        directorId: `overflow-${index}`,
        entityType: "object",
        transform: transform(index),
      })),
    ];
    const ack = hub.frame(frame(session, 5, mixed));
    expect(ack.accepted).toBe(true);
    expect(ack.droppedEntityCount).toBe(511);
    const preview = hub.preview();
    expect(preview.sessions[0]!.entities).toHaveLength(2_048);
    const updated = preview.sessions[0]!.entities.find(({ directorId }) => directorId === "obj-0");
    expect(updated).toMatchObject({ atSequence: 5 });
    expect(updated!.transform.location[0]).toBe(99);
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
    const session = (helloRun.writes[0]!.body as { result: SessionGrant }).result;

    const frameRun = await route("POST", "/api/dcc/live-link/godot/frame", hub, frame(session, 1));
    expect(frameRun.writes[0]).toMatchObject({ status: 200, body: { success: true } });

    const previewRun = await route("GET", "/api/dcc/live-link/godot/preview", hub);
    expect(previewRun.writes[0]!.status).toBe(200);
    const preview = (previewRun.writes[0]!.body as { result: { authoritative: boolean; sessions: unknown[] } }).result;
    expect(preview.authoritative).toBe(false);
    expect(preview.sessions).toHaveLength(1);
    expect(JSON.stringify(preview)).not.toContain(session.sessionToken);

    const byeRun = await route("POST", "/api/dcc/live-link/godot/bye", hub, bye(session));
    expect(byeRun.writes[0]).toMatchObject({ status: 200, body: { success: true } });

    for (const run of [helloRun, frameRun, previewRun, byeRun]) {
      expect(run.getProject).not.toHaveBeenCalled();
    }
  });

  it("maps hub rejections to structured HTTP errors", async () => {
    const hub = createGodotLiveLinkHub({ idleTimeoutMs: IDLE_TIMEOUT_MS });
    const session = hub.hello(hello());
    hub.frame(frame(session, 5));
    const stale = await route("POST", "/api/dcc/live-link/godot/frame", hub, frame(session, 5));
    expect(stale.writes[0]).toMatchObject({
      status: 409,
      body: { success: false, code: "live_link_sequence_stale" },
    });

    const unknown = await route("POST", "/api/dcc/live-link/godot/frame", hub, frame(UNKNOWN_SESSION, 1));
    expect(unknown.writes[0]).toMatchObject({ status: 404, body: { code: "live_link_session_unknown" } });

    const forged = await route("POST", "/api/dcc/live-link/godot/frame", hub, {
      ...frame(session, 6),
      sessionToken: "y".repeat(32),
    });
    expect(forged.writes[0]).toMatchObject({ status: 401, body: { code: "live_link_token_invalid" } });
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

  it("adopts the per-session token from the grant and sends it with every frame and bye", () => {
    const sender = readFileSync(resolve(addonDirectory, "director_live_link.gd"), "utf8");
    // The grant is only accepted when it carries both id and token…
    expect(sender).toContain('str(result.get("sessionToken", ""))');
    expect(sender).toMatch(/granted\.is_empty\(\) or token\.is_empty\(\)/);
    // …and both frame and bye payloads carry the token back.
    expect(sender.match(/"sessionToken": session_token/g)).toHaveLength(2);
    // Bye clears the credentials so a stale sender can never reuse them.
    expect(sender).toContain('session_token = ""');
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
