---
title: HTTP API
description: Bootstrap, authenticate, target, run, and recover Director through the local control-plane API.
---

The TypeScript gateway is a loopback control plane for the browser editor, Agent harnesses, MCP, CLI,
and Python workers. Its default base URL is:

```text
http://127.0.0.1:8787
```

Start the complete development stack with `npm run dev`, or only the gateway with
`npm run gateway`. The examples below use `jq` to carry structured target data between requests.

## Bootstrap and authentication

`GET /health` and `POST /te-man/director/agent/bootstrap` are the only routes that do not require a
gateway token. All `/api/*` routes, including `GET /api/preview`, and Director `/te-man/*` routes do.

```bash
BASE='http://127.0.0.1:8787'
BOOTSTRAP="$(curl -fsS -X POST "$BASE/te-man/director/agent/bootstrap" \
  -H 'Content-Type: application/json' \
  -d '{}')"
TOKEN="$(printf '%s' "$BOOTSTRAP" | jq -r '.browserToken')"

curl -fsS "$BASE/api/control-plane/capabilities" \
  -H "X-Director-Browser-Token: $TOKEN" | jq
```

Send the process token in `X-Director-Browser-Token`. The gateway also accepts `browser_token` in the
query string for compatibility, but the header avoids leaking credentials into URLs and logs. A
browser Origin must be in the loopback allowlist or `DIRECTOR_ALLOWED_ORIGINS`; native clients may
omit `Origin`.

By default the token is random for each gateway process and can be bootstrapped by local browser,
CLI, and MCP clients. Set `DIRECTOR_GATEWAY_TOKEN` to a value of at least 24 characters when several
processes need one stable shared token. The gateway refuses a non-loopback bind; use an authenticated
reverse proxy rather than exposing the gateway directly.

The process token authenticates the client to the gateway. It is separate from the opaque workspace
`target_token` returned by an observation.

## Discovery

| Method | Path                              | Result                                           |
| ------ | --------------------------------- | ------------------------------------------------ |
| `GET`  | `/health`                         | Unauthenticated process health and browser count |
| `GET`  | `/api/control-plane/capabilities` | Redacted Agent and video configuration           |
| `GET`  | `/api/agent/providers`            | Local/API session-provider availability          |
| `GET`  | `/api/agent/profiles`             | Public Profile metadata and model capabilities   |
| `GET`  | `/api/video/providers`            | Live video-provider capability report            |
| `GET`  | `/api/dcc/status`                 | Blender/DCC bridge status                        |
| `GET`  | `/api/stage`                      | Legacy StageScene projection                     |
| `GET`  | `/api/preview`                    | Latest captured preview; authenticated read      |

```bash
curl -fsS "$BASE/api/agent/profiles" \
  -H "X-Director-Browser-Token: $TOKEN" | jq '.profiles[]'
```

Discovery responses never contain model API keys, worker credentials, or raw credential environment
variable names.

Capture results may include a process-epoch `preview_token` URL. It is a read-only capability for that
preview route, allowing browsers and vision-capable Agents to render the image without receiving the
master gateway token. It expires when the gateway restarts. Operators may also read the route with
`X-Director-Browser-Token`.

## Acquire an exact browser target

Keep the intended Director tab open and observe it before any target-bound operation:

```bash
curl -fsS -X POST "$BASE/api/tools/director_workbench" \
  -H "X-Director-Browser-Token: $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"op":"observe","fields":["counts","cameras","production"]}' \
  > /tmp/director-observe.json

TARGET="$(jq -c '.target' /tmp/director-observe.json)"
TARGET_TOKEN="$(jq -r '.target.token' /tmp/director-observe.json)"
REVISION="$(jq -r '.result.project_revision' /tmp/director-observe.json)"
```

The target is a contract-v2 object containing `token`, `client_id`, `instance_id`, `scene_id`, and
`creative_scope_id`. Session messages and production runs carry the complete object. Direct tool
calls carry `target_token`; the gateway resolves it back to the same complete target and validates the
response. It never redirects an exact request to another tab.

