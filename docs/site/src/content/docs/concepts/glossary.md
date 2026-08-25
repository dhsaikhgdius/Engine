---
title: Glossary
description: One-line definitions for every term the Director documentation uses repeatedly.
---

Director's documentation uses a small, precise vocabulary. This page defines each term once;
every other page links here instead of re-explaining. If a page uses a term you do not
recognize, look it up here first.

## Product and services

- **WorldEngine** — the repository-root production platform. Director is its browser product.
- **Director** — the browser-based production desk: 3D staging, cameras, characters, animation,
  storyboard, Canvas, Video Editor, and Gallery, served at `http://127.0.0.1:5175`.
- **Gateway** — the TypeScript control plane at `http://127.0.0.1:8787`. It owns Agent sessions,
  HTTP/MCP/CLI access, durable jobs, media, and collaboration. See
  [Control Plane](/architecture/control-plane/).
- **Workspace** — one of the four top-level surfaces: **Canvas** (shot intent and media lineage),
  **3D Stage** (blocking, cameras, animation), **Video Editor** (picture/audio tracks), and
  **Agent** (durable coding-agent sessions). Select one with `/?workspace=stage` and similar
  URLs. Project media still lives in Gallery inside those production workspaces.
- **Blender** — the integrated native modeling backend: a local headless Blender 4.2+ process
  running `worldengine_studio`, started with `npm run blender`. The bound Blender scene is
  authoritative for native geometry while Director keeps production semantics.
- **White-box** — an untextured, metrically correct blocking scene built from primitives and
  mannequins. It fixes layout, scale, lens, and camera motion before any generative rendering, so
  composition problems are caught while they are still cheap.

## Project and data

- **Floor pivot** — primitive `position` is the bottom centre, not the geometric centre.
  A 3 m wall on the ground uses `position.y = 0` and `scale.y = 3`. Writing mid-height
  (`y = 1.5`) floats the wall; a ceiling at `3 + thickness/2` sits above the room.
- **DirectorProject** — the complete version-1 editor document: scene settings, assets, objects,
  characters, cameras, animation, storyboard, and production coverage. See
  [Data Models](/architecture/data-models/).
- **StageScene** — the compact version-5 projection used by the portable `stage_*` tools and older
  clients. It is a compatibility view of the same project, not a second document. Compact
  primitives use `kind:"cube"`; the full editor still stores `kind:"prop"` plus
  `geometry_type:"box"`. Public `director_workbench` author calls reject those primitives and
  instance catalog, Blender, or generated meshes instead.
- **Creative workspace** — the scene-scoped Canvas/Video model: board nodes and edges, edit
  tracks, and edit settings. Media bytes live in the media library and are referenced by ID.
- **Take** — a reusable performance: entity animation tracks evaluated independently of any
  camera.
- **Coverage shot** — a camera setup (optics, framing, frame range) that references a take.
  Several coverage shots can film the same take.
- **Revision** (`project_revision`) — the fingerprint of the current project state. Every
  observation returns it, and every guarded mutation passes it back as `expected_revision`.
- **Snapshot fingerprint** — the Canvas/Video equivalent of a revision, passed as
  `expected_snapshot_fingerprint` on creative mutations.

Three other “fingerprint” names appear next to these. They are not interchangeable:

| Name | Field | Scope |
| ---- | ----- | ----- |
| Project revision | `project_revision` / `expected_revision` | The whole `DirectorProject` |
| Snapshot fingerprint | `snapshot_fingerprint` / `expected_snapshot_fingerprint` | One Canvas/Video creative workspace |
| Shot IR revision fingerprint | `revisionFingerprint` | One camera/frame evaluation; it records the project revision that produced that Shot IR |
| Shot Package fingerprint | package fingerprint | One hashed multi-pass frame bundle |

## Control surfaces

- **Control surface** — any typed interface to the same production state: the MCP tools, the
  Gateway HTTP API, the Stage CLI, or the browser API. See
  [HTTP, CLI & Browser](/agents/control-surfaces/).
- **`director_workbench`** — the primary Agent tool for the 3D Stage: observe, author, audit,
  correct, capture, Shot IR, shot packages, and delivery. See
  [Agent Workbench](/agents/workbench/).
- **`director_creative`** — the Agent tool for Canvas and Video Editor: observe, execute batches,
  audit, and fingerprint-bound previews. See
  [Canvas & Video Agents](/agents/creative-workspaces/).
- **`stage_*`** — the compact compatibility tools, including `stage_video` for generation jobs.
  Prefer `director_workbench` for new integrations.
- **`director_dcc`** — the DCC handoff tool: capability discovery and Blender export/status. See
  [Interchange & DCC Handoff](/pipelines/interchange/).
- **Stage CLI** — the gateway command line: `npm run stage -- <tool> '<json>'`. Prefer `director_workbench`. `npm run stage -- --help` lists tools; `stage_read` and other compact `stage_*` names are HTTP-compatible only.

## The Agent loop

- **Agent-native** — designed so an Agent works through discoverable, guarded, verifiable
  contracts instead of clicking screen coordinates. See
  [Agent-native Production](/concepts/agent-native-production/).
