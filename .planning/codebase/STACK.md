# Technology Stack

**Analysis Date:** 2026-08-03

## Languages

**Primary:**
- TypeScript 5.7 - Browser application, shared contracts, Node.js control plane, MCP server, CLI-adjacent tooling, and tests in `src/`, `server/`, `tools/vite.config.ts`, and `tools/vitest.config.ts`.
- TSX / React JSX - UI workspaces, Three.js scene rendering, panels, Canvas, Video Editor, and tests under `src/comprehensive/` and `src/agent/`.
- Python 3.10+ / 3.11+ - LTX model runtime, training, pipelines, CUDA integration wrappers, and the resident inference worker under `pipelines/video-generation/ltx-2/packages/` and `pipelines/video-generation/worker/`.

**Secondary:**
- JavaScript ES modules - Repository automation, asset installation, source bootstrap, CLI, and Mixamo utilities in `scripts/*.mjs` and `scripts/mixamo-downloader/*.js`.
- CUDA C++ / C++ - Optional compiled LTX acceleration kernels in `pipelines/video-generation/ltx-2/packages/ltx-kernels/csrc/`.
- CSS - Application and documentation styling in `src/comprehensive/styles/` and `docs-site/src/styles/`.
- Markdown / MDX-compatible content - Astro/Starlight documentation in `docs-site/src/content/docs/`.
- JSON / YAML - Project schemas, asset catalogs, model/training configurations, MCP configuration, and CI in `assets/`, `public/`, `pipelines/video-generation/ltx-2/packages/ltx-trainer/configs/`, `.mcp.json`, and `.github/workflows/ci.yml`.

## Runtime

**Environment:**
- Node.js 22 - Required for the root application and CI; declared in `README.md` and selected in `.github/workflows/ci.yml`. The code uses native `node:sqlite`, Fetch, WebSocket-adjacent APIs, and ES2023.
- WebGL 2 browser - Runs the Director UI and owns interactive Three.js rendering/capture; requirement documented in `README.md`.
- Python >=3.11 - Resident Director LTX-2.3 worker in `pipelines/video-generation/worker/pyproject.toml`; CI uses Python 3.12 in `.github/workflows/ci.yml`.
- Python >=3.10 - Vendored LTX core, pipelines, and trainer packages in `pipelines/video-generation/ltx-2/packages/*/pyproject.toml`.
- CUDA-capable Python environment - Required for GPU LTX inference/training and optional kernels; source and model environments are intentionally isolated from Node/UI processes in `pipelines/video-generation/worker/src/director_ltx23_worker/executor.py`.

**Package Manager:**
- npm 10+ for root and docs JavaScript packages; lockfiles: `package-lock.json`, `docs-site/package-lock.json`, and `scripts/mixamo-downloader/package-lock.json` are present (lockfile version 3).
- uv for Python workspaces and worker environments; lockfiles: `pipelines/video-generation/ltx-2/uv.lock` and `pipelines/video-generation/worker/uv.lock` are present.
- Root Python workspace membership and local package sources are configured in `pipelines/video-generation/ltx-2/pyproject.toml`.

## Frameworks

**Core:**
- React 18.3 and React DOM 18.3 - Browser application shell and editor UI (`package.json`, `src/`).
- Three.js 0.184, React Three Fiber 8.17, and Drei 9.122 - Browser 3D scene rendering, cameras, assets, controls, and helpers (`package.json`, `src/comprehensive/editor/runtime/`, `src/comprehensive/editor/canvas/`).
- Zustand 5 - Browser/editor state management (`package.json`, `src/comprehensive/editor/store/`).
- Vite 6 - Browser development server and production bundler (`package.json`, `tools/vite.config.ts`).
- Node.js HTTP + `ws` 8.21 - Loopback control plane, HTTP APIs, browser command transport, collaboration, and PTY-over-WebSocket (`server/agent-gateway.ts`, `server/collaborationWebSocketHub.ts`, `server/terminalSessionManager.ts`).
- Model Context Protocol SDK 1.29 - Stdio MCP bridge exposing Director tools (`server/mcp-server.ts`).
- Zod 4.4 - Runtime validation and JSON-schema generation across frontend/shared/server contracts (`package.json`, `src/`, `server/`).
- Yjs 13.6 and y-protocols 1.0 - Collaborative document updates, awareness, comments, versions, and restore (`src/comprehensive/editor/collaboration/`, `server/collaborationWebSocketHub.ts`).
- Astro 7.1 + Starlight 0.41 - Bilingual static documentation site (`docs-site/package.json`, `docs-site/astro.config.mjs`).
- FastAPI >=0.116, Uvicorn >=0.35, and Pydantic >=2.11 - Resident LTX-2.3 HTTP worker and typed job API (`pipelines/video-generation/worker/pyproject.toml`, `pipelines/video-generation/worker/src/director_ltx23_worker/app.py`).
- PyTorch ~=2.7, Transformers >=4.52, Accelerate, and Safetensors - LTX model execution and loading (`pipelines/video-generation/ltx-2/packages/ltx-core/pyproject.toml`).
- LTX Core / Pipelines / Trainer 1.1.7 - Audio-video model definitions, inference pipelines, and fine-tuning toolkit (`pipelines/video-generation/ltx-2/packages/ltx-core/pyproject.toml`, `pipelines/video-generation/ltx-2/packages/ltx-pipelines/pyproject.toml`, `pipelines/video-generation/ltx-2/packages/ltx-trainer/pyproject.toml`).