`director_workbench` permits `capabilities`, `catalog`, and `observe` without a target. Inspecting a
catalog asset is also target-free. Other Workbench operations require `target_token`. For
`director_creative`, only `capabilities` and `observe` are target-free.

## Call a structured tool

The public tool paths are:

```text
/api/tools/stage_read
/api/tools/stage_scene
/api/tools/stage_object
/api/tools/stage_camera
/api/tools/stage_show
/api/tools/director_workbench
/api/tools/director_creative
/api/tools/stage_video
```

The body may contain the operation directly. `session_id` and `target_token` are envelope fields; all
other fields are parsed by that tool's strict runtime schema.

This example performs one guarded, atomic Workbench mutation:

```bash
curl -fsS -X POST "$BASE/api/tools/director_workbench" \
  -H "X-Director-Browser-Token: $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n \
    --arg target "$TARGET_TOKEN" \
    --arg revision "$REVISION" \
    '{
      session_id:"http-guide",
      target_token:$target,
      op:"author",
      expected_revision:$revision,
      idempotency_key:"http-guide-background-v1",
      quality_gate:"strict",
      actions:[{action:"set_scene",patch:{backgroundColor:"#222222"}}]
    }')" | jq
```

Always retain `project_revision` from the latest observation and send it as `expected_revision` on
mutations and evidence capture. Use one stable `idempotency_key` only for a byte-equivalent uncertain
retry. The HTTP boundary can supply missing mutation guards through a same-target preflight for naive
clients. When the key is omitted it creates a unique key for this intent and returns it in
`agent_boundary`; reuse that returned key only for the original request's uncertain retry. Explicit
values make intent and recovery unambiguous.

## Agent sessions

Agent sessions live in DeepSeek Harness (`vendor/deepseek-harness`). Director no longer hosts
`/api/agent/sessions` or `/api/agent/runs`. Start the Gateway, then run `npm run dsh` to prepare the
Director overlay and launch DSH Web. Stage / Canvas / Video / Blender tools POST to `/api/tools/:name`. `GET /api/agent/profiles`
still lists reconstruction and film-planning profiles.

## Import a Blender scene

Raw `.blend` import is a three-step upload → preview → apply protocol. It is separate from the
Director-owned `export_blend` / `import_return_package` round trip.

Upload the file bytes directly; do not JSON-encode or multipart-wrap them:

```bash
UPLOAD="$(curl -fsS -X POST \
  "$BASE/api/dcc/blender-scene/uploads?filename=$(printf '%s' 'set.blend' | jq -sRr @uri)" \
  -H "X-Director-Browser-Token: $TOKEN" \
  -H 'Content-Type: application/x-blender' \
  --data-binary @set.blend)"

PACKAGE_DIR="$(printf '%s' "$UPLOAD" | jq -r '.result.packagePath')"
PLAN_ID="$(printf '%s' "$UPLOAD" | jq -r '.result.plan.planId')"
REVISION="$(printf '%s' "$UPLOAD" | jq -r '.result.plan.targetRevision')"
```

`application/octet-stream` is also accepted. The filename query parameter must end in `.blend`; the
maximum upload is 512 MiB. A successful upload runs Blender headlessly and returns the validated
`director-blend-scene-v1` manifest plus a default plan selecting the scene bundle and all supported
perspective cameras.

v1 inspects only the active Blender scene and samples its current frame. The GLB may carry embedded
animation clips, but Director does not map or play them; imported perspective cameras are static at
that frame. Manifest timebase/range values are audit metadata and do not rewrite the Director
timeline. This API is batch upload/preview/apply, not live Blender synchronization.

To change the selection, preview a new server-persisted plan:

