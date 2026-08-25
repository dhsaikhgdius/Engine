#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const gatewayUrl = (process.env.STAGE_GATEWAY_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const dshUrl = (process.env.DSH_WEB_URL ?? "http://127.0.0.1:3080").replace(/\/$/, "");
const runId = Date.now().toString(36);
const sceneId = `director-reference-${runId}`;
const prepSessionId = `reference-prep-${runId}`;
const timeoutMs = 15 * 60_000;

const EXPECTED_OBJECT_IDS = ["reference-floor", "reference-backdrop", "reference-table"];
const EXPECTED_CAMERA_ID = "reference-camera-main";
const EXPECTED_PASSES = ["clean", "clay", "mask", "depth"];
let rpcSequence = 0;

function log(message = "") {
  process.stdout.write(`${message}\n`);
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(130_000), ...options });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function dshRpc(method, payload) {
  rpcSequence += 1;
  const body = await fetchJson(`${dshUrl}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "client-request",
      rpcId: `reference-${runId}-${rpcSequence}`,
      method,
      payload,
    }),
  });
  if (!body?.result?.ok) {
    throw new Error(
      `${method} failed: ${body?.result?.error?.code ?? "unknown"}: ${body?.result?.error?.message ?? ""}`,
    );
  }
  return body.result.value;
}

async function gatewayToken() {
  const body = await fetchJson(`${gatewayUrl}/te-man/director/agent/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (typeof body.browserToken !== "string") throw new Error("Director gateway bootstrap returned no browser token.");
  return body.browserToken;
}

async function callDirectorTool(token, tool, sessionId, input) {
  const body = await fetchJson(`${gatewayUrl}/api/tools/${tool}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-director-browser-token": token },
    body: JSON.stringify({ session_id: sessionId, omit_scene: true, input }),
  });
  if (body.success !== true) throw new Error(`${tool}.${input.op} failed: ${body.error ?? JSON.stringify(body)}`);
  return body;
}

async function waitFor(label, probe) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await probe();
    if (lastValue) return lastValue;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(lastValue)}`);
}

async function productionState(token) {
  const body = await callDirectorTool(token, "director_workbench", prepSessionId, {
    op: "production",
    command: { action: "observe" },
  });
  return record(body.result);
}

async function waitForBrowserScene(token, expectedSceneId) {
  return waitFor(`Director to activate scene ${expectedSceneId}`, async () => {
    const state = await productionState(token);
    return state?.current_browser_scene_id === expectedSceneId && state?.browser_matches_active_scene === true
      ? state
      : null;
  });
}

async function waitForDshSession(sessionId) {
  await waitFor(`DSH session ${sessionId}`, async () => {
    const list = await dshRpc("session.list", {});
    const row = list.items.find((item) => item.sessionId === sessionId);
    if (!row || row.running || row.blank) return null;
    const history = await dshRpc("session.history", { sessionId, maxMessages: 50 });
    return history.events.some(({ event }) => event.type === "turn/end") ? row : null;
  });
  let page = await dshRpc("session.history", { sessionId, maxMessages: 100 });
  const events = [...page.events];
  while (page.hasMore) {
    const beforeSeq = page.events[0]?.event?.seq;
    if (!Number.isInteger(beforeSeq)) throw new Error("DSH history page has no sequence boundary.");
    page = await dshRpc("session.history", { sessionId, beforeSeq, maxMessages: 100 });
    events.unshift(...page.events);
  }
  return { ...page, events, hasMore: false };
}

function parseJsonText(content) {
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    const candidate = record(block);
    if (candidate?.type !== "text" || typeof candidate.text !== "string") continue;
    try {
      return record(JSON.parse(candidate.text));
    } catch {
      // Non-JSON text blocks are ordinary tool presentation content.
    }
  }
  return null;
}

function toolCalls(history) {
  const calls = [];
  for (const entry of history.events ?? []) {
    const event = entry.event;
    if (event?.type !== "tool/call" && event?.type !== "tool/code-dispatch-start") continue;
    const data = record(event.data);
    if (!data || typeof data.name !== "string") continue;
    let args = data.arguments;
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        args = null;
      }
    }
    calls.push({
      name: data.name,
      args: record(args),
      callId:
        typeof data.callId === "string" ? data.callId : typeof data.subCallId === "string" ? data.subCallId : null,
    });
  }
  return calls;
}

