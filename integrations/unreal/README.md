# Director Unreal Engine connector

Source-only Editor plugin plus a fixed headless entry point that connects a licensed
Unreal Engine 5.3+ installation to Director. Nothing from Epic is redistributed here;
the connector runs inside the user's own engine and project, in line with the Unreal
Engine EULA.

## What it does

- **Import** (`--mode import`): reads a `director-dcc-exchange-package-v1` directory,
  spawns one actor per Director object (StaticMeshActor for bundled GLB payloads,
  empty actor with a warning otherwise) and one CineCameraActor per Director camera,
  restores the parent hierarchy, stamps every actor with a `director_id:<id>` tag,
  maps storyboard shots to a LevelSequence camera-cut track, saves the level under
  `/Game/Director/Levels/`, and echoes a canonical-space return package.
- **Export** (`--mode export`): reads back every `director_id`-tagged actor in the
  current level, converts transforms to Director canonical space at the provider
  boundary, and writes a `director-dcc-return-v1` package containing only the
  entities that moved relative to the exchange baseline.
- **Health** (`--mode health`): prints a JSON line with the engine and connector
  version.

Coordinate conversion (right-handed Y-up metres ↔ left-handed Z-up centimetres,
`(x, y, z) -> (-z*100, x*100, y*100)`) lives in `director_space.py`, which is pure
Python: run `python3 director_space.py --self-test` without Unreal installed. The
Gateway CI suite runs the same golden cases against the TypeScript reference.

## Install

1. Copy `plugins/DirectorBridge` into `<YourProject>/Plugins/DirectorBridge`.
2. Enable **Director Bridge** and the **Python Editor Script Plugin** in
   Edit → Plugins, then restart the editor.
3. Point the Director Gateway at your installation:

```bash
export DIRECTOR_UNREAL_EDITOR_BIN=/path/to/Engine/Binaries/Linux/UnrealEditor-Cmd
export DIRECTOR_UNREAL_PROJECT=/path/to/YourProject/YourProject.uproject
```

`director_dcc {"op":"status","provider":"unreal"}` reports `nativeReady: true` only
when the connector source, the executable, the engine version probe, and the
installed project plugin all check out. Detection of an executable alone never
implies native readiness; portable USDA/GLB exchange stays available either way.

## Headless invocation (what the Gateway runs)

```bash
"$DIRECTOR_UNREAL_EDITOR_BIN" "$DIRECTOR_UNREAL_PROJECT" \
  -ExecutePythonScript="<Project>/Plugins/DirectorBridge/Content/Python/director_headless.py \
      --mode import --package <package-dir> --report <job>/report.json --return-dir <job>/return" \
  -unattended -nopause -nosplash -nullrhi -stdout
```

The entry point is fixed; the Gateway never executes request-supplied Python. The
run writes a `director-dcc-engine-report-v1` receipt that the Gateway
schema-validates and cross-checks against the exchange package id and source
revision.

## Capability honesty

Implemented and versioned: headless import/export, stable `director_id` round trip,
scene hierarchy, transforms, cameras, storyboard shots → Sequencer camera cuts.
Still planned (warn-and-omit, never silently flattened): animation curves, skeleton
retargeting, material translation, live link.

---

## Unreal Engine integration

> Languages: **English** · [中文](README.zh-CN.md)

Import-only bridge from Unreal Engine 5 levels into Director. The exporter
runs inside the Unreal Editor (interactively or headless) and produces a
portable `director-engine-scene-v1` package that Director's gateway
validates, plans, and applies — the same preview/apply flow as the trusted
`.blend` import.

### Package layout

| File | Purpose |
| --- | --- |
| `manifest.json` | Scene metadata, hierarchy snapshot, cameras, lights, animation clip inventory, warnings, SHA-256 hashes. |
| `assets/scene.glb` | Renderable level geometry via the built-in **glTF Exporter** plugin (enable it in Edit → Plugins). Materials, skeletal meshes, and animation data ride embedded in the GLB. |

Every transform in the manifest is already converted from Unreal's
left-handed Z-up centimetre convention into Director's right-handed Y-up
metre convention (`(x,y,z)->(y,z,-x)*0.01`); the manifest records the map.

### Export

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

### Import into Director

1. `director_dcc {"op":"status","provider":"unreal"}` — check runtime and connector readiness.
2. Obtain a package: `extract_engine_scene` (engine installed) or the `.zip` upload above.
3. `preview_engine_scene_import` with the returned `packageDir` — inspect plan, warnings, conflicts.
4. `apply_engine_scene_import` with `plan_id`, `expected_revision`, and an `idempotency_key`.

### Preservation

| Feature | Level | Notes |
| --- | --- | --- |
| Geometry / hierarchy | exchange | GLB bundle plus a typed hierarchy snapshot with stable actor path IDs. |
| Cameras | exchange | Cine camera filmback, focal length, aperture, and focus distance; clip planes fall back to Director defaults. |
| Lights | exchange | Directional / point / spot / rect / sky lights with intensity heuristics (lux and lumens → Director's unitless scale). |
| Materials, skeletal meshes, animation data | exchange | Embedded in the GLB by the glTF Exporter plugin. Level Sequences are inventoried by name only. |
| Stable IDs | director-manifest | Actor path names recorded per node/camera/light. |
| Round-trip back to Unreal | planned | Import-only in v1. |

### Blockers

Epic requires an Epic Games account (EULA) for both binary and source
distribution, so cloud environments cannot fetch UE5 anonymously. Install it
manually and set `DIRECTOR_UNREAL_EDITOR_BIN`, or export inside the editor
and upload the `.zip`.
