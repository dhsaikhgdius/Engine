# Blender File Interchange

> Languages: **English** · [中文](README.zh-CN.md)

`integrations/blender/interchange/` contains the file-level interchange scripts
between Director and Blender. Four Python modules + two vitest test files for
`.blend` scene import and Director round-trip workflows.

## File-level inventory

| Path | Purpose |
| --- | --- |
| `director_bridge.py` | Import a validated Director DCC scene package into Blender: parses `director-dcc-scene-v1` manifest, creates/updates objects with `director_id` custom properties, stamps `director_source_transform` and `director_source_mesh_signature` properties; explicitly accepts only data, never executes package code. |
| `director_scene_export.py` | Extract an open `.blend` scene into a Director import package: exports `director-blend-scene-v1` package with `manifest.json` (source/artifact SHA-256 receipts, warnings, unsupported features), `assets/scene.glb` (metre-scale Y-up, preserves hierarchy/materials/skins/morphs/animation), camera optics, frame range/rate metadata. Gateway runs this after Blender starts with `--factory-startup --disable-autoexec`. |
| `director_return_export.py` | Export a `director-dcc-return-v1` return package from a refined `.blend`: only objects with `director_id` custom property are exported; generates `meshes/*.glb` (preserving `extras.director.stableId`); untouched `.blend` returns empty change set; mesh fingerprints exclude Director wrapper transform; every file has SHA-256 receipt; top-level objects without `director_id` are warnings only. |
| `director_signature.py` | Shared mesh-content fingerprint (SHA-256): `director_bridge.py` stamps it on export, `director_return_export.py` recomputes it on return. Both sides must feed byte-identical data — changing any hashed byte invalidates every previously stamped scene. |
| `director_scene_export.test.ts` | vitest unit tests for the scene export script (TypeScript, runs via vitest/jsdom). |
| `director_return_export.test.ts` | vitest unit tests for the return export script (TypeScript, runs via vitest/jsdom). |

## Two workflows

### 1. Import an existing `.blend` scene

```
Operator uploads .blend → Gateway saves to private job dir → Blender starts with --factory-startup --disable-autoexec
       → director_scene_export.py exports director-blend-scene-v1 package
       → Editor previews director-blend-scene-import-plan-v1 → Apply (atomic project replacement)
```

### 2. Director round trip

```
Director exports director-dcc-scene-v1 → director_bridge.py builds .blend (with director_id)
       → Refine in Blender → director_return_export.py exports director-dcc-return-v1
       → Gateway previews merge (dry_run) → Apply (only matching object/camera transforms updated, never full project replacement)
```

## Security

All scripts explicitly accept data only: never execute package code, never follow
remote URLs, write only to paths supplied by the trusted local gateway process.
Treat raw `.blend` import as a **trusted local desktop operation** — disabling
automatic Python/driver execution reduces attack surface but does not sandbox
Blender's native file parser.

## Run

```bash
# Import scene
blender --background --factory-startup --disable-autoexec scene.blend \
  --python integrations/blender/interchange/director_scene_export.py -- \
  --output-dir /path/to/output

# Return refined scene
blender --background scene.blend \
  --python integrations/blender/interchange/director_return_export.py -- \
  --source-manifest data/dcc-jobs/blender/JOB_ID/scene.director-dcc.json \
  --output-dir data/dcc-jobs/blender/JOB_ID/return-package \
  --report data/dcc-jobs/blender/JOB_ID/return-package/return-report.json
```