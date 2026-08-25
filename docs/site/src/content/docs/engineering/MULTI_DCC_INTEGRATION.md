---
title: Multi-DCC Integration Architecture
description: A capability-driven, format-neutral architecture for connecting Director to major DCCs and real-time engines.
---

## Scope and status

Director should interoperate with the tools already used for character animation,
procedural environments, motion graphics, virtual production, real-time rendering,
and final rendering. It should not make Blender, Maya, Unreal Engine, Houdini,
Cinema 4D, Unity, Godot, or 3ds Max into a second source of truth, and it should
not require an Agent to understand each application's menu layout or private file
format.

This document defines the target architecture for that interoperability. It uses
the following status vocabulary:

- **Implemented** — present in Director, covered by tests, and available through a
  user or Agent control surface.
- **Exchange** — Director can prepare or consume its documented portable format
  subset, but there is no verified native connector for that provider.
- **Proposed** — an intended provider adapter or capability, not a claim about the
  current runtime.

At the time of writing:

- **Blender** is the implemented native DCC round trip: live kernel, `.blend`
  import, reviewed return packages (meshes, transforms, camera optics,
  `director_id` lights, and portable character pose controls), and a bounded
  preview-only live-link delta feed that is never authoritative.
- **Unreal Engine, Unity, and Godot 4** have implemented Director-authored
  **engine-headless connectors**: the Gateway can run a fixed connector entry
  point inside the user's engine installation to import the exchange package
  (`send_to_engine`) and to bring a `director-dcc-return-v1` package back as a
  revision-guarded plan (`receive_from_engine` / `apply_import_plan`). The
  covered workflow is scene layout, cameras, stable IDs, and transform-level
  round trip. **Godot 4** additionally ships validated host-side animation
  (Gateway-baked `AnimationPlayer` tracks on a rational timebase), skinned GLB
  skeletons in bind pose, `StandardMaterial3D` translation with hashed external
  textures, and Omni/Spot/Directional lights. Animation, skeletons, and
  materials remain **planned** for Unreal and Unity, and live link remains
  planned for all three engines; the exchange package can carry model payloads,
  but Director does not claim host-side fidelity it has not validated.
- Director also has documented, deliberately limited glTF/GLB and USD
  interchange subsets.
- The Maya, Houdini, Cinema 4D, and 3ds Max native adapters described below are
  proposed.

Detecting an installed executable never makes a native adapter ready. For the
engine connectors, `nativeReady` additionally requires the Director-authored
connector files, a versioned host probe, and the connector installed inside the
configured engine project — all verified by a health check. See
[Blender Scene Import and Round Trip](/engineering/blender_bridge/) for the
existing Blender behavior and [Interchange & DCC Handoff](/pipelines/interchange/)
for the tested portable subsets.

## Design goals

The integration must provide:

1. one canonical Director representation for identity, coordinates, time, cameras,
   assets, characters, animation, and review metadata;
2. deterministic, headless import and export before optional live synchronization;
3. explicit capability discovery instead of provider-name assumptions;
4. preview-before-apply plans with revision, hash, and idempotency guards;
5. structured degradation warnings when a DCC feature cannot round-trip;
6. source-only open connectors that use a user's licensed DCC installation; and
7. the same normalized operations for a human operator and any Agent provider.

The integration is not intended to:

- parse proprietary `.ma`, `.mb`, `.max`, `.c4d`, `.hip`, `.uasset`, or Unity scene
  files inside the browser or Gateway;
- reproduce a DCC's control rig, dependency graph, simulation system, or node editor;
- claim lossless conversion of arbitrary shaders, constraints, simulations, or
  application-specific metadata; or
- expose an unauthenticated scripting console to the network.

## Three-layer architecture

```text
DirectorProject / Shot IR / stable asset identities
                    │
                    ▼
        1. Canonical DCC intermediate representation
           identity · metric space · rational time · optics
           hierarchy · deformation · materials · provenance
                    │
                    ▼
        2. Format adapters
           OpenUSD · GLB/glTF · OTIO · optional FBX fallback
           sidecar manifest · hashes · validation report
                    │
                    ▼
        3. Provider adapters
           Blender · Maya · Unreal · Houdini · Cinema 4D
           Unity · 3ds Max · Godot
           headless worker and/or in-host plug-in
```

Each layer has one responsibility. A provider adapter must not invent a competing
scene schema, and a format adapter must not contain Maya-, Unreal-, or Houdini-only
business rules.

### 1. Canonical DCC intermediate representation

The canonical IR is the only semantic contract shared by Director and provider
adapters. It is derived from a schema-validated `DirectorProject`, not from UI
state. The current `director-dcc-scene-v1` package is the starting point, not a
promise that every field below is already implemented.

The completed IR should define:

- immutable package ID, source revision, schema version, and content hashes;
- stable object, camera, shot, asset, skeleton, and material identities;
- parent hierarchy and explicit asset references rather than display-name lookup;
- right-handed, Y-up, metre-scale Director space with camera forward on local `-Z`;
- normalized quaternion transforms and the source/destination basis conversion;
- exact rational frame rate, drop-frame flag, start timecode, frame range, and
  evaluation sample times;
- physical camera aperture/sensor gate, focal length, focus distance, clipping,
  exposure metadata, anamorphic squeeze, and image aspect ratio;
- deformation skeleton, bind pose, skin weights, morph targets, root motion, and
  baked animation samples;
