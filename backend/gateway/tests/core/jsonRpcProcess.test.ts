// @vitest-environment node

import { describe, expect, it } from "vitest";
import { JsonRpcProcess } from "../../jsonRpcProcess";

const rpcFixture = String.raw`
let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  pending += chunk;
  let newline;
  while ((newline = pending.indexOf("\n")) >= 0) {
    const line = pending.slice(0, newline);
    pending = pending.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "echo") {
      process.stdout.write(JSON.stringify({ id: message.id, result: message.params }) + "\n");
    }
  }
});
setInterval(() => {}, 1000);
`;

const stubbornRpcFixture = String.raw`
let pending = "";
process.on("SIGTERM", () => {
  process.stderr.write("old-process-ignored-sigterm\n");
});
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  pending += chunk;
  let newline;
  while ((newline = pending.indexOf("\n")) >= 0) {
    const line = pending.slice(0, newline);
    pending = pending.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "pid") {
      process.stdout.write(JSON.stringify({ id: message.id, result: process.pid }) + "\n");
    }
  }
});
setInterval(() => {}, 1000);
`;

const closedStdinRpcFixture = String.raw`
const fs = require("node:fs");
fs.closeSync(0);
process.stdout.write(JSON.stringify({ method: "ready", params: { pid: process.pid } }) + "\n");
setInterval(() => {}, 1000);
`;

const stubbornRpcTreeFixture = String.raw`
const { spawn } = require("node:child_process");
const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
  stdio: ["ignore", process.stdout, process.stderr],
});
let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  pending += chunk;
  let newline;
  while ((newline = pending.indexOf("\n")) >= 0) {
    const line = pending.slice(0, newline);
    pending = pending.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "pids") {
      process.stdout.write(JSON.stringify({
        id: message.id,
        result: { parent: process.pid, descendant: descendant.pid },
      }) + "\n");
    }
  }
});
setInterval(() => {}, 1000);
`;

const detachedStdioRpcTreeFixture = String.raw`
const { spawn } = require("node:child_process");
const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});
let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  pending += chunk;
  let newline;
  while ((newline = pending.indexOf("\n")) >= 0) {
    const line = pending.slice(0, newline);
    pending = pending.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "pids") {
      process.stdout.write(JSON.stringify({
        id: message.id,
        result: { parent: process.pid, descendant: descendant.pid },
      }) + "\n");
    }
  }
});
setInterval(() => {}, 1000);
`;

async function waitForProcessExit(pid: number) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Process ${pid} did not exit`);
}

describe("JsonRpcProcess lifecycle", () => {
  it("rejects pending requests immediately on stop and can restart without a stale close race", async () => {
    const rpc = new JsonRpcProcess(process.execPath, ["-e", rpcFixture], process.cwd());
    const pending = rpc.request("hang", {}, 30_000);

    const stopped = rpc.stop();

    await expect(pending).rejects.toThrow(/RPC process stopped/);
    await expect(rpc.request("echo", { ok: true }, 5_000)).resolves.toEqual({ ok: true });
    await stopped;
    await rpc.stop();
  });

  it("escalates an ignored SIGTERM to SIGKILL and suppresses stderr from the stopped child", async () => {
    const rpc = new JsonRpcProcess(process.execPath, ["-e", stubbornRpcFixture], process.cwd(), process.env, 25);
    const stderr: string[] = [];
    rpc.onStderr((text) => stderr.push(text));
    const firstPid = await rpc.request<number>("pid", undefined, 5_000);

    const stopped = rpc.stop();
    const secondPid = await rpc.request<number>("pid", undefined, 5_000);
    expect(secondPid).not.toBe(firstPid);
    await stopped;

    expect(() => process.kill(firstPid, 0)).toThrow();
    expect(stderr.join("")).not.toContain("old-process-ignored-sigterm");
    await rpc.stop();
  });

  it("turns an asynchronous stdin EPIPE into an immediate request failure and retires the child", async () => {
    const rpc = new JsonRpcProcess(process.execPath, ["-e", closedStdinRpcFixture], process.cwd(), process.env, 25);
    let ready: ((pid: number) => void) | undefined;
    const readyPid = new Promise<number>((resolve) => {
      ready = resolve;
    });
    rpc.onNotification((message) => {
      if (message.method !== "ready" || !message.params || typeof message.params !== "object") return;
      const pid = (message.params as { pid?: unknown }).pid;
      if (typeof pid === "number") ready?.(pid);
    });
    rpc.start();
    const pid = await readyPid;
    const startedAt = Date.now();

    await expect(rpc.request("unwritable", {}, 5_000)).rejects.toThrow(/EPIPE/i);

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    await waitForProcessExit(pid);
    await rpc.stop();
  });

  it.skipIf(process.platform === "win32")(
    "kills descendants that inherited RPC stdio instead of waiting forever for close",
    async () => {
      const rpc = new JsonRpcProcess(process.execPath, ["-e", stubbornRpcTreeFixture], process.cwd(), process.env, 25);
      const pids = await rpc.request<{ parent: number; descendant: number }>("pids", undefined, 5_000);

      await rpc.stop();

      expect(() => process.kill(pids.parent, 0)).toThrow();
      expect(() => process.kill(pids.descendant, 0)).toThrow();
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not let the direct child's early close cancel escalation for a detached-stdio descendant",
    async () => {
      const rpc = new JsonRpcProcess(
        process.execPath,
        ["-e", detachedStdioRpcTreeFixture],
        process.cwd(),
        process.env,
        25,
      );
      const pids = await rpc.request<{ parent: number; descendant: number }>("pids", undefined, 5_000);

      try {
        await rpc.stop();
        await waitForProcessExit(pids.descendant);
        expect(() => process.kill(pids.parent, 0)).toThrow();
      } finally {
        try {
          process.kill(pids.descendant, "SIGKILL");
        } catch {
          // The expected process-tree escalation already removed it.
        }
      }
    },
  );
});
