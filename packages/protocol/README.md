# @director/protocol — Transport Contracts

> Languages: **English** · [中文](README.zh-CN.md)

Core shared transport contracts for Director. Contains Zod schema definitions, protocol constants, JSON definitions, and test helpers consumed by the Director frontend, Gateway, and Blender session.

**Package:** `@director/protocol` — `"main": "./src/index.ts"` — Depends: `zod`

## Files

| Path | Purpose |
| --- | --- |
| `index.ts` | Barrel export for all public contracts |
| `primitives.ts` | Primitive utilities: clamp, isRecord, protocolKeys, asset catalog claim normalization |
| `stableJson.ts` | Deterministic JSON serialization (locale-aware / code-point ordering) for fingerprints and hashing |
| `strictProtocolVariant.ts` | Zod helper factories: strictAction, strictOperation, strictKind, etc. for discriminated union builders |
| `agentGatewayProtocol.ts` | Agent gateway HTTP transport contracts: Assistant chat status, command status, target configuration |
| `agentTools.ts` | Agent tool name enumeration and classification (Stage commands vs workbench vs creative) |
| `agentTools.json` | Agent tool name → category mapping data |
| `agentSessionCapabilities.json` | Agent session capability declaration data |
| `stageProtocol.ts` | Stage constants: geometry kinds, camera moves, shake, gait enum schemas |
| `creativeWorkspaceProtocol.ts` | Canvas/Video Editor agent surface transport contract: nodes, edges, clips, timeline operations |
| `productionJobProtocol.ts` | Production job protocol: job statuses, kinds, input schemas (ComfyUI, generated 3D, transcription) |
| `productionJobKinds.json` | Production job kind and status enumeration data |
| `videoGenerationProtocol.ts` | Video generation contract: provider IDs, job statuses, render input, LTX constraints |
| `comfyGenerationProtocol.ts` | ComfyUI generation protocol: media kinds, parameter schemas, node definitions, prompt provenance |
| `generated3dProtocol.ts` | Generated 3D protocol: provider IDs, modes, topology, job input schemas |
| `episodeProtocol.ts` | Synthetic data episode contract: manifest, action track, captions with frame-level indexing |
| `mediaTranscriptionProtocol.ts` | Media transcription protocol: transcript segment and full transcript schemas |
| `productionArtifactProtocol.ts` | Production artifact versioning, promotion, and approval contracts |
| `captureReconstructionProtocol.ts` | Capture reconstruction contract: RGB-D scene reconstruction, walls/objects/key views |
| `referenceSceneReconstructionProtocol.ts` | Reference scene reconstruction protocol: geometry, lights, image input schemas |
| `assetCatalogProtocol.ts` | Asset catalog v2 schema: identifiers, kinds, formats, license metadata |
| `directorCameraProtocol.ts` | Camera protocol: aspect ratio enum (16:9, 9:16, 2.39:1, etc.) |
| `directorColorMetadata.ts` | Color metadata contract: primaries, transfer, matrix, range, role |
| `directorProceduralProtocol.ts` | Procedural generation protocol: linear/radial array, grid, scatter, random transform operations |
| `directorProductionProtocol.ts` | Production protocol: scene references, editorial shots, production record schemas |
| `directorCollaborationGatewayProtocol.ts` | Collaboration gateway protocol: rooms, WebSocket messages, base64 payload schemas |
| `filmPipelineProtocol.ts` | Film pipeline protocol: characters, shots, scenes, pipeline phases |
| `filmProductionProtocol.ts` | Film production protocol: workflows, brief, role deliverables schemas |
| `filmRoles.ts` | Film role ID enumeration: 12 roles including showrunner, screenwriter, cinematographer |
| `filmTimelineOtio.ts` | OTIO timeline builder: generates OTIO JSON from FilmRun for Video Editor import |
| `worldSystemsProtocol.ts` | World systems protocol: emitter effects, water bodies, wildlife, weather/time-of-day |
| `blenderLiveProtocol.ts` | Blender live protocol: native tool requests, transforms, primitives, lights, materials |
| `blenderKernel.ts` | Blender kernel policy: frozen typed modeling operations and operator/RNA allowlist |
| `vehicleProtocol.ts` | Drivable vehicle protocol: vehicle profile (mass, engine force, suspension, etc.) |

Local asset acceptance tests are gated by [`tests/localAssetTest.ts`](tests/localAssetTest.ts) (`DIRECTOR_LOCAL_ASSET_TESTS=1`). That helper is not a transport contract and is not exported from `src/`.

## Build

`npm run build` type-checks all protocol files. The Blender kernel policy must stay in sync with its Python copy at `integrations/blender/live/addons/worldengine_studio/kernel_policy.py`.