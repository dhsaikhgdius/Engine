# @director/dcc-protocol — DCC Protocol

> Languages: **English** · [中文](README.zh-CN.md)

DCC (Digital Content Creation) interop protocol layer. Defines exchange contracts, import/export formats, provider capability declarations, and return change schemas between Blender, Blender, and Director.

**Package:** `@director/dcc-protocol` — `"main": "./src/index.ts"` — Depends: `zod`, `@director/protocol`

## Files

| Path | Purpose |
| --- | --- |
| `index.ts` | Barrel export for all DCC contracts |
| `directorDccContract.ts` | Core DCC contract: coordinate system conversion (Three.js ↔ Blender), project round-trip serialization |
| `directorDccExchangePackageContract.ts` | DCC exchange package contract: zip packaging for GLB/USDA, SHA-256 verification, manifest definition |
| `directorDccProviderContract.ts` | DCC provider contract: provider IDs, exchange formats, capability declarations, feature flags schema |
| `directorDccReturnContract.ts` | DCC return contract: import plan for mesh replacement, transform updates, animation, material changes |
| `directorBlendSceneImportContract.ts` | Blender scene import contract: import plan for cameras, meshes, lights, materials, animations |
| `directorDccSharedContract.ts` | DCC shared types: finite numbers, Vec3, quaternion, transform schema (with normalization validation) |

## Build

Type-checked as part of the root `npm run build` as an npm workspace.