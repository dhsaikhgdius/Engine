// @vitest-environment node

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HOST = "127.0.0.1";
const GATEWAY_TOKEN = "integration-plan-apply-token-0001";
const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const OBSERVED_PROJECT_REVISION = "plan-apply-project-revision-1";

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

type FakeBrowser = {
  socket: WebSocket;
  workbenchRequests: Array<Record<string, unknown>>;
  setObserveResult: (result: Record<string, unknown>) => void;
  close: () => Promise<void>;
};

function connectFakeBrowser(port: number): Promise<FakeBrowser> {
  const socket = new WebSocket(`ws://${HOST}:${port}/ws?browser_token=${encodeURIComponent(GATEWAY_TOKEN)}`);
  const workbenchRequests: Array<Record<string, unknown>> = [];
  let observeResult: Record<string, unknown> = { project_revision: OBSERVED_PROJECT_REVISION };
  return new Promise((resolveBrowser, rejectBrowser) => {
    const timer = setTimeout(() => rejectBrowser(new Error("Fake browser never received target-bound")), 10_000);
    socket.once("error", (error) => {
      clearTimeout(timer);
      rejectBrowser(error);
    });
    socket.once("open", () => {
      socket.send(
        JSON.stringify({
          type: "hello",
          role: "director-ui",
          visible: true,
          client_id: "plan-apply-browser",
          instance_id: "plan-apply-instance",
          scene_id: "plan-apply-scene",
          creative_scope_id: "plan-apply-scope",
          contract_version: 2,
          workspace: "stage",
          capture_ready: true,
        }),
      );
    });
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (message.type === "target-bound") {
        clearTimeout(timer);
        resolveBrowser({
          socket,
          workbenchRequests,
          setObserveResult: (result) => {
            observeResult = result;
          },
          close: () =>
            new Promise<void>((resolveClosed) => {
              socket.once("close", () => resolveClosed());
              socket.close();
            }),
        });
        return;
      }
      if (message.type !== "workbench-command-request") return;
      const input = message.input as Record<string, unknown>;
      workbenchRequests.push(input);
      const result =
        input.op === "observe" ? observeResult : { changed: true, project_revision: "plan-apply-project-revision-2" };
      socket.send(
        JSON.stringify({
          type: "workbench-command-response",
          requestId: message.requestId,
          target: message.target,
          success: true,
          result,
        }),
      );
    });
  });
}

