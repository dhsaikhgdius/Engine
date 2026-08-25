# @director/dcc-interchange — DCC Interchange

> Languages: **English** · [中文](README.zh-CN.md)

DCC format conversion engine. Provides bidirectional GLTF (glTF/GLB) and USD (USDA/USDZ) export/import, Mixamo character catalog parsing, model library management, and encoding/camera orientation utilities.

**Package:** `@director/dcc-interchange` — `"main": "./src/index.ts"` — Depends: `zod`, `three`, `@gltf-transform/core`, `jszip`, `@director/protocol`, `@director/project-schema`

## Files

| Path | Purpose |
| --- | --- |
| `index.ts` | Barrel export for all interchange modules |
| `contract.ts` | Core interchange contract: coordinate system constants (meter, Y-up, right-handed), manifest definition, import/export interfaces |
| `gltf.ts` | GLTF/GLB adapter: Director project ↔ glTF export/import with camera, transform, and material conversion |
| `usd.ts` | USD/USDZ adapter: Director project ↔ USDA/USDZ export/import with zip packaging and manifest |
| `encoding.ts` | UTF-8 ↔ Base64 encoding/decoding utilities |
| `cameraOrientation.ts` | Camera orientation math: derives look-at quaternion and Euler from position→target for glTF/USD |
| `mixamoCharacterCatalog.ts` | Mixamo character catalog parser: JSON parsing, alias matching, default X-Bot fallback |
| `mixamoCharacterCatalog.json` | Mixamo character catalog data |
| `characterCatalogParser.ts` | Generic character catalog parser: field mapping, aliases, deduplication, height/offset extraction |
| `modelLibraryCatalog.ts` | Model library catalog: Flick categories, native actions, ModelLibraryItem type definitions |
| `flickSourceCategories.json` | Flick source category data |
| `flickNativeItems.json` | Flick native action items data |
| `flickStandardCategories.json` | Flick standard category data |

## Build

Type-checked as part of the root `npm run build` as an npm workspace.