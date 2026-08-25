---
title: Multi-DCC Integration Architecture
description: A capability-driven, format-neutral architecture for connecting Director to major DCCs and real-time engines.
---

## Scope and status

Director should interoperate with the tools already used for character animation,
procedural environments, motion graphics, virtual production, and final rendering.
It should not make Blender, Maya, Unreal Engine, Houdini, Cinema 4D, Unity, or 3ds
Max into a second source of truth, and it should not require an Agent to understand
each application's menu layout or private file format.

This document defines the target architecture for that interoperability. It uses
the following status vocabulary:

- **Implemented** — present in Director, covered by tests, and available through a
  user or Agent control surface.
- **Exchange** — Director can prepare or consume its documented portable format
  subset, but there is no verified native connector for that provider.
- **Proposed** — an intended provider adapter or capability, not a claim about the
  current runtime.

At the time of writing, Blender is the only implemented native DCC round trip.
Director also has documented, deliberately limited glTF/GLB and USD interchange
subsets. The Maya, Unreal Engine, Houdini, Cinema 4D, Unity, and 3ds Max native
adapters described below are proposed. Detecting an installed executable does not
make its native adapter ready. See [Blender Scene Import and Round Trip](/engineering/blender_bridge/)
for the existing Blender behavior and [Interchange & DCC Handoff](/pipelines/interchange/)
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
           Unity · 3ds Max
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

Runtime readiness is separate:

- `installed` means an executable was detected;
- `exchangeReady` means Director can prepare the documented portable package;
- `nativeReady` means the provider-specific connector and its prerequisites passed
  their readiness checks.

An Agent must never infer `nativeReady` from `installed`.

## Support matrix

The matrix below separates the current Director claim from upstream official
capability. Upstream support makes an adapter feasible; it does not make the
Director adapter implemented.

| Provider         | Current Director maturity     | Preferred portable path | Official automation surface                        | Native/live target                                           | Priority |
| ---------------- | ----------------------------- | ----------------------- | -------------------------------------------------- | ------------------------------------------------------------ | -------- |
| Blender          | **Implemented native subset** | `.blend` + GLB/USDA     | Background CLI and Python API                      | Existing reviewed round trip; interactive live link proposed | P0       |
| Autodesk Maya    | **Exchange**                  | USDA, then GLB          | `mayapy`, `maya.standalone`, Python API 2.0        | Headless export/import plus authenticated in-host connector  | P0       |
| Unreal Engine    | **Exchange**                  | USDA, then GLB          | Editor Python, commandlets, Interchange, Sequencer | Editor plug-in; Live Link only for preview                   | P0       |
| SideFX Houdini   | **Exchange**                  | USDA, then GLB          | `hython`, HOM, HAPI, SessionSync                   | Headless bake/export; HAPI or SessionSync preview optional   | P1       |
| Cinema 4D        | **Exchange**                  | USDA, then GLB          | Python SDK and `c4dpy`                             | Headless bake/export plus authenticated in-host connector    | P1       |
| Unity            | **Exchange**                  | GLB, then USDA          | Batch mode, C# Editor API, `AssetPostprocessor`    | UPM Editor package; custom preview transport optional        | P2       |
| Autodesk 3ds Max | **Exchange**                  | USDA, then GLB          | `3dsmaxbatch`, Python, MAXScript                   | Windows headless adapter and optional in-host plug-in        | P2       |

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

Unreal Engine is the first proposed engine adapter because it owns Sequencer,
virtual production, camera evaluation, and high-quality final rendering workflows.

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

Proposed Director boundary:

- use a commandlet for deterministic imports, exports, Sequencer baking, and CI;
- use a Director-authored Editor plug-in for stable IDs and reviewed transactions;
- map Shot/OTIO editorial ranges to Sequencer and object animation to USD samples;
- use Live Link for temporary camera or pose preview, not durable scene authority;
- treat Remote Control as optional rather than the security boundary; and
- never parse or synthesize `.uasset` files outside Unreal.

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

Unity is a proposed real-time engine and previs adapter. Its stable baseline differs
from Unreal's because the official USD path is not yet a production round-trip.

Official capabilities:

- [batch-mode editor arguments](https://docs.unity3d.com/ja/2022.1/Manual/EditorCommandLineArguments.html)
  support `-batchmode`, `-projectPath`, and `-executeMethod` automation;
- [`AssetPostprocessor`](https://docs.unity3d.com/cn/6000.0/ScriptReference/AssetPostprocessor.html)
  provides C# import-pipeline hooks;
- the official [FBX Exporter](https://docs.unity3d.com/Packages/com.unity.formats.fbx%40latest/)
  documents model, light, camera, animation, and Timeline workflows; and
- the [USD Importer](https://docs.unity3d.com/Packages/com.unity.importer.usd%40latest/)
  is currently a pre-release package, while its exporter remains experimental.

Proposed Director boundary:

- ship a source UPM Editor package plus batch `executeMethod` entry points;
- prefer GLB for portable runtime assets and the official FBX path for established
  Unity animation/Timeline workflows;
- keep USD import experimental until Director has version-pinned acceptance tests;
- map Director shot ranges into Timeline without making Unity scene YAML an
  exchange format; and
- use an authenticated outbound connection for optional preview rather than an
  exposed arbitrary C# execution endpoint.

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

The common capability surface should converge on operations such as:

- inspect provider capabilities and readiness;
- export scene or selection;
- import a reviewed package;
- synchronize a camera or animation take;
- validate round-trip invariants;
- commit a bounded patch; and
- undo the committed transaction.

These names describe the target provider-neutral surface. A capability is not
available merely because it appears in this architecture document or a catalog
descriptor. The live status result and feature-status documentation are authoritative.

An Agent should return structured diagnostics instead of retrying blindly:

```json
{
  "provider": "maya",
  "mode": "exchange",
  "ready": false,
  "warnings": ["Control rig requires deformation bake"],
  "recovery": ["Install and enable the Director Maya connector", "Retry as USDA exchange"]
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

- Add commandlet import/export and a Director Editor plug-in.
- Map shot editorial data to Sequencer and scene animation to USD.
- Add clean-frame render receipts.
- Add Live Link preview without making it the durable scene channel.

### Phase 3 — Houdini procedural path

- Add `hython` bake/export and HDA recipe metadata.
- Validate instances, caches, world geometry, collision, and materials.
- Add HAPI/SessionSync only as an optional licensed capability.

### Phase 4 — Cinema 4D motion-graphics path

- Add `c4dpy` batch conversion and source plug-in.
- Define generator, deformer, MoGraph, material, and animation bake policies.

### Phase 5 — Unity and 3ds Max paths

- Add the Unity UPM package and batch export around GLB/FBX and Timeline.
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
