# Tool Scripts

> Languages: **English** · [中文](README.zh-CN.md)

## Overview

`tools/scripts/` is the repository automation directory for WorldEngine: asset pipeline, LTX-2 video model integration, codebase quality checks, launchers, and agent skill synchronization. Scripts are run directly with `node`, `tsx`, or `blender --python` — no extra build step required.

Sibling directories under `tools/`:

| Path | Purpose |
|---|---|
| [`tools/README.md`](../README.md) | Vite, Vitest, ESLint, TypeScript, and PostCSS/Tailwind configs |
| [`tools/e2e/`](../e2e/README.md) | Playwright end-to-end tests (`npm run test:e2e`) |
| [`tools/evals/`](../evals/README.md) | Agent golden-task evals (`npm run eval`) |

---

## Complete Script Inventory

### Asset Pipeline

| File | Purpose |
|---|---|
| `director-assets.mjs` | Asset manifest CLI: `status`, `install` (pull from Hugging Face), `verify` (SHA256 check), `release-check` |
| `director-assets.test.mjs` | Vitest test suite for `director-assets.mjs` |
| `asset-ingest.ts` | Unified Asset Catalog v2 ingest CLI: registers model files under `assets/library/<library>/` into `catalog.v2.json` with upsert, GLB spatial bounds, and quality gates |
| `asset-ingest.test.ts` | Vitest test suite for `asset-ingest.ts` |
| `assetIngestGates.ts` | Game-grade quality gates (pure functions, no FS): checks triangle count, texture dimensions, vertex count, bounding boxes for GLB/GLTF/FBX/OBJ |
| `assetIngestGates.test.ts` | Vitest test suite for `assetIngestGates.ts` |
| `generate-flick-metadata.mjs` | Deterministic Chinese localization + tagging overlay for Flick stage-props: reads `catalog.json`, generates `metadata.i18n.json` via hand-authored dictionaries (no network, no LLM, byte-identical output) |
| `generate-flick-metadata.test.ts` | Vitest test suite for `generate-flick-metadata.mjs` (cross-checks against Zod schema) |
| `run-local-asset-tests.mjs` | Local asset test runner: checks asset file availability, then runs vitest asset test suite (`--check-assets` reports only) |

### LTX-2 Video Model

| File | Purpose |
|---|---|
| `bootstrap-ltx2-source.mjs` | Bootstrap LTX-2 source: pulls upstream repo via git submodule, verifies license acceptance, checks out the pinned commit |
| `ltx2-source.mjs` | Shared LTX-2 source utilities: reads `vendor/ltx-2.lock.json`, resolves source root, validates license acceptance, verifies checkout integrity |
| `ltx2-source.test.mjs` | Vitest test suite for `ltx2-source.mjs` |
| `ltx23-generate.py` | One-shot DistilledPipeline CLI; Gateway spawns this per video job |

### Inference source submodules

| File | Purpose |
|---|---|
| `inference-source.mjs` | Shared Hunyuan3D / TRELLIS / ARDY lock reader, license-acceptance gate, and checkout verifier |
| `bootstrap-inference-source.mjs` | Initialize a pinned inference submodule from its `*.lock.json` and detach to the locked commit |
| `inference-source.test.mjs` | Vitest suite for `inference-source.mjs` |

### Repository Checks

| File | Purpose |
|---|---|
| `check-open-source-boundary.mjs` | Open-source boundary check: forbids binary blobs (`.glb`, `.fbx`, `.onnx`, `.safetensors`, etc.) and unlicensed files in the source tree, enforces max source file size (5MB) |
| `check-native-agent-integration.mjs` | Native Agent integration check: verifies skill directories are real (not symlinks), `sync-agent-skills` sync status, and Agent MCP config consistency |
| `check-i18n-completeness.mjs` | i18n completeness gate: fails when a new untranslated Chinese UI string appears in `frontend/director/src` (not covered by `en-US.json` or a phrase rule); known gaps live in `i18n-missing-baseline.json` and may only shrink (`--update-baseline` refreshes intentionally) |
| `i18n-completeness.mjs` | Library behind the i18n gate: TypeScript-AST extraction of Chinese string literals/JSX text plus coverage checks; unit-tested in `i18n-completeness.test.ts` |
| `check-build-chunk-budget.mjs` | Vite build chunk budget check: warns when application chunks exceed 800KB (not enforced, a growth signal monitor) |
| `checkServerImportBoundaries.ts` | Server import boundary check: parses TypeScript AST to prevent Gateway code from importing browser-only React/Three.js packages, validates pure Agent/Stage/DCC module isolation |

### Launchers

| File | Purpose |
|---|---|
| `stage-cli.mjs` | Stage CLI: HTTP client for Director Gateway tools. Prefer `director_workbench`, `director_creative`, `director_dcc`, `stage_video`. Legacy compact: `stage_read`, `stage_scene`, `stage_object`, `stage_camera`, `stage_show`. `npm run stage -- --help` |
| `blender.mjs` | Blender launcher: locates Blender 4.2+, launches the WorldEngine Blender backend (`worldengine_backend.py`), supports `run` and `test` commands |

