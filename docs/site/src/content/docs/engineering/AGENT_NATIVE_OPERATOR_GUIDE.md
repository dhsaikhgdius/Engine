---
title: Director Agent-native operator guide
---

This is the provider-neutral runbook for Codex, Claude Code, and any
other MCP client. Director exposes the same production state and validation to
every provider; an Agent should not need DOM coordinates, private browser state,
or provider-specific prompt tricks to finish a shot.

The live tool schemas returned by `capabilities` are authoritative. This guide
defines the safe operating sequence and the evidence required before reporting
completion.

## The one closed loop

Use this sequence for every workspace:

```text
discover
  → observe exact target and concurrency guard
  → mutate one intent atomically
  → observe the effect from live state
  → audit production quality
  → preview or deliver and inspect the pixels
```

The workspace only changes the concrete operations:

| Step          | 3D Stage                                                                                              | Canvas / Video Editor                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Discover      | `director_workbench {"op":"capabilities"}`; use `catalog` before choosing character assets or motions | `director_creative {"op":"capabilities"}`                                                                |
| Observe       | Selective `observe`; retain `project_revision`; `inspect` exact entities                              | `observe`; retain `snapshot_fingerprint` and exact node, edge, media, track, and clip IDs                |
| Mutate        | One semantic `author` batch with `expected_revision`, `idempotency_key`, and `quality_gate:"strict"`  | One atomic `execute_batch`, or one `execute`, with `expected_snapshot_fingerprint` and `idempotency_key` |
| Verify state  | Fresh `observe`, then `diff` or `inspect` the changed IDs                                             | Fresh `observe`; compare exact entities, timing, and the new fingerprint                                 |
| Audit         | `audit` for targeted diagnosis; `deliver` runs the final audit again                                  | `audit` with `quality_profile:"production"` and the narrowest useful scope                               |
| Verify pixels | `deliver` with the latest revision; inspect its helper-free clean image                               | `preview` with the latest fingerprint; inspect the complete Canvas board or representative Video frames  |

A successful mutation is only an acknowledgement. It is not evidence that the
requested composition, timing, scale, contact, or readability is correct.

## Start and discover

1. Run `npm run dev` so the UI and local Agent gateway are both available.
2. Keep the intended Director tab open and visible.
3. Reload the coding-Agent session after adding or rebuilding the MCP plugin. A trusted Codex checkout reads `.codex/config.toml`; Claude Code reads `.mcp.json`; Cursor reads `.cursor/mcp.json`.
4. Call `capabilities` rather than hard-coding an operation list or limit.
5. Call `catalog` before selecting a packaged character or motion. Reuse the
   returned asset object or clip ID exactly; do not invent local paths.

Codex and Claude Code use the same `director_workbench` and
`director_creative` contracts. Provider adapters may differ, but they do not get
a different scene model or a weaker completion standard.

## Exact-target binding

Every gateway result identifies one exact browser target:

```json
{
  "token": "opaque target token",
  "client_id": "browser client",
  "instance_id": "Director project instance",
  "scene_id": "active scene",
  "creative_scope_id": "scene-scoped Canvas/Video workspace",
  "contract_version": 2
}
```

The bundled MCP server retains the opaque token automatically. The built-in
durable Agent session is pinned to the complete descriptor. Raw HTTP callers
must send the returned token as top-level `target_token` on later requests.
The repository CLI does the same binding automatically: a targeted Workbench or
Creative call with no existing lease first performs a read-only `observe`, pins the
complete returned target, injects the observed revision/fingerprint guard when that
operation accepts one, and immediately executes the requested command. A stable
`STAGE_AGENT_SESSION` retains the lease across invocations; `DIRECTOR_TARGET_TOKEN`
is an explicit override and takes priority.

