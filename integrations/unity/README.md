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

---

## Unity scene import (director-engine-scene-v1)

Import-only bridge from Unity scenes into Director. The Editor-only exporter
produces a portable `director-engine-scene-v1` package that Director's
gateway validates, plans, and applies — the same preview/apply flow as the
trusted `.blend` import.

### Package layout

| File | Purpose |
| --- | --- |
| `manifest.json` | Scene metadata, hierarchy snapshot, cameras, lights, animation clip inventory, warnings, SHA-256 hashes. |
| `assets/scene.glb` | Renderable scene geometry via **`com.unity.cloud.gltfast`** (install through the Package Manager). Materials and skinned meshes ride embedded in the GLB. |

Every transform in the manifest is already converted from Unity's
left-handed Y-up metre convention into Director's right-handed Y-up metre
convention (`(x,y,z)->(-x,y,z)`); the manifest records the map.

### Export

Headless (Director's gateway runs this for `director_dcc`
`extract_engine_scene` when `DIRECTOR_UNITY_BIN` or a well-known install
path resolves; the gateway copies `interchange/DirectorSceneExport.cs` into
the project's `Assets/Editor/DirectorInterchange/` first):

```bash
Unity -batchmode -nographics -quit -projectPath <project> \
    -executeMethod DirectorInterchange.DirectorSceneExport.ExportFromCommandLine \
    -directorOutputDir /abs/out [-directorScene Assets/Scenes/Main.unity] [-directorZip]
```

Headless batch mode requires an **activated Unity license** on the machine.
Without one, run the export from the Editor (the method works interactively)
and upload the `.zip` written by `-directorZip`:

```bash
curl -X POST "http://127.0.0.1:8787/api/dcc/engine-scene/uploads?provider=unity" \
    -H "content-type: application/zip" \
    -H "x-director-filename: director-engine-scene.zip" \
    --data-binary @director-engine-scene.zip
```

### Import into Director

1. `director_dcc {"op":"status","provider":"unity"}` — check runtime and connector readiness.
2. Obtain a package: `extract_engine_scene` (engine installed and licensed) or the `.zip` upload above.
3. `preview_engine_scene_import` with the returned `packageDir` — inspect plan, warnings, conflicts.
4. `apply_engine_scene_import` with `plan_id`, `expected_revision`, and an `idempotency_key`.

### Preservation

| Feature | Level | Notes |
| --- | --- | --- |
| Geometry / hierarchy | exchange | GLB bundle plus a typed hierarchy snapshot with `GlobalObjectId` stable IDs. |
| Cameras | exchange | Physical camera sensor, aperture, and focus distance when enabled; vertical FOV and clip planes always. |
| Lights | exchange | Directional / point / spot / rectangle lights plus flat ambient environment lighting; disc lights are recorded as gaps. |
| Materials, skinned meshes | exchange | Embedded in the GLB by gltfast. Animation clips are inventoried with durations. |
| Stable IDs | director-manifest | `GlobalObjectId` recorded per node/camera/light. |
| Round-trip back to Unity | planned | Import-only in v1. |

### Blockers

The Linux Editor itself downloads freely (`tools/scripts/install-dcc-runtimes.sh`
installs 6000.0.82f1 LTS into `/opt/director-dcc`), but `-batchmode`
execution needs an activated license (a free Personal license works). Without
one, export interactively and upload the `.zip`.