```bash
PREVIEW="$(curl -sS -X POST "$BASE/api/tools/director_dcc" \
  -H "X-Director-Browser-Token: $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg package "$PACKAGE_DIR" '{input:{
    op:"preview_blend_scene_import",
    package_dir:$package,
    selection:{includeScene:true,cameraSourceIds:[]}
  }}')")"

PLAN_ID="$(printf '%s' "$PREVIEW" | jq -r '.result.plan.planId')"
REVISION="$(printf '%s' "$PREVIEW" | jq -r '.result.plan.targetRevision')"
```

Preview never mutates the project. Selection/ID conflicts intentionally return HTTP `409` with a
usable `result.plan`, `ready:false`, warnings, and conflicts. Resolve them and preview again.

Apply only the exact server-stored ready plan:

```bash
curl -fsS -X POST "$BASE/api/tools/director_dcc" \
  -H "X-Director-Browser-Token: $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg plan "$PLAN_ID" --arg revision "$REVISION" '{input:{
    op:"apply_blend_scene_import",
    plan_id:$plan,
    expected_revision:$revision,
    idempotency_key:("blender-scene-import-" + ($plan | gsub("[^A-Za-z0-9._-]";"-")))
  }}')" | jq
```

Apply revalidates the package/hash receipts and current revision, rebuilds the plan, then performs one
atomic authoring mutation. Reuse the idempotency key only for an uncertain retry of the same intent.
On success, `result.copiedAssets[]` reports each asset ID, SHA-256, and immutable URL. Scene GLBs are
read with `GET`/`HEAD /dcc-import/<hash-prefix>/<asset-id>.glb`; traversal, symlink escape, non-GLB
paths, and files above 512 MiB are rejected.

Raw `.blend` files are trusted local input. Blender is launched with automatic script/driver
execution disabled, but this is not an OS or container sandbox for Blender's native parser. Private
job paths, limits, and timeouts do not make untrusted files safe. Do not import untrusted files
outside a container or VM. See [Interchange & DCC Handoff](/pipelines/interchange/) for the
preservation and degradation boundary.

## Engine handoff (Unreal / Unity / Godot)

`director_dcc` also runs headless engine round trips through the Director-authored connectors in
`integrations/{unreal,unity,godot}`. Check readiness first; `nativeReady` requires the connector
files, a version-probed executable, and the connector installed in the configured engine project:

```bash
curl -fsS -X POST "$BASE/api/tools/director_dcc" \
  -H "X-Director-Browser-Token: $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"input":{"op":"status","provider":"godot"}}' | jq
```

Send the current project into the engine. The Gateway exports an exchange package into a private
job directory, invokes the fixed connector entry point (never a request-supplied script), and
returns the schema-validated host report:

```bash
curl -sS -X POST "$BASE/api/tools/director_dcc" \
  -H "X-Director-Browser-Token: $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"input":{"op":"send_to_engine","provider":"godot","formats":["glb"]}}' | jq
```

When the connector is not ready, the route responds `409 engine_not_ready` with structured
`diagnostics` (`provider`, `mode`, `ready`, `warnings`, `recovery`) instead of a bare failure.
Follow the recovery steps (set `DIRECTOR_GODOT_BIN` / `DIRECTOR_GODOT_PROJECT`, install the addon)
or fall back to `export_exchange_package`.

Bring engine edits back with the same preview-then-apply protocol as Blender returns. Engine return
packages carry canonical Director-space transforms, so pass the producing provider explicitly:

```bash
PREVIEW="$(curl -sS -X POST "$BASE/api/tools/director_dcc" \
  -H "X-Director-Browser-Token: $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"input":{"op":"receive_from_engine","provider":"godot","package_dir":"JOB_ID/return-package"}}')"

curl -fsS -X POST "$BASE/api/tools/director_dcc" \
  -H "X-Director-Browser-Token: $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "$(printf '%s' "$PREVIEW" | jq '{input:{
    op:"apply_import_plan",
    provider:"godot",
    plan:.result.plan,
    expected_revision:.result.plan.targetRevision,
    idempotency_key:("godot-return-" + .result.plan.packageId)
  }}')" | jq
```

