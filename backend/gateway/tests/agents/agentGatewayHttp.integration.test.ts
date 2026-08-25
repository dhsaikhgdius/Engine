// @vitest-environment node

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HOST = "127.0.0.1";
const GATEWAY_TOKEN = "integration-gateway-token-00000001";
const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const PLANNER_PRIVATE_PATH = "/Users/private-operator/unpublished-project";
const PLANNER_PRIVATE_TOKEN = "planner-upstream-secret";
const PLANNER_INVALID_JSON_SECRET = "planner-model-json-secret";
const PLANNER_DRAFT_DECODER_SECRET = "planner-draft-decoder-secret";
const PLANNER_OUTPUT_LIMIT_SECRET = "planner-model-limit-secret";
const PLANNER_SEMANTIC_SECRET = "planner-semantic-validation-secret";
const NATIVE_SCENE_EPOCH = "82a6f8c1-7cb8-4d6f-a5f2-a4f5654a0420";
const NATIVE_JOB_ID = "21c84665-2730-4248-9a0e-45b798b5b3fe";
const NATIVE_REQUEST_ID = "63a521f0-7fe3-4fd7-8e06-8457e806c6b3";

function reservePort() {
  return new Promise<number>((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.once("error", rejectPort);
    probe.listen(0, HOST, () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close();
        rejectPort(new Error("Could not reserve an integration-test port"));
        return;
      }
      const { port } = address;
      probe.close((error) => (error ? rejectPort(error) : resolvePort(port)));
    });
  });
}

function waitForGateway(child: ChildProcess, port: number) {
  return new Promise<void>((resolveReady, rejectReady) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      rejectReady(new Error(`Gateway did not start on ${port}. stdout=${stdout} stderr=${stderr}`));
    }, 15_000);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("exit", onExit);
      if (error) rejectReady(error);
      else resolveReady();
    };
    const onStdout = (chunk: Buffer) => {
      stdout = `${stdout}${chunk.toString()}`.slice(-8_192);
      if (stdout.includes(`Director Stage gateway ready at http://${HOST}:${port}`)) finish();
    };
    const onStderr = (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-8_192);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(new Error(`Gateway exited before ready (${code ?? signal}). stderr=${stderr}`));
    };
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("exit", onExit);
  });
}