describe("agent plan apply guard injection", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "director-plan-apply-"));
  const dataDirectory = resolve(directory, "state");
  let child: ChildProcess;
  let browser: FakeBrowser;
  let baseUrl: string;

  const planRequest = async (message: string) => {
    const response = await fetch(`${baseUrl}/api/assistant/plan`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-director-browser-token": GATEWAY_TOKEN },
      body: JSON.stringify({ agent: "codex", message }),
    });
    const raw = await response.text();
    // Include the body in the failure message so planner-side errors (which
    // surface as non-200 JSON) are diagnosable from the assertion alone.
    expect({ status: response.status, body: response.ok ? "ok" : raw }).toEqual({ status: 200, body: "ok" });
    const body = JSON.parse(raw) as { plan: { id: string; operations: Array<{ id: string }> } };
    return body.plan;
  };

  const applyRequest = (planId: string) =>
    fetch(`${baseUrl}/api/assistant/apply`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-director-browser-token": GATEWAY_TOKEN },
      body: JSON.stringify({ plan_id: planId }),
    });

  beforeAll(async () => {
    mkdirSync(dataDirectory, { recursive: true });
    const binDirectory = resolve(directory, "bin");
    mkdirSync(binDirectory, { recursive: true });
    const fakePlanner = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
// Real codex reads the prompt from stdin when the positional argument is "-";
// the gateway must use that form because the prompt can exceed the OS
// single-argument limit (E2BIG).
const positional = args.at(-1) || "";
const prompt = positional === "-" ? fs.readFileSync(0, "utf8") : positional;
const outputIndex = args.indexOf("--output-last-message");
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : null;
const emit = (plan) => {
  const serialized = JSON.stringify(plan);
  if (outputPath) fs.writeFileSync(outputPath, serialized);
  else process.stdout.write(serialized);
  process.exit(0);
};
const authorStep = (summary, patch) => ({
  tool: "director_workbench",
  summary,
  input_json: JSON.stringify({ op: "author", actions: [{ action: "set_scene", patch }] }),
});
if (prompt.includes("PLAN_APPLY_GUARD_TEST")) {
  emit({ summary: "调整场景背景", operations: [authorStep("设置背景颜色", { backgroundColor: "#182033" })] });
}
if (prompt.includes("PLAN_APPLY_PREFLIGHT_FAIL_TEST")) {
  emit({
    summary: "两步调整场景",
    operations: [
      authorStep("第一步设置背景", { backgroundColor: "#101010" }),
      authorStep("第二步设置地面", { showGround: true }),
    ],
  });
}
process.stderr.write("unexpected planner prompt");
process.exit(17);
`;
    const fakeCodex = resolve(binDirectory, "codex");
    writeFileSync(fakeCodex, fakePlanner);
    chmodSync(fakeCodex, 0o755);

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
        PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForGateway(child, port);
    child.stdout?.resume();
    child.stderr?.resume();
    browser = await connectFakeBrowser(port);
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
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
    rmSync(directory, { recursive: true, force: true });
  });

  it("injects the observed project revision into an unguarded planned author mutation", async () => {
    browser.setObserveResult({ project_revision: OBSERVED_PROJECT_REVISION });
    const plan = await planRequest("PLAN_APPLY_GUARD_TEST");
    browser.workbenchRequests.length = 0;

    const applied = await applyRequest(plan.id);
    const body = (await applied.json()) as {
      success: boolean;
      result: { operations: Array<{ id: string; agent_boundary?: Record<string, unknown> }> };
    };
    expect(applied.status).toBe(200);
    expect(body.success).toBe(true);

    const authorRequests = browser.workbenchRequests.filter((input) => input.op === "author");
    expect(authorRequests).toHaveLength(1);
    expect(authorRequests[0]).toMatchObject({
      op: "author",
      expected_revision: OBSERVED_PROJECT_REVISION,
      idempotency_key: expect.stringMatching(/^agent-intent:/),
    });
    const observeRequests = browser.workbenchRequests.filter((input) => input.op === "observe");
    expect(observeRequests.length).toBeGreaterThanOrEqual(1);

    expect(body.result.operations).toHaveLength(1);
    expect(body.result.operations[0]).toMatchObject({
      id: `${plan.id}-1`,
      tool: "director_workbench",
      agent_boundary: {
        policy: "director-agent-public-boundary-v2",
        operation: "author",
        preflight_observe: true,
        guard: {
          mode: "revision",
          field: "expected_revision",
          source: "preflight_observe",
          value: OBSERVED_PROJECT_REVISION,
        },
        idempotency: { source: "generated", stable_retry: true },
      },
    });
  }, 20_000);

  it("fails the step and halts the plan when preflight returns no usable revision", async () => {
    browser.setObserveResult({ project_revision: OBSERVED_PROJECT_REVISION });
    const plan = await planRequest("PLAN_APPLY_PREFLIGHT_FAIL_TEST");
    expect(plan.operations).toHaveLength(2);
    browser.setObserveResult({ counts: { objects: 0 } });
    browser.workbenchRequests.length = 0;

    const applied = await applyRequest(plan.id);
    const body = (await applied.json()) as { success: boolean; error?: string; code?: string };
    expect(applied.status).toBe(502);
    expect(body.success).toBe(false);
    expect(body.code).toBe("invalid_preflight_revision");
    expect(body.error).toContain("第一步设置背景");
    expect(body.error).toContain("守卫预检未返回可用的项目修订号");

    expect(browser.workbenchRequests.filter((input) => input.op === "author")).toHaveLength(0);
    expect(browser.workbenchRequests.filter((input) => input.op === "observe")).toHaveLength(1);
  }, 20_000);
});