- **`capabilities`** — the discovery operation that returns the vocabulary a surface actually
  supports. It prevents invented operations.
- **`catalog`** — the discovery operation for real asset, character, and motion IDs. It prevents
  invented asset references.
- **`observe`** — the read operation that returns selected slices of current state plus the
  current revision and target. Observation is the only honest source for IDs and revisions.
- **`inspect`** — the read operation for one exact entity when a summary is not enough.
- **Exact target** (target lease) — the tuple that binds a session to one browser tab, project
  instance, scene, and creative scope. Director never redirects a write to a different target.
- **Guard** — the concurrency precondition on a mutation: `expected_revision` for the Stage,
  `expected_snapshot_fingerprint` for Canvas/Video. A mismatch rejects the write instead of
  overwriting newer work.
- **`author` / atomic intent** — one user intent expressed as one validated batch of semantic
  actions. Either the whole batch commits and creates one undo unit, or nothing changes.
- **`compose_blocking`** — compile a multi-character layout and a fitted camera from semantic
  roles, not guessed world coordinates.
- **`place_relative`** — place an existing object relative to another object, the world, or the
  camera.
- **`orient_toward`** — aim an existing object at a target, camera, or world direction.
- **`arrange_group`** — build a deterministic formation (line, grid, cluster) from existing
  objects.
- **`arrange_facing_pair`** — place two existing objects so they face each other at a measured
  clearance.
- **Idempotency key** — a caller-chosen request identifier. Retrying the byte-equivalent payload
  with the same key returns the original result instead of applying the mutation twice.
- **Quality gate** (`quality_gate`) — an authoring option that rejects a batch when it would
  create deterministic quality violations, instead of committing and repairing later.
- **Naive caller** — a public HTTP/MCP/CLI caller that omits target, guard, or key. The boundary
  observes one exact target, injects the missing values, and reports them in an `agent_boundary`
  receipt. Browser execution itself stays strict.
- **Locked content** — objects marked `locked: true` are owned by the user. Agents must not
  change or delete them without an explicit unlock or override in the request.

## Failure vocabulary

These are the structured codes a mutation can return instead of silently misbehaving. The
authoritative recovery steps live in the
[Agent Workbench recovery table](/agents/workbench/#revision-conflicts-and-uncertain-outcomes)
and in [Troubleshooting](/troubleshooting/).

- **`stale_project_revision`** / **`stale_snapshot`** — the target changed after the observation
  that produced the guard. Re-observe and re-plan; do not force the write.
- **`idempotency_key_conflict`** — the key was reused for different input. Choose a new key for
  the new intent.
- **`idempotency_replay_stale`** — the original mutation already succeeded and the project has
  moved on. Express remaining work as a new intent.
- **`outcome_unknown`** — the mutation may have committed before the acknowledgement was lost.
  Observe and diff before deciding whether to retry; never blindly resubmit.
- **`command_timeout`** — a read or evidence request was cancelled. Retry it; do not claim its
  result exists.
- **`target_required`** / **`target_unavailable`** — no writable exact target is bound, or the
  bound one disappeared. Reopen the intended workspace and observe again.

## Evidence and delivery

- **Editor helpers** — grids, labels, gizmos, camera frusta, trajectory guides, and selection
  outlines. Helpers exist for editing and are excluded from captures.
- **Clean capture** — a camera or viewport render with every helper removed, bound to an exact
  camera, frame, and revision. This is the visual evidence format.
- **Render passes** — the deterministic per-frame outputs `clean`, `depth`, `normal`,
  `object-id`, and `mask`, rendered off-screen for downstream conditioning and compositing.
- **`audit`** — the deterministic quality check: references, grounding, overlap, timeline ranges,
  and camera-space framing. A passing audit proves constraints, not pixel quality.
- **Audit token** — the identifier a failed audit returns. `correct` applies only the validated
  suggestions bound to that token.
- **`correct`** — the repair operation for deterministic audit findings, guarded by the audit
  token and the latest revision.
- **Preview** — a fingerprint-bound, helper-free PNG of the Canvas board or an exact Video
  timeline time. It never moves the playhead.
- **Shot IR** — the provider-neutral intermediate representation of one camera/frame evaluation:
  visible objects, sensor gate and crop, lens, exposure/focus metadata, motion intent, and a
  stable `revisionFingerprint`.
- **Shot Package** — the hashed multi-pass bundle for one exact frame: the Shot IR manifest plus
  SHA-256 hashes and a stable package fingerprint for every real artifact.
- **`deliver`** — the acceptance boundary: audit plus clean capture plus Shot IR plus package
  hashes, all bound to one expected revision. Accept a shot only from a delivery receipt, and
  inspect the clean image itself.
- **Receipt** — the structured result of any committed operation or job. Receipts, not optimistic
  status messages, are what an Agent reports.
- **Evidence chain** — the complete set the loop accumulates: exact target, revision, idempotency
  key, audit token, clean capture, and package fingerprint. A missing link means the work is not
  verified.
