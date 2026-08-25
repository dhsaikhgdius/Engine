#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [, , tool, rawInput = "{}"] = process.argv;
const gatewayUrl = process.env.STAGE_GATEWAY_URL ?? "http://127.0.0.1:8787";
const sessionId = process.env.STAGE_AGENT_SESSION?.trim() || "cli-default";
const preferredTools = ["director_workbench", "director_creative", "director_dcc", "stage_video"];
const legacyTools = ["stage_read", "stage_scene", "stage_object", "stage_camera", "stage_show"];
const validTools = new Set([...preferredTools, ...legacyTools]);
const helpFlags = new Set(["--help", "-h", "help"]);

function printHelp() {
  process.stdout.write(`Stage CLI — HTTP client for the Director gateway (default ${gatewayUrl}).

Coding agents: when the Director MCP server is connected, call MCP tools
director_workbench, director_creative, and director_dcc instead of this CLI.

Usage:
  npm run --silent stage -- <tool> '<json>'
  npm run --silent stage -- --help
  node tools/scripts/stage-cli.mjs <tool> '<json>'

Preferred tools:
  director_workbench   3D Stage, generation, jobs
  director_creative    Canvas, Video Editor, Gallery
  director_dcc         Blender / DCC handoff
  stage_video          image-to-video jobs

Legacy compact tools (HTTP compatibility; not advertised on MCP):
  stage_read  stage_scene  stage_object  stage_camera  stage_show

JSON must be an object with "op". The gateway must be running
(\`npm run dev\` or \`npm run dev:gateway\`). Writes also need an open Director tab.
Discover fields with describe (no tab required).
\`npm run stage --\` prints an npm banner that breaks JSON.parse; use --silent
or invoke this file with node.

Examples:
  npm run --silent stage -- director_workbench '{"op":"observe"}'
  npm run --silent stage -- director_workbench '{"op":"capabilities"}'
  npm run --silent stage -- director_workbench '{"op":"describe","target":"author.add_object"}'
  npm run --silent stage -- director_creative '{"op":"observe"}'
  npm run --silent stage -- director_dcc '{"op":"status"}'

Env: STAGE_GATEWAY_URL, STAGE_AGENT_SESSION, DIRECTOR_TARGET_TOKEN
`);
}

function printUsageError(unknown) {
  if (unknown) console.error(`Unknown tool: ${unknown}`);
  console.error(`Usage: npm run --silent stage -- <${[...preferredTools, ...legacyTools].join("|")}> '<json>'`);
  console.error(
    "Run `npm run --silent stage -- --help` for examples. Prefer director_workbench over legacy stage_* tools.",
  );
}

if (!tool || helpFlags.has(tool)) {
  if (helpFlags.has(tool)) {
    printHelp();
    process.exit(0);
  }
  printUsageError();
  process.exit(2);
}

if (!validTools.has(tool)) {
  printUsageError(tool);
  process.exit(2);
}

