# Unreal Engine integration

> Languages: **English** · [中文](README.zh-CN.md)

Import-only bridge from Unreal Engine 5 levels into Director. The exporter
runs inside the Unreal Editor (interactively or headless) and produces a
portable `director-engine-scene-v1` package that Director's gateway
validates, plans, and applies — the same preview/apply flow as the trusted
`.blend` import.

## Package layout

| File | Purpose |
| --- | --- |
| `manifest.json` | Scene metadata, hierarchy snapshot, cameras, lights, animation clip inventory, warnings, SHA-256 hashes. |
| `assets/scene.glb` | Renderable level geometry via the built-in **glTF Exporter** plugin (enable it in Edit → Plugins). Materials, skeletal meshes, and animation data ride embedded in the GLB. |

Every transform in the manifest is already converted from Unreal's
left-handed Z-up centimetre convention into Director's right-handed Y-up
metre convention (`(x,y,z)->(y,z,-x)*0.01`); the manifest records the map.

## Export

Headless (Director's gateway runs this for `director_dcc`
`extract_engine_scene` when `DIRECTOR_UNREAL_EDITOR_BIN` or a well-known
install path resolves):

```bash
UnrealEditor-Cmd <project.uproject> -run=pythonscript \
    -script="integrations/unreal/interchange/director_scene_export.py --output-dir /abs/out [--scene /Game/Maps/Set] [--zip]" \
    -unattended -nosplash -nullrhi -stdout
```

Or run the same script from the editor's Python console. `--zip` writes
`director-engine-scene.zip` next to the output directory, ready for:

```bash
curl -X POST "http://127.0.0.1:8787/api/dcc/engine-scene/uploads?provider=unreal" \
    -H "content-type: application/zip" \
    -H "x-director-filename: director-engine-scene.zip" \
    --data-binary @director-engine-scene.zip
```

## Import into Director

1. `director_dcc {"op":"status","provider":"unreal"}` — check runtime and connector readiness.
2. Obtain a package: `extract_engine_scene` (engine installed) or the `.zip` upload above.
3. `preview_engine_scene_import` with the returned `packageDir` — inspect plan, warnings, conflicts.
4. `apply_engine_scene_import` with `plan_id`, `expected_revision`, and an `idempotency_key`.

## Preservation

| Feature | Level | Notes |
| --- | --- | --- |
| Geometry / hierarchy | exchange | GLB bundle plus a typed hierarchy snapshot with stable actor path IDs. |
| Cameras | exchange | Cine camera filmback, focal length, aperture, and focus distance; clip planes fall back to Director defaults. |
| Lights | exchange | Directional / point / spot / rect / sky lights with intensity heuristics (lux and lumens → Director's unitless scale). |
| Materials, skeletal meshes, animation data | exchange | Embedded in the GLB by the glTF Exporter plugin. Level Sequences are inventoried by name only. |
| Stable IDs | director-manifest | Actor path names recorded per node/camera/light. |
| Round-trip back to Unreal | planned | Import-only in v1. |

## Blockers

Epic requires an Epic Games account (EULA) for both binary and source
distribution, so cloud environments cannot fetch UE5 anonymously. Install it
manually and set `DIRECTOR_UNREAL_EDITOR_BIN`, or export inside the editor
and upload the `.zip`.