- portable material intent plus texture color space and relative content URI;
- collision, navigation, semantic tags, Agent affordances, and IK/control metadata;
- source application, source asset hash, bake settings, and degradation warnings.

Every entity that may return from a DCC needs a persistent `director:id`. Names are
labels and may change. A rename or reparent must not silently create a new entity.
Character objects must retain a concrete `assetRefId`; an Agent must never resolve a
character by array position or a hard-coded catalog entry.

### Coordinates and time

Provider adapters convert at their boundary. The canonical Director contract is:

| Property       | Canonical value                                       |
| -------------- | ----------------------------------------------------- |
| Handedness     | Right-handed                                          |
| Up axis        | `+Y`                                                  |
| Linear unit    | Metre                                                 |
| Camera forward | Local `-Z`                                            |
| Rotation       | Normalized quaternion; Euler only at an operator edge |
| Frame rate     | Rational numerator/denominator                        |
| Timecode       | Explicit start and drop-frame flag                    |

The adapter must transform points, vectors, normals, tangents, winding, bind
matrices, animation, and camera orientation with the same basis. Swapping Euler
components is not a valid conversion. Negative scale and mirrored hierarchies must
be represented in golden fixtures.

For broad OpenUSD compatibility, animation should default to time-sampled values.
Provider-specific animation-curve schemas may be emitted only after capability and
version discovery. Maya's current USD documentation, for example, states different
OpenUSD version requirements for camera/light and transform animation curves.

### Preserve, bake, or warn

Each provider feature must choose exactly one policy:

- **Preserve** when the canonical IR and selected format have equivalent semantics.
- **Bake** when evaluated results are portable but the authoring graph is not.
- **Warn and omit** when neither representation is safe or deterministic.

Control rigs, constraints, procedural graphs, deformers, MoGraph, Houdini networks,
and engine-only components normally remain authored in their source application.
Director receives a deformation skeleton, evaluated transforms or geometry, and a
sidecar recipe that identifies the source and bake settings. Silent flattening is
not permitted.

### 2. Format adapters

Format adapters compile canonical IR to transport artifacts and reconstruct an
import plan from validated artifacts. The format is a transport, not the source of
truth.

The current generic DCC package is specifically a **portable layout package**. Its
verified exchange-format capabilities are scene hierarchy/transforms and cameras.
Model files are copied as separate payloads and the Director manifest preserves
their stable references, but package creation alone does not prove that a target
DCC imported, reconstructed, or can edit their animation, deformation skeletons,
or materials. Those three capabilities remain `planned` until a version-tested
Director connector performs and validates the host-side work.

| Format                | Intended role                                                                                       | Boundary                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| OpenUSD               | Hierarchy, instances, cameras, lights, time samples, skeletons, layering, variants, material intent | DCC-specific graphs and arbitrary shaders still require baking or namespaced metadata    |
| GLB/glTF 2.0          | Fast web/runtime preview, PBR meshes, skins, morph targets, animation                               | Not a complete authoring or editorial round trip                                         |
| OTIO/OTIOZ            | Shot order, editorial tracks, rational ranges, references                                           | Object and skeletal animation belongs in the scene package, not OTIO                     |
| FBX                   | Compatibility fallback for established rig and animation pipelines                                  | Optional host-side adapter; SDK and redistribution terms must remain outside the core IR |
| Director sidecar JSON | Stable IDs, hashes, capabilities, semantics, collision/nav, warnings, and receipts                  | Schema-validated and versioned; never trusted because it came from a local DCC           |

The portable package should use relative, content-addressed asset URIs. Textures,
geometry, manifests, and reports must be individually hashed. Material exchange
should prefer MaterialX, OpenPBR, or UsdPreviewSurface where supported and include a
documented PBR fallback. Unsupported material networks remain a warning, not a
successful round-trip claim.

### 3. Provider adapters

A provider adapter is a thin boundary around official host APIs. It may contain:

- a headless launcher for deterministic CI and batch conversion;
- an in-host Python, C++, or C# plug-in for selection, review, and explicit
  **Send to Director** / **Receive from Director** actions;
- an optional preview transport for cameras, poses, or transforms; and
- a capability probe that reports host, plug-in, SDK, and format versions.

The baseline is a transactional snapshot or patch. Continuous live synchronization
is optional and must not be required to export, review, or recover a scene.

## Capability and maturity model

`native`, `exchange`, and `planned` describe how Director can provide a capability:

- **native** — a tested Director connector invokes the host and completes the
  documented workflow.
- **exchange** — the capability can be encoded in Director's portable package, but
  the operator must use an external importer/exporter or a connector not yet
  verified by Director.
- **planned** — the canonical intent exists, but no supported path is claimed.

Every built-in capability also declares the layer that supplies it:

| Capability layer    | Meaning                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| `connector`         | A Director-authored, provider-specific adapter performs and validates the operation in the host         |
| `exchange-format`   | The named portable format carries Director's verified subset; it says nothing about host-side ingestion |
| `director-manifest` | Director's sidecar preserves identity, hashes, revisions, warnings, or other non-format semantics       |

For generic exchange providers, only scene layout and cameras are currently
`exchange-format` capabilities. Stable IDs are a `director-manifest` capability.
Animation, skeletons, and materials are `connector: planned`, even though the USD
or glTF standards and some copied model payloads can represent versions of those
concepts. Standard expressiveness is not Director connector maturity.

Every built-in provider also declares its integration style:

| Integration        | Meaning                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `native-roundtrip` | An in-process Director bridge drives the host end to end (Blender)                                                                          |
| `engine-headless`  | A Director-authored connector runs fixed headless entry points inside the user's engine installation (Unreal, Unity, Godot)                 |
| `exchange-package` | Director only prepares or consumes the portable package; the operator uses external import/export (Maya, Houdini, Cinema 4D, 3ds Max, etc.) |

For the `engine-headless` providers, the connector promotes exactly the
capabilities it performs and validates: `headless`, `roundtrip`, and
`stable_ids` are `native`; `scene` and `camera` remain `exchange` because the
portable format still carries them; `animation`, `skeleton`, `materials`, and
`live_link` remain `planned` for Unity and Godot. The Unreal descriptor is the
one exception: its connector additionally promotes `animation` (Gateway-baked
Sequencer tracks), `skeleton` (skinned-GLB skeletal mesh import), and
`materials` (PBR material instances) to `native`, each backed by host-free
golden fixtures in `backend/gateway/tests/dcc/unreal*.test.ts`; Unreal
`live_link` stays `planned` because no Gateway transport ships yet.

Runtime readiness is separate:

- `installed` means an executable was detected;
- `exchangeReady` means Director can prepare the documented portable package;
- `nativeReady` means the provider-specific connector and its prerequisites passed
  their readiness checks.

For an engine connector, `nativeReady` is true only when the health check passes
end to end: the Director-authored connector manifest and entry points exist in
the repository, the engine executable was found and version-probed, the engine
project is configured, and the connector is installed inside that project. The
Gateway reads these locations from environment variables:

| Provider | Executable                   | Engine project            |
| -------- | ---------------------------- | ------------------------- |
| Unreal   | `DIRECTOR_UNREAL_EDITOR_BIN` | `DIRECTOR_UNREAL_PROJECT` |
| Unity    | `DIRECTOR_UNITY_BIN`         | `DIRECTOR_UNITY_PROJECT`  |
| Godot    | `DIRECTOR_GODOT_BIN`         | `DIRECTOR_GODOT_PROJECT`  |

An Agent must never infer `nativeReady` from `installed`.

## Support matrix

The matrix below separates the current Director claim from upstream official
capability. Upstream support makes an adapter feasible; it does not make the
Director adapter implemented.

| Provider         | Current Director maturity                          | Preferred portable path | Official automation surface                        | Native/live target                                                 | Priority |
| ---------------- | -------------------------------------------------- | ----------------------- | -------------------------------------------------- | ------------------------------------------------------------------ | -------- |
| Blender          | **Implemented native subset**                      | `.blend` + GLB/USDA     | Background CLI and Python API                      | Reviewed round trip plus preview-only live-link delta feed         | P0       |
| Autodesk Maya    | **Exchange**                                       | USDA, then GLB          | `mayapy`, `maya.standalone`, Python API 2.0        | Headless export/import plus authenticated in-host connector        | P0       |
| Unreal Engine    | **Implemented headless connector (scene/cameras/animation/skeleton/materials)** | USDA, then GLB          | Editor Python, commandlets, Interchange, Sequencer | Sequencer tracks, timecode, skeletal import, and material instances implemented; Live Link preview still planned | P0       |
| SideFX Houdini   | **Exchange**                                       | USDA, then GLB          | `hython`, HOM, HAPI, SessionSync                   | Headless bake/export; HAPI or SessionSync preview optional         | P1       |
| Cinema 4D        | **Exchange**                                       | USDA, then GLB          | Python SDK and `c4dpy`                             | Headless bake/export plus authenticated in-host connector          | P1       |
| Unity            | **Implemented headless connector (scene/cameras/animation/avatars/materials)** | GLB, then USDA          | Batch mode, C# Editor API, `AssetPostprocessor`    | Timeline animation baking, Avatars, lights, and PBR fallback implemented; preview transport still planned | P2       |
| Autodesk 3ds Max | **Exchange**                                       | USDA, then GLB          | `3dsmaxbatch`, Python, MAXScript                   | Windows headless adapter and optional in-host plug-in              | P2       |
| Godot 4          | **Implemented headless connector (deep)**          | GLB                     | `godot --headless`, GDScript editor plug-ins       | Baked animation, skeletons, materials, lights implemented; live preview still planned | P2       |

"Implemented headless connector" means the Director-authored connector performs
the headless scene/camera import and transform-level return round trip verified
by Director's host-free tests. The Unreal connector claims exactly the deeper
subset its fixtures verify: Gateway-baked transform/camera animation into
Sequencer, skinned-GLB skeletal mesh import, and PBR material instances — not
lossless USD animation, Control Rig transfer, or texture translation. Unity
bakes Director animation onto Timeline, builds Humanoid/Generic Avatars from
skinned GLB, and translates PBR materials, pinned by the in-package EditMode
suite plus the host-free Unity golden tests. Godot 4 ships Gateway-baked
`AnimationPlayer` animation, skinned GLB `Skeleton3D` import,
`StandardMaterial3D` translation with hashed external textures, and
Omni/Spot/Directional lights, backed by host-free goldens plus a skip-if-missing
real headless roundtrip. All three remain warned, bounded subsets, and live link
remains `planned` for every engine.

The table does not promise complete USD or glTF fidelity. Director only claims the
subset covered by its schemas, fixtures, validators, and provider acceptance tests.

## Provider research and adapter boundaries

### Autodesk Maya

Maya is the first proposed native adapter after Blender because it is a common
character, rigging, animation, and layout source.

Official capabilities:

- [`mayapy`](https://help.autodesk.com/cloudhelp/2026/ENU/Maya-Scripting/files/GUID-D64ACA64-2566-42B3-BE0F-BCE843A1702F.htm)
  provides a command-line Python interpreter with access to Maya libraries.
- External Python can initialize and release Maya through
  [`maya.standalone`](https://help.autodesk.com/cloudhelp/2022/ENU/Maya-Scripting/files/GUID-D457D6A0-1E7F-4ED2-B0B4-8B57153B563B.htm).
- [Python API 2.0](https://help.autodesk.com/cloudhelp/2024/ENU/MAYA-API-REF/py_ref/index.html)
  is the supported lower-overhead API surface for plug-ins and tools.
- [Maya USD export](https://help.autodesk.com/cloudhelp/2026/ENU/Maya-USD/files/USD-for-Maya/USD-import-export/GUID-3A763D43-E626-4832-9824-57AAA9BC0A00.html)
  documents meshes, skin clusters, skeletons, blendshapes, cameras, lights,
  animation, MaterialX, and UsdPreviewSurface options.
- Autodesk's [Unreal Live Link for Maya](https://help.autodesk.com/view/MAYAUL/2025/ENU/?guid=UnrealLiveLink_unreal_livelink_landing_html)
  demonstrates real-time character and camera streaming, but it is a Maya-to-Unreal
  connector, not a generic Director protocol.

Proposed Director boundary:

- run deterministic package export and validation through `mayapy`;
- use an in-host Python/C++ plug-in for selection and explicit transactions;
- bake control rigs, constraints, and unsupported deformation to the portable
  deformation skeleton and samples;
- retain Maya node IDs and bake provenance in namespaced metadata; and
- make any live camera/pose transport preview-only until committed.

Do not build the connector on Maya `commandPort`. Autodesk documents that
[`commandPort`](https://help.autodesk.com/cloudhelp/2024/ENU/Maya-Tech-Docs/CommandsPython/commandPort.html)
has no authentication and can execute commands with the user's privileges.

### Unreal Engine

Unreal Engine is the first implemented engine adapter because it owns Sequencer,
virtual production, camera evaluation, and high-quality final rendering workflows.
The Director-authored connector lives at `integrations/unreal/` (the
`DirectorBridge` Editor plugin with fixed Python entry points); the Gateway
invokes it through `UnrealEditor-Cmd` with `-ExecutePythonScript`.

Official capabilities:

- [Editor Python scripting](https://dev.epicgames.com/documentation/en-us/unreal-engine/scripting-the-unreal-editor-using-python)
  supports the full editor and `UnrealEditor-Cmd` commandlet execution; Epic labels
  the Python Editor API experimental.
- [USD in Unreal Engine](https://dev.epicgames.com/documentation/en-us/unreal-engine/universal-scene-description-in-unreal-engine)
  covers USD Stage workflows, meshes, skeletal data, lights, animation, and Level
  Sequence generation; Epic labels the feature Beta.
- [Interchange](https://dev.epicgames.com/documentation/en-us/unreal-engine/importing-assets-using-interchange-in-unreal-engine)
  provides an asynchronous and customizable import framework.
- [Sequencer Python](https://dev.epicgames.com/documentation/en-us/unreal-engine/python-scripting-in-sequencer-in-unreal-engine)
  exposes bindings, tracks, cameras, and rational frame rates.
- [Live Link](https://dev.epicgames.com/documentation/en-us/unreal-engine/live-link-in-unreal-engine)
  is the official extensible transport for time-varying animation and camera data.
- [Remote Control](https://dev.epicgames.com/documentation/en-us/unreal-engine/remote-control-for-unreal-engine)
  exposes HTTP/WebSocket control but remains a Beta feature.

Implemented Director boundary (see `integrations/unreal/README.md`):

- headless import spawns actors and `CineCameraActor`s from the exchange
  package, stamps `director:id` actor tags, maps storyboard shots to a
  `LevelSequence` with camera cuts, and echoes a canonical-space return package;
- headless export collects tagged actors, converts UE centimetre/Z-up transforms
  back to Director canonical space, and diffs against the exchange baseline;
- the Gateway samples Director's animation evaluators into a hash-pinned
  `director-unreal-sequencer-bake-v1` sidecar; the connector verifies the hash
  and keys LevelSequence transform and camera focal-length tracks with rational
  display rates, Sequencer tick resolutions, and SMPTE start timecodes
  (23.976 / 24 / 25 / 29.97 DF / 30 covered by host-free fixtures), then embeds
  a Sequencer receipt read back from the authored asset in its report;
- skinned GLB payloads (detected from the GLB JSON chunk only) import as
  skeletal meshes in bind pose and spawn tagged `SkeletalMeshActor`s;
- Director PBR parameters become Material Instances on Director-authored parent
  materials; unsupported channels warn-and-omit;
- an optional preview-only loopback camera feed (`--mode live-preview`) applies
  token-gated, sequence-numbered frames to the editor viewport with tested
  reorder/disconnect semantics — the `live_link` capability stays `planned`
  because no Gateway transport ships yet;
- the connector runs only its fixed entry points from `connector.json`; a
  request can never substitute its own script.

Still planned:

- rig pose and motion-clip transfer (Control Rig channels warn-and-omit today);
- texture-file translation (only bundled relative hashed files are considered);
- a Gateway Live Link transport for camera or pose preview (never durable scene
  authority);
- clean-frame render receipts;
- Remote Control stays optional rather than the security boundary; and
- `.uasset` files are never parsed or synthesized outside Unreal.

### SideFX Houdini

Houdini is the proposed procedural environment, instancing, world-building, and FX
adapter.

Official capabilities:

- [`hython` and command-line HOM](https://www.sidefx.com/docs/houdini/hom/commandline)
  allow Houdini Python execution without the interactive UI and require an
  appropriate Houdini license.
- [Houdini Engine API](https://www.sidefx.com/docs/houdini/ref/hengine.html)
  exposes the C and Python HAPI integration surface.
- [SessionSync](https://www.sidefx.com/docs/houdini/ref/henginesessionsync.html)
  supports bidirectional Houdini Engine sessions and viewport synchronization, with
  documented ownership and synchronization limitations.
- [glTF import/export](https://www.sidefx.com/docs/houdini/io/gltf.html) supports
  glTF 2.0 geometry, PBR data, and KineFX character/skin/animation paths.
- [Solaris USD output](https://www.sidefx.com/docs/houdini/nodes/out/usd.html) and
  [MaterialX](https://www.sidefx.com/docs/houdini/solaris/materialx) provide the
  native scene-description and material route.

Proposed Director boundary:

- use `hython` for deterministic evaluation, bake, and package export;
- leave HDAs and procedural dependency graphs as Houdini-owned sources;
- export evaluated meshes, instances, caches, collision/nav geometry, and an HDA
  parameter recipe;
- use HAPI/SessionSync only when the user's license and connector support it; and
- do not imply that installation includes a Houdini Engine or Batch license.

### Maxon Cinema 4D

Cinema 4D is the proposed motion-graphics and advertising adapter.

Official capabilities:

- the [Cinema 4D Python SDK](https://developers.maxon.net/docs/py/) supports
  scripts and plug-ins;
- [`c4dpy`](https://developers.maxon.net/docs/py/2026_1_0/manuals/manual_py_c4dpy.html)
  can load, construct, save, and render documents without the normal UI, but still
  requires a licensed Cinema 4D installation;
- [Cinema 4D USD](https://help.maxon.net/c4d/2026/en-us/Content/html/78533.html)
  documents transform animation, cameras, lights, USD/USDZ, and an incremental USD
  Bridge workflow; and
- [Cinema 4D glTF export](https://help.maxon.net/c4d/2026/en-us/Content/html/FGLTFEXPORTER.html)
  documents geometry, cameras, textures, and animation together with current light,
  material, and joint limitations.

Proposed Director boundary:

- use `c4dpy` for deterministic batch export and rendering;
- bake generators, deformers, and MoGraph where portable evaluated output is
  required;
- preserve source-object and generator provenance in the sidecar manifest; and
- treat the USD Bridge as a file-update workflow, not as a generic authenticated
  live-control API.

### Unity

Unity is an implemented real-time engine and previs adapter. Its stable baseline
differs from Unreal's because the official USD path is not yet a production
round-trip. The Director-authored connector lives at `integrations/unity/`
(the `com.director.bridge` UPM Editor package); the Gateway invokes it through
`-batchmode -executeMethod` with fixed C# methods.

Official capabilities:

- [batch-mode editor arguments](https://docs.unity3d.com/ja/2022.1/Manual/EditorCommandLineArguments.html)
  support `-batchmode`, `-projectPath`, and `-executeMethod` automation;
- [`AssetPostprocessor`](https://docs.unity3d.com/cn/6000.0/ScriptReference/AssetPostprocessor.html)
  provides C# import-pipeline hooks;
- the official [FBX Exporter](https://docs.unity3d.com/Packages/com.unity.formats.fbx%40latest/)
  documents model, light, camera, animation, and Timeline workflows; and
- the [USD Importer](https://docs.unity3d.com/Packages/com.unity.importer.usd%40latest/)
  is currently a pre-release package, while its exporter remains experimental.

Implemented Director boundary (see `integrations/unity/README.md`):

- a source UPM Editor package (`com.director.bridge`) with batch
  `-executeMethod` entry points for health, import, and export;
- headless import builds a Unity scene from the hash-verified exchange package,
  stamps a `DirectorId` component on every object, camera, and light, and
  echoes a canonical-space return package;
- GLB payloads are copied under content-hashed names and imported through the
  project's glTF `ScriptedImporter` (for example `com.unity.cloud.gltfast`);
  the connector never parses GLB bytes itself, and a missing importer
  warns-and-omits;
- Director storyboard shots map to Timeline activation tracks, and Director
  keyframe/trajectory animation is baked into `AnimationClip`s through C# ports
  of Director's easing and trajectory evaluators (unsupported channels
  warn-and-omit);
- skinned character payloads resolve by `assetRefId` and receive Humanoid
  Avatars when the Mixamo-compatible required bones resolve, Generic Avatars
  otherwise;
- Director PBR manifest materials fall back to URP/Lit or Built-in Standard by
  detected render pipeline, with hashed relative textures; unsupported graphs
  warn-and-omit;
- cameras import as physical Unity cameras (focal length, sensor-gate crop,
  lens shift; anamorphic squeeze warned and omitted), and lights map to Unity
  `Light` objects or `RenderSettings`;
- headless export reopens the scene, collects `DirectorId` components, converts
  Unity left-handed transforms back to Director canonical space, and diffs
  against the exchange baseline (objects and cameras only; the return contract
  has no light entity type);
- the C# math ports are pinned by an in-package EditMode (NUnit) suite and the
  host-free Gateway golden tests
  (`packages/dcc-protocol/tests/directorDccUnityConnectorGolden.test.ts`), so
  Unity is never required in CI;
- GLB remains the preferred portable asset format; Unity scene YAML is never an
  exchange format.

Still planned:

- an authenticated outbound preview connection rather than an exposed arbitrary
  C# execution endpoint (`live_link` stays `planned` until disconnect-safe
  transport tests exist); and
- production USD round trip (USD stays experimental until Director has
  version-pinned acceptance tests against the pre-release Unity packages).

### Autodesk 3ds Max

3ds Max is a proposed Windows adapter for architectural visualization and Autodesk
asset pipelines.

Official capabilities:

- [`3dsmaxbatch.exe`](https://help.autodesk.com/view/3DSMAX/2025/ENU/?guid=GUID-0968FF0A-5ADD-454D-B8F6-1983E76A4AF9)
  loads a scene, executes Python or MAXScript, and exits without the desktop UI;
- the [3ds Max developer portal](https://help.autodesk.com/view/MAXDEV/2026/ENU/)
  documents Python, MAXScript, and the SDK; and
- [3ds Max USD export](https://help.autodesk.com/cloudhelp/2026/ENU/3dsMax-USD/files/USD-for-3ds-Max/Import-and-export-USD-data-in-Max/GUID-DC04C60D-07CD-4844-AB96-4FDE25CCAD8C.html)
  documents cameras, lights, transform/camera/light animation, MaterialX,
  UsdPreviewSurface, USDSkel, skinning, blendshapes, and USDZ.

Proposed Director boundary:

- run a Windows `3dsmaxbatch` worker with bounded job directories;
- use Python/MAXScript only through fixed, versioned adapter entry points;
- bake unsupported modifiers and controllers with explicit warnings; and
- add an interactive plug-in only after headless golden fixtures pass.

### Godot 4

Godot is an implemented open-source real-time engine adapter. Its coordinate
system (right-handed, Y-up, metres, camera forward `-Z`) matches Director's
canonical space exactly, which makes it the lowest-conversion-cost engine path.
The Director-authored connector lives at `integrations/godot/` (the
`director_bridge` editor addon with a fixed headless GDScript entry point); the
Gateway invokes it through `godot --headless --script`.

Official capabilities:

- [Command line tutorial](https://docs.godotengine.org/en/stable/tutorials/editor/command_line_tutorial.html)
  documents `--headless`, `--script`, and project-scoped execution;
- [`GLTFDocument`](https://docs.godotengine.org/en/stable/classes/class_gltfdocument.html)
  provides runtime and editor glTF 2.0 import/export;
- [`EditorPlugin`](https://docs.godotengine.org/en/stable/classes/class_editorplugin.html)
  and `plugin.cfg` addons are the supported editor extension surface; and
- [Object metadata](https://docs.godotengine.org/en/stable/classes/class_object.html#class-object-method-set-meta)
  (`set_meta`/`get_meta`) persists Director stable IDs on nodes and scenes.

Implemented Director boundary (see `integrations/godot/README.md`):

- headless import builds a `Node3D` scene from the exchange package,
  instantiates GLB payloads through `GLTFDocument`, restores the Director
  parent hierarchy (exact under negative scale and mirrored transforms),
  stamps `director_id` metadata, preserves storyboard shots as scene metadata,
  saves `res://director/` scenes, and echoes a canonical-space return package;
- Director lights import as `OmniLight3D`/`SpotLight3D`/`DirectionalLight3D`
  nodes with `director_id`; ambient/hemisphere/rect lights warn-and-omit;
- glTF PBR payload materials import as `StandardMaterial3D` with Director PBR
  overrides applied on top; embedded textures are externalized to
  content-hashed `res://director/textures/` resources; custom shaders
  warn-and-omit;
- skinned GLB payloads import as `Skeleton3D` + skin, verified in bind pose
  and tagged with `director_id` on the skeleton root;
- the Gateway bakes Director timeline animation (easing curves, trajectories,
  camera path/follow actions, camera vertical fov) into a hash-pinned
  `director-godot-animation-bake-v1` sidecar; the connector verifies the
  SHA-256 and keys `AnimationPlayer`/`AnimationLibrary` tracks on the rational
  timebase (`seconds = frame * denominator / numerator`), while glTF payload
  animations are preserved as their own AnimationPlayers;
- the engine report carries a Godot-specific receipt (track/key counts and
  light/skeleton/material/texture counts) read back from the saved scene;
- `nativeReady` additionally requires the enabled addon entry in
  `project.godot` and a validated fixed-entry `--mode health` JSON line whose
  connector version matches the workspace (Godot 4.x only);
- headless export collects tagged nodes and diffs their transforms against the
  exchange baseline at matrix level (an identity basis change, since Godot
  matches Director), so mirrored transforms round-trip without false drift;
- GLB is the only advertised portable format; USDA is deliberately not claimed
  because Godot has no bundled USD importer.

Still planned:

- rig pose channels and character motion clips (only world transforms are
  baked; warn-and-omit); and
- an authenticated outbound preview transport (live link) — outbound to
  Director only, never an unauthenticated scripting port, and gated on
  disconnect tests before the capability claim moves.

## Agent discover-first workflow

An Agent must discover the environment before selecting a transport. The normalized
workflow is:

```text
1. Discover provider descriptors and capability levels.
2. Inspect each capability's `layer`; never treat an `exchange-format` or
   `director-manifest` claim as host-native behavior.
3. Read live provider status and connector/runtime versions.
4. Select native only when nativeReady is true and the required capability is
   `connector: native`.
5. Otherwise select a supported exchange format only when every required portable
   capability names that format and exchangeReady is true.
6. Export a versioned package into a server-owned job directory.
7. Validate schemas, paths, hashes, coordinate/timebase metadata, and dependencies.
8. Run the provider adapter or present explicit external-import instructions.
9. Build a read-only return plan and expose warnings/conflicts.
10. Apply only with the expected Director revision and an intent-scoped idempotency key.
11. Re-observe state, render clean evidence, and record the receipt.
```

The `director_dcc` tool implements this workflow today with:

- `discover` / `status` — provider descriptors, capability levels and layers,
  and truthful `installed` / `exchangeReady` / `nativeReady` readiness;
- `export_exchange_package` — portable GLB/USDA layout package for any provider;
- `send_to_engine` — headless handoff into Unreal, Unity, or Godot through the
  fixed Director-authored connector entry point (rejected with structured
  diagnostics when the connector is not `nativeReady`);
- `receive_from_engine` — validate an engine return package and build a
  read-only import plan (`skip_director_ids` supported);
- `import_return_package` / `apply_import_plan` — the same plan/apply path for
  Blender and engine returns, guarded by the exact expected revision and an
  idempotency key; and
- `export_blend`, `preview_blend_scene_import`, `apply_blend_scene_import` —
  the Blender-specific surfaces.

A capability is not available merely because it appears in this architecture
document or a catalog descriptor. The live status result and feature-status
documentation are authoritative.

When a native engine operation is not available, the Gateway returns structured
diagnostics instead of a bare failure, and an Agent should follow `recovery`
instead of retrying blindly:

```json
{
  "provider": "unreal",
  "mode": "native",
  "ready": false,
  "warnings": ["unreal executable was not found"],
  "recovery": [
    "Set DIRECTOR_UNREAL_EDITOR_BIN to the UnrealEditor-Cmd executable.",
    "Set DIRECTOR_UNREAL_PROJECT to the .uproject that hosts the DirectorBridge plugin.",
    "Retry with export_exchange_package for a portable USDA/GLB handoff."
  ]
}
```

### Declarative exchange-only providers

Studios can add a portable GLB/USDA provider without changing or executing Gateway
code. Copy `integrations/dcc-providers.example.json`, keep the file below the
repository's real `integrations/` directory, and start the Gateway with an
explicit path:

```bash
DIRECTOR_DCC_PROVIDER_CONFIG=integrations/dcc-providers.json npm run dev
```

The configuration contract is `director-dcc-provider-config-v1`. It cannot declare
commands, executable paths, native readiness, or native capability layers. The
Gateway validates the entire catalog before registering anything, rejects built-in
ID collisions, limits the file to 1 MiB, rejects a symlinked `integrations/` root,
and requires the resolved JSON file to remain inside that trusted directory. The
current portable layout package may advertise only scene, camera, and Director
stable-ID exchange; animation, skeleton, materials, round-trip, headless, and live
link remain `planned` until a tested connector supplies them.

## Transaction and synchronization modes

Provider adapters may advertise these modes independently:

| Mode       | Semantics                                                                                 | Baseline                |
| ---------- | ----------------------------------------------------------------------------------------- | ----------------------- |
| `snapshot` | Complete immutable package and receipt                                                    | Required                |
| `patch`    | Stable-ID changes against an exact source revision, reviewed before apply                 | Required for round trip |
| `live`     | Ephemeral ordered preview deltas; disconnect-safe and never authoritative until committed | Optional                |

Live mode must use sequence numbers, replay protection, capability/version
negotiation, and a clear distinction between preview state and a committed undo
group. Dropping a live connection must leave the last committed Director revision
intact. Provider-specific Live Link or SessionSync features may carry preview data,
but durable changes still pass through Director's validated patch and receipt path.

## Security boundary

A local DCC file and a headless DCC process are not a sandbox. The bridge must:

1. accept only explicit operator or authenticated Agent jobs;
2. bind the Gateway to loopback and require the existing Director token;
3. use argument arrays rather than shell command strings;
4. invoke fixed adapter entry points, never request-supplied Python, C#, MAXScript,
   HScript, or console text;
5. disable embedded auto-execution where the host supports it;
6. run in a private, size-limited, timeout-limited job directory;
7. reject traversal, absolute paths, remote URIs, symlink escape, and undeclared
   artifacts;
8. schema-validate and hash-verify every manifest and returned file;
9. preview the exact server-persisted plan before revision-guarded apply; and
10. recommend a VM, container, or isolated workstation for untrusted proprietary
    scene files.

In-host connectors should make an authenticated outbound connection to Director.
They should not expose a general-purpose scripting port. Unreal Remote Control,
Maya `commandPort`, and similar host surfaces are not substitutes for Director's
authentication and operation schemas.

## Open-source and redistribution boundary

The public repository may contain:

- Director-authored schemas, protocol code, validators, launchers, plug-ins, and
  reproducible fixtures;
- source adapters that load public APIs from a user's installed DCC;
- OpenUSD, glTF, OTIO, and MaterialX integrations used under their applicable
  licenses; and
- connector tests that skip with an explicit reason when the licensed host is not
  installed.

The repository should not contain vendor executables, SDK redistributions without
explicit permission, user license material, marketplace assets, model libraries,
or copied engine source. In particular:

- Autodesk describes the [FBX SDK](https://aps.autodesk.com/developer/overview/fbx-sdk)
  as available subject to its license; the safest open implementation keeps it an
  optional user-provided build dependency.
- Unreal connector distribution must follow the
  [Unreal Engine EULA](https://www.unrealengine.com/eula/unreal) and
  [UE source distribution rules](https://www.unrealengine.com/ue-on-github/).
- Houdini Engine, Cinema 4D, Maya, 3ds Max, Unity, and Unreal runtimes remain
  user-installed prerequisites.
- The exact license shipped by a pinned OpenUSD revision must be preserved; do not
  infer its terms from an older release. The upstream
  [OpenUSD release license](https://raw.githubusercontent.com/PixarAnimationStudios/OpenUSD/release/LICENSE.txt)
  is the authoritative text for that branch.
- Khronos describes [glTF](https://www.khronos.org/gltf/) as a royalty-free format;
  implementation dependencies still retain their own licenses.

## Acceptance fixtures

No provider becomes `nativeReady` from a smoke test alone. Its version-pinned
acceptance suite must cover:

- static geometry, hierarchy, instancing, negative scale, and mirrored transforms;
- a skinned character with bind pose, root motion, morph target, and animation;
- left/right coordinate conversion and camera forward-ray equivalence;
- focal length, sensor gate, focus distance, clipping, and animated camera values;
- PBR/MaterialX textures with relative paths and declared color spaces;
- 23.976, 24, 25, 29.97 drop-frame, and 30 fps with non-zero start timecode;
- a shot cut or engine timeline binding;
- collision and navigation geometry;
- stable identity after rename and reparent;
- deterministic export hashes or documented non-deterministic fields;
- interrupted process, timeout, missing dependency, malformed return, stale revision,
  and idempotent retry recovery; and
- a clean-frame render that excludes grids, labels, selections, gizmos, paths, and
  camera frusta.

Each provider/version pair should publish a machine-readable receipt containing
host version, connector version, format-library version, fixture hash, warnings,
and pass/fail evidence.

## Phased delivery roadmap

### Phase 0 — common contract and conformance

- Freeze provider IDs, capability vocabulary, readiness semantics, and package
  receipts.
- Extend canonical IR only through versioned schemas and migrations.
- Implement common USD/GLB/manifest validation and golden fixtures.
- Make discovery truthful when a provider is missing, installed without a
  connector, exchange-only, or native-ready.

### Phase 1 — Maya character and animation path

- Add `mayapy` headless export/import.
- Validate skeleton, bind pose, skin, morph, root motion, camera, and rational time.
- Add a source plug-in for selection, reviewed transactions, and stable IDs.
- Defer live pose/camera preview until snapshot and patch recovery pass.

### Phase 2 — Unreal virtual-production path

- ✅ Headless import/export through the `DirectorBridge` Editor plug-in.
- ✅ Shot editorial data mapped to Sequencer camera cuts.
- ✅ Gateway-baked transform/camera animation keyed into Sequencer tracks with
  rational rates and SMPTE start timecodes (hash-pinned bake sidecar).
- ✅ Skinned-GLB skeletal mesh import in bind pose with `director_id` tags.
- ✅ Director PBR parameters as Material Instances (warn-and-omit for the rest).
- ✅ Preview-only loopback camera protocol with tested reorder/disconnect
  semantics (capability stays `planned` until a Gateway transport ships).
- Add clean-frame render receipts.
- Promote Live Link once the Gateway transport exists, without making it the
  durable scene channel.

### Phase 3 — Houdini procedural path

- Add `hython` bake/export and HDA recipe metadata.
- Validate instances, caches, world geometry, collision, and materials.
- Add HAPI/SessionSync only as an optional licensed capability.

### Phase 4 — Cinema 4D motion-graphics path

- Add `c4dpy` batch conversion and source plug-in.
- Define generator, deformer, MoGraph, material, and animation bake policies.

### Phase 5 — Unity, Godot, and 3ds Max paths

- ✅ The Unity UPM package (`com.director.bridge`) with batch import/export,
  Timeline shot mapping and baked Director animation, Humanoid/Generic Avatars,
  PBR material fallback, physical cameras, and lights.
- ✅ The Godot `director_bridge` addon with `--headless` import/export around GLB.
- ✅ Deep Godot 4 coverage: Gateway-baked `AnimationPlayer` animation on a
  rational timebase, skinned GLB `Skeleton3D` in bind pose,
  `StandardMaterial3D` translation with hashed external textures,
  Omni/Spot/Directional lights, and readiness gated on the enabled addon plus a
  fixed-entry health JSON probe.
- Add the Windows `3dsmaxbatch` worker around USD and validated fixtures.
- Keep Unity USD export experimental until the upstream package and Director tests
  justify a stronger claim.

### Phase 6 — optional live collaboration

- Add ordered preview deltas, reconnect, and commit boundaries.
- Keep snapshot/patch as the recovery and reproducibility path.
- Promote a provider to live-ready only after disconnect, reorder, duplicate,
  concurrent edit, and undo tests pass.

## Decision summary

Director integrates many DCCs by standardizing semantics, validation, review, and
Agent operations—not by copying every host's internal scene model. Canonical IR is
the semantic source, format adapters are portable transports, and provider adapters
are replaceable execution boundaries. Offline/headless exchange is the required
foundation; native plug-ins and live links are progressively enhanced capabilities.