describe("agent gateway HTTP boundary", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "director-gateway-http-"));
  const dataDirectory = resolve(directory, "state");
  let child: ChildProcess;
  let nativeServer: ReturnType<typeof createServer>;
  let baseUrl: string;
  let gatewayStderr = "";
  let dccConfigDirectory = "";

  beforeAll(async () => {
    mkdirSync(dataDirectory, { recursive: true });
    writeFileSync(resolve(dataDirectory, "latest-preview.png"), Buffer.from("private-preview"));
    const binDirectory = resolve(directory, "bin");
    const fakeCodex = resolve(binDirectory, "codex");
    const fakeClaude = resolve(binDirectory, "claude");
    mkdirSync(binDirectory, { recursive: true });
    const fakePlanner = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const prompt = args.at(-1) || "";
const outputIndex = args.indexOf("--output-last-message");
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : null;
if (prompt.includes("DRAFT_DECODER_TEST")) {
  const malformedDraft = JSON.stringify({ operations: [{ input_json: ${JSON.stringify(`{"api_key":"${PLANNER_DRAFT_DECODER_SECRET}", bad}`)} }] });
  if (outputPath) fs.writeFileSync(outputPath, malformedDraft);
  else process.stdout.write(malformedDraft);
  process.exit(0);
}
if (prompt.includes("INVALID_JSON_TEST")) {
  const malformed = ${JSON.stringify(`{"api_key":"${PLANNER_INVALID_JSON_SECRET}", bad}`)};
  if (outputPath) fs.writeFileSync(outputPath, malformed);
  else process.stdout.write(malformed);
  process.exit(0);
}
if (prompt.includes("OUTPUT_LIMIT_TEST")) {
  process.stdout.write("x".repeat(1100000) + ${JSON.stringify(` access_token=${PLANNER_OUTPUT_LIMIT_SECRET}`)});
  return;
}
if (prompt.includes("OUTPUT_FILE_LIMIT_TEST")) {
  if (outputPath) fs.writeFileSync(outputPath, "x".repeat(1100000));
  process.exit(0);
}
if (prompt.includes("SEMANTIC_VALIDATION_TEST")) {
  const semanticFailure = JSON.stringify({
    summary: "invalid semantic plan",
    operations: [{
      tool: "stage_read",
      summary: "inspect a missing subject",
      input_json: JSON.stringify({ op: "critique", camera_id: "camera-1", subject_id: ${JSON.stringify(PLANNER_SEMANTIC_SECRET)} })
    }]
  });
  if (outputPath) fs.writeFileSync(outputPath, semanticFailure);
  else process.stdout.write(semanticFailure);
  process.exit(0);
}
process.stderr.write(${JSON.stringify(`fatal ${PLANNER_PRIVATE_PATH} token=${PLANNER_PRIVATE_TOKEN}\n`)});
process.exit(17);
`;
    writeFileSync(fakeCodex, fakePlanner);
    writeFileSync(fakeClaude, fakePlanner);
    chmodSync(fakeCodex, 0o755);
    chmodSync(fakeClaude, 0o755);
    // The gateway only trusts DCC provider configs under workspace/integrations.
    mkdirSync(resolve(WORKSPACE_ROOT, "integrations"), { recursive: true });
    dccConfigDirectory = mkdtempSync(resolve(WORKSPACE_ROOT, "integrations", "gateway-dcc-provider-"));
    const dccConfigPath = resolve(dccConfigDirectory, "providers.json");
    writeFileSync(
      dccConfigPath,
      JSON.stringify({
        contract: "director-dcc-provider-config-v1",
        providers: [
          {
            id: "integration.gateway",
            label: "Integration Gateway",
            category: "dcc",
            integration: "exchange-package",
            preferredFormat: "usda",
            exchangeFormats: ["usda", "glb"],
            capabilities: [
              { id: "scene", level: "exchange" },
              { id: "camera", level: "exchange" },
              { id: "stable_ids", level: "exchange" },
            ],
          },
        ],
      }),
    );
    const nativePort = await reservePort();
    nativeServer = createServer((request, response) => {
      const path = new URL(request.url ?? "/", `http://${HOST}`).pathname;
      let payload: unknown;
      if (request.method === "GET" && path === "/health") {
        payload = {
          ok: true,
          contract: "worldengine-blender-live-v1",
          sceneEpoch: NATIVE_SCENE_EPOCH,
          blenderVersion: "5.1.2",
          revision: 3,
          busy: false,
        };
      } else if (request.method === "POST" && path === "/v1/commands") {
        payload = {
          contract: "worldengine-blender-live-v1",
          jobId: NATIVE_JOB_ID,
          requestId: NATIVE_REQUEST_ID,
          status: "queued",
        };
      } else if (request.method === "GET" && path === `/v1/jobs/${NATIVE_JOB_ID}`) {
        payload = {
          contract: "worldengine-blender-live-v1",
          jobId: NATIVE_JOB_ID,
          requestId: NATIVE_REQUEST_ID,
          status: "succeeded",
          revision: 3,
          result: {
            revisionBefore: 3,
            revisionAfter: 3,
            operations: [
              {
                contract: "worldengine-blender-live-v1",
                sceneEpoch: NATIVE_SCENE_EPOCH,
                revision: 3,
                mimeType: "model/gltf-binary",
                dataBase64: "Z2xURg==",
                byteLength: 4,
              },
            ],
          },
          error: null,
        };
      } else if (request.method === "GET" && path === `/v1/previews/${NATIVE_JOB_ID}.glb`) {
        // The live bridge serves the detached preview GLB as binary bytes with
        // authoritative scene headers instead of inlining base64 in the job.
        const bytes = Buffer.from("glTF");
        response.writeHead(200, {
          "content-length": String(bytes.byteLength),
          "content-type": "model/gltf-binary",
          "x-blender-scene-epoch": NATIVE_SCENE_EPOCH,
          "x-blender-revision": "3",
        });
        response.end(bytes);
        return;
      } else {
        response.writeHead(404).end();
        return;
      }
      const body = JSON.stringify(payload);
      response.writeHead(200, {
        "content-length": String(Buffer.byteLength(body)),
        "content-type": "application/json",
      });
      response.end(body);
    });
    await new Promise<void>((resolveReady) => nativeServer.listen(nativePort, HOST, resolveReady));

    const port = await reservePort();
    baseUrl = `http://${HOST}:${port}`;
    child = spawn(process.execPath, ["--import", "tsx/esm", "backend/gateway/agent-gateway.ts"], {
      cwd: WORKSPACE_ROOT,
      env: {
        ...process.env,
        STAGE_GATEWAY_HOST: HOST,
        STAGE_GATEWAY_PORT: String(port),
        DIRECTOR_DATA_DIRECTORY: dataDirectory,
        DIRECTOR_GATEWAY_TOKEN: GATEWAY_TOKEN,
        DIRECTOR_DCC_PROVIDER_CONFIG: dccConfigPath,
        DIRECTOR_BLENDER_URL: `http://${HOST}:${nativePort}`,
        PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForGateway(child, port);
    child.stdout?.resume();
    child.stderr?.on("data", (chunk: Buffer) => {
      gatewayStderr = `${gatewayStderr}${chunk.toString()}`.slice(-64 * 1024);
    });
  }, 20_000);

  afterAll(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolveExit) => {
        const timer = setTimeout(resolveExit, 5_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolveExit();
        });
        child.kill("SIGTERM");
      });
    }
    if (nativeServer?.listening) {
      await new Promise<void>((resolveClosed, rejectClosed) =>
        nativeServer.close((error) => (error ? rejectClosed(error) : resolveClosed())),
      );
    }
    rmSync(directory, { recursive: true, force: true });
    if (dccConfigDirectory) rmSync(dccConfigDirectory, { recursive: true, force: true });
  });

  it("keeps health and loopback bootstrap available", async () => {
    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      ok: true,
      service: "director-stage-gateway",
    });

    const anonymous = await fetch(`${baseUrl}/te-man/director/agent/bootstrap`, { method: "POST" });
    expect(anonymous.status).toBe(200);
    await expect(anonymous.json()).resolves.toMatchObject({
      browserToken: GATEWAY_TOKEN,
    });

    for (const origin of ["http://127.0.0.1:5175"]) {
      const browser = await fetch(`${baseUrl}/te-man/director/agent/bootstrap`, {
        method: "POST",
        headers: { Origin: origin },
      });
      expect(browser.status).toBe(200);
      expect(browser.headers.get("access-control-allow-origin")).toBe(origin);
      await expect(browser.json()).resolves.toMatchObject({
        browserToken: GATEWAY_TOKEN,
      });
    }

    const unexpectedDevPort = await fetch(`${baseUrl}/te-man/director/agent/bootstrap`, {
      method: "POST",
      headers: { Origin: "http://127.0.0.1:5176" },
    });
    expect(unexpectedDevPort.status).toBe(403);
    await expect(unexpectedDevPort.json()).resolves.toMatchObject({
      code: "origin_denied",
    });

    const authenticatedNative = await fetch(`${baseUrl}/te-man/director/agent/bootstrap`, {
      method: "POST",
      headers: { "x-director-browser-token": GATEWAY_TOKEN },
    });
    expect(authenticatedNative.status).toBe(200);
  });

  it("protects preview bytes while preserving authenticated browser and Agent reads", async () => {
    expect((await fetch(`${baseUrl}/api/preview`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/dcc/blender/preview.glb`)).status).toBe(401);

    const headerRead = await fetch(`${baseUrl}/api/preview`, {
      headers: { "x-director-browser-token": GATEWAY_TOKEN },
    });
    expect(headerRead.status).toBe(200);
    expect(await headerRead.text()).toBe("private-preview");

    const queryRead = await fetch(`${baseUrl}/api/preview?browser_token=${encodeURIComponent(GATEWAY_TOKEN)}`);
    expect(queryRead.status).toBe(200);
    expect(await queryRead.text()).toBe("private-preview");

    const nativeScenePreview = await fetch(`${baseUrl}/api/dcc/blender/preview.glb`, {
      headers: {
        Origin: "http://127.0.0.1:5175",
        "x-director-browser-token": GATEWAY_TOKEN,
      },
    });
    expect(nativeScenePreview.status).toBe(200);
    expect(nativeScenePreview.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5175");
    expect(nativeScenePreview.headers.get("access-control-expose-headers")).toBe(
      "X-Blender-Revision, X-Blender-Scene-Epoch, Content-Length",
    );
    expect(nativeScenePreview.headers.get("x-blender-revision")).toBe("3");
    expect(nativeScenePreview.headers.get("x-blender-scene-epoch")).toBe(NATIVE_SCENE_EPOCH);
    expect(Buffer.from(await nativeScenePreview.arrayBuffer()).toString()).toBe("glTF");
  });

  it("distinguishes unprotected 404s from protected API paths", async () => {
    expect((await fetch(`${baseUrl}/missing`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/missing`)).status).toBe(401);
    expect(
      (
        await fetch(`${baseUrl}/api/missing`, {
          headers: { "x-director-browser-token": GATEWAY_TOKEN },
        })
      ).status,
    ).toBe(404);
  });

  it("loads an explicit exchange-only DCC provider configuration at gateway startup", async () => {
    const headers = { "x-director-browser-token": GATEWAY_TOKEN };
    const discovery = await fetch(`${baseUrl}/api/dcc/providers`, { headers });
    expect(discovery.status).toBe(200);
    await expect(discovery.json()).resolves.toMatchObject({
      success: true,
      result: {
        contract: "director-dcc-provider-catalog-v1",
        providers: expect.arrayContaining([
          expect.objectContaining({
            provider: expect.objectContaining({
              id: "integration.gateway",
              integration: "exchange-package",
              preferredFormat: "usda",
              exchangeFormats: ["usda", "glb"],
            }),
            installed: false,
            executable: null,
            nativeReady: false,
            exchangeReady: true,
          }),
        ]),
      },
    });

    const status = await fetch(`${baseUrl}/api/dcc/providers/integration.gateway/status`, { headers });
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({
      success: true,
      result: {
        provider: { id: "integration.gateway" },
        installed: false,
        executable: null,
        nativeReady: false,
        exchangeReady: true,
      },
    });
  });

  it("returns a safe planner failure over HTTP without reflecting raw stderr", async () => {
    const response = await fetch(`${baseUrl}/api/assistant/plan`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-director-browser-token": GATEWAY_TOKEN,
      },
      body: JSON.stringify({
        agent: "codex",
        message: "Build a safe test shot",
      }),
    });
    const body = (await response.json()) as { error?: string; code?: string };

    expect(response.status).toBe(502);
    expect(body.code).toBe("agent_failed");
    expect(body.error).toContain("故障编号");
    expect(body.error).not.toContain(PLANNER_PRIVATE_PATH);
    expect(body.error).not.toContain(PLANNER_PRIVATE_TOKEN);
  }, 10_000);

  for (const agent of ["codex", "claude"] as const) {
    it(`returns a fixed incident error for malformed ${agent} JSON without reflecting model output`, async () => {
      const response = await fetch(`${baseUrl}/api/assistant/plan`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-director-browser-token": GATEWAY_TOKEN,
        },
        body: JSON.stringify({ agent, message: "INVALID_JSON_TEST" }),
      });
      const body = (await response.json()) as { error?: string; code?: string };

      expect(response.status).toBe(502);
      expect(body.code).toBe("agent_invalid_json");
      expect(body.error).toMatch(
        new RegExp(`^${agent === "codex" ? "Codex" : "Claude"} 返回的结构化计划无效，请重试（故障编号 [^)]+）$`),
      );
      expect(body.error).not.toContain(PLANNER_INVALID_JSON_SECRET);
      expect(gatewayStderr).not.toContain(PLANNER_INVALID_JSON_SECRET);
    }, 10_000);

    it(`sanitizes ${agent} operation-envelope decoder failures after the bounded retry`, async () => {
      const response = await fetch(`${baseUrl}/api/assistant/plan`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-director-browser-token": GATEWAY_TOKEN,
        },
        body: JSON.stringify({ agent, message: "DRAFT_DECODER_TEST" }),
      });
      const body = (await response.json()) as { error?: string; code?: string };

      expect(response.status).toBe(422);
      expect(body.code).toBe("agent_invalid_json");
      expect(body.error).toContain("返回的结构化计划无效");
      expect(body.error).toContain("故障编号");
      expect(body.error).not.toContain(PLANNER_DRAFT_DECODER_SECRET);
      expect(gatewayStderr).not.toContain(PLANNER_DRAFT_DECODER_SECRET);
    }, 10_000);

    it(`sanitizes ${agent} semantic validation failures after the bounded retry`, async () => {
      const response = await fetch(`${baseUrl}/api/assistant/plan`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-director-browser-token": GATEWAY_TOKEN,
        },
        body: JSON.stringify({ agent, message: "SEMANTIC_VALIDATION_TEST" }),
      });
      const body = (await response.json()) as { error?: string; code?: string };

      expect(response.status).toBe(422);
      expect(body.code).toBe("agent_invalid_json");
      expect(body.error).toContain("返回的结构化计划无效");
      expect(body.error).toContain("故障编号");
      expect(body.error).not.toContain(PLANNER_SEMANTIC_SECRET);
      expect(gatewayStderr).not.toContain(PLANNER_SEMANTIC_SECRET);
    }, 10_000);

    it(`terminates ${agent} when stdout exceeds the planner safety limit`, async () => {
      const response = await fetch(`${baseUrl}/api/assistant/plan`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-director-browser-token": GATEWAY_TOKEN,
        },
        body: JSON.stringify({ agent, message: "OUTPUT_LIMIT_TEST" }),
      });
      const body = (await response.json()) as { error?: string; code?: string };

      expect(response.status).toBe(502);
      expect(body.code).toBe("agent_output_limit");
      expect(body.error).toContain("规划输出超过安全上限");
      expect(body.error).toContain("故障编号");
      expect(body.error).not.toContain(PLANNER_OUTPUT_LIMIT_SECRET);
      expect(gatewayStderr).not.toContain(PLANNER_OUTPUT_LIMIT_SECRET);
    }, 10_000);
  }

  it("applies the same safety limit to Codex's output-last-message file", async () => {
    const response = await fetch(`${baseUrl}/api/assistant/plan`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-director-browser-token": GATEWAY_TOKEN,
      },
      body: JSON.stringify({
        agent: "codex",
        message: "OUTPUT_FILE_LIMIT_TEST",
      }),
    });
    const body = (await response.json()) as { error?: string; code?: string };

    expect(response.status).toBe(502);
    expect(body.code).toBe("agent_output_limit");
    expect(body.error).toContain("故障编号");
  }, 10_000);
});