`receive_from_engine` accepts the same optional `skip_director_ids` list as
`import_return_package`. Apply is revision-guarded and idempotent; conflicts return `409` with a
usable read-only plan.

## Analyze a reference image

`POST /api/reconstruction/reference-scene/analyze` accepts the versioned
`referenceSceneAnalysisRequestSchema`: a current project revision, append/replace intent,
`auto`/`vision`/`local` mode, optional hosted Profile ID, bounded object count, normalized image
base64, SHA-256, MIME type, filename, and local image metrics. It returns one strict draft plan and
does not mutate the Stage. The browser must apply that plan against the same project revision.

The route rejects hash or MIME mismatch before a provider call. Forced vision mode reports
`profile_unavailable`, `vision_profile_required`, or `vision_failed`; auto mode can return a plan
whose analysis status is `degraded` and mode is `local`. See
[Reference Image Reconstruction](/editor/reference-reconstruction/) for the complete trust boundary.

## Other HTTP domains

| Domain            | Routes                                                                               |
| ----------------- | ------------------------------------------------------------------------------------ |
| Assistant planner | `POST /api/assistant/plan`, `POST /api/assistant/apply`                              |
| Production jobs   | `POST /api/canvas-jobs`, `GET /api/canvas-jobs/{id}`, `GET .../{id}/artifact`        |
| Production state  | `/te-man/director/productions/{id}` and nested `/scenes`; `/scenes/{id}/project`     |
| DCC               | `GET /api/dcc/status` plus the versioned DCC job operations documented by the bridge |
| Reconstruction    | `POST /api/reconstruction/reference-scene/analyze`                                   |
| Observability     | `GET /api/agent/traces`, `GET /api/agent/traces/summary`, `GET /api/agent/usage`, `GET /api/agent/progress` |
| Legacy Stage      | `GET /api/stage`, `PUT /api/stage`                                                   |

Observability routes return redacted execution receipts, model-usage aggregates, and one unified
progress shape for production jobs, multi-agent runs, and film runs. Tool calls may self-identify
their entry surface with the `x-director-trace-source: ui|mcp|http|cli` header; unknown or missing
values are recorded as `http`. Trace receipts never contain prompts, tool payloads, or credentials.

Prefer structured tools over raw `PUT /api/stage`: Workbench operations participate in revision,
idempotency, exact-target, quality, asset, audit, and evidence contracts.

## Guards and recovery

| HTTP/code                       | Recovery                                                                                                          |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `401 gateway_unauthorized`      | Bootstrap again and retry once with the new process token.                                                        |
| `403 origin_denied`             | Use a configured loopback origin or add the exact trusted origin; do not disable origin checks.                   |
| `428 target_required`           | Observe the intended workspace and attach its `target_token`.                                                     |
| `409 target_unavailable`        | Reconnect that exact tab/scope and observe again; never redirect the write.                                       |
| `409 target_mismatch`           | Discard the response and acquire a new target lease.                                                              |
| `409 stale_project_revision`    | Observe, reconcile, and create a new intent with the latest revision and a new idempotency key.                   |
| `409 stale_production_revision` | Observe production again, reconcile the manifest, and submit a new intent with a new key.                         |
| `409 idempotency_key_conflict`  | Preserve the old receipt and use a new key for different input.                                                   |
| `409 idempotency_replay_stale`  | The old mutation succeeded and the project advanced; observe and express only remaining work as a new intent.     |
| `409 outcome_unknown`           | Observe/diff first. If the effect is absent, retry only with the injected revision and key from `agent_boundary`. |
| `504 command_timeout`           | Do not claim success. Keep the target visible, observe if necessary, and retry the read/evidence operation.       |
| `profile_unavailable`           | Select an available, provider-compatible Profile and verify credentials.                                          |
| `profile_capability_mismatch`   | Select a tool-capable Profile; a visual Critic also requires vision.                                              |

Do not use `unconditional:true` merely to bypass a conflict. A successful HTTP status also does not
prove visual quality: inspect the helper-free clean frame and the audit/delivery receipt.
