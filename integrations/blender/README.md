# Director ↔ Blender

> Languages: **English** · [中文](README.zh-CN.md)

`integrations/blender/` is the Blender connector root (DCC catalog
`connectorDirectory`). Python lives in two sibling trees:

| Directory | Purpose |
| --- | --- |
| `live/` | Headless live modeling. `BLENDER_USER_SCRIPTS` points here. Contains `worldengine_backend.py` and `addons/worldengine_studio/`. |
| `interchange/` | File workflows: import a trusted `.blend`, or export/return a Director scene. |

Install Blender 4.2+ (or set `BLENDER_BIN`) for live modeling. Director
does not vendor Blender's C source.

## File-level inventory

### `live/`

| Path | Purpose |
| --- | --- |
| `worldengine_backend.py` | Headless Blender backend entry: loads addon, configures project as metric 24fps 1080p, starts loopback HTTP session on `127.0.0.1:8791`, runs event loop until SIGTERM. |
| `addons/worldengine_studio/` | Blender 4.2+ addon (WorldEngine Studio v0.1.0, GPL-2.0), 17 modules + test suite. See `live/README.md`. |

### `interchange/`

| Path | Purpose |
| --- | --- |
| `director_bridge.py` | Import a validated Director DCC scene package into Blender: stamps `director_id` custom properties, mesh signatures, source transforms; explicitly accepts only data. |
| `director_scene_export.py` | Extract an open `.blend` scene: exports a `director-blend-scene-v1` package (manifest.json + scene.glb + camera optics + hash receipts). Gateway runs this after launching Blender with `--factory-startup --disable-autoexec`. |
| `director_return_export.py` | Export a `director-dcc-return-v1` return package from a refined `.blend`: only objects with `director_id` are exported; generates GLB + SHA-256 receipts; top-level objects without `director_id` are warnings only. |
| `director_signature.py` | Shared mesh-content fingerprint: `director_bridge.py` stamps it on export, `director_return_export.py` recomputes it on return; both sides must feed byte-identical data. |
| `director_scene_export.test.ts` | vitest unit tests for the scene export script. |
| `director_return_export.test.ts` | vitest unit tests for the return export script. |

## Live modeling kernel

Headless Blender plus `worldengine_studio` at
`integrations/blender/live/addons/worldengine_studio/`. Stage and Agents edit
one native scene over `worldengine-blender-live-v1`. Start with
`npm run blender`.

The launcher sets `BLENDER_USER_SCRIPTS` to `integrations/blender/live` so
Blender finds `addons/worldengine_studio/`. The backend entry is
`integrations/blender/live/worldengine_backend.py`.

The loopback session is unauthenticated by default. To require bearer auth,
export the same `DIRECTOR_BLENDER_TOKEN` for the gateway and the Blender
process (Blender inherits the shell env; `WORLDENGINE_SESSION_TOKEN` overrides
it for Blender only). Every session request must then carry
`Authorization: Bearer <token>`; requests without it receive 401.

## File interchange

Director has two separate file workflows. They share the local Gateway and
hash validation, but they do not have the same merge semantics:

1. **Import an existing `.blend` scene** — snapshot the active scene of an
   operator-trusted local file into one GLB scene bundle and optionally create
   its perspective cameras.
2. **Director round trip** — export a Director-owned scene, refine only its
   stable-ID entities in Blender, then review and return those changes.

The first flow creates new Director entities. The second updates known
Director entities and never treats unrelated Blender objects as implicit edits.

### Import an existing Blender scene

Use **Interchange → Import Blender scene** in the editor, or upload the raw file
to the local Gateway. The Gateway saves the upload in a private job directory
and launches Blender headlessly with `--factory-startup` and
`--disable-autoexec`. `integrations/blender/interchange/director_scene_export.py`
writes a validated `director-blend-scene-v1` package containing:

- `manifest.json`, source and artifact SHA-256 receipts, warnings, and explicit
  unsupported-feature records;
- `assets/scene.glb`, a single metre-scale, Y-up scene bundle that preserves
  the Blender world layout, hierarchy inside the GLB, materials, skins, morphs,
  and embedded GLB animations;
- physical parameters and current-frame transforms for supported perspective
  cameras; and
- the source frame range, current frame, and exact rational frame rate as
  review/provenance metadata.

The editor previews a `director-blend-scene-import-plan-v1` before any mutation.
The editor imports the scene bundle by default and lets the operator select its
cameras; API clients can also build camera-only plans. Conflicts disable apply.
Apply accepts only the server-stored `plan_id`, the exact live
`expected_revision`, and an `idempotency_key`; it revalidates the source package
and hashes, rebuilds the plan, and submits one atomic project replacement.

The copied GLB is immutable and content-addressed under
`assets/generated/dcc-import/`. The browser reads it through
`/dcc-import/<hash-prefix>/<asset-id>.glb`. Director sets
`modelNormalization: "preserve"`, so it does not recenter or auto-rescale the
authored Blender scene.

This is a scene snapshot, not a deep editable conversion. v1 evaluates only
Blender's active scene. Treat raw `.blend` import as a **trusted local desktop
operation** — disabling automatic Python/driver execution reduces attack surface
but does not sandbox Blender's native file parser. Do not upload an untrusted
`.blend`.

### Export a Director scene for refinement

Director exports a validated `director-dcc-scene-v1` package and builds a
`.blend` with stable `director_id` properties. Refine that scene in Blender;
do not rename or remove those custom IDs.

### Return a refined scene

Run the return exporter inside Blender. The report must remain inside the
output directory:

```bash
blender --background scene.blend \
  --python integrations/blender/interchange/director_return_export.py -- \
  --source-manifest data/dcc-jobs/blender/JOB_ID/scene.director-dcc.json \
  --output-dir data/dcc-jobs/blender/JOB_ID/return-package \
  --report data/dcc-jobs/blender/JOB_ID/return-package/return-report.json
```

The output is manifest-first: `manifest.json` uses `director-dcc-return-v1`;
`meshes/*.glb` retain `extras.director.stableId`; an untouched `.blend` returns
an empty change set; mesh fingerprints exclude the Director wrapper transform;
every emitted file has a SHA-256 receipt; top-level objects without
`director_id` are warnings and are never silently imported.

Preview the merge before applying it:

```bash
curl -sS http://127.0.0.1:8787/api/tools/director_dcc \
  -H 'content-type: application/json' \
  -d '{"input":{"op":"import_return_package","package_dir":"JOB_ID/return-package","dry_run":true}}'
```

Apply the returned plan with its exact `targetRevision`, a stable retry-only
idempotency key, and `op: "apply_import_plan"`. Director registers immutable
GLB assets and updates only the matching object/camera transforms. It never
replaces the full project.