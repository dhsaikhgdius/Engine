---
title: Agent Control
description: Connect an Agent to Director and control production state through validated, provider-neutral interfaces.
---

Director is agent-native: the same production state can be controlled through the UI, the MCP
tools, HTTP, the CLI, or a browser API — with the same guards and the same evidence rules on
every surface. Unfamiliar terms on this page are defined in the [Glossary](/concepts/glossary/).

## Connect in three steps

1. **Start Director** with `npm run dev` and keep a browser tab open on the target workspace. A
   writable Agent target exists only while a Director browser is connected to the gateway.
2. **Attach a client.** Point any MCP client at the repository's `.mcp.json`, or use the
   built-in workbench panel, or start from the CLI:

   ```bash
   npm run stage -- director_workbench '{"op":"capabilities"}'
   ```

3. **Observe before writing.** The first observation binds your session to an exact target and
   returns the `project_revision` that every mutation must carry as a guard:

   ```bash
   npm run stage -- director_workbench '{"op":"observe","fields":["scene","objects","cameras"]}'
   ```

## Choose a surface

| Tool                  | Owns                                    | Use it for                                                            |
| --------------------- | --------------------------------------- | --------------------------------------------------------------------- |
| `director_workbench`  | Full DirectorProject and Stage evidence | Scene, object, character, camera, timeline, coverage, audit, delivery |
| `director_creative`   | Canvas and Video workspace              | Nodes, edges, media clips, tracks, preview, undo/redo, interchange    |
| `blender_native`      | Native Blender modeling kernel          | Blockout shells, openings, modifiers, materials, rigs, native capture |
| `stage_video`         | Generation jobs                         | Prepare, submit/render, poll, cancel                                  |
| `director_dcc`        | DCC/engine handoff                      | Provider discovery, exchange packages, Blender/engine round trips     |
| `director_game`       | Experimental game slice                 | Plan, bind, and playtest a typed slice on the live Stage player       |
| `director_production` | Production evidence (MCP only)          | Immutable artifact versions, approvals, guarded promotion             |
| `director_film`       | Film pipeline (MCP only)                | Durable idea-to-film / script-to-film runs                            |

The legacy `stage_*` tools remain an HTTP-only compact compatibility surface for the white-box
scene protocol and existing Stage version 5 clients; they are no longer advertised over MCP.
New automation should prefer `director_workbench`.

## Supported provider harnesses

The built-in Agent workbench can connect to:

- **Codex** through `codex app-server`;
- **Claude Code** through its streaming JSON CLI and project MCP configuration.

The production protocol is not tied to these providers. Any MCP client can use the same tools.

## The verified authoring loop

```text
discover capabilities/catalog
  → observe exact target and concurrency guard
  → mutate one intent atomically
  → observe and inspect the effect
  → audit production quality
  → preview or deliver and inspect the pixels
```

Each step closes a specific failure mode:

- `observe` prevents invented IDs and stale assumptions.
- `author` groups one intent into one validated, undoable mutation; an idempotency key makes an
  exact network retry safe.
- `audit` tests references, grounding, overlap, timeline ranges, and camera-space framing.
- `correct` applies only the validated suggestions bound to the returned audit token.
- `deliver` proves the current revision with a helper-free clean frame, Shot IR, and a hashed
  multi-pass package.

For the 3D Stage, the concurrency guard is `project_revision` and `deliver` is the final
evidence boundary. If delivery is blocked, use `audit → correct(audit_token) → audit`, then
retry delivery. Use the shorter `observe → author → audit` loop only when the result has no
visual component.

Canvas and Video use a separate concurrency token because they are scene-scoped browser stores:

```text
capabilities → observe(target + snapshot_fingerprint) → execute_batch → observe → audit → preview
```

`preview` returns a fingerprint-bound, helper-free PNG for the complete Canvas board or an exact
Video timeline time without moving the playhead. See
[Canvas & Video Agents](/agents/creative-workspaces/) for aliases, atomic rollback, preview, and
idempotent retries.

## Guards, retries, and recovery

Observation binds the provider session to the exact browser tab, project instance, scene, and
creative scope. Director returns `target_unavailable` instead of redirecting a write when any
part of that target changes; observe again rather than reusing a lease from another tab.

Reuse an `idempotency_key` only for a byte-equivalent retry. If a mutation returns
`outcome_unknown`, stop and observe the exact target before deciding what happened: if the
effect exists, do not retry; if it is absent and the original preconditions still hold, retry
the exact payload with the same key. A revised intent or a changed guard requires a new key.

The complete code-by-code recovery contract — `stale_project_revision`,
`idempotency_key_conflict`, `idempotency_replay_stale`, `outcome_unknown`, `command_timeout`,
and `target_unavailable` — lives in the
[Agent Workbench recovery table](/agents/workbench/#revision-conflicts-and-uncertain-outcomes).
[Troubleshooting](/troubleshooting/) maps the same codes to symptoms.

## Locked human work

`locked: true` marks content owned by the user. Agents must not update or delete locked objects
unless the request explicitly authorizes an unlock or force override.
