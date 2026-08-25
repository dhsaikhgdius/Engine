# Director Unity connector

Source-only UPM Editor package (`com.director.bridge`) plus fixed `-batchmode
-executeMethod` entry points that connect a licensed Unity 2022.3+ installation to
Director. Scene payloads travel as GLB plus Director manifest JSON; Unity YAML is
never used as an exchange format and is never parsed by the Director Gateway.

## What it does

- **Import** (`Director.Bridge.Editor.DirectorBridgeCli.Import`): reads a
  `director-dcc-exchange-package-v1` directory, builds a new scene with one
  GameObject per Director object (instantiating GLB payloads through the project's
  glTF importer when one is installed, e.g. `com.unity.cloud.gltfast`; otherwise an
  empty GameObject with a warning), one `Camera` per Director camera, restores the
  parent hierarchy, stamps every entity with a `DirectorId` component, maps
  storyboard shots to Timeline activation tracks, saves the scene under
  `Assets/Director/Scenes/`, and echoes a canonical-space return package.
- **Export** (`...DirectorBridgeCli.Export`): reopens the Director scene, converts
  every `DirectorId` transform back to Director canonical space at the provider
  boundary, and writes a `director-dcc-return-v1` package containing only the
  entities that moved relative to the exchange baseline.
- **Health** (`...DirectorBridgeCli.Health`): logs a JSON health line.

Coordinate conversion (right-handed Y-up ↔ left-handed Y-up, both metres,
`(x, y, z) -> (x, y, -z)`, quaternion `(x, y, z, w) -> (-x, -y, z, w)`) lives in
`DirectorSpace.cs`. The Gateway CI suite verifies the same golden cases against the
TypeScript reference without Unity installed.

## Install

1. Copy `com.director.bridge` into `<YourProject>/Packages/com.director.bridge`
   (or add it to `Packages/manifest.json` as a local package).
2. Optional but recommended: install `com.unity.cloud.gltfast` so GLB payloads
   import as meshes instead of warn-and-omit placeholders.
3. Point the Director Gateway at your installation:

```bash
export DIRECTOR_UNITY_BIN=/path/to/Unity/Editor/Unity
export DIRECTOR_UNITY_PROJECT=/path/to/YourProject
```

`director_dcc {"op":"status","provider":"unity"}` reports `nativeReady: true` only
when the connector source, the executable, the version probe, and the installed
package all check out. Portable GLB/USDA exchange stays available either way.

## Headless invocation (what the Gateway runs)

```bash
"$DIRECTOR_UNITY_BIN" -batchmode -nographics -quit \
  -projectPath "$DIRECTOR_UNITY_PROJECT" \
  -executeMethod Director.Bridge.Editor.DirectorBridgeCli.Import \
  -logFile <job>/host.log \
  -directorPackage <package-dir> -directorReport <job>/report.json \
  -directorReturnDir <job>/return
```

The entry method is fixed; the Gateway never executes request-supplied C#. The run
writes a `director-dcc-engine-report-v1` receipt that the Gateway schema-validates
and cross-checks against the exchange package id and source revision.

## Capability honesty

Implemented and versioned: headless import/export, stable `director_id` round trip,
scene hierarchy, transforms, cameras, storyboard shots → Timeline activation
tracks. Still planned (warn-and-omit, never silently flattened): animation curves,
skeleton retargeting, material translation, live link.