function toolResultBody(history, call) {
  for (const entry of history.events ?? []) {
    const event = entry.event;
    const data = record(event?.data);
    if (!data) continue;
    if (event.type === "tool/code-dispatch" && data.subCallId === call.callId) {
      return parseJsonText(data.content);
    }
    if (event.type !== "tool/result") continue;
    const message = record(data.message);
    for (const block of Array.isArray(message?.content) ? message.content : []) {
      const result = record(block);
      if (result?.type === "tool-result" && result.toolCallId === call.callId) {
        return parseJsonText(result.content);
      }
    }
  }
  return null;
}

function eventToolFailure(event) {
  const data = record(event?.data);
  if (!data) return null;
  if (event.type === "tool/code-dispatch" && data.isError === true) return data;
  if (event.type !== "tool/result") return null;
  if (data.error) return data.error;
  const message = record(data.message);
  const failed = (Array.isArray(message?.content) ? message.content : []).find(
    (block) => record(block)?.type === "tool-result" && record(block)?.isError === true,
  );
  return failed ?? null;
}

function assertCleanTrajectory(history) {
  const failures = (history.events ?? []).flatMap(({ event }) => {
    const failure = eventToolFailure(event);
    return failure ? [failure] : [];
  });
  if (failures.length) throw new Error(`Agent trajectory contains failed tool calls: ${JSON.stringify(failures)}`);

  const turnEnd = [...(history.events ?? [])].reverse().find(({ event }) => event.type === "turn/end")?.event;
  const turnReason = record(record(turnEnd?.data)?.reason);
  if (turnReason?.kind !== "completed") {
    throw new Error(`Agent turn did not complete: ${JSON.stringify(turnReason)}`);
  }

  const calls = toolCalls(history);
  const workbenchCalls = calls.filter((call) => call.name === "director_workbench");
  const blenderCalls = calls.filter((call) => call.name === "blender_native");
  if (!workbenchCalls.some((call) => call.args?.op === "author")) {
    throw new Error("Agent never authored the Director scene.");
  }
  if (!blenderCalls.some((call) => call.args?.op === "apply")) {
    throw new Error("Agent never refined the scene through Blender.");
  }
  const delivery = workbenchCalls.find((call) => call.args?.op === "deliver");
  const passes = Array.isArray(delivery?.args?.render_passes) ? delivery.args.render_passes : [];
  if (!EXPECTED_PASSES.every((pass) => passes.includes(pass))) {
    throw new Error(`Agent delivery did not request ${EXPECTED_PASSES.join(", ")}.`);
  }
  if (calls.some((call) => call.name === "director_dcc")) {
    throw new Error("Agent used manual DCC interchange instead of the bound Blender kernel.");
  }
  const deliveryBody = toolResultBody(history, delivery);
  if (!deliveryBody) throw new Error("Agent delivery result is missing from the durable DSH trajectory.");
  return deliveryBody;
}

function assertProject(project, nativeScene) {
  for (const id of EXPECTED_OBJECT_IDS) {
    if (!project.objects?.some((object) => object.id === id)) throw new Error(`Director object ${id} is missing.`);
  }
  if (!project.cameras?.some((camera) => camera.id === EXPECTED_CAMERA_ID)) {
    throw new Error(`Director camera ${EXPECTED_CAMERA_ID} is missing.`);
  }
  const nativeTable = nativeScene.objects?.find((object) => object.directorId === "reference-table");
  const directorTable = project.objects?.find((object) => object.id === "reference-table");
  if (!nativeTable) throw new Error("Blender refinement is not linked to Director Stable ID reference-table.");
  if (!directorTable?.localBoundsM) throw new Error("Director did not adopt real Blender bounds for reference-table.");
  if (project.nativeScene?.projectId !== nativeScene.projectId) {
    throw new Error("Director and Blender are not bound to the same project identity.");
  }
  if (project.nativeScene?.revision !== nativeScene.revision) {
    throw new Error("Director and Blender revisions are not synchronized.");
  }
}