**Testing:**
- Vitest 4.1 with jsdom 29 - TypeScript unit, component, contract, and HTTP integration tests (`tools/vitest.config.ts`, `tools/vite.config.ts`).
- Testing Library - React/UI behavior tests (`package.json`).
- pytest 8 for the resident worker and pytest ~9 for the LTX workspace (`pipelines/video-generation/worker/pyproject.toml`, `pipelines/video-generation/ltx-2/pyproject.toml`).

**Build/Dev:**
- TypeScript compiler 5.7 in strict, no-emit, ES2023 mode (`tools/tsconfig.json`).
- esbuild 0.28 bundles the portable MCP plugin for Node 20 compatibility (`package.json`).
- ESLint 10 + typescript-eslint 8.65 + React Hooks lint rules (`tools/eslint.config.js`).
- Prettier 3.9 for TypeScript, TSX, CSS, server code, and root metadata (`package.json`).
- Ruff >=0.14.3 for the LTX workspace and Ruff-configured Python 3.11 worker (`pipelines/video-generation/ltx-2/pyproject.toml`, `pipelines/video-generation/worker/pyproject.toml`).
- Hatchling builds the worker and trainer; uv-build builds LTX core/pipelines; setuptools builds optional CUDA kernels (`pipelines/video-generation/worker/pyproject.toml`, `pipelines/video-generation/ltx-2/packages/*/pyproject.toml`).
- GitHub Actions runs lint, format, build, tests, docs build, and worker contract tests (`.github/workflows/ci.yml`).

## Key Dependencies

**Critical:**
- `three`, `@react-three/fiber`, `@react-three/drei`, `camera-controls` - Core interactive previz and cinematography surface (`package.json`).
- `@dimforge/rapier3d-compat` 0.12 - Browser-compatible physics (`package.json`, `src/comprehensive/editor/player/`).
- `@gltf-transform/core`, `@gltf-transform/extensions`, `draco3dgltf`, `meshoptimizer` - glTF/GLB interchange, optimization, and compression (`package.json`, `server/dcc/`).
- `@modelcontextprotocol/sdk` - Typed external Agent control surface (`server/mcp-server.ts`).
- `node:sqlite` - Durable Agent sessions, events, messages, plans, and checkpoints in `server/agentSessionStore.ts`.
- `node-pty` + xterm - Local Agent terminal sessions streamed through the gateway (`server/terminalSessionManager.ts`, `src/agent/useTerminalSession.ts`).
- `torch`, `transformers`, `accelerate`, `torchaudio`, `safetensors` - LTX model loading, inference, and distributed training (`pipelines/video-generation/ltx-2/packages/ltx-core/pyproject.toml`).
- `peft`, `bitsandbytes`, `optimum-quanto` - LoRA and quantized trainer execution (`pipelines/video-generation/ltx-2/packages/ltx-trainer/pyproject.toml`).

**Infrastructure:**
- `ws` - Authenticated browser, Workbench, creative workspace, collaboration, and terminal socket transport (`server/agent-gateway.ts`).
- `yjs` / `y-protocols` - In-process collaboration rooms and browser synchronization (`server/collaborationWebSocketHub.ts`).
- `jszip` and `cloudpickle` - Archive/interchange handling and Python pipeline serialization (`package.json`, `pipelines/video-generation/ltx-2/packages/ltx-pipelines/pyproject.toml`).
- `av`, `openimageio`, `opencv-python`, `imageio-ffmpeg`, `soundfile` - Media decoding, encoding, and processing in LTX pipelines/trainer (`pipelines/video-generation/ltx-2/packages/ltx-pipelines/pyproject.toml`, `pipelines/video-generation/ltx-2/packages/ltx-trainer/pyproject.toml`).
- `wandb`, `huggingface-hub`, `google-genai`, `openai` - Optional experiment tracking, model publishing, and captioning integrations (`pipelines/video-generation/ltx-2/packages/ltx-trainer/pyproject.toml`).

