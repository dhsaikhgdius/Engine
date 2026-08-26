import { readFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { resolve } from "node:path";
import {
  DIRECTOR_UNREAL_LIVE_PREVIEW_PROTOCOL,
  DIRECTOR_UNREAL_LIVE_PREVIEW_STATUS_CONTRACT,
  directorUnrealLivePreviewSessionSummarySchema,
  directorUnrealLivePreviewStatusSchema,
} from "@director/dcc-protocol";
import { DirectorUnrealLivePreviewSession, createDirectorUnrealLivePreviewHub } from "../../dcc/unrealLivePreview";

const TOKEN = "fixture-preview-token";

const IDENTITY_TRANSFORM = { location: [0, 0, 0], rotationQuaternion: [0, 0, 0, 1], scale: [1, 1, 1] };

interface PreviewServerHarness {
  port: number;
  lines: () => string[];
  sockets: Socket[];
  waitForLines: (count: number) => Promise<string[]>;
  close: () => Promise<void>;
}

/** A real loopback listener standing in for `director_headless.py --mode live-preview`. */
async function startPreviewServer(): Promise<PreviewServerHarness> {
  const received: string[] = [];
  const sockets: Socket[] = [];
  const waiters: Array<{ count: number; resolve: (lines: string[]) => void }> = [];
  let buffered = "";
  const server: Server = createServer((socket) => {
    sockets.push(socket);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      let newlineIndex = buffered.indexOf("\n");
      while (newlineIndex >= 0) {
        received.push(buffered.slice(0, newlineIndex));
        buffered = buffered.slice(newlineIndex + 1);
        newlineIndex = buffered.indexOf("\n");
      }
      for (const waiter of [...waiters]) {
        if (received.length >= waiter.count) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve([...received]);
        }
      }
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Preview server has no port.");
  return {
    port: address.port,
    lines: () => [...received],
    sockets,
    waitForLines: (count) =>
      new Promise((resolveWait, rejectWait) => {
        if (received.length >= count) {
          resolveWait([...received]);
          return;
        }
        const timer = setTimeout(() => rejectWait(new Error(`Timed out waiting for ${count} lines.`)), 5_000);
        waiters.push({
          count,
          resolve: (lines) => {
            clearTimeout(timer);
            resolveWait(lines);
          },
        });
      }),
    close: () =>
      new Promise((resolveClose) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolveClose());
      }),
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for a session state change.");
    await new Promise((resolveTick) => setTimeout(resolveTick, 10));
  }
}

const frame = (seq: number, transform: unknown = IDENTITY_TRANSFORM) => ({ seq, transform });

