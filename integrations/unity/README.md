# Director Unity connector

Source-only UPM Editor package (`com.director.bridge`) plus fixed `-batchmode
-executeMethod` entry points that connect a licensed Unity 2022.3+ installation to
Director. Scene payloads travel as GLB plus Director manifest JSON; Unity YAML is
never used as an exchange format and is never parsed by the Director Gateway.

## What it does

- **Import** (`Director.Bridge.Editor.DirectorBridgeCli.Import`): reads a
  `director-dcc-exchange-package-v1` directory (schema- and SHA-256-verified),
  builds a new scene, and saves it under `Assets/Director/Scenes/`. Every entity
  is stamped with a `DirectorId` component and the parent hierarchy is restored.
  - **GLB payloads** are copied into `Assets/Director/Packages/<id>/` under
    content-hashed names and imported synchronously through whatever glTF
    `ScriptedImporter` the project has installed (for example
    `com.unity.cloud.gltfast`). The connector never parses GLB bytes itself; a
    missing importer warns and leaves an empty GameObject.
  - **Characters** resolve by `assetRefId` (never by array index). Skinned GLB
    payloads get an `Animator` with a Humanoid Avatar when the Mixamo-compatible
    required bones resolve (bone prefixes are stripped automatically), and a
    Generic Avatar otherwise.
  - **Pose channels**: Director semantic pose controls (`poseValues`) are
    applied to Mixamo-compatible rigs through a C# port of Director's pose
    math (`DirectorPoseMath.cs` / `DirectorPoseImport.cs`) — static poses pin
    the rest pose, keyframed pose channels bake into per-bone rotation curves
    on the entity's `AnimationClip`. Rigs without the Mixamo bone roles and
    motion-block channels are still never silently flattened: each skipped
    channel is recorded as a structured entry in the engine report instead of
    a free-text log line.
  - **Materials** from the Director PBR manifest map onto URP/Lit or Built-in
    Standard depending on the detected render pipeline (HDRP warns and uses the
    closest fallback). glTF metallic-roughness scalars and hashed package
    textures (Gateway-bundled PNG/JPEG/TGA/EXR slots) are bound; unsupported
    material graphs and unbound slots warn-and-omit.
  - **Cameras** become physical Unity cameras: focal length plus the Director
    sensor-gate crop drive `Camera.usePhysicalProperties`, sensor size, and FOV;
    look-at targets resolve against scene entities; orthographic scale converts.
    Anamorphic squeeze is warned and omitted. Unknown light types surface as typed `omittedLights[]` (`directorId` / `code` / `lightType` / `reason`) with matching `omittedLightCount`.
  - **Lights** (point / spot / directional / area) become Unity `Light`
    GameObjects with their own `DirectorId`; ambient and hemisphere lights map
    onto `RenderSettings` with a warning. Lights do not round-trip (the return
    contract has no light entity type).
  - **Timeline**: one `TimelineAsset` under `Assets/Director/Timelines/` with a
    single `PlayableDirector` host. Storyboard shots become `ActivationTrack`
    clips over their cameras, and Director keyframe / trajectory animation is
    baked into `AnimationClip`s on `AnimationTrack`s using a C# port of
    Director's easing and trajectory evaluators. Unsupported channels
    warn-and-omit; `.unity` YAML never becomes the interchange format.
  - Finally, the run echoes a canonical-space return package and writes a
    `director-dcc-engine-report-v1` receipt whose `unity` block reports the
    render pipeline, glTF importer availability, imported light / baked clip /
    avatar / material-fallback / applied-texture / posed-character counters, and the structured
    `omittedChannels` list (channel id, entity, reason) for anything the
    connector could not bake.
- **Export** (`...DirectorBridgeCli.Export`): reopens the Director scene,
  converts every `DirectorId` transform back to Director canonical space at the
  provider boundary, and writes a `director-dcc-return-v1` package containing
  only the objects and cameras that moved relative to the exchange baseline.