For project authoring, Production mutations, generated-3D promotion, Storyboard
capture/export, Creative edits, Canvas pipeline start, collaboration comments,
and durable job submit/retry, the public HTTP boundary is fail-safe for a naive
client. It binds one exact browser target, observes and injects a missing
revision/fingerprint where required, and assigns a unique key when
`idempotency_key` is missing. The response exposes the applied policy as
structured `agent_boundary` data in HTTP, MCP, and CLI receipts. An exact retry
after `outcome_unknown` reuses the first injected guard and returned key.
Explicit guards and keys are preserved byte-for-byte;
`unconditional:true` remains an explicit revision opt-out but still receives a
retry-safe idempotency key. Supplying explicit values is still recommended when
an Agent manages a multi-step intent itself.

`blender_native apply` has no browser target lease. A naive caller may omit
`expectedSceneEpoch`, `expectedRevision`, and `intentId`; the Gateway snapshots the
native scene and binds all three before submission. If dispatch returns
`outcome_unknown`, resend the complete `result.retry_ticket.input` unchanged. It is
the exact native request, including the original intent ID, needed to reconcile or
replay the Blender transaction safely.

Treat all six fields as one lease. Never reuse only the client ID, switch the
token to another tab, or allow a recently visible workspace to receive a write.
If the tab reloads, disconnects, changes project, changes scene, or changes
creative scope, discard the lease and observe again. Director intentionally
fails closed with `target_unavailable` instead of guessing.

## Multi-scene activation

Start production-level scene work with
`{"op":"production","command":{"action":"observe"}}` and retain both the returned
`production_revision` and exact browser scene. Create, duplicate, rename, activate, and delete use a
stable exact-retry `idempotency_key`. New scene references and their validated `DirectorProject`
documents are one atomic server mutation; each scene document also has a separate revision.

An operation that changes the loaded scene returns an activation receipt with status `pending` and
an `activation_id`. This means the durable mutation succeeded, not that the destination browser is
ready. The browser then loads the server scene document, rejects superseded switches, updates its
Stage projection, and acknowledges readiness after rendering. Discard the old target lease and call
production `observe` again. Continue authoring only when `current_browser_scene_id` matches
`active_scene_id` and `scene_document_revision` is present.

## Workbench: 3D Stage, cameras, characters, and shots

Request only the slices needed for the intent:

```json
{
  "op": "observe",
  "fields": ["cameras", "characters", "timeline", "production"]
}
```

Inspect every existing entity whose exact values matter. Then send the complete
intent as one semantic batch:

```json
{
  "op": "author",
  "expected_revision": "<project_revision from the latest observe>",
  "idempotency_key": "shot-017-medium-framing-v1",
  "quality_gate": "strict",
  "camera_id": "cam-main",
  "subject_id": "hero",
  "actions": [
    {
      "action": "update_camera",
      "camera_id": "cam-main",
      "patch": {
        "target_object_id": "hero",
        "focal_length_mm": 50,
        "aspect_ratio": "16:9"
      }
    }
  ]
}
```

After the mutation:

1. Observe again and retain the returned `project_revision`.
2. Use `diff` or `inspect` to prove the intended camera/entity changed and
   unrelated state did not.
3. Run `audit` if issues need diagnosis. Apply deterministic issues only through
   `correct` with the current `audit_token`, revision, and a new correction key.
4. Finish with `deliver` using the latest revision. Use `cinematic` for normal
   shot acceptance or `video-gen` for a generation control frame.
5. Inspect the attached clean image. Confirm silhouette, floor contact,
   occlusion, scale, subject framing, and camera intent before claiming delivery.

`deliver` is revision-bound and returns the final audit, Shot IR, artifact
hashes, `shot_revision_fingerprint`, and `package_fingerprint`. Machine
acceptance requires `ready:true`, `status:"delivered"`,
`capture_verified:true`, and `audit.ready:true`. A receipt is not visually
complete until the Agent has actually consumed the image. `scene_hint.validation`
proves only structural Stage projection, and standalone `audit.ready` remains a
diagnostic state that must proceed to delivery.

### Placement semantics for naive Agents

Before authoring an elevated object, classify its intent in this order:

