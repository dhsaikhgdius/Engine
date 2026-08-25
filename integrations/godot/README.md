# Director Godot 4 connector

Source-only editor plugin (`addons/director_bridge`) plus a fixed
`godot --headless --script` entry point that connects a licensed Godot 4.2+
installation to Director.

Godot 4's world basis (right-handed, Y-up, metres, camera forward -Z) matches
Director's canonical space exactly, so the provider-boundary conversion is the
identity map `(x, y, z) -> (x, y, z)`; it still runs through `director_space.gd`
so the boundary stays explicit and testable.

## What it does

- **Import** (`--mode import`): reads a `director-dcc-exchange-package-v1`
  directory, builds a scene with one `Node3D` per Director object (instancing GLB
  payloads through `GLTFDocument`, which works headless), one `Camera3D` per
  Director camera, restores the parent hierarchy, stamps every node with
  `director_id` metadata, preserves storyboard shots as `director_shots` metadata
  on the scene root (Godot has no built-in shot timeline; warn-and-omit rather
  than silently flattening), saves the scene to `res://director/scenes/`, and
  echoes a canonical-space return package.
- **Export** (`--mode export`): reloads the Director scene and writes a
  `director-dcc-return-v1` package containing the canonical transforms of every
  `director_id`-tagged node that moved relative to the exchange baseline.
- **Health** (`--mode health`): prints a JSON line with the engine and connector
  version.

## Install

1. Copy `addons/director_bridge` into `<YourProject>/addons/director_bridge`.
2. Enable **Director Bridge** in Project → Project Settings → Plugins.
3. Point the Director Gateway at your installation:

```bash
export DIRECTOR_GODOT_BIN=/path/to/godot4
export DIRECTOR_GODOT_PROJECT=/path/to/YourProject
```

`director_dcc {"op":"status","provider":"godot"}` reports `nativeReady: true` only
when the connector source, the executable, the version probe, and the installed
addon all check out. Portable GLB exchange stays available either way.

## Headless invocation (what the Gateway runs)

```bash
"$DIRECTOR_GODOT_BIN" --headless --path "$DIRECTOR_GODOT_PROJECT" \
  --script res://addons/director_bridge/director_headless.gd -- \
  --mode import --package <package-dir> --report <job>/report.json \
  --return-dir <job>/return
```

The entry script is fixed; the Gateway never executes request-supplied GDScript.
The run writes a `director-dcc-engine-report-v1` receipt that the Gateway
schema-validates and cross-checks against the exchange package id and source
revision.

## Capability honesty

Implemented and versioned: headless import/export, stable `director_id` round trip,
scene hierarchy, transforms, cameras. Still planned (warn-and-omit, never silently
flattened): shot timeline mapping beyond metadata, animation curves, skeletons,
material translation, live link.
