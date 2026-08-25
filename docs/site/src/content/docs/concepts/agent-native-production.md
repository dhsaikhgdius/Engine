---
title: Agent-native Production
description: The contracts that let a naive Agent author, verify, and repair Director projects safely.
---

Director is **Agent-native**, not merely “controllable by an Agent.” The distinction is the
contract around every action: an Agent can discover vocabulary, address an exact project, make a
bounded change, verify state and pixels, and recover from conflicts without clicking coordinates.

This page explains the model. The individual terms it uses — observe, author, audit, deliver,
exact target, guard, idempotency key — are defined in the [Glossary](/concepts/glossary/).

## The control loop

```text
capabilities/catalog
  → observe target + revision
  → inspect exact entities
  → author one atomic intent
  → observe/diff
  → audit/correct
  → deliver
  → inspect clean pixels and receipts
```

Each step closes a different failure mode. `capabilities` prevents invented operations;
`catalog` prevents invented asset IDs; the target lease prevents cross-tab writes; revision guards
prevent stale overwrites; idempotency prevents duplicate effects; `audit` catches deterministic
violations; and `deliver` binds a clean rendered frame to the accepted revision.

## One model, four semantic surfaces

| Surface              | Owns                                    | Use it for                                                            |
| -------------------- | --------------------------------------- | --------------------------------------------------------------------- |
| `director_workbench` | Full DirectorProject and Stage evidence | Scene, object, character, camera, timeline, coverage, audit, delivery |
| `director_creative`  | Canvas and Video workspace              | Nodes, edges, media clips, tracks, preview, undo/redo                 |
| `stage_video`        | Generation jobs                         | Prepare, submit/render, poll, cancel                                  |
| `director_dcc`       | DCC handoff                             | Capability discovery, Blender export/status                           |

The `stage_*` tools remain a compact compatibility surface. New automation should prefer
`director_workbench` unless it specifically needs the compact Stage protocol.

## Exact target leases

A writable browser target is a tuple, not just a URL:

```text
token + client_id + instance_id + scene_id + creative_scope_id + contract_version
```

An Agent obtains it from the current observation or bootstrap response and must carry it across
the turn. Director does not silently fall back to a different tab, scene, or creative scope. If
the target disappears, re-bind explicitly.

## Guards and idempotency

Stage mutations use `expected_revision`; Canvas/Video mutations use
`expected_snapshot_fingerprint`. A mismatch is useful evidence that somebody changed the target.
Re-observe, compute the remaining intent, and submit a new request with a new idempotency key.

If the result is `outcome_unknown`, do **not** immediately invent a new key. Observe or diff first.
Only retry the byte-equivalent request with the original key after confirming that the effect is
absent.

Naive callers may omit the target lease, guard, and request key on public Workbench/Creative calls.
Director discovers one responsive exact target, performs the required read-only preflight, injects
the missing guard/key, and returns an `agent_boundary` receipt. Browser execution remains strict:
unguarded project/Production/Storyboard writes and unkeyed durable job submissions are rejected.

Native Blender `apply` follows the same naive-caller principle without a browser lease. The Gateway
snapshots Blender and injects a missing scene epoch, revision, and intent ID. If the native
outcome becomes unknown after dispatch, the response contains a complete `retry_ticket.input`;
replay that object unchanged so Blender can return the original transaction rather than authoring it twice.

## Atomic intent

One user intent should be one `author` batch. A useful batch may upsert an asset, create its object,
assign motion, and create a camera together. If any action fails validation, the durable project is
not partially committed.

Avoid raw JSON Patch unless the semantic action vocabulary cannot express the change. Semantic
actions preserve invariants such as ground contact, real asset identity, locked objects, and
camera/character relationships.

## Evidence levels

| Evidence          | Proves                                           | Does not prove                                                  |
| ----------------- | ------------------------------------------------ | --------------------------------------------------------------- |
| Mutation receipt  | The operation committed                          | The shot looks right                                            |
| New revision/diff | The expected fields changed                      | The frame is usable                                             |
| `audit`           | Deterministic constraints pass                   | Pixel-level quality                                             |
| Clean capture     | What the camera rendered                         | That it belongs to the latest revision unless fingerprint-bound |
| `deliver`         | Audit and capture refer to one accepted revision | Creative taste without human/critic inspection                  |

For a video-generation delivery, require `ready:true`, `status:"delivered"`,
`capture_verified:true`, a ready audit, the expected revision/package fingerprint, and inspection
of the clean PNG. `audit.ready` alone is not acceptance.

## What an Agent must never guess

- asset IDs, file URLs, motion clip IDs, camera IDs, or object IDs;
- world coordinates when a semantic relative-placement action exists;
- support relationships from `parent_id` alone;
- whether a timed-out mutation committed;
- whether a render is clean without inspecting the returned artifact;
- whether a provider generated output without a real job or artifact receipt.

Use [Asset discovery](/agents/assets/), [Agent Workbench](/agents/workbench/), and the
[Gateway HTTP API](/reference/http-api/) for the concrete interfaces.
