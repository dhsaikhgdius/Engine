import { readFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { resolve } from "node:path";
import { createUnrealLivePreviewHub, DirectorUnrealLivePreviewHubError } from "../../dcc/unrealLivePreviewHub";

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

const frame = (seq: number) => ({ seq, transform: IDENTITY_TRANSFORM });

describe("Unreal live preview hub (Gateway HTTP surface)", () => {
  it("opens a session with the environment token, forwards ordered frames, and closes with bye", async () => {
    const server = await startPreviewServer();
    try {
      const hub = createUnrealLivePreviewHub({
        environment: { DIRECTOR_UNREAL_PREVIEW_TOKEN: TOKEN },
      });
      const opened = await hub.open({ port: server.port });
      expect(opened.contract).toBe("director-unreal-live-preview-status-v1");
      expect(opened.port).toBe(server.port);
      expect(opened.summary.forwardedFrameCount).toBe(0);

      expect(hub.frame(opened.sessionId, frame(1)).send).toEqual({ sent: true, seq: 1 });
      expect(hub.frame(opened.sessionId, frame(1)).send).toMatchObject({
        sent: false,
        reason: expect.stringMatching(/stale/i),
      });
      expect(hub.frame(opened.sessionId, frame(2)).send).toEqual({ sent: true, seq: 2 });

      const lines = await server.waitForLines(3);
      expect(JSON.parse(lines[0]!)).toMatchObject({ type: "hello", token: TOKEN });
      expect(JSON.parse(lines[1]!)).toMatchObject({ type: "camera_frame", seq: 1 });
      expect(JSON.parse(lines[2]!)).toMatchObject({ type: "camera_frame", seq: 2 });

      const read = hub.read(opened.sessionId);
      expect(read.summary.forwardedFrameCount).toBe(2);
      expect(read.summary.droppedFrameCount).toBe(1);
      expect(hub.status().map((session) => session.sessionId)).toEqual([opened.sessionId]);

      const closed = await hub.close(opened.sessionId);
      expect(closed.summary.closed).toBe(true);
      const closingLines = await server.waitForLines(4);
      expect(JSON.parse(closingLines[3]!)).toEqual({ type: "bye" });
      expect(() => hub.read(opened.sessionId)).toThrowError(DirectorUnrealLivePreviewHubError);
      expect(hub.status()).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("refuses to open without the shared token in the gateway environment", async () => {
    const hub = createUnrealLivePreviewHub({ environment: {} });
    await expect(hub.open({ port: 4_000 })).rejects.toMatchObject({
      code: "live_preview_token_missing",
      status: 503,
    });
  });

  it("gates Editor Python and returns its command receipt over the hot session", async () => {
    const server = await startPreviewServer();
    try {
      const hub = createUnrealLivePreviewHub({
        environment: { DIRECTOR_UNREAL_PREVIEW_TOKEN: TOKEN },
      });
      const defaultSession = await hub.open({ port: server.port });
      expect(() =>
        hub.requestCommand(defaultSession.sessionId, { command: "execute_code", code: "result = 1" }),
      ).toThrow(/disabled/i);
      await hub.close(defaultSession.sessionId);

      const workshop = await hub.open({ port: server.port, allowCode: true, authority: "engine" });
      const pending = hub.requestCommand(workshop.sessionId, { command: "execute_code", code: "result = 7" });
      expect(pending.status).toBe("pending");
      const lines = await server.waitForLines(4);
      const editorCommand = JSON.parse(lines[3]!);
      expect(editorCommand).toMatchObject({ type: "editor_command", command: "execute_code", language: "python" });
      server.sockets.at(-1)!.write(
        `${JSON.stringify({
          type: "command_result",
          result: {
            commandId: pending.commandId,
            command: "execute_code",
            status: "completed",
            output: "7\n",
          },
        })}\n`,
      );
      await new Promise((resolveTick) => setTimeout(resolveTick, 20));
      expect(hub.commandStatus(workshop.sessionId, pending.commandId)).toMatchObject({
        status: "completed",
        output: "7\n",
      });
      await hub.close(workshop.sessionId);
    } finally {
      await server.close();
    }
  });

  it("rejects malformed open requests before touching the network", async () => {
    const hub = createUnrealLivePreviewHub({ environment: { DIRECTOR_UNREAL_PREVIEW_TOKEN: TOKEN } });
    await expect(hub.open({ port: 0 })).rejects.toMatchObject({ code: "live_preview_invalid", status: 400 });
    await expect(hub.open({})).rejects.toMatchObject({ code: "live_preview_invalid", status: 400 });
  });

  it("reports a structured connect failure when no listener answers", async () => {
    const probe = await startPreviewServer();
    const freePort = probe.port;
    await probe.close();
    const hub = createUnrealLivePreviewHub({ environment: { DIRECTOR_UNREAL_PREVIEW_TOKEN: TOKEN } });
    await expect(hub.open({ port: freePort })).rejects.toMatchObject({
      code: "live_preview_connect_failed",
      status: 502,
    });
  });

  it("caps concurrent sessions and frees capacity when sessions close", async () => {
    const server = await startPreviewServer();
    try {
      const hub = createUnrealLivePreviewHub({
        environment: { DIRECTOR_UNREAL_PREVIEW_TOKEN: TOKEN },
        maxSessions: 1,
      });
      const first = await hub.open({ port: server.port });
      await expect(hub.open({ port: server.port })).rejects.toMatchObject({
        code: "live_preview_session_limit",
        status: 429,
      });
      await hub.close(first.sessionId);
      const second = await hub.open({ port: server.port });
      expect(second.sessionId).not.toBe(first.sessionId);
      await hub.close(second.sessionId);
    } finally {
      await server.close();
    }
  });

  it("has no import path into project mutation or authoring dispatch (source guard)", async () => {
    const source = await readFile(resolve(__dirname, "..", "..", "dcc", "unrealLivePreviewHub.ts"), "utf8");
    const importedModules = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]!);
    expect(importedModules.length).toBeGreaterThan(0);
    for (const module of importedModules) {
      expect(["node:crypto", "@director/dcc-protocol", "./unrealLivePreview"]).toContain(module);
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
});
