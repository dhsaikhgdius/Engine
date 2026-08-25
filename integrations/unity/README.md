# Unity integration

> Languages: **English** · [中文](README.zh-CN.md)

Import-only bridge from Unity scenes into Director. The Editor-only exporter
produces a portable `director-engine-scene-v1` package that Director's
gateway validates, plans, and applies — the same preview/apply flow as the
trusted `.blend` import.

## Package layout

| File | Purpose |
| --- | --- |
| `manifest.json` | Scene metadata, hierarchy snapshot, cameras, lights, animation clip inventory, warnings, SHA-256 hashes. |
| `assets/scene.glb` | Renderable scene geometry via **`com.unity.cloud.gltfast`** (install through the Package Manager). Materials and skinned meshes ride embedded in the GLB. |

Every transform in the manifest is already converted from Unity's
left-handed Y-up metre convention into Director's right-handed Y-up metre
convention (`(x,y,z)->(-x,y,z)`); the manifest records the map.

## Export

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

## Import into Director

1. `director_dcc {"op":"status","provider":"unity"}` — check runtime and connector readiness.
2. Obtain a package: `extract_engine_scene` (engine installed and licensed) or the `.zip` upload above.
3. `preview_engine_scene_import` with the returned `packageDir` — inspect plan, warnings, conflicts.
4. `apply_engine_scene_import` with `plan_id`, `expected_revision`, and an `idempotency_key`.

## Preservation

| Feature | Level | Notes |
| --- | --- | --- |
| Geometry / hierarchy | exchange | GLB bundle plus a typed hierarchy snapshot with `GlobalObjectId` stable IDs. |
| Cameras | exchange | Physical camera sensor, aperture, and focus distance when enabled; vertical FOV and clip planes always. |
| Lights | exchange | Directional / point / spot / rectangle lights plus flat ambient environment lighting; disc lights are recorded as gaps. |
| Materials, skinned meshes | exchange | Embedded in the GLB by gltfast. Animation clips are inventoried with durations. |
| Stable IDs | director-manifest | `GlobalObjectId` recorded per node/camera/light. |
| Round-trip back to Unity | planned | Import-only in v1. |

## Blockers

The Linux Editor itself downloads freely (`tools/scripts/install-dcc-runtimes.sh`
installs 6000.0.82f1 LTS into `/opt/director-dcc`), but `-batchmode`
execution needs an activated license (a free Personal license works). Without
one, export interactively and upload the `.zip`.
