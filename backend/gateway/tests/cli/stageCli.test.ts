import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../../../..");
const cliPath = join(workspaceRoot, "tools", "scripts", "stage-cli.mjs");
const temporaryDirectories: string[] = [];

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function runCliProcess(args: string[], extraEnvironment: Record<string, string> = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveRun) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        ...extraEnvironment,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

function runCli(
  gatewayUrl: string,
  stateDirectory: string,
  tool: string,
  input: Record<string, unknown>,
  sessionId = "test-agent-session",
  extraEnvironment: Record<string, string> = {},
) {
  return runCliProcess([tool, JSON.stringify(input)], {
    STAGE_GATEWAY_URL: gatewayUrl,
    STAGE_AGENT_SESSION: sessionId,
    DIRECTOR_CLI_STATE_DIR: stateDirectory,
    DIRECTOR_GATEWAY_TOKEN: "test-gateway-token-longer-than-24-characters",
    ...extraEnvironment,
  });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("stage CLI help", () => {
  it("prints preferred tools and examples for --help", async () => {
    const result = await runCliProcess(["--help"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("director_workbench");
    expect(result.stdout).toContain("Legacy compact tools");
    expect(result.stdout).toContain(`npm run --silent stage -- director_workbench '{"op":"observe"}'`);
    expect(result.stdout).toContain("when the Director MCP server is connected");
  });

  it("treats -h the same as --help", async () => {
    const result = await runCliProcess(["-h"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Preferred tools:");
    expect(result.stdout).toContain("director_workbench");
  });

  it("points unknown tools at --help instead of treating --help as a tool name", async () => {
    const result = await runCliProcess(["not-a-tool"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unknown tool: not-a-tool");
    expect(result.stderr).toContain("npm run --silent stage -- --help");
    expect(result.stderr).toContain("Prefer director_workbench over legacy stage_* tools");
  });

  it("prints usage when invoked with no arguments", async () => {
    const result = await runCliProcess([]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("npm run --silent stage -- --help");
  });
});

describe("stage CLI Agent session", () => {
  it("retains the exact observe target and reuses it on the next process invocation", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const target = {
      token: "director-target-token-for-the-exact-browser-tab",
      client_id: "browser-client-1",
      instance_id: "director-instance-1",
      scene_id: "scene-1",
      creative_scope_id: "scene-1",
      contract_version: 2,
    } as const;
    const server = createServer(async (request, response) => {
      const requestBody = await body(request);
      requests.push(requestBody);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          success: true,
          scene: { deliberately: "omitted from CLI receipt" },
          result: { operation: (requestBody.input as Record<string, unknown>).op, project_revision: "revision-1" },
          target,
        }),
      );
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP test server address");
    const gatewayUrl = `http://127.0.0.1:${address.port}`;
    const stateDirectory = await mkdtemp(join(tmpdir(), "director-cli-test-"));
    temporaryDirectories.push(stateDirectory);

    try {
      const observed = await runCli(gatewayUrl, stateDirectory, "director_workbench", { op: "observe" });
      const audited = await runCli(gatewayUrl, stateDirectory, "director_workbench", { op: "audit" });
      expect(observed).toMatchObject({ code: 0, stderr: "" });
      expect(audited).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(observed.stdout)).toMatchObject({
        success: true,
        target,
        session: { id: "test-agent-session", target_binding: "response", target_cached: true },
      });
      expect(JSON.parse(observed.stdout)).not.toHaveProperty("scene");
      expect(requests[0]).not.toHaveProperty("target_token");
      expect(requests[1]).toMatchObject({
        session_id: "test-agent-session",
        target_token: target.token,
        input: { op: "audit" },
      });
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it("preserves machine-readable failure details and gives an actionable recovery step", async () => {
    const server = createServer(async (request, response) => {
      const requestBody = await body(request);
      const operation = requestBody.input as Record<string, unknown>;
      if (operation.op === "observe") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            success: true,
            result: { project_revision: `director-project-revision:v1:sha256:${"a".repeat(64)}` },
            target: {
              token: "failure-recovery-exact-target-token",
              client_id: "browser-client-failure",
              instance_id: "director-instance-failure",
              scene_id: "scene-failure",
              creative_scope_id: "scene-failure",
              contract_version: 2,
            },
          }),
        );
        return;
      }
      response.writeHead(409, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          success: false,
          code: "outcome_unknown",
          error: "The browser did not acknowledge the mutation in time.",
          result: {
            operation: "author",
            outcome: "unknown",
            retry_requires_observe: true,
          },
          agent_boundary: {
            policy: "director-workbench-public-boundary-v1",
            operation: "author",
            exact_target: true,
            target_scope: `sha256:${"c".repeat(64)}`,
            preflight_observe: false,
            revision_guard: {
              mode: "expected_revision",
              source: "caller",
              expected_revision: `director-project-revision:v1:sha256:${"a".repeat(64)}`,
            },
            idempotency: {
              key: "cli-outcome-unknown-v1",
              source: "caller",
              stable_retry: true,
            },
          },
          feedback: { changed: { object_ids: [], track_ids: [], scene_settings: false } },
        }),
      );
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP test server address");
    const gatewayUrl = `http://127.0.0.1:${address.port}`;
    const stateDirectory = await mkdtemp(join(tmpdir(), "director-cli-test-"));
    temporaryDirectories.push(stateDirectory);

    try {
      const result = await runCli(gatewayUrl, stateDirectory, "director_workbench", {
        op: "author",
        expected_revision: `director-project-revision:v1:sha256:${"a".repeat(64)}`,
        idempotency_key: "cli-outcome-unknown-v1",
        actions: [{ action: "set_scene", patch: { backgroundColor: "#111111" } }],
      });
      const receipt = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(result.code).toBe(1);
      expect(receipt).toMatchObject({
        success: false,
        http_status: 409,
        code: "outcome_unknown",
        result: { operation: "author", outcome: "unknown", retry_requires_observe: true },
        agent_boundary: {
          exact_target: true,
          revision_guard: {
            expected_revision: `director-project-revision:v1:sha256:${"a".repeat(64)}`,
          },
          idempotency: { key: "cli-outcome-unknown-v1", stable_retry: true },
        },
        recovery: {
          code: "outcome_unknown",
          suggested_next: expect.stringContaining("Do not write again yet"),
        },
      });
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it("acquires a Workbench target and revision guard inside one targeted command", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const revision = `director-project-revision:v1:sha256:${"b".repeat(64)}`;
    const target = {
      token: "one-command-workbench-exact-target-token",
      client_id: "browser-client-workbench",
      instance_id: "director-instance-workbench",
      scene_id: "scene-workbench",
      creative_scope_id: "scene-workbench",
      contract_version: 2,
    } as const;
    const server = createServer(async (request, response) => {
      const requestBody = await body(request);
      requests.push(requestBody);
      const operation = requestBody.input as Record<string, unknown>;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          success: true,
          result: operation.op === "observe" ? { project_revision: revision } : { status: "delivered" },
          target,
        }),
      );
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP test server address");
    const gatewayUrl = `http://127.0.0.1:${address.port}`;
    const stateDirectory = await mkdtemp(join(tmpdir(), "director-cli-test-"));
    temporaryDirectories.push(stateDirectory);

    try {
      const delivered = await runCli(
        gatewayUrl,
        stateDirectory,
        "director_workbench",
        { op: "deliver", camera_id: "cam-main" },
        "one-command-workbench",
      );
      expect(delivered.code).toBe(0);
      expect(requests).toHaveLength(2);
      expect(requests[0]).toMatchObject({ input: { op: "observe", fields: ["counts"] } });
      expect(requests[0]).not.toHaveProperty("target_token");
      expect(requests[1]).toMatchObject({
        target_token: target.token,
        input: { op: "deliver", camera_id: "cam-main", expected_revision: revision },
      });
      expect(JSON.parse(delivered.stdout)).toMatchObject({
        success: true,
        session: {
          target_binding: "response",
          preflight_observe: true,
          injected_guard: { field: "expected_revision", value: revision, source: "preflight_observe" },
        },
      });
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it("does not combine an explicit unconditional Workbench mutation with an injected revision guard", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const target = {
      token: "one-command-unconditional-exact-target-token",
      client_id: "browser-client-unconditional",
      instance_id: "director-instance-unconditional",
      scene_id: "scene-unconditional",
      creative_scope_id: "scene-unconditional",
      contract_version: 2,
    } as const;
    const server = createServer(async (request, response) => {
      const requestBody = await body(request);
      requests.push(requestBody);
      const operation = requestBody.input as Record<string, unknown>;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          success: true,
          result:
            operation.op === "observe"
              ? { project_revision: `director-project-revision:v1:sha256:${"d".repeat(64)}` }
              : { status: "completed" },
          target,
        }),
      );
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP test server address");
    const gatewayUrl = `http://127.0.0.1:${address.port}`;
    const stateDirectory = await mkdtemp(join(tmpdir(), "director-cli-test-"));
    temporaryDirectories.push(stateDirectory);

    try {
      const executed = await runCli(
        gatewayUrl,
        stateDirectory,
        "director_workbench",
        {
          op: "author",
          unconditional: true,
          idempotency_key: "explicit-unconditional-write-v1",
          actions: [{ action: "set_scene", patch: { backgroundColor: "#111111" } }],
        },
        "one-command-unconditional",
      );
      expect(executed.code).toBe(0);
      expect(requests).toHaveLength(2);
      expect(requests[1]).toMatchObject({
        target_token: target.token,
        input: { op: "author", unconditional: true, idempotency_key: "explicit-unconditional-write-v1" },
      });
      expect(requests[1]?.input).not.toHaveProperty("expected_revision");
      expect(JSON.parse(executed.stdout)).toMatchObject({
        success: true,
        session: { preflight_observe: true },
      });
      expect(JSON.parse(executed.stdout).session).not.toHaveProperty("injected_guard");
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it("does the same one-command binding and fingerprint guard for Creative preview", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const fingerprint = `sha256:${"c".repeat(64)}`;
    const target = {
      token: "one-command-creative-exact-target-token",
      client_id: "browser-client-creative",
      instance_id: "director-instance-creative",
      scene_id: "scene-creative",
      creative_scope_id: "creative-scope-1",
      contract_version: 2,
    } as const;
    const server = createServer(async (request, response) => {
      const requestBody = await body(request);
      requests.push(requestBody);
      const operation = requestBody.input as Record<string, unknown>;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          success: true,
          result:
            operation.op === "observe"
              ? { op: "observe", snapshot: { snapshot_fingerprint: fingerprint } }
              : { op: "preview", preview: { success: true, image_attached: true } },
          target,
        }),
      );
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP test server address");
    const gatewayUrl = `http://127.0.0.1:${address.port}`;
    const stateDirectory = await mkdtemp(join(tmpdir(), "director-cli-test-"));
    temporaryDirectories.push(stateDirectory);

    try {
      const previewed = await runCli(
        gatewayUrl,
        stateDirectory,
        "director_creative",
        { op: "preview", workspace: "canvas" },
        "one-command-creative",
      );
      expect(previewed.code).toBe(0);
      expect(requests).toHaveLength(2);
      expect(requests[0]).toMatchObject({ input: { op: "observe" } });
      expect(requests[1]).toMatchObject({
        target_token: target.token,
        input: { op: "preview", workspace: "canvas", expected_snapshot_fingerprint: fingerprint },
      });
      expect(JSON.parse(previewed.stdout)).toMatchObject({
        success: true,
        session: {
          preflight_observe: true,
          injected_guard: {
            field: "expected_snapshot_fingerprint",
            value: fingerprint,
            source: "preflight_observe",
          },
        },
      });
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it("refreshes a guard on the same cached target before a later guarded mutation", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const revision = `director-project-revision:v1:sha256:${"e".repeat(64)}`;
    const target = {
      token: "capabilities-cached-exact-target-token",
      client_id: "browser-client-capabilities",
      instance_id: "director-instance-capabilities",
      scene_id: "scene-capabilities",
      creative_scope_id: "scene-capabilities",
      contract_version: 2,
    } as const;
    const server = createServer(async (request, response) => {
      const requestBody = await body(request);
      requests.push(requestBody);
      const operation = requestBody.input as Record<string, unknown>;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          success: true,
          result: operation.op === "observe" ? { project_revision: revision } : { operation: operation.op },
          target,
        }),
      );
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP test server address");
    const gatewayUrl = `http://127.0.0.1:${address.port}`;
    const stateDirectory = await mkdtemp(join(tmpdir(), "director-cli-test-"));
    temporaryDirectories.push(stateDirectory);

    try {
      const discovered = await runCli(
        gatewayUrl,
        stateDirectory,
        "director_workbench",
        { op: "capabilities" },
        "cached-guard-session",
      );
      const authored = await runCli(
        gatewayUrl,
        stateDirectory,
        "director_workbench",
        {
          op: "author",
          idempotency_key: "cached-target-author-v1",
          actions: [{ action: "set_scene", patch: { backgroundColor: "#222222" } }],
        },
        "cached-guard-session",
      );

      expect(discovered.code).toBe(0);
      expect(authored.code).toBe(0);
      expect(requests).toHaveLength(3);
      expect(requests[1]).toMatchObject({
        target_token: target.token,
        input: { op: "observe", fields: ["counts"] },
      });
      expect(requests[2]).toMatchObject({
        target_token: target.token,
        input: { op: "author", expected_revision: revision, idempotency_key: "cached-target-author-v1" },
      });
      expect(JSON.parse(authored.stdout)).toMatchObject({
        session: {
          target_binding: "response",
          preflight_observe: true,
          injected_guard: { field: "expected_revision", value: revision, source: "preflight_observe" },
        },
      });
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it("gives an explicit DIRECTOR_TARGET_TOKEN priority without silently observing another tab", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const explicitToken = "explicit-director-target-token";
    const server = createServer(async (request, response) => {
      requests.push(await body(request));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ success: true, result: { ready: true } }));
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP test server address");
    const gatewayUrl = `http://127.0.0.1:${address.port}`;
    const stateDirectory = await mkdtemp(join(tmpdir(), "director-cli-test-"));
    temporaryDirectories.push(stateDirectory);

    try {
      const audited = await runCli(
        gatewayUrl,
        stateDirectory,
        "director_workbench",
        { op: "audit" },
        "explicit-target-session",
        { DIRECTOR_TARGET_TOKEN: explicitToken },
      );
      expect(audited.code).toBe(0);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ target_token: explicitToken, input: { op: "audit" } });
      expect(JSON.parse(audited.stdout)).toMatchObject({
        session: { target_binding: "environment", preflight_observe: false },
      });
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });
});