1. It touches the scene floor: use `placement_mode:"grounded"`. A primitive's
   `position` is its floor pivot (bottom centre), so grounded objects use
   `scene.groundHeight`, not half their height. A 3 m wall on the ground is
   `position.y = 0` with `scale.y = 3`; `position.y = 1.5` floats it. A ceiling
   whose underside should sit at 3 m uses `position.y = 3`, not
   `3 + thickness/2`. A window whose sill is 0.8 m up a 2.2 m pane uses
   `position.y = 0.8`, not `0.8 + 1.1`.
2. It rests on a table, shelf, platform, or another anchored object: use
   `placement_mode:"supported"` and make the geometry physically contact that
   support chain. `parent_id` alone does not prove support.
3. It is mounted to the side/surface of a wall, vehicle, rig, or other anchor:
   use `placement_mode:"attached"` and set `parent_id` to an existing object that
   already resolves in the placement chain. Inspect the final pixels for gaps
   and penetration.
4. It hangs from a ceiling beam or another spatially overhead anchor: use
   `placement_mode:"suspended"` with that resolved `parent_id`. The parent must
   actually be above the child's footprint.
5. It is deliberately support-free because airborne placement is the requested
   art direction: use `placement_mode:"floating"`.

Use `auto` only for existing/intent-unknown content that audit should infer from
bounds. `parent_id` is an attachment/composition anchor, not a look target and
not a shortcut for physical support. A wall lamp is `attached`, a chandelier is
`suspended`, a cup on a table is `supported`, and only a magic orb/VFX element
is `floating`. Never mark a misplaced grounded object or character as floating
merely to suppress a quality issue.

If audit reports `unsupported_object` for an elevated `auto`/intent-unknown
object, it deliberately provides no automatic lowering fix. Inspect the object,
nearby geometry, and intended mounting first, then author the truthful mode,
parent, and transform. If the same audit also contains unambiguous fixes, call
`correct` with a narrow `audit_issues` list.

The quality gate protects the author batch, and standalone `audit` diagnoses
the live project. Neither is the Stage completion boundary. Only a fresh
revision-bound `deliver` with `ready:true`, `status:"delivered"`,
`capture_verified:true`, `audit.ready:true`, visually inspected helper-free
pixels, and Shot IR/package fingerprints is acceptable delivery evidence.

## Canvas and Video Editor

Observe first, then express one user intent as one atomic batch:

