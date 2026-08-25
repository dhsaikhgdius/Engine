---
title: Assets and characters for Agents
description: Discover exact local assets and author verified Mixamo characters without guessing identifiers.
---

Agent-authored scenes must use Director's catalog as the source of truth. Never invent an asset ID,
model URL, preview URL, or character motion ID from a display label.

## Start the control surfaces

Run the browser and Gateway together:

```bash
npm run dev
```

Use a stable CLI session while working on one browser target:

```bash
export STAGE_AGENT_SESSION=asset-authoring
```

The CLI stores the exact observed target for this session and fails closed if that tab, scene, or
creative scope changes. It never redirects a pending write to another open Director tab.

## Discover before authoring

The Workbench exposes four catalogs:

| Catalog             | Contents                                              |
| ------------------- | ----------------------------------------------------- |
| `assets`            | All Agent-addressable local assets                    |
| `character_assets`  | Packaged Mixamo character models                      |
| `character_motions` | Packaged Mixamo skeletal clips                        |
| `project_assets`    | The current project's uploaded and generated models   |

The tracked metadata snapshot is recorded on [Feature Status](/reference/feature-status/#catalog-counts)
(108 Mixamo characters and 1,426 locally mirrored Stage props at last verification). Binary
payloads are external to Git and may be absent. Treat the live catalog response and local
availability status—not these counts—as authoritative after assets are provisioned. See
[Open-source Assets & Hugging Face](/development/open-source-assets/).

```bash
npm run stage -- director_workbench '{"op":"catalog","catalog":"assets","query":"chair","limit":25}'
npm run stage -- director_workbench '{"op":"catalog","catalog":"assets","query":"木椅","limit":25}'
npm run stage -- director_workbench '{"op":"catalog","catalog":"character_assets","asset_id":"mixamo:x-bot","limit":1}'
npm run stage -- director_workbench '{"op":"catalog","catalog":"character_motions","limit":25}'
```

Asset catalogs accept `query`, `asset_id`, `category`, `kind`, `preview_status`, `offset`, and
`limit` (1–100). The motion catalog accepts text query and pagination, but not asset-only filters.
Chinese queries are supported: `name_zh`, Chinese aliases, and `tags` are indexed.

Each asset result contains preview metadata, the exact asset record, and prepared authoring
actions. Prefer those returned actions. If an Agent upserts a packaged asset, it must copy the
catalog's `asset` object unchanged; Director rejects a packaged path whose identity differs from
the catalog.

Items also report `name_zh` (nullable), `tags`, and nullable `spatial` facts in metres:
`bounds_m: [x, y, z]`, `footprint_m: [x, z]`, `height_m`, `ground_offset_y`, and `front_axis`.
Read `spatial` to sanity-check scale and footprint before `compose_blocking` or `place_relative`.

## Reuse the project's own assets

`project_assets` lists the current project's runtime assets — user-uploaded and AI-generated
models — instead of the packaged library:

```bash
npm run stage -- director_workbench '{"op":"catalog","catalog":"project_assets","query":"robot","asset_source":"generated","limit":25}'
```

It accepts `query`, `kind`, `asset_source`, `offset`, and `limit`. Each item returns `id`, `name`,
`kind`, `file_name`, `url`, `thumbnail_url`, `asset_source`, and one prepared `add_object`
authoring action. The asset already exists in the project, so there is no upsert step; submit the
returned action unchanged.

## Keep assets at real-world scale

A model asset record can carry `realWorldSizeM`, the asset's real-world size in metres measured as
the largest bounding-box dimension, plus `sizeSource` (`catalog`, `user`, or `estimated`). Director
scales the model so its largest dimension matches that size, which keeps props on the same metric
scale as characters. Packaged props receive a default size for their category, and Asset Catalog v2
items prefer their authored `bounds_m`/`height_m`; copying the returned `asset` unchanged carries
the size with it.

An asset with no `realWorldSizeM` falls back to the legacy display normalization, which fits its
largest dimension into 2 m — usually wrong beside a 1.78 m character. `audit` reports this as an
`asset_missing_real_world_size` warning naming the asset and the visible objects bound to it, with
an `upsert_asset` fix when the catalog knows the size. The catalog knows nothing about a
user-imported model, so send the measured size in `upsert_asset` yourself: `realWorldSizeM` in
metres and `sizeSource: "user"`. `sizeSource` is rejected without `realWorldSizeM`. Unlike `url`,
`fileName`, and `sourceType`, the size is not locked to the catalog record, so a packaged asset can
be upserted with a corrected size.

Assets with `modelNormalization: "preserve"` — promoted generated 3D models and imported scene
bundles — keep their authored metric scale and are never flagged. The Agent's spatial proxy uses
the declared size, so audit clearances and placement match what the viewport renders.

## Observe the exact target

Observe only the slices needed for the operation, and retain the returned `project_revision`:

```bash
npm run stage -- director_workbench '{"op":"observe","fields":["assets","characters","timeline","graph_issues"]}'
```

The CLI automatically performs a preflight observation and adds a missing revision guard to
guarded operations. MCP and HTTP callers should explicitly send the latest `expected_revision`.
All mutations also need a stable `idempotency_key`.

## Add a real X Bot

The following request is executable in a scene that does not already contain `actor-xbot`:

```bash
npm run stage -- director_workbench '{"op":"author","idempotency_key":"asset-guide-xbot-v1","actions":[{"action":"add_object","id":"actor-xbot","name":"X Bot","kind":"character","asset_id":"mixamo:x-bot","transform":{"position":[0,0,0],"rotation":[0,0,0],"scale":[1,1,1]}}]}'
```

For catalog characters, `add_object` can register the packaged asset automatically. The persisted
object must contain `characterSource: "asset"`, `assetRefId: "mixamo:x-bot"`, and a Mixamo rig.
Director does not allow an existing character's asset binding to be cleared.

If a name is supplied without `asset_id`, Director only accepts an exact unambiguous alias; otherwise
it uses the default X Bot. Explicit catalog IDs are clearer and are recommended for repeatable Agent
plans.

## Apply a packaged motion

Discover the clip first, then assign its catalog ID:

```bash
npm run stage -- director_workbench '{"op":"author","idempotency_key":"asset-guide-xbot-walk-v1","actions":[{"action":"set_character_motion","object_id":"actor-xbot","clip_id":"walk","enabled":true,"loop":"repeat","speed":1,"weight":1,"root_motion":"in-place"}]}'
```

Valid packaged IDs are `idle`, `walk`, `walk-back`, `walk-left`, `walk-right`, `run`, `run-back`,
`run-left`, `run-right`, `wave`, `clap`, `sit-idle`, `jump`, and `talk`.
The catalog owns the default loop and recommended root-motion mode. Supported overrides are:

- `loop`: `once`, `repeat`, or `ping-pong`;
- `speed`: 0.1–4;
- `weight`: 0–1;
- `start_frame`: an integer timeline frame;
- `blend_in_s` and `blend_out_s`: 0–10 seconds;
- `root_motion`: `in-place` or `authored`.

## Refine pose and IK

Explicit pose controls are applied after the sampled clip. `merge` starts from the currently
resolved pose; `replace` starts from neutral controls.

```bash
npm run stage -- director_workbench '{"op":"author","idempotency_key":"asset-guide-xbot-pose-v1","actions":[{"action":"set_character_pose_controls","object_id":"actor-xbot","mode":"merge","controls":[{"control":"head.yaw","value":15},{"control":"rightElbow.bend","value":35}]}]}'
```

IK is the final rig layer. Targets and poles are character-local meters:

```bash
npm run stage -- director_workbench '{"op":"author","idempotency_key":"asset-guide-xbot-ik-v1","actions":[{"action":"set_character_ik","object_id":"actor-xbot","effector":"rightHand","target":[0.45,1.25,0.2],"pole":[0.2,1.1,-0.35],"weight":1,"reach_clamp":0.95}]}'
```

Only `leftHand`, `rightHand`, `leftFoot`, and `rightFoot` are valid effectors. The two-bone solver
does not stretch limbs. A locked character rejects motion, pose, and IK changes unless the user has
explicitly authorized an override.

## Verify the result

Use structured state inspection first:

```bash
npm run stage -- director_workbench '{"op":"observe","fields":["characters","timeline","graph_issues"]}'
npm run stage -- director_workbench '{"op":"inspect","entity":"object","id":"actor-xbot"}'
npm run stage -- director_workbench '{"op":"audit","subject_id":"actor-xbot","include_spatial":true}'
npm run stage -- director_workbench '{"op":"capture","camera_id":"cam_1","frame":0,"render_pass":"clean","clean_plate":true}'
```

The CLI returns a durable capture receipt but does not print image bytes. An MCP-capable visual Agent
or an operator must inspect the returned clean pixels before accepting grounding, silhouette,
occlusion, pose, or framing.

## Acceptance criteria

- Catalog discovery identifies one exact asset and a ready preview.
- The created character retains the expected real `assetRefId`.
- Observe reports the intended motion, controls, and IK under `character_rig`.
- Walk/run loops retain vertical pelvis motion without unintended planar skeleton drift.
- Feet are grounded at the evaluated frame and IK remains within reach.
- The final clean frame contains no grid, gizmo, label, frustum, or selection helper.
- Final delivery is not claimed from `audit.ready` alone; use the latest revision, verified capture,
  and visual pixel inspection.

## Recovery rules

- On a stale revision, observe again and submit only the remaining intent with a new key.
- On `outcome_unknown`, inspect before retrying. Reuse the original key only for a byte-equivalent
  retry whose effect is confirmed absent.
- On `target_unavailable`, reconnect the intended tab and observe again. Never fall back to another
  target.
- Do not use `force:true` as a convenience flag; it requires explicit operator authorization.

## Library maintainers: adding new assets

Packaged libraries are described on disk by the Asset Catalog v2 manifest at
`assets/library/<library>/catalog.v2.json`; its zod contract is
`packages/protocol/src/assetCatalogProtocol.ts`. Register new files with the developer ingest CLI:

```bash
npx tsx tools/scripts/asset-ingest.ts <files...> --library <library> [--kind --category --name-zh --tags ...]
```

The CLI normalizes GLB/GLTF payloads (bounds, SHA-256), registers FBX/OBJ files, and merges the
result into `catalog.v2.json`. This is a developer workflow for adding libraries, not an Agent
runtime tool. Distribution and licensing rules are covered in
[Open-source Assets & Hugging Face](/development/open-source-assets/).