let input;
try {
  input = JSON.parse(rawInput);
} catch (error) {
  console.error(`Invalid JSON input: ${error.message}`);
  process.exit(2);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isExactTarget(value) {
  return (
    isRecord(value) &&
    typeof value.token === "string" &&
    value.token.length > 0 &&
    typeof value.client_id === "string" &&
    value.client_id.length > 0 &&
    typeof value.instance_id === "string" &&
    value.instance_id.length > 0 &&
    typeof value.scene_id === "string" &&
    value.scene_id.length > 0 &&
    typeof value.creative_scope_id === "string" &&
    value.creative_scope_id.length > 0 &&
    value.contract_version === 2
  );
}

function nestedString(value, key) {
  if (!isRecord(value)) return null;
  if (typeof value[key] === "string") return value[key];
  for (const childKey of ["execution", "preview", "result"]) {
    const child = value[childKey];
    if (isRecord(child) && typeof child[key] === "string") return child[key];
  }
  return null;
}

function recoveryFor(code, embeddedSuggestion) {
  if (embeddedSuggestion) return { code, suggested_next: embeddedSuggestion };
  const suggestions = {
    target_required:
      'Run the same tool with {"op":"observe"} first. This CLI will retain that exact browser target for the same STAGE_AGENT_SESSION.',
    target_unavailable:
      "Stop writes and discard the invalid binding (including DIRECTOR_TARGET_TOKEN when it supplied the lease). Reconnect the intended Director tab, then observe again; any cached lease has been cleared.",
    target_mismatch:
      "Stop writes. The exact target changed during preflight; observe the intended Director tab again and never fall back to another tab.",
    invalid_preflight_revision:
      "No mutation was sent. Observe the same target again and retry only after it returns a valid project_revision.",
    stale_project_revision:
      "Observe the same target again, reconcile current state, and submit only the remaining intent with the latest revision and a new idempotency key.",
    revision_conflict:
      "Observe the same target again, reconcile current state, and submit only the remaining intent with the latest revision and a new idempotency key.",
    stale_snapshot:
      "Observe the same creative workspace again and rebuild the request with its latest snapshot fingerprint.",
    conflict: "Observe the same creative workspace again and rebuild the request with its latest snapshot fingerprint.",
    idempotency_key_conflict: "Keep the prior receipt and use a new idempotency key for the changed intent.",
    idempotency_replay_stale:
      "Observe and reconcile current state; express only the remaining work as a new intent with a new idempotency key.",
    outcome_unknown:
      "Do not write again yet. Observe and diff the same target; retry only an absent effect with the byte-equivalent payload and original idempotency key.",
    command_timeout:
      "Keep the intended Director tab visible, refresh the observation guard when required, and retry the cancelled read or evidence request.",
    workbench_unavailable:
      "Open the intended Director workspace and retry. Durable observe/audit can use the last persisted project or live Blender kernel; mutations and capture still need a visible tab.",
    creative_workspace_unavailable:
      "Open the intended Canvas or Video workspace, wait for its gateway connection, and observe again.",
  };
  return code && suggestions[code] ? { code, suggested_next: suggestions[code] } : null;
}

const stateDirectory = process.env.DIRECTOR_CLI_STATE_DIR?.trim() || join(tmpdir(), "director-stage-cli-targets");
const stateKey = createHash("sha256").update(`${gatewayUrl}\0${sessionId}`).digest("hex").slice(0, 24);
const statePath = join(stateDirectory, `${stateKey}.json`);

async function readSessionState() {
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8"));
    if (
      isRecord(parsed) &&
      parsed.version === 1 &&
      parsed.gateway_url === gatewayUrl &&
      parsed.session_id === sessionId &&
      isExactTarget(parsed.target)
    ) {
      return {
        target: parsed.target,
        lastProjectRevision:
          typeof parsed.last_project_revision === "string" && parsed.last_project_revision.length > 0
            ? parsed.last_project_revision
            : null,
      };
    }
  } catch {
    // A missing, stale, or truncated local lease is equivalent to no binding.
  }
  return null;
}

