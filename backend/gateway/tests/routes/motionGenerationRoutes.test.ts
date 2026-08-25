import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { spawn } from "node:child_process";
import { ArdyMotionService } from "../../motion/ardyMotionService";
import { handleMotionGenerationRoute } from "../../routes/motionGenerationRoutes";

function fakeResponse() {
  const chunks: Buffer[] = [];
  let statusCode = 0;
  let headers: Record<string, string> = {};
  const stream = new PassThrough();
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  const response = stream as PassThrough & {
    writeHead: (status: number, headerMap?: Record<string, string>) => unknown;
  };
  response.writeHead = (status: number, headerMap?: Record<string, string>) => {
    statusCode = status;
    headers = headerMap ?? {};
    return response;
  };
  return {
    response: response as unknown as ServerResponse,
    body: () => Buffer.concat(chunks).toString("utf8"),
    status: () => statusCode,
    headers: () => headers,
    ended: () => response.writableEnded,
  };
}

function fakeRequest(method: string) {
  const request = new EventEmitter() as EventEmitter & { method: string };
  request.method = method;
  return request as unknown as IncomingMessage;
}

const json = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

function serviceWith(behavior: (stem: string) => Promise<void>, configured = true) {
  const spawnImpl = vi.fn((command: string, args: string[]) => {
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
    child.pid = 999;
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn();
    const stem = args[args.indexOf("--output") + 1];
    void behavior(stem).then(() => {
      child.stdout.emit("data", Buffer.from("Loaded model core8\n"));
      child.exitCode = 0;
      child.emit("exit", 0, null);
    });
    return child;
  }) as unknown as typeof spawn;
  return mkdtemp(join(tmpdir(), "ardy-route-")).then(
    (dataDirectory) =>
      new ArdyMotionService({
        config: {
          ...(configured ? { repo: "/opt/ardy" } : {}),
          python: "python3",
          model: "core8",
          timeoutMs: 5_000,
        },
        dataDirectory,
        spawnImpl,
      }),
  );
}

describe("motion generation routes", () => {
  it("reports bridge status without requiring configuration", async () => {
    const ardy = await serviceWith(async () => {}, false);
    const { response, body, status } = fakeResponse();
    const handled = await handleMotionGenerationRoute(
      fakeRequest("GET"),
      response,
      new URL("http://gateway/api/motion/ardy/status"),
      { readBody: async () => ({}), json, ardy },
    );
    expect(handled).toBe(true);
    expect(status()).toBe(200);
    expect(JSON.parse(body())).toEqual({
      success: true,
      result: { configured: false, remote: false, model: "core8" },
    });
  });

  it("refuses generation when unconfigured and validates the body when configured", async () => {
    const unconfigured = await serviceWith(async () => {}, false);
    const refusal = fakeResponse();
    await handleMotionGenerationRoute(
      fakeRequest("POST"),
      refusal.response,
      new URL("http://gateway/api/motion/ardy/generate"),
      { readBody: async () => ({ prompt: "walk" }), json, ardy: unconfigured },
    );
    expect(refusal.status()).toBe(503);

    const configured = await serviceWith(async () => {});
    const invalid = fakeResponse();
    await handleMotionGenerationRoute(
      fakeRequest("POST"),
      invalid.response,
      new URL("http://gateway/api/motion/ardy/generate"),
      { readBody: async () => ({ durationS: 5 }), json, ardy: configured },
    );
    expect(invalid.status()).toBe(200);
    const lines = invalid
      .body()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines.at(-1)).toMatchObject({ event: "error", message: expect.stringContaining("prompt") });
  });

  it("streams NDJSON status events, then done, then serves the allowlisted npz", async () => {
    const ardy = await serviceWith(async (stem) => {
      await writeFile(`${stem}.npz`, Buffer.from("npz-payload"));
    });
    const generate = fakeResponse();
    await handleMotionGenerationRoute(
      fakeRequest("POST"),
      generate.response,
      new URL("http://gateway/api/motion/ardy/generate"),
      { readBody: async () => ({ prompt: "a person walks", durationS: 4 }), json, ardy },
    );
    expect(generate.headers()["content-type"]).toContain("application/x-ndjson");
    const events = generate
      .body()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events[0]).toMatchObject({ event: "status" });
    const done = events.at(-1);
    expect(done).toMatchObject({ event: "done", bytes: 11, model: "core8" });

    const fetchMotion = fakeResponse();
    await handleMotionGenerationRoute(
      fakeRequest("GET"),
      fetchMotion.response,
      new URL(`http://gateway${done.motionUrl}`),
      { readBody: async () => ({}), json, ardy },
    );
    expect(fetchMotion.status()).toBe(200);
    expect(fetchMotion.headers()["content-type"]).toBe("application/octet-stream");
    await vi.waitFor(() => expect(fetchMotion.body()).toContain("npz-payload"));

    const unknown = fakeResponse();
    await handleMotionGenerationRoute(
      fakeRequest("GET"),
      unknown.response,
      new URL("http://gateway/api/motion/ardy/motions/motion-doesnotexist1"),
      { readBody: async () => ({}), json, ardy },
    );
    expect(unknown.status()).toBe(404);
  });

  it("ignores unrelated paths and rejects wrong methods", async () => {
    const ardy = await serviceWith(async () => {});
    const unrelated = fakeResponse();
    expect(
      await handleMotionGenerationRoute(fakeRequest("GET"), unrelated.response, new URL("http://gateway/api/other"), {
        readBody: async () => ({}),
        json,
        ardy,
      }),
    ).toBe(false);

    const wrongMethod = fakeResponse();
    await handleMotionGenerationRoute(
      fakeRequest("DELETE"),
      wrongMethod.response,
      new URL("http://gateway/api/motion/ardy/generate"),
      { readBody: async () => ({}), json, ardy },
    );
    expect(wrongMethod.status()).toBe(405);
  });
});