- **Health** (`...DirectorBridgeCli.Health`): logs a JSON health line with host
  and connector versions, the active render pipeline, and glTF importer
  availability.

Coordinate conversion (right-handed Y-up ↔ left-handed Y-up, both metres,
`(x, y, z) -> (x, y, -z)`, quaternion `(x, y, z, w) -> (-x, -y, z, w)`, and the
matching 4×4 bind-matrix conjugation) lives in `DirectorSpace.cs`. The camera
math (sensor gates, vertical FOV, look-at quaternions), animation evaluation
(cubic-bezier easing, keyframe transforms, circle/path trajectories), and pose
math (control clamping, Mixamo bone-role mapping, semantic pose rotations) are
C# ports of the TypeScript reference implementations.

## Live preview link

`Director → Live Link Preview` (`DirectorLiveLink.cs`) opens an Editor window
that long-polls the Gateway's Unity live-link hub
(`/api/dcc/unity/live-link/sessions/<id>/events`) with a per-session bearer
token. The transport is deliberately narrow:

- **Outbound-only**: Unity only ever issues GET polls; it never pushes state
  back, and the Gateway exposes no C# execution endpoint of any kind.
- **Sequence-numbered**: every event carries a monotonic `seq`; the client
  resumes with `?after=<seq>` and the hub replays from its ring buffer, or
  re-sends the latest full snapshot when the requested tail was evicted.
- **Disconnect-safe**: closed sockets, expired sessions (idle TTL), and
  Director-side session closes all resolve to clean terminal responses; the
  client backs off and resyncs instead of tearing the scene down. These
  behaviours are pinned by `backend/gateway/tests/dcc/unityLiveLink.test.ts`.
- **Never authoritative**: live-link events preview transforms on objects the
  headless import already stamped with `DirectorId`. The durable channel
  remains the exchange package / return package round trip.

## Tests

`Tests/Editor/` carries a Unity EditMode (NUnit) suite that pins `DirectorSpace`,
`DirectorCameraMath`, `DirectorAnimationEvaluator`, and `DirectorPoseMath`
against golden values. The same golden tables are asserted host-free in the
Gateway CI suite
(`packages/dcc-protocol/tests/directorDccUnityConnectorGolden.test.ts` and the
frontend Mixamo golden test), so the C# ports and the TypeScript references
cannot drift apart without a test failing on at least one side — and Unity
itself is never required in CI.

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

When `DIRECTOR_UNITY_BIN` is unset the Gateway probes Unity Hub per-version
installs on macOS (`/Applications/Unity/Hub/Editor`), Linux
(`~/Unity/Hub/Editor`), and Windows (`%PROGRAMFILES%\Unity\Hub\Editor`),
preferring the newest stable release, then falls back to the legacy and
containerized editor layouts and finally to `PATH`. A relocated Hub editor
root can be named with `DIRECTOR_UNITY_HUB_EDITORS`.

`director_dcc {"op":"status","provider":"unity"}` reports `nativeReady: true` only
when the connector source, the executable, the version probe, and the installed
package all check out. `installed` alone never implies `nativeReady`. Portable
GLB/USDA exchange stays available either way.

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

Implemented and versioned: headless import/export, stable `director_id` round
trip, scene hierarchy, transforms, physical cameras, lights, PBR material
fallback with Gateway-bundled hashed textures, Humanoid/Generic avatars from skinned GLB, storyboard shots →
Timeline activation tracks, Director animation and semantic pose channels
baked onto Timeline `AnimationClip`s, and the outbound-only preview live link
described above (token-authenticated, sequence-numbered, disconnect-safe —
preview only, never scene authority). Channels the connector cannot bake
(motion blocks, pose channels on non-Mixamo rigs) are reported as structured
`omittedChannels`, never silently flattened. Still planned: production USD
round trip — Unity's USD packages are pre-release, so USDA stays secondary
and experimental, and GLB remains the preferred exchange payload.