```json
{
  "op": "execute_batch",
  "idempotency_key": "canvas-shot-chain-v1",
  "expected_snapshot_fingerprint": "<snapshot_fingerprint from observe>",
  "steps": [
    {
      "step_id": "intent",
      "save_as": "intent",
      "operation": {
        "op": "canvas.node.add",
        "kind": "note",
        "title": "镜头意图",
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

Creation steps may expose generated IDs with `save_as`; later ID fields may use
`@alias`. If any step fails, the entire batch and its selection state roll back
as one undo unit.

Observe again, run the production audit, then request real visual evidence:

```json
{
  "op": "preview",
  "workspace": "canvas",
  "expected_snapshot_fingerprint": "<fingerprint from the post-mutation observe>"
}
```

For Video Editor, use `workspace:"video"` and optionally set `time_sec` for an
exact representative frame. Preview is helper-free, returns PNG pixels, checks
the fingerprint both before and after rendering, and does not move the timeline
playhead. Inspect more than one time when timing, transitions, or coverage change.
Audit remains structural; `ready:true` never substitutes for this visual pass.

## Idempotency rules

An idempotency key identifies one exact mutation payload in one observed scope.

- Generate one stable 8–160 character key for a user intent.
- Reuse it only when retrying the byte-equivalent request after a lost response.
- Do not change a revision/fingerprint, action, step, order, target, or parameter
  while keeping the key.
- Use a new key for a corrected request, a re-planned intent, or a mutation built
  against a newer observation.
- Never use a fresh key merely to force a duplicate after an uncertain timeout.

## Structured recovery

Recovery is part of the protocol. Do not hide an uncertain outcome behind a
generic success message.

| Result code or state                                                                           | Meaning                                                                      | Required recovery                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Revision conflict (`stale_project_revision`; some clients summarize it as `revision_conflict`) | The Workbench project changed after observation                              | Observe the same target, reconcile the user's intent with current state, and build a new request with the new revision and a new key. Never use `unconditional:true` just to bypass the conflict.                                                                                       |
| Creative `conflict` / preview `stale_snapshot`                                                 | The Canvas/Video fingerprint changed, or the preview changed while rendering | Observe again, use current IDs, rebuild against the new fingerprint, and use a new key when the mutation payload changes.                                                                                                                                                               |
| `idempotency_key_conflict`                                                                     | The key was already paired with different input                              | Preserve the old receipt; use a new key for the genuinely new intent.                                                                                                                                                                                                                   |
| `idempotency_replay_stale`                                                                     | The original mutation succeeded, but later work changed the scope            | Observe and reconcile. Do not replay the old mutation; express any remaining work as a new intent with a new key.                                                                                                                                                                       |
| `outcome_unknown`                                                                              | A mutation timed out before acknowledgement and may already have committed   | Stop. Observe the exact bound target, then inspect/diff. If the effect exists, do not retry. If it is absent and the original preconditions still hold, retry the byte-equivalent payload with the same key. Otherwise re-plan with a new key.                                          |
| `command_timeout`                                                                              | A read, preview, or capture timed out and was cancelled                      | Keep the target visible, observe if a guard is required, then retry the read/evidence request. Do not claim evidence was produced.                                                                                                                                                      |
| `capture_unavailable`                                                                          | The bound Stage viewport is unmounted, mounting, or was replaced during HMR  | Keep or switch the exact browser target to 3D Stage, wait for capture readiness, then observe that target again before retrying. This is not evidence that the prior capture completed.                                                                                                 |
| `target_unavailable`                                                                           | The exact tab/project/scene/scope lease is gone                              | Reconnect or reopen the intended tab and observe again. Never redirect the pending write to another target.                                                                                                                                                                             |
| `not_found`                                                                                    | An observed ID or alias no longer resolves                                   | Observe/inspect and rebuild with current IDs.                                                                                                                                                                                                                                           |
| `locked`                                                                                       | Human-owned content rejects the mutation                                     | Ask the user to unlock it or explicitly authorize the narrow override.                                                                                                                                                                                                                  |
| `capacity`                                                                                     | A Canvas/Video safety limit was reached                                      | Deliberately remove or reorganize content, or use another scene scope. Never evict older work implicitly.                                                                                                                                                                               |
| `ready:false`                                                                                  | Audit or delivery found blocking quality issues                              | Inspect/classify any `auto` or intent-unknown elevated object before correction; never blindly lower it. Apply only unambiguous fixes through `correct` (use narrow `audit_issues` when needed), handle judgment issues semantically, re-observe, re-audit, and retry delivery/preview. |
| Preview `render_failed` / `aborted`                                                            | The browser could not decode/render media, or the request was cancelled      | Check media availability, CORS/decoder errors, and canvas visibility; retry only if visual evidence is still required.                                                                                                                                                                  |

After any recovery mutation, restart the loop at observation. Do not treat a
trace, cached plan, previous preview, or gateway-side project file as fresher
than the live bound browser state.

## Completion checklist

Report completion only when all relevant items are true:

- A fresh observation contains the requested state and exact changed IDs.
- The target descriptor is still the one observed for this intent.
- The mutation receipt has no unknown outcome and no unrelated changes.
- Production audit is ready, or every remaining warning is explicitly reported.
- Stage work has a delivered clean frame plus Shot IR and package fingerprints.
- Canvas/Video work has a fingerprint-bound clean preview from the final state.
- The Agent inspected the pixels rather than trusting `success:true` or
  `ready:true`.
- Locked and unrelated user-authored content remains unchanged.

If the current Agent runtime cannot consume the returned image, state that visual
verification is unavailable and stop short of claiming render-ready completion.
