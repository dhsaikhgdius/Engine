#!/usr/bin/env node
// Director agent-eval harness: spawns an isolated gateway + Vite UI + headless
// chromium tab, then replays the golden tasks in tools/evals/tasks/*.json against the
// public agent HTTP boundary. See tools/evals/README.md.
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const tasksDirectory = join(repoRoot, "tools", "evals", "tasks");
const GATEWAY_PORT = 8899;
const UI_PORT = 5199;
const GATEWAY_URL = `http://127.0.0.1:${GATEWAY_PORT}`;
const UI_URL = `http://127.0.0.1:${UI_PORT}`;
const DATA_DIRECTORY = ".runtime/evals/data";
const READY_BUDGET_MS = 120_000;
const STEP_TIMEOUT_MS = 120_000;

const children = [];
let browser = null;

function log(line = "") {
  process.stdout.write(`${line}\n`);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function assertPortFree(port) {
  await new Promise((resolveProbe, rejectProbe) => {
    const probe = createServer();
    probe.once("error", () =>
      rejectProbe(
        new Error(
          `Port ${port} is already in use. The eval harness refuses to touch a running Director stack; stop whatever listens on ${port} and rerun.`,
        ),
      ),
    );
    probe.listen({ host: "127.0.0.1", port }, () => probe.close(resolveProbe));
  });
}

function spawnChild(label, args, env) {
  const child = spawn("npx", args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const handle = { label, child, output: "" };
  const capture = (chunk) => {
    handle.output = (handle.output + chunk).slice(-20_000);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  children.push(handle);
  return handle;
}

function assertChildrenAlive() {
  for (const { label, child, output } of children) {
    if (child.exitCode !== null || child.signalCode) {
      throw new Error(`${label} exited before the harness finished. Recent output:\n${output}`);
    }
  }
}

async function teardown() {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
  for (const { child } of children) {
    if (child.exitCode !== null || child.signalCode) continue;
    // Children are process-group leaders (detached), so signal the whole group
    // to take down npx -> tsx/vite descendants as well.
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline && children.some(({ child }) => child.exitCode === null && !child.signalCode)) {
    await sleep(100);
  }
  for (const { child } of children) {
    if (child.exitCode !== null || child.signalCode) continue;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

async function fetchJson(url, options) {
  const response = await fetch(url, { signal: AbortSignal.timeout(STEP_TIMEOUT_MS), ...options });
  return { status: response.status, body: await response.json() };
}

async function bootstrapToken() {
  const { status, body } = await fetchJson(`${GATEWAY_URL}/te-man/director/agent/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (status !== 200 || typeof body.browserToken !== "string") {
    throw new Error(`Gateway bootstrap failed with HTTP ${status}: ${JSON.stringify(body)}`);
  }
  return body.browserToken;
}

function callTool(token, tool, sessionId, input) {
  return fetchJson(`${GATEWAY_URL}/api/tools/${tool}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-director-browser-token": token },
    body: JSON.stringify({ session_id: sessionId, input }),
  });
}

async function waitFor(label, probe, budgetMs, intervalMs = 1_000) {
  const deadline = Date.now() + budgetMs;
  let lastError = "";
  while (Date.now() < deadline) {
    assertChildrenAlive();
    try {
      if (await probe()) return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${budgetMs}ms waiting for ${label}.${lastError ? ` Last error: ${lastError}` : ""}`);
}

async function startStack() {
  await rm(join(repoRoot, DATA_DIRECTORY), { recursive: true, force: true });
  await mkdir(join(repoRoot, DATA_DIRECTORY), { recursive: true });
  await assertPortFree(GATEWAY_PORT);
  await assertPortFree(UI_PORT);

  spawnChild("gateway", ["tsx", "backend/gateway/agent-gateway.ts"], {
    STAGE_GATEWAY_PORT: String(GATEWAY_PORT),
    STAGE_GATEWAY_HOST: "127.0.0.1",
    DIRECTOR_DATA_DIRECTORY: DATA_DIRECTORY,
    // The gateway must trust the isolated UI origin for browser-tab traffic.
    DIRECTOR_UI_PORT: String(UI_PORT),
  });
  spawnChild("vite", ["vite", "--config", "tools/vite.config.ts", "--host", "127.0.0.1"], {
    DIRECTOR_UI_PORT: String(UI_PORT),
    VITE_STAGE_GATEWAY_URL: GATEWAY_URL,
  });

  log(`Waiting for the isolated gateway on :${GATEWAY_PORT} ...`);
  await waitFor("gateway /health", async () => (await fetch(`${GATEWAY_URL}/health`)).ok, 60_000);
  const token = await bootstrapToken();

  log(`Waiting for the isolated Vite UI on :${UI_PORT} ...`);
  await waitFor("vite dev server", async () => (await fetch(UI_URL)).ok, 60_000);

  log("Opening headless chromium so the workbench tab connects ...");
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(UI_URL, { waitUntil: "domcontentloaded", timeout: READY_BUDGET_MS });

  log("Waiting for the workbench tab to answer observe (first compile may be slow) ...");
  await waitFor(
    "workbench observe to succeed",
    async () => {
      const { status, body } = await callTool(token, "director_workbench", "eval-readiness", {
        op: "observe",
        fields: ["counts"],
      });
      return status === 200 && body.success === true;
    },
    READY_BUDGET_MS,
    2_000,
  );
  return token;
}

function resolvePath(value, path) {
  return path.split(".").reduce((current, key) => (current == null ? undefined : current[key]), value);
}

function checkExpectations(expect, body) {
  const failures = [];
  if (body.success !== expect.success) {
    failures.push(`expected success=${expect.success}, got success=${body.success}`);
  }
  const code = body.code ?? (typeof body.result === "object" && body.result !== null ? body.result.code : undefined);
  if (expect.code !== undefined && code !== expect.code) {
    failures.push(`expected code="${expect.code}", got code=${JSON.stringify(code)}`);
  }
  if (expect.error_includes !== undefined && !String(body.error ?? "").includes(expect.error_includes)) {
    failures.push(`expected error to include "${expect.error_includes}", got error=${JSON.stringify(body.error)}`);
  }
  for (const path of expect.result_paths ?? []) {
    if (resolvePath(body, path) == null) failures.push(`expected response path "${path}" to resolve to a value`);
  }
  if (failures.length && !expect.success) {
    failures.push(`actual code=${JSON.stringify(code)} error=${JSON.stringify(body.error)}`);
  }
  return failures;
}

async function loadTasks() {
  const files = (await readdir(tasksDirectory)).filter((file) => file.endsWith(".json")).sort();
  if (!files.length) throw new Error(`No task files found in ${tasksDirectory}.`);
  return Promise.all(
    files.map(async (file) => ({ file, ...JSON.parse(await readFile(join(tasksDirectory, file), "utf8")) })),
  );
}

async function runTask(token, task) {
  const sessionId = `eval-${task.name}-${Date.now()}`;
  log(`task ${task.file} — ${task.description}`);
  let taskPassed = true;
  for (const step of task.steps) {
    let failures;
    try {
      const { body } = await callTool(token, step.tool, sessionId, step.input);
      failures = checkExpectations(step.expect, body);
    } catch (error) {
      failures = [`request failed: ${error instanceof Error ? error.message : String(error)}`];
    }
    log(`  ${failures.length ? "FAIL" : "PASS"}  ${step.label.padEnd(32)} ${step.input.op ?? ""}`);
    for (const failure of failures) log(`        - ${failure}`);
    if (failures.length) {
      taskPassed = false;
      break; // Later steps depend on earlier scene state; skip the rest.
    }
  }
  return taskPassed;
}

async function main() {
  const tasks = await loadTasks();
  const token = await startStack();
  log();
  let passed = 0;
  for (const task of tasks) {
    if (await runTask(token, task)) passed += 1;
    log();
  }
  log(`evals: ${passed}/${tasks.length} tasks passed`);
  return passed === tasks.length ? 0 : 1;
}

process.on("SIGINT", () => {
  teardown().finally(() => process.exit(130));
});

let exitCode = 1;
try {
  exitCode = await main();
} catch (error) {
  log(`eval harness error: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await teardown();
}
process.exit(exitCode);
