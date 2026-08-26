---
title: MCP
description: Connect any MCP-capable coding agent to Director's structured production tools.
---

The repository owns the MCP integration natively. Project configurations launch
`backend/gateway/mcp-server.ts` through Node's `tsx/esm` loader; the Skill instructions live in
`.claude/skills/`. The `integrations/plugins/director-workbench/` folder is
only the optional portable packaging of the same runtime.

## Start the gateway

```bash
npm run dev
```

Reload the coding-agent session after the project MCP configuration is present.

## Tools

| Tool                 | Use                                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| `director_workbench` | Complete editor observation, authoring, audit, capture, Shot IR, multi-pass Shot Package, and UI control |
| `director_creative`  | Canvas/Video observation, atomic editing, audit, and fingerprint-bound clean PNG preview                 |
| `director_dcc`       | DCC/engine handoff: provider discovery, Blender `.blend` round trips, Unreal/Unity/Godot headless send + guarded returns, and engine scene import |
| `stage_read`         | Compact observation, inspection, critique, full state, and camera capture                                |
| `stage_scene`        | Reset, scene settings, validation, and scene-level mutations                                             |
| `stage_object`       | Create, transform, place, parent, animate, and remove white-box objects                                  |
| `stage_camera`       | Create, frame, aim, move, and configure cameras                                                          |
| `stage_show`         | Timeline, tracks, actions, playback, and recording controls                                              |
| `stage_video`        | Prepare, submit, and inspect white-box-to-video jobs                                                     |

`stage_*` is the compact `StageScene` protocol. New work should use `director_workbench`.
In particular, `kind:"cube"` is valid only on `stage_object`. Public `director_workbench`
`author` batches instance catalog or project meshes (`asset_id`); unique architecture uses
`blender_native`, and unique generated meshes use `generated_3d`. Stage `geometry_type`
primitives are rejected on that agent wire. See the
[Quick Start](/getting-started/quick-start/) and
[verified-shot tutorial](/tutorials/verified-shot/).

## Portable plugin

The distributable plugin lives at:

```text
integrations/plugins/director-workbench/
```

Rebuild and validate it with:

```bash
npm run build:mcp-plugin
npm run validate:agent-plugin
```

The `director-workbench` Skill teaches evidence-backed Workbench delivery and the
separate Creative loop rather than treating a successful write as visual proof. The repository
root `AGENTS.md` is the canonical instruction entry point; project discovery is already
configured for the main coding agents:

| Agent           | MCP configuration       | Instructions / Skill entry               |
| --------------- | ----------------------- | ---------------------------------------- |
| Codex           | `.codex/config.toml`    | `AGENTS.md`                              |
| Claude Code     | `.mcp.json`             | `CLAUDE.md` + `.claude/skills/`          |
| Cursor          | `.cursor/mcp.json`      | `.cursor/rules/director-workbench.mdc`   |

The canonical Skill source is `.claude/skills/director-workbench`. In-repo adapters exist only
for Cursor, Codex, and Claude Code; `npm run sync:skills` generates those files from
`tools/scripts/agent-integrations.mjs`. `npm run repo:check` verifies they launch the same MCP
server. Other MCP clients can copy `.mcp.json`. Start the live application with `npm run dev`,
reload the coding-agent session so it discovers the MCP, then ask it to use `director-workbench`.

## Session identity

The stdio server creates a ref session automatically. Set a stable value when the host
restarts its MCP process between calls:

```bash
export DIRECTOR_MCP_SESSION_ID=my-director-session
```

Ref aliases are scoped to that session. Idle ref sessions expire and the gateway caps stored
sessions to prevent unbounded growth.

## Atomic batches

Stage tools accept a single operation or an ordered `ops` batch. Create operations can declare
`ref`; later operations can use the alias in the same session.

```json
{
  "ops": [
    { "op": "create", "ref": "hero", "kind": "cube", "position": [0, 0, 0] },
    { "op": "transform", "object_id": "hero", "scale": [2, 0.5, 2] },
    { "op": "place", "object_id": "hero", "on": "ground" }
  ]
}
```

This `kind:"cube"` batch is compact `stage_*` input. Do not paste it into
`director_workbench` `author`.

A failed batch leaves the original scene unchanged.

## Response envelope

MCP tools return machine-readable `structuredContent` with fields such as:

- `ok`
- `result`
- `error`
- `changed`
- `scene_hint`
- `context`
- `available_refs`
- `ui_events`
- `target`

Text content mirrors the envelope for clients that do not consume structured content.

`target` identifies the exact browser client, project instance, scene, creative scope, and contract
version used for the response. Treat the full descriptor as one lease. The bundled MCP server
retains its opaque token after observation and reuses it for later Workbench or Creative
operations. If that target disappears, the call fails closed and the client must observe again; it
never redirects the write to another visible tab.

## Low-token observation

Prefer:

```json
{ "op": "observe" }
```

Then inspect one entity:

```json
{ "op": "inspect", "entity": "object", "id": "hero-id" }
```

Reserve full scene or project snapshots for operations that genuinely require them.

For a portable exact-frame handoff after the final audit and capture, use:

```json
{
  "op": "shot_ir",
  "take_id": "take-main",
  "coverage_shot_id": "coverage-close",
  "frame": 48
}
```

This operation is read-only and returns the same evaluated contract through MCP, HTTP, and
the browser workbench transport, including its stable revision fingerprint. A simple
camera-only request may use `camera_id` instead. Mutating workbench calls should carry the latest
returned `project_revision` as `expected_revision` and a stable `idempotency_key` so stale writes
and duplicate retries are rejected. `capture`, `shot_package`, and `deliver` require that revision
because their evidence must match the exact scene version.

Use `capture` with an explicit `camera_id` and non-negative integer `frame`; optional `render_pass`,
`width`, and `height` select one PNG. Use `shot_package` with `render_passes` for a hashed
clean/depth/normal/object-ID bundle. Agent-wire raster requests
are bounded to 2,073,600 pixels so a pathological image cannot overflow the response channel.
For final acceptance, prefer `deliver`; it combines audit, helper-free clean capture, Shot IR, and
the hashed package into one machine-readable receipt.

## Canvas and Video Editor

Use `director_creative {"op":"capabilities"}` and then `{"op":"observe"}`. Mutations require the
returned `snapshot_fingerprint` and an `idempotency_key`. Prefer `execute_batch` for one user intent;
created IDs can be saved with `save_as` and referenced later as `@alias`. Any failed step restores
the complete pre-batch workspace and selection.

After mutation, observe again and run:

```json
{ "op": "audit", "scope": "all", "quality_profile": "production" }
```

The audit is structural and explicitly requires a visual Canvas/Video preview check. See
[Canvas & Video Agents](/agents/creative-workspaces/) for the complete loop and recovery codes.
Request that visual evidence against the post-mutation fingerprint:

```json
{
  "op": "preview",
  "workspace": "video",
  "time_sec": 2.5,
  "expected_snapshot_fingerprint": "<latest snapshot_fingerprint>"
}
```

The response attaches a helper-free PNG and does not move the timeline playhead. A concurrent
change returns `stale_snapshot`; observe again rather than accepting or relabeling stale pixels.

## Timeout recovery

A mutating command that times out reports `outcome_unknown`, not
`target_unavailable`. Observe the exact target and inspect the effect before retrying. If the
mutation is absent and its original preconditions still hold, resend only the byte-equivalent
request with the same `idempotency_key`. A changed payload, revision, or fingerprint is a new
intent and requires a new key. Read/evidence timeouts report `command_timeout` and are cancelled;
retry them only after restoring a visible target and refreshing any required guard.