describe("Unreal Gateway live preview transport (loopback, preview-only)", () => {
  it("sends hello first, forwards in-order frames, and drops duplicate/reordered/malformed frames", async () => {
    const server = await startPreviewServer();
    try {
      const session = await DirectorUnrealLivePreviewSession.connect({ port: server.port, token: TOKEN });

      expect(session.sendFrame(frame(1))).toEqual({ sent: true, seq: 1 });
      // Duplicate sequence number: dropped locally, never reaches the socket.
      expect(session.sendFrame(frame(1))).toMatchObject({ sent: false, reason: expect.stringMatching(/stale/i) });
      expect(session.sendFrame(frame(3))).toEqual({ sent: true, seq: 3 });
      // Reordered sequence number: dropped locally.
      expect(session.sendFrame(frame(2))).toMatchObject({ sent: false, reason: expect.stringMatching(/stale/i) });
      // Malformed transform: dropped by schema validation.
      expect(session.sendFrame(frame(4, { location: [0, 0] }))).toMatchObject({
        sent: false,
        reason: expect.stringMatching(/malformed/i),
      });

      const lines = await server.waitForLines(3);
      expect(lines).toHaveLength(3);
      expect(JSON.parse(lines[0]!)).toEqual({
        type: "hello",
        protocol: DIRECTOR_UNREAL_LIVE_PREVIEW_PROTOCOL,
        token: TOKEN,
      });
      expect(JSON.parse(lines[1]!)).toMatchObject({ type: "camera_frame", seq: 1 });
      expect(JSON.parse(lines[2]!)).toMatchObject({ type: "camera_frame", seq: 3 });

      await session.close();
      const summary = directorUnrealLivePreviewSessionSummarySchema.parse(session.summary());
      expect(summary.forwardedFrameCount).toBe(2);
      expect(summary.droppedFrameCount).toBe(3);
      const closingLines = await server.waitForLines(4);
      expect(JSON.parse(closingLines[3]!)).toEqual({ type: "bye" });
      expect(summary.closed).toBe(true);
      expect(summary.disconnectReason).toBe("client_close");
    } finally {
      await server.close();
    }
  });

  it("detects a peer disconnect and refuses further frames", async () => {
    const server = await startPreviewServer();
    try {
      const session = await DirectorUnrealLivePreviewSession.connect({ port: server.port, token: TOKEN });
      expect(session.sendFrame(frame(1))).toEqual({ sent: true, seq: 1 });
      await server.waitForLines(2);

      server.sockets[0]!.destroy();
      await waitUntil(() => !session.connected);

      expect(session.sendFrame(frame(2))).toMatchObject({
        sent: false,
        reason: expect.stringMatching(/peer close/i),
      });
      const summary = session.summary();
      expect(summary.disconnectReason).toBe("peer_close");
      expect(summary.forwardedFrameCount).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("reports a silent session stale and disconnects on the next frame", async () => {
    const server = await startPreviewServer();
    try {
      let nowMs = 0;
      const session = await DirectorUnrealLivePreviewSession.connect({
        port: server.port,
        token: TOKEN,
        staleTimeoutMs: 1_000,
        now: () => nowMs,
      });
      nowMs = 500;
      expect(session.isStale()).toBe(false);
      expect(session.sendFrame(frame(1))).toEqual({ sent: true, seq: 1 });
      nowMs = 1_600;
      expect(session.isStale()).toBe(true);
      expect(session.sendFrame(frame(2))).toMatchObject({
        sent: false,
        reason: expect.stringMatching(/stale/i),
      });
      const summary = session.summary();
      expect(summary.disconnectReason).toBe("stale_timeout");
      expect(summary.closed).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("ignores inbound bytes entirely: the preview channel can never mutate the project", async () => {
    const server = await startPreviewServer();
    try {
      const session = await DirectorUnrealLivePreviewSession.connect({ port: server.port, token: TOKEN });
      await server.waitForLines(1);

      // A hostile or buggy peer writes back scene-shaped data; the Gateway
      // counts and discards the bytes without ever parsing them.
      const hostile = `${JSON.stringify({ op: "update_object", id: "hero", position: [9, 9, 9] })}\n`;
      server.sockets[0]!.write(hostile);
      await waitUntil(() => session.summary().ignoredInboundByteCount >= hostile.length);

      expect(session.sendFrame(frame(1))).toEqual({ sent: true, seq: 1 });
      const summary = session.summary();
      expect(summary.ignoredInboundByteCount).toBeGreaterThanOrEqual(hostile.length);
      expect(summary.forwardedFrameCount).toBe(1);
      await session.close();
    } finally {
      await server.close();
    }
  });

  it("has no import path into project mutation or authoring dispatch (source guard)", async () => {
    const source = await readFile(resolve(__dirname, "..", "..", "dcc", "unrealLivePreview.ts"), "utf8");
    const importedModules = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]!);
    // The transport may only touch the socket layer and the DCC protocol
    // package; authoring surfaces (project schema mutators, agent-engine
    // operations, return importers) must stay unreachable from live frames.
    expect(importedModules.length).toBeGreaterThan(0);
    for (const module of importedModules) {
      expect(["node:net", "@director/dcc-protocol"]).toContain(module);
    }
    for (const forbidden of [
      "@director/project-schema",
      "@director/agent-engine",
      "applyAuthoring",
      "blenderReturnImport",
      "authoringDispatch",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("refuses an empty preview token before touching the network", async () => {
    await expect(DirectorUnrealLivePreviewSession.connect({ port: 1, token: "   " })).rejects.toThrow(/token/i);
  });
});

describe("Unreal live preview hub (read-only status snapshot)", () => {
  it("tracks the idle -> connected -> closed lifecycle with schema-valid snapshots", async () => {
    const server = await startPreviewServer();
    try {
      const hub = createDirectorUnrealLivePreviewHub();
      const { sessionId, session } = await hub.open({ port: server.port, token: TOKEN });
      expect(hub.get(sessionId)).toBe(session);

      // Idle: connected with the hello sent but no camera frame forwarded yet.
      const idle = directorUnrealLivePreviewStatusSchema.parse(hub.status());
      expect(idle.contract).toBe(DIRECTOR_UNREAL_LIVE_PREVIEW_STATUS_CONTRACT);
      expect(idle.sessions).toHaveLength(1);
      expect(idle.sessions[0]).toMatchObject({
        sessionId,
        port: server.port,
        state: "idle",
        lastFrameAtMs: null,
        lastForwardedSeq: null,
      });

      expect(session.sendFrame(frame(1))).toEqual({ sent: true, seq: 1 });
      const connected = hub.status();
      expect(connected.sessions[0]).toMatchObject({ state: "connected", lastForwardedSeq: 1 });
      expect(connected.sessions[0]!.lastFrameAtMs).toBeGreaterThanOrEqual(connected.sessions[0]!.openedAtMs);

      expect(await hub.close(sessionId)).toBe(true);
      const closed = hub.status();
      expect(closed.sessions[0]).toMatchObject({ state: "closed" });
      expect(closed.sessions[0]!.summary.disconnectReason).toBe("client_close");
      expect(await hub.close("unknown-session")).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("reports a silent session stale without mutating it, then closed after teardown", async () => {
    const server = await startPreviewServer();
    try {
      const hub = createDirectorUnrealLivePreviewHub();
      let nowMs = 0;
      const { session } = await hub.open({ port: server.port, token: TOKEN, staleTimeoutMs: 1_000, now: () => nowMs });
      expect(session.sendFrame(frame(1))).toEqual({ sent: true, seq: 1 });

      nowMs = 2_000;
      // Reading the status is side-effect free: the session is reported stale
      // but stays alive until the next frame attempt tears it down.
      expect(hub.status().sessions[0]!.state).toBe("stale");
      expect(hub.status().sessions[0]!.state).toBe("stale");
      expect(session.connected).toBe(true);

      expect(session.sendFrame(frame(2))).toMatchObject({ sent: false, reason: expect.stringMatching(/stale/i) });
      const closed = hub.status();
      expect(closed.sessions[0]!.state).toBe("closed");
      expect(closed.sessions[0]!.summary.disconnectReason).toBe("stale_timeout");
    } finally {
      await server.close();
    }
  });

  it("evicts the oldest closed sessions beyond the retention window", async () => {
    const server = await startPreviewServer();
    try {
      const hub = createDirectorUnrealLivePreviewHub({ closedSessionRetention: 1 });
      const first = await hub.open({ port: server.port, token: TOKEN });
      const second = await hub.open({ port: server.port, token: TOKEN });
      const third = await hub.open({ port: server.port, token: TOKEN });
      await hub.close(first.sessionId);
      await hub.close(second.sessionId);

      const status = hub.status();
      expect(status.sessions.map((entry) => entry.sessionId)).toEqual([second.sessionId, third.sessionId]);
      expect(hub.get(first.sessionId)).toBeNull();
      await hub.close(third.sessionId);
    } finally {
      await server.close();
    }
  });

  it("refuses to open past the concurrent-session cap", async () => {
    const server = await startPreviewServer();
    try {
      const hub = createDirectorUnrealLivePreviewHub();
      const opened = [];
      for (let index = 0; index < 16; index += 1) {
        opened.push(await hub.open({ port: server.port, token: TOKEN }));
      }
      await expect(hub.open({ port: server.port, token: TOKEN })).rejects.toThrow(/open sessions/i);
      for (const { sessionId } of opened) await hub.close(sessionId);
    } finally {
      await server.close();
    }
  });
});
