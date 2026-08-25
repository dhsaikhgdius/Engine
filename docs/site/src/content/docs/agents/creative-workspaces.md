---
title: Canvas, Video & Gallery Agents
description: Control Canvas, its production DAG, Video Editor, and Gallery with target binding, atomic batches, idempotency, and production audits.
---

`director_creative` is the Agent-native control plane for Canvas, its multimodal production DAG, Video Editor,
and Gallery. It operates on the
live scene-scoped browser workspace, not a gateway-side imitation of it. The contract is shared by
MCP, HTTP, the browser bridge, and the built-in Codex and Claude Code planner.

## Closed loop

```text
capabilities
  → observe (retain target + snapshot_fingerprint + exact IDs)
  → execute_batch or execute
  → observe again
  → audit(scope="all", quality_profile="production")
  → preview(latest snapshot_fingerprint)
  → inspect Canvas layout / representative Video frames
```

`audit` proves structural readiness. It intentionally returns
`visual_verification_required:true`; it never claims that composition, readability, or editorial
rhythm is visually correct without a real preview check.

## Discover the contract

```json
{ "op": "capabilities" }
```

The response lists request operations, content operations, limits, batch exclusions, concurrency
guards, and quality profiles. Then read the live workspace:

```json
{ "op": "observe" }
```

Retain the returned `snapshot_fingerprint` and use only observed node, edge, media, track, clip, and Gallery
IDs. Durable source-media bytes stay browser-owned; observation returns metadata while the
dedicated `preview` operation returns clean PNG evidence.

## One intent as one atomic batch

```json
{
  "op": "execute_batch",
  "idempotency_key": "canvas-shot-chain-v1",
  "expected_snapshot_fingerprint": "<sha256 fingerprint from observe>",
  "steps": [
    {
      "step_id": "intent",
      "save_as": "intent",
      "operation": {
        "op": "canvas.node.add",
        "kind": "note",
        "title": "镜头意图",
        "body": "人物保持在右侧三分线",
        "x": 80,
        "y": 80
      }
    },
    {
      "step_id": "shot",
      "save_as": "shot",
      "operation": {
        "op": "canvas.node.add",
        "kind": "shot",
        "title": "Shot 01",
        "body": "50mm 中景，缓慢推进",
        "x": 440,
        "y": 80
      }
    },
    {
      "step_id": "connect",
      "operation": {
        "op": "canvas.edge.add",
        "source_node_id": "@intent",
        "target_node_id": "@shot"
      }
    }
  ]
}
```

Creation steps may expose their generated ID with `save_as`; later ID fields use `@alias`. A batch
contains 1–32 durable mutations and becomes one undo unit. `edit.seek`, `workspace.switch`, undo, and
redo are deliberately excluded because they are transient UI commands rather than durable content.

If a later step fails, the response identifies `failed_step_id`, reports `rolled_back:true`, and
returns the restored snapshot. Retry the complete corrected intent against a fresh observation.

## Single edit

Use `execute` for exactly one operation:

```json
{
  "op": "execute",
  "idempotency_key": "move-shot-card-v2",
  "expected_snapshot_fingerprint": "<sha256 fingerprint from observe>",
  "operation": {
    "op": "canvas.node.update",
    "node_id": "board-shot-01",
    "patch": { "x": 620, "y": 160 }
  }
}
```

Both mutation envelopes require a fingerprint and an idempotency key. Reusing the same key for the
byte-equivalent retry returns the original successful result with `replayed:true` and does not
duplicate the mutation. Reusing it for changed input is a conflict.

## Operation families

