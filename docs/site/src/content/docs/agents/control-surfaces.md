---
title: HTTP, CLI & Browser
description: Use Director without an MCP host.
---

All control surfaces converge on the same gateway execution and validation layer.

## CLI

The CLI forwards one tool name and one JSON object (`{"op":"..."}`) to the local gateway.
`npm run stage -- --help` prints the tool list. Prefer the same names MCP advertises:

```bash
npm run stage -- director_workbench '{"op":"observe"}'
npm run stage -- director_workbench '{"op":"describe","target":"author.add_object"}'
npm run stage -- director_creative '{"op":"observe"}'
npm run stage -- director_dcc '{"op":"status"}'
npm run stage -- director_game '{"op":"capabilities"}'
```

`stage_read`, `stage_scene`, `stage_object`, `stage_camera`, and `stage_show` are a legacy
compact `StageScene` surface. They remain HTTP-compatible but are not advertised on MCP.
`kind:"cube"` is compact input. Public `director_workbench` author calls instance catalog
meshes or reject Stage `geometry_type` primitives.

Configuration:

```bash
export STAGE_GATEWAY_URL=http://127.0.0.1:8787
export STAGE_AGENT_SESSION=cli-default
export DIRECTOR_TARGET_TOKEN=<optional observed target.token>
```

For `director_workbench` and `director_creative`, one targeted CLI command is enough: when no
target is bound, the CLI performs a read-only `observe` in the same process, locks the returned
exact browser target, injects the observed revision or fingerprint when the operation accepts
that guard, and then executes the requested operation. The lease is retained per
`STAGE_AGENT_SESSION` across later invocations. `DIRECTOR_TARGET_TOKEN` explicitly pins an
already-observed target and always takes priority over the local session cache. CLI output
preserves `code`, `feedback`, `suggested_next`/`recovery`, and target metadata while omitting
the redundant full scene and binary image payload.

## HTTP

Tool routes use:

```text
POST /api/tools/{tool-name}
```

Raw HTTP clients first bootstrap the loopback gateway token. The bundled CLI, MCP server, and
browser client do this automatically:

```bash
DIRECTOR_TOKEN="$(curl -fsS -X POST http://127.0.0.1:8787/te-man/director/agent/bootstrap \
  -H 'content-type: application/json' \
  -d '{}' | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).browserToken')"
```

Example:

```bash
curl -sS http://127.0.0.1:8787/api/tools/stage_object \
  -H 'content-type: application/json' \
  -H "x-director-browser-token: $DIRECTOR_TOKEN" \
  -d '{
    "session_id": "my-agent",
    "input": {
      "op": "create",
      "ref": "hero",
      "kind": "humanoid"
    }
  }'
```

Use explicit `session_id` values when ref aliases must survive across requests.

Workbench and Creative HTTP calls are bound to an exact browser target. First observe without a
token and copy `target.token` from the response:

```bash
curl -sS http://127.0.0.1:8787/api/tools/director_creative \
  -H 'content-type: application/json' \
  -H "x-director-browser-token: $DIRECTOR_TOKEN" \
  -d '{"input":{"op":"observe"}}'
```

Send the token at the top level on later calls:

```bash
curl -sS http://127.0.0.1:8787/api/tools/director_creative \
  -H 'content-type: application/json' \
  -H "x-director-browser-token: $DIRECTOR_TOKEN" \
  -d '{
    "target_token": "<target.token>",
    "input": {
      "op": "audit",
      "scope": "all",
      "quality_profile": "production"
    }
  }'
```

HTTP returns `428 target_required` when the token is missing and `409 target_unavailable` when the
bound tab, scene, or scope no longer exists. Re-observe; do not retry against a different tab.
The browser-authentication token and the exact-target token serve different purposes: the header
authorizes access to the local gateway, while `target_token` pins an operation to one observed
Director workspace. Keep both. A gateway restart rotates the default browser token, so bootstrap
again after `401`.

## Browser API

The editor exposes `window.stageAgent` for same-page integrations:

```js
await window.stageAgent.scene({ op: "validate" });
await window.stageAgent.object({
  op: "create",
  kind: "sphere",
  position: [1, 0, 0],
});
await window.stageAgent.camera({ op: "frame", shot: "medium" });
await window.stageAgent.show({ op: "play" });
```

Pipeline calls are available on the same object:

```js
await window.stageAgent.video({
  op: "prepare",
  prompt: "Preserve the exact blocking and camera composition",
});

const creative = await window.stageAgent.creative({ op: "observe" });
console.log(creative.result);
```

## Cross-app receipt handoff

External apps (compositors, review tools, other agent-native products) should consume Director
output through receipts, never through screenshots or unverified file paths. Two receipt families
matter; [ADR 0003](/engineering/adr/0003-import-export-receipts/) defines the plan/receipt model
behind both:

- **Stage delivery** — `director_workbench` `{"op":"deliver"}` returns `status: "delivered"`,
  `capture_verified: true`, the self-bound `project_revision`, and a `delivery` object with
  `package_fingerprint` (SHA-256 of the shot-package manifest), `shot_revision_fingerprint`, the
  full `manifest`, and `files[]` where each file carries `path`, `mimeType`, `byteLength`, and
  `sha256`.
- **Interchange export** — `director_creative` interchange `plan-export` → `export` returns a
  `director-interchange-export-v1` receipt: `receipt_id`, the exact `plan_id` it committed,
  `format`, `file_name`, `mime_type`, `byte_length`, the `guard` (`kind` plus `fingerprint`) the
  export was validated against, the encoded `payload`, and `warnings` listing degraded semantics.
  The OBJ/STL ZIP report sidecar additionally records SHA-256 per geometry payload.

Consume them like this:

1. **Store identity with the artifact.** Keep `plan_id`, `receipt_id`, and the guard fingerprint
   (or `project_revision` / `shot_revision_fingerprint`) next to the bytes you copied out.
2. **Verify before use.** Recompute the SHA-256 and byte length of the received bytes and compare
   them with the receipt's `sha256` / `byteLength` (delivery files) or `byte_length` (export
   payload). Reject on mismatch instead of ingesting "best effort".
3. **Detect staleness by fingerprint.** Before re-exporting, diffing, or pushing changes back,
   observe the same workspace; if the current fingerprint no longer matches the receipt, the
   source moved on — request a new plan rather than mixing artifacts from different revisions.
4. **No receipt, no artifact.** A text claim of success is not a delivery; the receipt's
   `warnings` are the honest record of what was degraded.

## Choose a surface

| Need                                  | Recommended surface          |
| ------------------------------------- | ---------------------------- |
| Full Agent-native production workflow | MCP `director_workbench`     |
| Canvas and Video Editor automation    | MCP/HTTP `director_creative` |
| Shell script or CI smoke test         | CLI                          |
| Service integration                   | HTTP                         |
| In-page automation or host embedding  | Browser API                  |
| Human staging and visual review       | Director UI                  |

Do not use coordinate clicking when a semantic tool exists for the same operation.
