# @director/stage-protocol — Stage Protocol

> Languages: **English** · [中文](README.zh-CN.md)

Stage scene schema, types, default scene factory, and prop catalog for Director.

**Package:** `@director/stage-protocol` — `"main": "./src/index.ts"` — Depends: `zod`, `@director/protocol`

## Files

| Path | Purpose |
| --- | --- |
| `index.ts` | Barrel export for all public modules |
| `sceneSchema.ts` | Stage scene Zod schema: discriminated union for humanoids, props, primitives, cameras, tracks, keyframes |
| `types.ts` | Stage scene type exports: Scene, Object, Camera, Track, Item, etc. |
| `defaultScene.ts` | Default scene factory: parses `defaultScene.json`, deep-clones, and provides `createStageId` utility |
| `defaultScene.json` | Default scene JSON data: preset humanoid, target, camera, and track |
| `propCatalog.ts` | Prop catalog: preset prop definitions for chair, table, sofa, tree, rock, boat, car, cat, horse, wall |

## Build

Type-checked as part of the root `npm run build` as an npm workspace.