| Family          | Operations                                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Canvas nodes    | `canvas.node.add`, `canvas.node.update`, `canvas.node.remove`                                                               |
| Canvas edges    | `canvas.edge.add`, `canvas.edge.remove`                                                                                     |
| Canvas DAG      | `canvas.dag.layout`, `canvas.production.configure`; top-level `pipeline` start/status/cancel                                |
| Video clips     | `edit.clip.add`, `edit.clip.update`, `edit.clip.move`, `edit.clip.split`, `edit.clip.remove`                                |
| Video tracks    | `edit.track.add`, `edit.track.update`, `edit.track.remove`                                                                  |
| Gallery media   | `gallery.media.update`, `gallery.media.move`, `gallery.media.rename_many`, `gallery.media.trash`, `gallery.media.restore`   |
| Gallery folders | `gallery.folder.add`, `gallery.folder.rename`, `gallery.folder.move`, `gallery.folder.remove`, `gallery.preferences.update` |
| UI and history  | `edit.seek`, `workspace.switch`, `workspace.undo`, `workspace.redo`                                                         |

Read `capabilities` rather than hard-coding limits. The current safety bounds are 240 board nodes,
2,000 edges, 12 tracks, 400 clips per track, 5,000 Gallery records, 200 Gallery folders, and 32 batch steps.

Gallery is part of the same fingerprint and undo history. Folder creation supports `save_as`, so an
atomic batch can create a folder and move media to `@folder`. Permanent deletion is not an Agent
operation because it removes durable browser-owned bytes; use reversible Trash/restore operations.

## Run the Canvas production DAG

Canvas edges are executable dependencies, not only visual connectors. First use `execute` or
`execute_batch` to configure each generative image, video, or audio node with an observed workflow
and node pool. Do not invent either ID:

```json
{
  "op": "execute",
  "idempotency_key": "configure-board-shot-01-v1",
  "expected_snapshot_fingerprint": "<latest snapshot_fingerprint>",
  "operation": {
    "op": "canvas.production.configure",
    "node_id": "board-shot-01",
    "patch": {
      "workflow_id": "comfy-workflow-image-main",
      "node_ids": ["gpu-a", "gpu-b"],
      "negative_prompt": "blur, duplicate subject",
      "seed": 17,
      "parameters": { "12.cfg": 6.5 }
    }
  }
}
```

Observe again, retain the new fingerprint, then start the whole graph by leaving
`target_node_ids` empty, or start selected targets plus all of their ancestors:

```json
{
  "op": "pipeline",
  "request": {
    "action": "start",
    "target_node_ids": ["board-shot-01"],
    "force_node_ids": [],
    "max_parallel": 4,
    "await_completion": false,
    "expected_snapshot_fingerprint": "<post-configuration snapshot_fingerprint>",
    "idempotency_key": "run-board-shot-01-v1"
  }
}
```

`force_node_ids` regenerates only explicit nodes in the selected execution scope; every other
unchanged node may use its verified cache. Layout changes do not invalidate production cache.
Direct-upstream persistent images are bound as workflow reference inputs. Note and frame nodes pass
through without provider jobs. Independent nodes in the same topological level run with bounded
parallelism, while a failed branch blocks only its descendants.

For a background run, retain the returned exact `run.id` and poll or cancel it:

```json
{ "op": "pipeline", "request": { "action": "status", "run_id": "canvas-run-01" } }
```

```json
{ "op": "pipeline", "request": { "action": "cancel", "run_id": "canvas-run-01" } }
```

The run receipt persists per-node status, request fingerprint, job, artifact, media, timestamps, and
errors. Director verifies output byte length and SHA-256 before Gallery promotion and keeps bounded
node output plus graph-run history. A `stale` node result means its input changed while it ran and
must be deliberately started again from a fresh observation. A process refresh can reconcile durable
generation jobs, but it cannot pretend to own a missing in-browser cancellation controller.

## Audit

```json
{ "op": "audit", "scope": "all", "quality_profile": "production" }
```

Scopes are `canvas`, `video`, or `all`. Profiles are `draft` and `production`; production treats
important warnings such as disconnected nodes, heavy overlap, unresolved shots, empty/no-picture
timelines, overlapping clips, and unready media as blocking.

## Preview

Audit is structural. Request pixels from the same post-mutation fingerprint before claiming visual
completion:

```json
{
  "op": "preview",
  "workspace": "canvas",
  "expected_snapshot_fingerprint": "<fingerprint from the post-mutation observe>"
}
```