function assertDelivery(deliveryBody) {
  const manifest = deliveryBody.result?.delivery?.manifest;
  const passes = manifest?.renderPasses?.map((pass) => pass.id) ?? [];
  if (!EXPECTED_PASSES.every((pass) => passes.includes(pass))) {
    throw new Error(`Delivery manifest is missing required passes: ${EXPECTED_PASSES.join(", ")}.`);
  }
  if (!manifest.artifacts?.some((artifact) => artifact.path?.endsWith(".exr") && artifact.renderPass === "depth")) {
    throw new Error("Delivery manifest is missing float depth EXR.");
  }
}

const prompt = `在当前空的 Director 场景中完成一个端到端标杆镜头：搭建一个 6m × 5m 的现代公寓客厅体块，包含地面、背景墙和中央餐桌；使用稳定 ID reference-floor、reference-backdrop、reference-table。用 Blender 内核精修 reference-table（保持同一个 Director Stable ID，桌体贴地并加真实倒角），不要使用 director_dcc，也不要手动导入导出。然后在 Director 中创建并启用 reference-camera-main，做一个清晰的 16:9 三分之四构图。完成审计后，用 deliver 在第 0 帧输出 1280×720 的 clean、clay、mask、depth，并包含 depth EXR。所有操作必须留在同一个 DirectorProject、同一 revision 链中。`;

let token;
let originalSceneId;
let referenceCreated = false;

try {
  const dshHealth = await fetchJson(`${dshUrl}/director/health`);
  if (dshHealth.service !== "director-deepseek-harness") throw new Error("Director DSH plugin is not loaded.");
  const gatewayHealth = await fetchJson(`${gatewayUrl}/health`);
  if (!gatewayHealth.clients) throw new Error("No Director browser target is connected.");
  token = await gatewayToken();
  const blenderStatus = await callDirectorTool(token, "blender_native", prepSessionId, { op: "status" });
  if (blenderStatus.result?.available !== true) throw new Error("Blender is not available.");

  const before = await productionState(token);
  originalSceneId = before?.active_scene_id;
  if (typeof originalSceneId !== "string") throw new Error("Production has no active Director scene.");

  log(`Creating isolated reference scene ${sceneId} ...`);
  await callDirectorTool(token, "director_workbench", prepSessionId, {
    op: "production",
    command: { action: "create_scene", scene_id: sceneId, title: "Director Blender Reference", activate: true },
  });
  referenceCreated = true;
  await waitForBrowserScene(token, sceneId);

  const created = await dshRpc("session.create", { cwd: repoRoot });
  log(`Running natural-language DSH task in session ${created.sessionId} ...`);
  await dshRpc("session.prompt", {
    sessionId: created.sessionId,
    mode: "queue",
    content: [{ type: "text", text: prompt }],
    clientTimeZone: "Asia/Shanghai",
  });
  const history = await waitForDshSession(created.sessionId);
  const deliveryBody = assertCleanTrajectory(history);

  const directorSessionId = `dsh-${created.sessionId}`;
  const nativeBody = await callDirectorTool(token, "blender_native", directorSessionId, { op: "scene" });
  const snapshotBody = await callDirectorTool(token, "director_workbench", directorSessionId, {
    op: "snapshot",
    scope: "project",
  });
  assertProject(snapshotBody.result.project, nativeBody.result);
  assertDelivery(deliveryBody);

  log("PASS: natural language → Blender refinement → Director camera → clean/clay/mask/depth.");
} finally {
  if (token && referenceCreated && originalSceneId) {
    try {
      await callDirectorTool(token, "director_workbench", prepSessionId, {
        op: "production",
        command: { action: "activate_scene", scene_id: originalSceneId },
      });
      await waitForBrowserScene(token, originalSceneId);
      await callDirectorTool(token, "director_workbench", prepSessionId, {
        op: "production",
        command: { action: "delete_scene", scene_id: sceneId },
      });
      log(`Restored Director scene ${originalSceneId}; removed reference scene ${sceneId}.`);
    } catch (error) {
      log(`Reference cleanup needs attention: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
