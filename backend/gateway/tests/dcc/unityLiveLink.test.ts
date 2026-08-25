import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createUnityLiveLinkHub, UnityLiveLinkError, type UnityLiveLinkEventPayload } from "../../dcc/unityLiveLink";
import { handleDccRoute } from "../../routes/dccRoutes";
import type { BlenderBridge } from "../../dcc/blenderBridge";

function transformUpdate(directorId: string, x = 0): UnityLiveLinkEventPayload {
  return {
    kind: "transform_update",
    entities: [
      {
        directorId,
        entityType: "object",
        transform: {
          location: [x, 0, 0],
          rotationQuaternion: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
      },
    ],
  };
}

function snapshot(frame = 0): UnityLiveLinkEventPayload {
  return { kind: "snapshot", frame, entities: [] };
}

async function expectLiveLinkError(promise: Promise<unknown>, status: number, code: string) {
  const error = await promise.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(UnityLiveLinkError);
  expect((error as UnityLiveLinkError).status).toBe(status);
  expect((error as UnityLiveLinkError).code).toBe(code);
}

describe("Unity live-link hub", () => {
  it("mints scoped sessions and reports status without leaking the token", () => {
    const hub = createUnityLiveLinkHub();
    const created = hub.createSession("Shot 12 preview");
    expect(created.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.token).toMatch(/^[0-9a-f]{64}$/);

    const status = hub.status();
    expect(status).toHaveLength(1);
    expect(status[0]).toMatchObject({
      sessionId: created.sessionId,
      label: "Shot 12 preview",
      closed: false,
      latestSeq: 0,
      bufferedEventCount: 0,
      connectorSeenAt: null,
    });
    expect(JSON.stringify(status)).not.toContain(created.token);
  });

  it("assigns contiguous sequence numbers and resumes polls from after", async () => {
    const hub = createUnityLiveLinkHub();
    const { sessionId, token } = hub.createSession();
    expect(hub.publish(sessionId, [snapshot(), transformUpdate("cube", 1)])).toEqual({ firstSeq: 1, latestSeq: 2 });
    expect(hub.publish(sessionId, [transformUpdate("cube", 2)])).toEqual({ firstSeq: 3, latestSeq: 3 });

    const fromStart = await hub.poll({ sessionId, token, afterSeq: 0, waitMs: 0 });
    expect(fromStart.events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(fromStart.latestSeq).toBe(3);
    expect(fromStart.resync).toBe(false);

    const resumed = await hub.poll({ sessionId, token, afterSeq: 2, waitMs: 0 });
    expect(resumed.events.map((event) => event.seq)).toEqual([3]);
    expect(resumed.latestSeq).toBe(3);
  });

  it("wakes a pending long poll when Director publishes", async () => {
    const hub = createUnityLiveLinkHub();
    const { sessionId, token } = hub.createSession();
    const startedAt = Date.now();
    const pending = hub.poll({ sessionId, token, afterSeq: 0, waitMs: 5_000 });
    setTimeout(() => hub.publish(sessionId, [transformUpdate("cube")]), 20);
    const result = await pending;
    expect(result.events).toHaveLength(1);
    expect(Date.now() - startedAt).toBeLessThan(4_000);
  });

  it("returns an empty result when the wait times out", async () => {
    const hub = createUnityLiveLinkHub();
    const { sessionId, token } = hub.createSession();
    const result = await hub.poll({ sessionId, token, afterSeq: 0, waitMs: 30 });
    expect(result.events).toEqual([]);
    expect(result.latestSeq).toBe(0);
    expect(result.resync).toBe(false);
  });

  it("is disconnect-safe: an aborted poll resolves promptly and leaves the session healthy", async () => {
    const hub = createUnityLiveLinkHub();
    const { sessionId, token } = hub.createSession();
    const abortController = new AbortController();
    const startedAt = Date.now();
    const pending = hub.poll({ sessionId, token, afterSeq: 0, waitMs: 30_000, signal: abortController.signal });
    setTimeout(() => abortController.abort(), 20);
    const aborted = await pending;
    expect(aborted.events).toEqual([]);
    expect(Date.now() - startedAt).toBeLessThan(4_000);

    // The abandoned waiter is gone: publishing still works and a fresh poll
    // (a reconnect) picks the event up from the sequence it left off at.
    hub.publish(sessionId, [transformUpdate("cube", 3)]);
    const reconnected = await hub.poll({ sessionId, token, afterSeq: aborted.latestSeq, waitMs: 0 });
    expect(reconnected.events.map((event) => event.seq)).toEqual([1]);
  });

  it("rejects wrong tokens, unknown sessions, and closed sessions with stable codes", async () => {
    const hub = createUnityLiveLinkHub();
    const { sessionId, token } = hub.createSession();
    await expectLiveLinkError(
      hub.poll({ sessionId, token: "f".repeat(64), afterSeq: 0, waitMs: 0 }),
      401,
      "live_link_token_invalid",
    );
    await expectLiveLinkError(
      hub.poll({ sessionId: "00000000-0000-4000-8000-000000000000", token, afterSeq: 0, waitMs: 0 }),
      404,
      "live_link_session_unknown",
    );
    expect(hub.closeSession(sessionId)).toBe(true);
    expect(hub.closeSession(sessionId)).toBe(false);
    await expectLiveLinkError(hub.poll({ sessionId, token, afterSeq: 0, waitMs: 0 }), 410, "live_link_session_closed");
    expect(() => hub.publish(sessionId, [snapshot()])).toThrow(UnityLiveLinkError);
  });

  it("wakes pending polls with a clean 410 when Director closes the session mid-wait", async () => {
    const hub = createUnityLiveLinkHub();
    const { sessionId, token } = hub.createSession();
    const pending = hub.poll({ sessionId, token, afterSeq: 0, waitMs: 30_000 });
    setTimeout(() => hub.closeSession(sessionId), 20);
    await expectLiveLinkError(pending, 410, "live_link_session_closed");
  });

  it("expires idle sessions after the TTL", async () => {
    let currentTime = 1_000;
    const hub = createUnityLiveLinkHub({ now: () => currentTime, sessionTtlMs: 60_000 });
    const { sessionId, token } = hub.createSession();
    currentTime += 59_000;
    await expect(hub.poll({ sessionId, token, afterSeq: 0, waitMs: 0 })).resolves.toMatchObject({ resync: false });
    // Polling refreshed the TTL; only a full idle window expires the session.
    currentTime += 60_001;
    await expectLiveLinkError(hub.poll({ sessionId, token, afterSeq: 0, waitMs: 0 }), 404, "live_link_session_unknown");
    expect(hub.status()).toEqual([]);
  });

  it("resyncs from the latest snapshot when the requested tail was evicted", async () => {
    const hub = createUnityLiveLinkHub({ maxBufferedEvents: 4 });
    const { sessionId, token } = hub.createSession();
    hub.publish(sessionId, [snapshot(0), transformUpdate("cube", 1), transformUpdate("cube", 2)]);
    hub.publish(sessionId, [snapshot(10)]);
    hub.publish(sessionId, [transformUpdate("cube", 3), transformUpdate("cube", 4), transformUpdate("cube", 5)]);

    // Ring holds seqs 4..7; a client resuming after seq 1 lost its tail.
    const result = await hub.poll({ sessionId, token, afterSeq: 1, waitMs: 0 });
    expect(result.resync).toBe(true);
    expect(result.events[0]?.payload.kind).toBe("snapshot");
    expect(result.events[0]?.seq).toBe(4);
    expect(result.events.map((event) => event.seq)).toEqual([4, 5, 6, 7]);
    expect(result.latestSeq).toBe(7);

    // Resuming from a delivered seq continues without another resync.
    hub.publish(sessionId, [transformUpdate("cube", 6)]);
    const resumed = await hub.poll({ sessionId, token, afterSeq: 7, waitMs: 0 });
    expect(resumed.resync).toBe(false);
    expect(resumed.events.map((event) => event.seq)).toEqual([8]);
  });

  it("rebases a client that is ahead of the session instead of looping on resync", async () => {
    const hub = createUnityLiveLinkHub();
    const { sessionId, token } = hub.createSession();
    const result = await hub.poll({ sessionId, token, afterSeq: 999, waitMs: 0 });
    expect(result.resync).toBe(true);
    expect(result.events).toEqual([]);
    expect(result.latestSeq).toBe(0);

    hub.publish(sessionId, [transformUpdate("cube")]);
    const next = await hub.poll({ sessionId, token, afterSeq: result.latestSeq, waitMs: 0 });
    expect(next.resync).toBe(false);
    expect(next.events.map((event) => event.seq)).toEqual([1]);
  });

  it("caps concurrently open sessions", () => {
    const hub = createUnityLiveLinkHub({ maxSessions: 1 });
    const first = hub.createSession();
    expect(() => hub.createSession()).toThrow(UnityLiveLinkError);
    hub.closeSession(first.sessionId);
    expect(() => hub.createSession()).not.toThrow();
  });
});

interface JsonCall {
  status: number;
  body: {
    success: boolean;
    code?: string;
    error?: string;
    result?: Record<string, unknown>;
  };
}

function routeHarness(hub = createUnityLiveLinkHub()) {
  const calls: JsonCall[] = [];
  const blender = { status: vi.fn(), exportBlend: vi.fn() } as unknown as BlenderBridge;
  let requestBody: unknown;

  async function invoke(
    method: string,
    path: string,
    options: { body?: unknown; headers?: Record<string, string>; request?: IncomingMessage } = {},
  ) {
    requestBody = options.body;
    const request =
      options.request ??
      (Object.assign(new EventEmitter(), { method, headers: options.headers ?? {} }) as unknown as IncomingMessage);
    (request as { method?: string }).method = method;
    const handled = await handleDccRoute(request, {} as ServerResponse, new URL(`http://gateway${path}`), {
      readBody: async () => requestBody,
      json: (_response, status, body) => calls.push({ status, body: body as JsonCall["body"] }),
      getProject: vi.fn(),
      blender,
      unityLiveLink: hub,
    });
    expect(handled).toBe(true);
    return calls[calls.length - 1]!;
  }

  return { hub, invoke, calls };
}

describe("Unity live-link routes", () => {
  it("creates sessions with a poll path and lists them Director-side", async () => {
    const { invoke } = routeHarness();
    const created = await invoke("POST", "/api/dcc/unity/live-link/sessions", { body: { label: "Stage preview" } });
    expect(created.status).toBe(200);
    const result = created.body.result as { sessionId: string; token: string; pollPath: string };
    expect(result.pollPath).toBe(`/api/dcc/unity/live-link/sessions/${result.sessionId}/events`);

    const listed = await invoke("GET", "/api/dcc/unity/live-link/sessions");
    expect(listed.status).toBe(200);
    const sessions = (listed.body.result as { sessions: Array<{ sessionId: string; label: string }> }).sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ sessionId: result.sessionId, label: "Stage preview" });
    expect(JSON.stringify(listed.body)).not.toContain(result.token);
  });

  it("validates published events against the payload schema", async () => {
    const { invoke } = routeHarness();
    const created = await invoke("POST", "/api/dcc/unity/live-link/sessions", { body: {} });
    const { sessionId } = created.body.result as { sessionId: string };

    const rejected = await invoke("POST", `/api/dcc/unity/live-link/sessions/${sessionId}/events`, {
      body: { events: [{ kind: "execute_csharp", code: "System.IO.File.Delete()" }] },
    });
    expect(rejected.status).toBe(400);

    const accepted = await invoke("POST", `/api/dcc/unity/live-link/sessions/${sessionId}/events`, {
      body: { events: [transformUpdate("cube", 1)] },
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.result).toEqual({ firstSeq: 1, latestSeq: 1 });
  });

  it("requires the session bearer token to poll and rejects mismatches", async () => {
    const { invoke } = routeHarness();
    const created = await invoke("POST", "/api/dcc/unity/live-link/sessions", { body: {} });
    const { sessionId, token } = created.body.result as { sessionId: string; token: string };
    await invoke("POST", `/api/dcc/unity/live-link/sessions/${sessionId}/events`, {
      body: { events: [snapshot(5)] },
    });

    const missing = await invoke("GET", `/api/dcc/unity/live-link/sessions/${sessionId}/events?wait_ms=0`);
    expect(missing.status).toBe(401);
    expect(missing.body.code).toBe("live_link_token_missing");

    const wrong = await invoke("GET", `/api/dcc/unity/live-link/sessions/${sessionId}/events?wait_ms=0`, {
      headers: { authorization: `Bearer ${"f".repeat(64)}` },
    });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe("live_link_token_invalid");

    const polled = await invoke("GET", `/api/dcc/unity/live-link/sessions/${sessionId}/events?wait_ms=0&after=0`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(polled.status).toBe(200);
    const result = polled.body.result as { events: Array<{ seq: number }>; latestSeq: number };
    expect(result.events.map((event) => event.seq)).toEqual([1]);
    expect(result.latestSeq).toBe(1);
  });

  it("closes sessions so later polls get a clean 410", async () => {
    const { invoke } = routeHarness();
    const created = await invoke("POST", "/api/dcc/unity/live-link/sessions", { body: {} });
    const { sessionId, token } = created.body.result as { sessionId: string; token: string };

    const closed = await invoke("DELETE", `/api/dcc/unity/live-link/sessions/${sessionId}`);
    expect(closed.status).toBe(200);

    const polled = await invoke("GET", `/api/dcc/unity/live-link/sessions/${sessionId}/events?wait_ms=0`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(polled.status).toBe(410);
    expect(polled.body.code).toBe("live_link_session_closed");
  });

  it("aborts the long poll when the connector's request socket closes", async () => {
    const { invoke } = routeHarness();
    const created = await invoke("POST", "/api/dcc/unity/live-link/sessions", { body: {} });
    const { sessionId, token } = created.body.result as { sessionId: string; token: string };

    const request = Object.assign(new EventEmitter(), {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    }) as unknown as IncomingMessage;
    const startedAt = Date.now();
    const pending = invoke("GET", `/api/dcc/unity/live-link/sessions/${sessionId}/events?wait_ms=30000`, { request });
    setTimeout(() => request.emit("close"), 20);
    const aborted = await pending;
    expect(aborted.status).toBe(200);
    expect((aborted.body.result as { events: unknown[] }).events).toEqual([]);
    expect(Date.now() - startedAt).toBeLessThan(4_000);
    expect((request as unknown as EventEmitter).listenerCount("close")).toBe(0);
  });

  it("reports 503 when the hub is not configured", async () => {
    const calls: JsonCall[] = [];
    const handled = await handleDccRoute(
      Object.assign(new EventEmitter(), { method: "POST", headers: {} }) as unknown as IncomingMessage,
      {} as ServerResponse,
      new URL("http://gateway/api/dcc/unity/live-link/sessions"),
      {
        readBody: async () => ({}),
        json: (_response, status, body) => calls.push({ status, body: body as JsonCall["body"] }),
        getProject: vi.fn(),
        blender: { status: vi.fn(), exportBlend: vi.fn() } as unknown as BlenderBridge,
      },
    );
    expect(handled).toBe(true);
    expect(calls[0]?.status).toBe(503);
    expect(calls[0]?.body.code).toBe("live_link_unavailable");
  });
});