`workspace` accepts `auto`, `canvas`, or `video`. A Canvas preview fits the complete board and
renders nodes, edges, and available media thumbnails without selection chrome. A Video preview
uses the same clip timing and compositing rules as the timeline renderer:

```json
{
  "op": "preview",
  "workspace": "video",
  "time_sec": 2.5,
  "expected_snapshot_fingerprint": "<fingerprint from the post-mutation observe>"
}
```

Preview returns a helper-free `image/png`, metadata for the rendered board or active clips, and the
fingerprint that owns the evidence. It does not move the playhead. Director checks the fingerprint
before and after rendering, so a concurrent edit returns `stale_snapshot` instead of mislabeled
pixels. Inspect several representative times when timing, transitions, or coverage changed.

## Exact browser target

The first `observe` response includes a gateway `target` descriptor and opaque token for the exact
browser client, project instance, scene, creative scope, and contract version. Treat the complete
descriptor as one lease. MCP retains its token automatically, and the built-in durable Agent
session pins the full descriptor. HTTP callers must copy the token into top-level `target_token` on
later mutation, audit, and preview calls.

Director never falls back to another recently visible tab. A missing token returns
`target_required`; a closed or changed target returns `target_unavailable`. Re-observe and rebuild
the request against the new target and snapshot.

## Recovery table

| Code                        | Meaning                                                                    | Correct recovery                                                                                                                                                                                      |
| --------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `target_required`           | No observed browser target was supplied                                    | Observe the intended workspace, retain its exact target, and rebuild the request.                                                                                                                     |
| `target_unavailable`        | The bound tab/project/scene/scope changed or disconnected                  | Reconnect and observe again; never redirect the old write.                                                                                                                                            |
| `conflict`                  | The fingerprint changed, or the key was reused incorrectly                 | Inspect `result.code`. Observe/rebuild for a changed snapshot; use a new key only for a changed intent.                                                                                               |
| `stale_snapshot`            | Preview started from or finished against a different fingerprint           | Observe again and request preview from the current fingerprint. Do not accept the stale image.                                                                                                        |
| `idempotency_key_conflict`  | One key was paired with different input                                    | Keep the old receipt and use a new key for the new intent.                                                                                                                                            |
| `idempotency_replay_stale`  | The original mutation succeeded, then later work changed the scope         | Observe and reconcile; express remaining work as a new intent with a new key.                                                                                                                         |
| `outcome_unknown`           | A mutation timed out before acknowledgement and may already have committed | Stop and observe the exact target. If the effect exists, do not retry. If absent and preconditions still hold, retry the byte-equivalent payload with the same key; otherwise re-plan with a new key. |
| `command_timeout`           | Observe/audit/preview timed out and was cancelled                          | Keep the workspace visible, observe if a new guard is needed, and retry the evidence request.                                                                                                         |
| `stale_guard` on start      | The graph changed before a pipeline run was accepted                       | Observe the exact board, reconcile configuration and IDs, then start a new intent with the current fingerprint and a new key.                                                                         |
| `conflict` on active start  | This browser already owns an active Canvas pipeline                        | Request status or cancel the exact active run; never start a competing controller in the same workspace.                                                                                              |
| `not_found`                 | An ID or alias does not exist                                              | Inspect observed IDs and correct the request.                                                                                                                                                         |
| `locked`                    | A track or entity rejects mutation                                         | Ask the user to unlock it or explicitly authorize a narrow override.                                                                                                                                  |
| `capacity`                  | A safety limit was reached                                                 | Remove content deliberately or use another scene scope; never evict older work implicitly.                                                                                                            |
| `render_failed` / `aborted` | Preview media could not render or the request was cancelled                | Check media availability, browser decoding/CORS support, and canvas visibility; retry only if evidence is still required.                                                                             |

Do not report success from the command status alone. Finish only after a fresh observation proves the
effect, production audit is ready, and visual work has been inspected in the actual workspace.
