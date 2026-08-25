---
title: Install & Run
description: Install Director, start its services, and verify the local environment.
---

## Requirements

- Node.js 22 LTS is recommended.
- npm 10 or later.
- A browser with WebGL 2 support.
- Xcode Command Line Tools on macOS when the optional native terminal dependency must be rebuilt.
- A compatible local Blender 4.2+ binary when using the integrated Blender native backend.

## Install the application

From the repository root:

```bash
npm install
npm run dev
```

`npm run dev` starts both the Vite UI (`5175`, the editor you operate) and the Agent gateway
(`8787`, HTTP / MCP / CLI / health).

Binary runtime assets are intentionally not stored in Git. A source-only checkout can build and run core
tests; install the cleared asset bundle with `npm run assets:install` after creating a pinned
`assets/manifest.lock.json`. Mixamo and unresolved mirrored assets remain user-provided. See
[Open-source Assets & Hugging Face](/development/open-source-assets/).

Open:

- UI: <http://127.0.0.1:5175>
- gateway health: <http://127.0.0.1:8787/health>

## Run the integrated native product

For normal Director-only staging, keep using `npm run dev`. For the bound Blender scene,
native Mesh editor, and native Rig inspector, run from the same repository root:

```bash
npm run blender
```

The launcher checks `BLENDER_BIN`, then `.runtime/blender-build` if a
binary is already there, then a standard local Blender install. Set
`BLENDER_BIN` when none of those paths is correct.

```bash
npm run blender:test
```

The native project defaults to `data/blender/director-native.blend`. Override it with
`DIRECTOR_BLENDER_PROJECT_FILE` when a production needs an explicit project file. Director and
Blender still operate as one bound production; `.blend` import and DCC round trip are separate,
optional file workflows.

## Run services separately

```bash
npm run dev:ui
npm run dev:gateway
```

The production gateway can also be started without watch mode:

```bash
npm run gateway
```

## Install and run the documentation

```bash
npm --prefix docs/site install
npm run docs:dev
```

Open <http://127.0.0.1:4321>.

For a hosted docs build, set `DIRECTOR_DOCS_SITE_URL` to the public HTTPS origin before
`npm run docs:build`. Local builds default to `http://127.0.0.1:4321`.

## Verify the checkout

```bash
npm test
npm run lint
npm run format:check
npm run build
npm run docs:build
```

The application build validates TypeScript, creates the Vite bundle, and rebuilds the
portable MCP plugin. The docs build verifies navigation, Markdown/MDX, and internal links.

Continue with the [End-to-end Verified Shot](/tutorials/verified-shot/) once these checks pass.

## Optional integrations

### Coding agents

Install the local CLI for each provider you want to expose in the Agent workbench:

- `codex`
- `claude`

Unavailable CLIs remain disabled instead of presenting a non-functional provider tab.

The Agent workspace **Configure API** panel can also add OpenAI, Anthropic, DeepSeek, Gemini,
Qwen, Ollama, OpenRouter, Groq, MiniMax, Zhipu GLM, xAI, Mistral, or a custom
compatible endpoint; keys are stored locally in `agent-api-providers.json`.
Hosted OpenAI, Anthropic Claude, and OpenAI-compatible models can still be configured as
server-owned profiles with `DIRECTOR_AGENT_PROFILES_JSON` and server-only environment credentials.
The legacy `DIRECTOR_AGENT_API_BASE_URL`, `DIRECTOR_AGENT_API_MODEL`, and
`DIRECTOR_AGENT_API_KEY` still create `api-default`. Every hosted profile uses the same persistent
Session and Director tools without requiring a coding-agent CLI.

### LTX-2.3 video generation

Official LTX-2 source is `vendor/ltx-2`. After reviewing the Community License:

```bash
export DIRECTOR_ACCEPT_LTX2_LICENSE=1
npm run setup:ltx2
```

Point the Gateway at local weights with `LTX23_DISTILLED_CHECKPOINT_PATH`,
`LTX23_SPATIAL_UPSAMPLER_PATH`, and `LTX23_GEMMA_ROOT`, then select
`DIRECTOR_VIDEO_PROVIDER=ltx-2.3`. The Gateway spawns one DistilledPipeline job at a time;
`npm run dev` still only owns the browser and TypeScript control plane.

This integration is experimental. Do not treat spawn tests as a verified GPU render; see
[Feature Status](/reference/feature-status/).

### Optional ComfyUI image and video generation

Configure:

```bash
export COMFYUI_URL=http://127.0.0.1:8188
export COMFYUI_IMAGE_WORKFLOW_PATH=workflows/director-image-api.json
export COMFYUI_VIDEO_WORKFLOW_PATH=workflows/director-video-api.json
```

The workflow paths must resolve inside the Director repository. They are optional: API-format JSON
can also be imported from **Gallery → Generate** at runtime.

For a node pool, replace the single URL with strict JSON. Persisted node edits made in the Gallery
drawer are stored under `data/comfy-nodes.json` without provider credentials.

```bash
export COMFYUI_NODES_JSON='[
  {"id":"gpu-a","label":"GPU A","baseUrl":"http://127.0.0.1:8188","enabled":true,"maxConcurrent":1},
  {"id":"gpu-b","label":"GPU B","baseUrl":"http://192.168.1.42:8188","enabled":true,"maxConcurrent":1}
]'
```
