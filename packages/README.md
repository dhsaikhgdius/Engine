# Shared Packages

> Languages: **English** · [中文](README.zh-CN.md)

These are npm workspaces shared across the frontend and backend — transport contracts and process-agnostic runtime logic. Official Python model sources live in `vendor/`, not here.


| Package path       | Name                        | Purpose                                                                                           |
| ------------------ | --------------------------- | ------------------------------------------------------------------------------------------------- |
| `protocol/`        | `@director/protocol`        | Transport contracts: Zod schemas, Stage protocol, Agent gateway, video generation, Blender kernel |
| `stage-protocol/`  | `@director/stage-protocol`  | Stage scene schema, types, default scene factory, and prop catalog                                |
| `project-schema/`  | `@director/project-schema`  | DirectorProject types, camera geometry, poses, animation, timeline                                |
| `agent-engine/`    | `@director/agent-engine`    | Agent engine: workbench contracts, command execution, authoring, audit, automation                |
| `dcc-protocol/`    | `@director/dcc-protocol`    | DCC interop protocol: Blender exchange, Blender import/export contracts                           |
| `dcc-interchange/` | `@director/dcc-interchange` | DCC format conversion: glTF/USD export/import, Mixamo catalog, model library                      |
| `model-provider/`  | `@director/model-provider`  | Pluggable LLM providers and Model Drivers                                                         |
| `di/`              | `@director/di`              | Lightweight dependency-injection container used by the Gateway                                    |
| `scene-pipeline/`  | `@director/scene-pipeline`  | Text-to-layout scene pipeline (planner, assembler, validator)                                     |
| `dsh-plugin-workbench/` | `@director/dsh-plugin-workbench` | DeepSeek Harness plugin: Stage, Canvas, Video Editor, and Blender tools                      |




## Build

All TypeScript packages are npm workspaces listed in the root `package.json`; `npm run build` at the repo root type-checks them (`tsc -p tools/tsconfig.json`). `packages/tsconfig.json` is a thin `extends` so the IDE finds that project from package source files.

The Gateway spawns `tools/scripts/ltx23-generate.py` against `vendor/ltx-2` after `npm run setup:ltx2`.