async function writeSessionState(target, lastProjectRevision) {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify({
      version: 1,
      gateway_url: gatewayUrl,
      session_id: sessionId,
      target,
      ...(lastProjectRevision ? { last_project_revision: lastProjectRevision } : {}),
      updated_at: new Date().toISOString(),
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await rename(temporaryPath, statePath);
}

async function clearBoundTarget() {
  await rm(statePath, { force: true });
}

function captureReceipt(capture) {
  if (!isRecord(capture) || typeof capture.data !== "string") return null;
  return {
    mime_type: typeof capture.mimeType === "string" ? capture.mimeType : "application/octet-stream",
    byte_length: Buffer.from(capture.data, "base64").byteLength,
    image_returned: true,
  };
}

function requiresExactTarget(requestTool, requestInput) {
  if (!isRecord(requestInput) || typeof requestInput.op !== "string") return false;
  if (requestTool === "director_workbench") {
    return (
      !["capabilities", "describe", "catalog", "observe"].includes(requestInput.op) &&
      !(requestInput.op === "inspect" && requestInput.entity === "catalog_asset")
    );
  }
  if (requestTool === "director_creative") {
    return !["capabilities", "observe"].includes(requestInput.op);
  }
  return false;
}

function requiresObservedGuard(requestTool, requestInput) {
  if (!isRecord(requestInput) || typeof requestInput.op !== "string") return false;
  if (requestTool === "director_workbench") {
    return (
      new Set(["patch", "author", "correct", "replace_project", "undo", "capture", "shot_package", "deliver"]).has(
        requestInput.op,
      ) &&
      requestInput.expected_revision === undefined &&
      requestInput.unconditional !== true
    );
  }
  if (requestTool === "director_creative") {
    return (
      new Set(["execute", "execute_batch", "preview"]).has(requestInput.op) &&
      requestInput.expected_snapshot_fingerprint === undefined
    );
  }
  return false;
}

function applyObservedGuard(requestTool, requestInput, observation) {
  if (!isRecord(requestInput) || !isRecord(observation)) return { input: requestInput, guard: null };
  if (requestTool === "director_workbench") {
    const guardedOperations = new Set([
      "patch",
      "author",
      "correct",
      "replace_project",
      "undo",
      "capture",
      "shot_package",
      "deliver",
    ]);
    const revision = nestedString(observation.result, "project_revision");
    if (
      guardedOperations.has(requestInput.op) &&
      requestInput.expected_revision === undefined &&
      requestInput.unconditional !== true &&
      revision
    ) {
      return {
        input: { ...requestInput, expected_revision: revision },
        guard: { field: "expected_revision", value: revision, source: "preflight_observe" },
      };
    }
  }
  if (requestTool === "director_creative") {
    const guardedOperations = new Set(["execute", "execute_batch", "preview"]);
    const snapshot = isRecord(observation.result) ? observation.result.snapshot : null;
    const fingerprint = nestedString(snapshot, "snapshot_fingerprint");
    if (
      guardedOperations.has(requestInput.op) &&
      requestInput.expected_snapshot_fingerprint === undefined &&
      fingerprint
    ) {
      return {
        input: { ...requestInput, expected_snapshot_fingerprint: fingerprint },
        guard: {
          field: "expected_snapshot_fingerprint",
          value: fingerprint,
          source: "preflight_observe",
        },
      };
    }
  }
  return { input: requestInput, guard: null };
}

try {
  const configuredToken = process.env.DIRECTOR_GATEWAY_TOKEN?.trim();
  let gatewayToken = configuredToken && configuredToken.length >= 24 ? configuredToken : "";
  const bootstrapToken = async () =>
    fetch(`${gatewayUrl}/te-man/director/agent/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).then(async (response) => {
      const payload = await response.json();
      if (!response.ok || typeof payload.browserToken !== "string" || payload.browserToken.length < 24) {
        throw new Error("gateway bootstrap failed");
      }
      return payload.browserToken;
    });
  if (!gatewayToken) gatewayToken = await bootstrapToken();

  const explicitTargetToken = process.env.DIRECTOR_TARGET_TOKEN?.trim() || "";
  const cachedSession = explicitTargetToken ? null : await readSessionState();
  const cachedTarget = cachedSession?.target ?? null;
  let cachedRevision = cachedSession?.lastProjectRevision ?? null;
  let targetToken = explicitTargetToken || cachedTarget?.token || "";
  let targetSource = explicitTargetToken ? "environment" : cachedTarget ? "session_cache" : "none";
  let effectiveInput = input;
  let injectedGuard = null;
  let preflightObservation = null;

  // A cached revision from the previous response lets a guarded workbench write
  // skip the preflight observe round trip. A stale cache is detected by the
  // gateway and retried once below with a freshly observed revision.
  if (
    tool === "director_workbench" &&
    requiresObservedGuard(tool, effectiveInput) &&
    targetToken &&
    cachedRevision
  ) {
    effectiveInput = { ...effectiveInput, expected_revision: cachedRevision };
    injectedGuard = { field: "expected_revision", value: cachedRevision, source: "session_cache" };
  }

  const call = (requestInput, requestTargetToken) =>
    fetch(`${gatewayUrl}/api/tools/${tool}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-director-browser-token": gatewayToken,
        // Observability (M5): attribute this call to the CLI entry surface.
        "x-director-trace-source": "cli",
      },
      body: JSON.stringify({
        input: requestInput,
        session_id: sessionId,
        ...(requestTargetToken ? { target_token: requestTargetToken } : {}),
      }),
    });
  const callAuthenticated = async (requestInput, requestTargetToken) => {
    let response = await call(requestInput, requestTargetToken);
    if (response.status === 401) {
      gatewayToken = await bootstrapToken();
      response = await call(requestInput, requestTargetToken);
    }
    const payload = await response.json();
    return { response, payload };
  };

  let boundTarget = cachedTarget;
  if (requiresExactTarget(tool, effectiveInput) && (!targetToken || requiresObservedGuard(tool, effectiveInput))) {
    const preflightInput = tool === "director_workbench" ? { op: "observe", fields: ["counts"] } : { op: "observe" };
    const requestedTargetToken = targetToken;
    const preflight = await callAuthenticated(preflightInput, requestedTargetToken);
    if (!isRecord(preflight.payload) || typeof preflight.payload.success !== "boolean") {
      throw new Error(`gateway returned malformed preflight JSON (HTTP ${preflight.response.status})`);
    }
    preflightObservation = preflight.payload;
    const observedTarget = isExactTarget(preflight.payload.target) ? preflight.payload.target : null;
    if (!preflight.payload.success || !observedTarget) {
      const preflightCode =
        typeof preflight.payload.code === "string"
          ? preflight.payload.code
          : nestedString(preflight.payload.result, "code") || "target_acquisition_failed";
      const { scene: _scene, capture: _capture, ...durablePreflight } = preflight.payload;
      if (preflightCode === "target_unavailable") await clearBoundTarget();
      console.log(
        JSON.stringify(
          {
            ...durablePreflight,
            success: false,
            code: preflightCode,
            http_status: preflight.response.status,
            tool,
            session: {
              id: sessionId,
              target_binding: "none",
              target_cached: false,
              preflight_observe: true,
            },
            recovery: recoveryFor(
              preflightCode,
              nestedString(preflight.payload.result, "suggested_next") ||
                "Open the intended Director workspace, wait for its gateway connection, and retry the command.",
            ),
          },
          null,
          2,
        ),
      );
      process.exit(1);
    }
    if (requestedTargetToken && observedTarget.token !== requestedTargetToken) {
      throw new Error("gateway changed the exact Director target during preflight; observe again before writing");
    }
    targetToken = observedTarget.token;
    if (!requestedTargetToken) targetSource = "preflight_observe";
    boundTarget = observedTarget;
    cachedRevision = nestedString(preflight.payload.result, "project_revision") ?? cachedRevision;
    await writeSessionState(observedTarget, cachedRevision);
    const guarded = applyObservedGuard(tool, effectiveInput, preflight.payload);
    effectiveInput = guarded.input;
    injectedGuard = guarded.guard;
  }

  let { response, payload: result } = await callAuthenticated(effectiveInput, targetToken);
  if (!isRecord(result) || typeof result.success !== "boolean") {
    throw new Error(`gateway returned malformed tool JSON (HTTP ${response.status})`);
  }

  const staleRevisionCodes = new Set(["stale_project_revision", "revision_conflict"]);
  let code = typeof result.code === "string" ? result.code : nestedString(result.result, "code");

  // A guard injected from the session cache may be stale after another writer's
  // edit. One automatic re-observe and retry matches what a fresh invocation
  // would have done via preflight, without a manual round trip.
  if (!result.success && code && staleRevisionCodes.has(code) && injectedGuard?.source === "session_cache") {
    const refreshed = await callAuthenticated({ op: "observe", fields: ["counts"] }, targetToken);
    const refreshedRevision = isRecord(refreshed.payload)
      ? nestedString(refreshed.payload.result, "project_revision")
      : null;
    if (isRecord(refreshed.payload) && refreshed.payload.success === true && refreshedRevision) {
      effectiveInput = { ...effectiveInput, expected_revision: refreshedRevision };
      injectedGuard = { field: "expected_revision", value: refreshedRevision, source: "stale_retry_observe" };
      ({ response, payload: result } = await callAuthenticated(effectiveInput, targetToken));
      if (!isRecord(result) || typeof result.success !== "boolean") {
        throw new Error(`gateway returned malformed tool JSON (HTTP ${response.status})`);
      }
      code = typeof result.code === "string" ? result.code : nestedString(result.result, "code");
    }
  }

  const responseTarget = isExactTarget(result.target) ? result.target : null;
  const responseRevision = nestedString(result.result, "project_revision");
  const targetForState = responseTarget ?? (boundTarget && boundTarget.token === targetToken ? boundTarget : null);
  if (code === "target_unavailable") await clearBoundTarget();
  else if (targetForState) {
    const revisionForState =
      result.success && responseRevision
        ? responseRevision
        : code && staleRevisionCodes.has(code)
          ? null
          : cachedRevision;
    await writeSessionState(targetForState, revisionForState);
  }

  const embeddedSuggestion = nestedString(result.result, "suggested_next");
  const { scene: _scene, capture: rawCapture, ...durableResult } = result;
  const receipt = {
    ...durableResult,
    http_status: response.status,
    tool,
    session: {
      id: sessionId,
      target_binding: responseTarget ? "response" : targetSource,
      target_cached: Boolean(responseTarget || cachedTarget),
      preflight_observe: Boolean(preflightObservation),
      ...(injectedGuard ? { injected_guard: injectedGuard } : {}),
    },
    ...(rawCapture ? { capture: captureReceipt(rawCapture) } : {}),
    ...(!result.success ? { recovery: recoveryFor(code, embeddedSuggestion) } : {}),
  };
  console.log(JSON.stringify(receipt, null, 2));
  if (!result.success) process.exitCode = 1;
} catch (error) {
  console.error(
    `Director Stage gateway is unavailable at ${gatewayUrl}. Start it with "npm run dev". ${error.message}`,
  );
  process.exitCode = 1;
}
