# Director Unreal Engine connector

Source-only Editor plugin plus a fixed headless entry point that connects a licensed
Unreal Engine 5.3+ installation to Director. Nothing from Epic is redistributed here;
the connector runs inside the user's own engine and project, in line with the Unreal
Engine EULA.

## What it does

- **Import** (`--mode import`): reads a `director-dcc-exchange-package-v1` directory,
  spawns one actor per Director object (StaticMeshActor for bundled GLB payloads,
  SkeletalMeshActor for skinned GLBs, empty actor with a warning otherwise) and one
  CineCameraActor per Director camera, restores the parent hierarchy, stamps every
  actor with a `director_id:<id>` tag, applies Director PBR materials as Material
  Instances, keys the LevelSequence from the Gateway's hash-pinned animation bake,
  maps storyboard shots to a camera-cut track, saves the level under
  `/Game/Director/Levels/`, and echoes a canonical-space return package.
- **Export** (`--mode export`): reads back every `director_id`-tagged actor in the
  current level, converts transforms to Director canonical space at the provider
  boundary, and writes a `director-dcc-return-v1` package containing only the
  entities that moved relative to the exchange baseline. Camera baselines use the
  same look-at rotation the glTF/OpenUSD exporters produce.
- **Health** (`--mode health`): prints a JSON line with the engine and connector
  version plus the connector feature list.
- **Live preview** (`--mode live-preview`): optional preview-only loopback camera
  feed into the editor viewport. See "Live preview" below; it is never the durable
  scene channel.

Coordinate conversion (right-handed Y-up metres ↔ left-handed Z-up centimetres,
`(x, y, z) -> (-z*100, x*100, y*100)`) lives in `director_space.py`, which is pure
Python: run `python3 director_space.py --self-test` without Unreal installed. The
Gateway CI suite runs the same golden cases against the TypeScript reference.

## Module map

| Module | Runs without Unreal | Responsibility |
| ------------------------- | ------------------- | ------------------------------------------------------------------------------------------------ |
| `director_headless.py` | health mode only | Fixed entry point: import / export / health / live-preview orchestration |
| `director_package.py` | yes | Exchange/return package IO, report receipts |
| `director_space.py` | yes (`--self-test`) | Canonical ↔ Unreal basis change, camera look-at quaternions |
| `director_timebase.py` | yes (`--self-test`) | Rational rates, Sequencer tick resolution, SMPTE NDF/DF timecode (23.976 / 24 / 25 / 29.97 DF / 30) |
| `director_bake.py` | yes (`--self-test`) | Hash-verifies the Gateway bake sidecar; converts canonical samples to Unreal keys with rotator continuity unwrapping |
| `director_materials.py` | yes (CLI) | Director PBR parameters → material-instance overrides, sRGB→linear, warn-and-omit records |
| `director_gltf.py` | yes (CLI) | GLB container inspection (JSON chunk only) to route skinned payloads to skeletal import |
| `director_livelink.py` | yes (CLI) | Preview session protocol: token, sequence numbers, reorder/duplicate drop, staleness |
| `director_sequencer.py` | no | LevelSequence authoring: display rate, tick resolution, start timecode, camera cuts, transform and focal-length tracks |
| `director_host_materials.py` | no | Creates the `DirectorPbrOpaque`/`DirectorPbrTranslucent` parents and Material Instances |

The host-free modules are exercised by the Gateway CI suite
(`backend/gateway/tests/dcc/unrealConnectorModules.test.ts`) with plain `python3`;
the host-only modules are compile-checked there and exercised inside the editor.

## Animation: the Sequencer bake sidecar

Director's animation evaluators (easing curves, trajectories, camera path and
follow actions) run in the Gateway, not in Python. For every Unreal handoff the
Gateway samples world transforms and camera focal lengths per frame into a
`director-unreal-sequencer-bake-v1` sidecar (`animation.json`) inside the private
job directory, and pins its SHA-256 through the fixed argument array:

```text
--animation "<job>/animation.json" --animation-sha256 <hex>
```

The connector refuses a sidecar whose hash, package id, or source revision does
not match, then keys:

- one transform track per baked entity (location in centimetres, rotation as
  continuity-unwrapped rotator degrees, scale permuted onto Unreal axes);
- one focal-length track per camera with fov animation, derived against the
  camera's own filmback;
- the LevelSequence display rate, tick resolution, and start timecode from the
  Director timeline timebase (rational rates; drop-frame only on NTSC 29.97/59.94).

Channels the bake cannot carry — rig pose keyframes (Control-Rig-style values),
character motion clips, character rig state — are recorded as warn-and-omit
entries in the report instead of being silently flattened. The report embeds a
`sequencer` receipt read back from the authored LevelSequence asset (display
rate, tick resolution, start timecode, playback range, track and key counts).

## Skeletons and materials

- Skinned GLB payloads (detected from the GLB JSON chunk, never the binary
  buffer) import through the editor asset pipeline and spawn `SkeletalMeshActor`s
  in bind pose with `director_id` tags. When the import pipeline does not produce
  a skeleton, or a character references an unskinned GLB, the connector warns and
  falls back to a static mesh.
- Director PBR material parameters (baseColor, metalness, roughness, opacity,
  emissive, double-sided) become Material Instances whose parents are the
  Director-authored `DirectorPbrOpaque` / `DirectorPbrTranslucent` materials.
  Unsupported channels (transmission, IOR, clearcoat, texture references that are
  not bundled relative hashed files, back-face-only rendering) warn-and-omit.

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
      --mode import --package <package-dir> --report <job>/report.json --return-dir <job>/return \
      --animation <job>/animation.json --animation-sha256 <hex>" \
  -unattended -nopause -nosplash -nullrhi -stdout
```

The entry point is fixed; the Gateway never executes request-supplied Python. The
run writes a `director-dcc-engine-report-v1` receipt that the Gateway
schema-validates and cross-checks against the exchange package id and source
revision. A missing `--animation` argument means a static import; a present but
invalid sidecar is a hard failure.

## Live preview (preview-only, capability stays `planned`)

`--mode live-preview` binds `127.0.0.1` only, requires a shared token from the
`DIRECTOR_UNREAL_PREVIEW_TOKEN` environment variable, and applies
sequence-numbered `camera_frame` messages to the editor viewport. Reordered or
duplicated frames are dropped; a silent peer disconnects the session. The
protocol semantics are tested host-free in
`backend/gateway/tests/dcc/unrealConnectorModules.test.ts`. No Gateway transport
ships yet, so the `live_link` capability remains `planned`; the durable scene
channel is always the hash-verified exchange/return package.

## Capability honesty

Implemented and versioned: headless import/export, stable `director_id` round
trip, scene hierarchy, transforms, cameras, storyboard shots → Sequencer camera
cuts, Gateway-baked transform/camera animation into Sequencer tracks with
rational rates and start timecodes, skinned-GLB skeletal mesh import in bind
pose, and Director PBR parameters as material instances. Every conversion above
is covered by host-free golden tests; the in-editor paths are additionally
exercised only when a licensed Unreal installation is configured.

Still planned (warn-and-omit, never silently flattened): rig pose and motion-clip
transfer (Control Rig), skeletal animation retargeting, texture-file translation,
a Gateway live-link transport, and clean-frame render receipts. `.uasset` files
are never parsed or synthesized outside Unreal.
