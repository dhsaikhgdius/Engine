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