### Agent Integration

| File | Purpose |
|---|---|
| `sync-agent-skills.mjs` | Copies `.claude/skills/director-workbench/` to the plugin tree, and writes per-agent MCP/instruction adapters from `agent-integrations.mjs` |
| `agent-integrations.mjs` | Single definition for Director MCP launch plus generated adapters (`.cursor/mcp.json`, `.codex/config.toml`, `CLAUDE.md`, …); `repo:check` requires those files to match |
| `agent-integrations.test.mjs` | Vitest test suite for `agent-integrations.mjs` |
| `dsh-director.mjs` | Write the Director overlay and launch the pinned official DeepSeek Harness Web profile (`@deepseek-ai/dsh@0.1.0-rc.6`) from the repository root so `.dsh/skills/director-workbench` is discovered; passes `STAGE_GATEWAY_URL` / `DIRECTOR_GATEWAY_TOKEN` / `DIRECTOR_TARGET_TOKEN` through when set and adds `--no-open` for `CI` / `DIRECTOR_DSH_NO_OPEN=1` (`npm run dsh`) |
| `dsh-director.test.mjs` | Vitest test suite for `dsh-director.mjs` (overlay patch shape, headless `--no-open`, env passthrough) |

### Miscellaneous

| File | Purpose |
|---|---|
| `normalize-generated-mcp-bundle.mjs` | Normalize generated MCP plugin bundle: strips trailing whitespace from esbuild's `server.mjs` output for reproducible builds |
| `generate_open_mannequin.py` | Generate StoryAI Open Mannequin GLB: Blender Python script that creates the redistributable MIT-licensed mannequin from procedural geometry and materials |
| `package_mixamo_animations.py` | Package Mixamo animations: Blender Python script that converts local Mixamo FBX animation files into deterministic GLB clips, generates `catalog.json` with source provenance and license info |

---

## package.json Script References

The following `package.json` scripts directly invoke files in `tools/scripts/`:

| npm Script | Invoked Script |
|---|---|
| `npm run assets:status` | `tools/scripts/director-assets.mjs status` |
| `npm run assets:install` | `tools/scripts/director-assets.mjs install` |
| `npm run assets:verify` | `tools/scripts/director-assets.mjs verify --required-only` |
| `npm run assets:release-check` | `tools/scripts/director-assets.mjs release-check` |
| `npm run test:assets` | `tools/scripts/run-local-asset-tests.mjs` |
| `npm run build` | `tools/scripts/check-build-chunk-budget.mjs` (after `tsc` and `vite build`) |
| `npm run build:mcp-plugin` | `tools/scripts/normalize-generated-mcp-bundle.mjs` (after esbuild) |
| `npm run setup:ltx2` | `tools/scripts/bootstrap-ltx2-source.mjs` |
| `npm run setup:hunyuan3d` | `tools/scripts/bootstrap-inference-source.mjs vendor/hunyuan3d.lock.json` |
| `npm run setup:trellis` | `tools/scripts/bootstrap-inference-source.mjs vendor/trellis.lock.json` |
| `npm run setup:ardy` | `tools/scripts/bootstrap-inference-source.mjs vendor/ardy.lock.json` |
| `npm run stage` | `tools/scripts/stage-cli.mjs` |
| `npm run lint` | `tools/scripts/checkServerImportBoundaries.ts` (after ESLint) |
| `npm run repo:check` | `tools/scripts/check-open-source-boundary.mjs` + `tools/scripts/check-native-agent-integration.mjs` + `tools/scripts/check-i18n-completeness.mjs` |
| `npm run sync:skills` | `tools/scripts/sync-agent-skills.mjs` |
| `npm run sync:blender-operations` | `tools/scripts/sync-blender-operation-manifest.mjs` |
| `npm run dsh` | `tools/scripts/dsh-director.mjs` |
| `npm run dsh:prepare` | `tools/scripts/dsh-director.mjs --prepare-only` |
| `npm run blender` | `tools/scripts/blender.mjs run` |
| `npm run blender:test` | `tools/scripts/blender.mjs test` |

The following scripts are not directly exposed as `npm run` commands in `package.json` and must be invoked manually:

- `asset-ingest.ts` — run via `npx tsx tools/scripts/asset-ingest.ts`
- `generate-flick-metadata.mjs` — run via `node tools/scripts/generate-flick-metadata.mjs`
- `generate_open_mannequin.py` — run via `blender --background --python tools/scripts/generate_open_mannequin.py -- --output <path>`
- `package_mixamo_animations.py` — run via `blender --background --python tools/scripts/package_mixamo_animations.py -- --source-dir <dir> --output-dir <dir>`
