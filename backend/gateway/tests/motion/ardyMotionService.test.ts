import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { spawn } from "node:child_process";
import { ArdyMotionService, type ArdyMotionEvent } from "../../motion/ardyMotionService";

type FakeChildBehavior = (command: string, args: string[], options: { cwd?: string }) => Promise<number>;

function fakeSpawn(behavior: FakeChildBehavior): typeof spawn {
  return vi.fn((command: string, args: string[], options: { cwd?: string }) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      pid: number;
      exitCode: number | null;
      signalCode: string | null;
      kill: () => void;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 4242;
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn();
    void behavior(command, args, options).then((code) => {
      child.exitCode = code;
      child.emit("exit", code, null);
    });
    return child;
  }) as unknown as typeof spawn;
}

async function collect(service: ArdyMotionService, request: unknown) {
  const events: ArdyMotionEvent[] = [];
  await service.generate(request, (event) => events.push(event));
  return events;
}

describe("ArdyMotionService", () => {
  it("reports an unconfigured bridge as data, not a crash", async () => {
    const service = new ArdyMotionService({
      config: { python: "python3", model: "core8", timeoutMs: 5_000 },
      dataDirectory: await mkdtemp(join(tmpdir(), "ardy-service-")),
      spawnImpl: fakeSpawn(async () => 0),
    });
    expect(service.status()).toEqual({ configured: false, remote: false, model: "core8" });
    const events = await collect(service, { prompt: "a person walks" });
    expect(events).toEqual([{ event: "error", message: expect.stringContaining("DIRECTOR_ARDY_REPO") }]);
  });

  it("runs the upstream generate.py in the checkout and allowlists the produced npz", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "ardy-service-"));
    let observed: { command: string; args: string[]; cwd?: string } | null = null;
    const spawnImpl = fakeSpawn(async (command, args, options) => {
      observed = { command, args, cwd: options.cwd };
      const stem = args[args.indexOf("--output") + 1];
      await writeFile(`${stem}.npz`, Buffer.from("npz-bytes"));
      return 0;
    });
    const service = new ArdyMotionService({
      config: { repo: "/opt/ardy", python: "/opt/ardy/.venv/bin/python", model: "core8", timeoutMs: 5_000 },
      dataDirectory,
      spawnImpl,
    });

    const events = await collect(service, { prompt: "a person walks in a circle", durationS: 4, seed: 7 });
    const done = events.at(-1);
    if (done?.event !== "done") throw new Error(`expected a done event, got ${JSON.stringify(done)}`);
    expect(done.motionUrl).toBe(`/api/motion/ardy/motions/${done.jobId}`);
    expect(done.bytes).toBeGreaterThan(0);
    expect(done.model).toBe("core8");
    expect(service.resolveMotionPath(done.jobId)).toContain(done.jobId);

    expect(observed).not.toBeNull();
    const run = observed as unknown as { command: string; args: string[]; cwd?: string };
    expect(run.command).toBe("/opt/ardy/.venv/bin/python");
    expect(run.cwd).toBe("/opt/ardy");
    expect(run.args.slice(0, 2)).toEqual(["scripts/generate.py", "a person walks in a circle"]);
    expect(run.args).toEqual(expect.arrayContaining(["--model", "core8", "--duration", "4", "--seed", "7"]));
  });

  it("surfaces a failing generator with its stderr tail", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "ardy-service-"));
    const spawnImpl = vi.fn((command: string) => {
      void command;
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        pid: number;
        exitCode: number | null;
        signalCode: string | null;
        kill: () => void;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.pid = 4242;
      child.exitCode = null;
      child.signalCode = null;
      child.kill = vi.fn();
      queueMicrotask(() => {
        child.stderr.emit("data", Buffer.from("RuntimeError: CUDA out of memory\n"));
        child.exitCode = 1;
        child.emit("exit", 1, null);
      });
      return child;
    }) as unknown as typeof spawn;
    const service = new ArdyMotionService({
      config: { repo: "/opt/ardy", python: "python3", model: "core8", timeoutMs: 5_000 },
      dataDirectory,
      spawnImpl,
    });

    const events = await collect(service, { prompt: "a person jumps" });
    const terminal = events.at(-1);
    if (terminal?.event !== "error") throw new Error("expected an error event");
    expect(terminal.message).toContain("CUDA out of memory");
  });

  it("routes remote generation through ssh with quoted arguments and copies the npz back", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "ardy-service-"));
    const invocations: Array<{ command: string; args: string[] }> = [];
    const spawnImpl = fakeSpawn(async (command, args) => {
      invocations.push({ command, args });
      if (command === "scp") {
        await writeFile(args.at(-1) as string, Buffer.from("npz-bytes"));
      }
      return 0;
    });
    const service = new ArdyMotionService({
      config: {
        repo: "~/ardy",
        python: "~/ardy/.venv/bin/python",
        sshHost: "user@gpu-box",
        model: "core8",
        timeoutMs: 5_000,
      },
      dataDirectory,
      spawnImpl,
    });

    const events = await collect(service, { prompt: "a person waves; then bows", durationS: 5 });
    expect(events.at(-1)?.event).toBe("done");
    expect(invocations).toHaveLength(2);
    expect(invocations[0].command).toBe("ssh");
    expect(invocations[0].args).toContain("user@gpu-box");
    const remoteCommand = invocations[0].args.at(-1) as string;
    expect(remoteCommand).toContain("'a person waves; then bows'");
    expect(remoteCommand).not.toContain("motion-jobs");
    expect(invocations[1].command).toBe("scp");
    expect(String(invocations[1].args.at(-2))).toMatch(/^user@gpu-box:\/tmp\/director-ardy-motion-/);
  });

  it("rejects malformed requests before any process is spawned", async () => {
    const spawnImpl = fakeSpawn(async () => 0);
    const service = new ArdyMotionService({
      config: { repo: "/opt/ardy", python: "python3", model: "core8", timeoutMs: 5_000 },
      dataDirectory: await mkdtemp(join(tmpdir(), "ardy-service-")),
      spawnImpl,
    });
    await expect(service.generate({ prompt: "" }, () => {})).rejects.toThrow();
    await expect(service.generate({ prompt: "ok", durationS: 99 }, () => {})).rejects.toThrow();
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(service.resolveMotionPath("../etc/passwd")).toBeNull();
    expect(service.resolveMotionPath("motion-unknown-1234")).toBeNull();
  });
});