## Configuration

**Environment:**
- The Node control plane parses backend integration settings once through strict Zod validation in `server/controlPlane/controlPlaneConfig.ts`; provider credentials remain server-side.
- Gateway settings include `STAGE_GATEWAY_HOST`, `STAGE_GATEWAY_PORT`, `DIRECTOR_DATA_DIRECTORY`, `DIRECTOR_GATEWAY_TOKEN`, `DIRECTOR_ALLOWED_ORIGINS`, and `DIRECTOR_ALLOW_ANON_BOOTSTRAP` (`server/controlPlane/controlPlaneConfig.ts`, `server/gatewayAuth.ts`).
- Hosted model profiles use `DIRECTOR_AGENT_PROFILES_JSON`, `DIRECTOR_AGENT_ROLE_PROFILES_JSON`, provider API keys/base URLs, and legacy `DIRECTOR_AGENT_API_*` values (`server/controlPlane/controlPlaneConfig.ts`).
- Video providers use `DIRECTOR_LTX23_*`, `COMFYUI_URL`, and `COMFYUI_VIDEO_WORKFLOW_PATH`; the worker separately uses `LTX23_*` and `LTX2_*` settings (`server/controlPlane/controlPlaneConfig.ts`, `pipelines/video-generation/worker/src/director_ltx23_worker/executor.py`).
- MCP/CLI connection defaults live in `.mcp.json`, `server/mcp-server.ts`, and `scripts/stage-cli.mjs`.
- No `.env` files were detected at repository root or recursively; configuration is expected via process environment or checked-in non-secret metadata.

**Build:**
- `tools/tsconfig.json` - Strict ES2023 TypeScript and bundler module resolution.
- `tools/vite.config.ts` - Port 5175, `/te-man` gateway proxy, asset extensions, WebGL-oriented vendor chunking, and 800 KiB chunk warning budget.
- `tools/postcss.config.js` / `tools/tailwind.config.js` - Director UI CSS pipeline; Vite `css.postcss` points at `tools/`.
- `tools/vitest.config.ts` / `tools/vitest.setup.ts` - jsdom test environment with a single worker.
- `tools/eslint.config.js` - Typed linting plus enforced frontend/server/shared import boundaries.
- `tools/e2e/playwright.config.ts` - Playwright end-to-end suite.
- `docs-site/astro.config.mjs` - Starlight navigation, bilingual locales, and `DIRECTOR_DOCS_SITE_URL`.
- `pipelines/video-generation/ltx-2/pyproject.toml` - uv workspace, dev groups, optional CUDA kernels, and Ruff policy.
- `.github/workflows/ci.yml` - Node 22 and Python 3.12 verification.

## Platform Requirements

**Development:**
- Root UI/control plane: Node.js 22, npm 10+, and a WebGL 2 browser (`README.md`).
- `node-pty` may require native build tools; root `postinstall` attempts a node-gyp rebuild (`package.json`).
- LTX worker: Python 3.11+, uv, accepted upstream LTX license, a pinned official source checkout, local model checkpoints, and usually CUDA GPU hardware (`README.md`, `scripts/ltx2-source.mjs`, `pipelines/video-generation/worker/src/director_ltx23_worker/executor.py`).
- LTX trainer: Linux is required for supported Triton/bitsandbytes workflows; CUDA with substantial VRAM is expected (`pipelines/video-generation/ltx-2/packages/ltx-trainer/AGENTS.md`).
- Optional kernel build requires CUDA, PyTorch already installed, and may use CUTLASS (`pipelines/video-generation/ltx-2/packages/ltx-kernels/setup.py`).

**Production:**
- The application is designed primarily as a local, single-operator browser plus loopback Node gateway; `server/controlPlane/controlPlaneConfig.ts` rejects non-loopback gateway hosts.
- Static UI output is produced by Vite; static documentation output is produced by Astro (`package.json`, `docs-site/package.json`).
- Remote/multi-user deployment requires an authenticated reverse proxy and separate operational design; no container or cloud hosting manifest was detected.
- Heavy model inference runs as a separate FastAPI/Uvicorn process, usually at loopback port 8790, or through an independently operated ComfyUI server (`pipelines/video-generation/worker/src/director_ltx23_worker/app.py`, `server/video/providers/comfyUiVideoProvider.ts`).

---

*Stack analysis: 2026-08-03*
