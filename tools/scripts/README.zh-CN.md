# 工具脚本

> 语言:**中文** · [English](README.md)

## 概述

`tools/scripts/` 是 WorldEngine 仓库的自动化脚本目录，覆盖资产管线、LTX-2 视频模型、代码库质量检查、启动器、Agent 技能同步等。脚本直接通过 `node`、`tsx` 或 `blender --python` 运行，无需额外构建。

`tools/` 下的相邻目录：

| 路径 | 用途 |
|---|---|
| [`tools/README.md`](../README.md) | Vite、Vitest、ESLint、TypeScript 与 PostCSS/Tailwind 配置 |
| [`tools/e2e/`](../e2e/README.md) | Playwright 端到端测试（`npm run test:e2e`） |
| [`tools/evals/`](../evals/README.md) | Agent 黄金任务评测（`npm run eval`） |

---

## 完整脚本清单

### 资产管线

| 文件 | 用途 |
|---|---|
| `director-assets.mjs` | 资产清单 CLI：`status`（检查）、`install`（从 Hugging Face 安装）、`verify`（SHA256 校验）、`release-check`（发布检查） |
| `director-assets.test.mjs` | `director-assets.mjs` 的 vitest 测试套件 |
| `asset-ingest.ts` | 统一资产目录 v2 导入 CLI：将 `assets/library/<library>/` 下的模型文件注册到 `catalog.v2.json`（支持 upsert、GLB 空间包围盒解析、质量门控） |
| `asset-ingest.test.ts` | `asset-ingest.ts` 的 vitest 测试套件 |
| `assetIngestGates.ts` | 游戏级质量门控（纯函数，无文件系统依赖）：检查三角面数、纹理尺寸、顶点数、包围盒等，支持 GLB/GLTF/FBX/OBJ 格式 |
| `assetIngestGates.test.ts` | `assetIngestGates.ts` 的 vitest 测试套件 |
| `generate-flick-metadata.mjs` | 确定性中文翻译与标签叠加层生成器：读取 Flick 道具 `catalog.json`，通过手写词典生成 `metadata.i18n.json`（无网络、无 LLM 依赖，输出字节级一致） |
| `generate-flick-metadata.test.ts` | `generate-flick-metadata.mjs` 的 vitest 测试套件（与 Zod schema 交叉校验） |
| `run-local-asset-tests.mjs` | 本地资产测试运行器：先检查资产文件可用性，再运行 vitest 资产测试套件（`--check-assets` 仅报告不运行测试） |

### LTX-2 视频模型

| 文件 | 用途 |
|---|---|
| `bootstrap-ltx2-source.mjs` | 引导 LTX-2 源码：从 git submodule 拉取上游仓库，校验 license 接受状态，切换到指定 commit |
| `ltx2-source.mjs` | LTX-2 源码共享工具模块：读取 `vendor/ltx-2.lock.json`、解析源码路径、校验 LTX-2 Community License 接受状态、验证 checkout 完整性 |
| `ltx2-source.test.mjs` | `ltx2-source.mjs` 的 vitest 测试套件 |
| `ltx23-generate.py` | 一次性 DistilledPipeline CLI；网关按视频作业 spawn |

### 推理源码子模块

| 文件 | 用途 |
|---|---|
| `inference-source.mjs` | Hunyuan3D / TRELLIS / ARDY 共用的 lock 读取、许可证接受门闩与 checkout 校验 |
| `bootstrap-inference-source.mjs` | 按 `*.lock.json` 初始化锁定的推理子模块并检出固定 commit |
| `inference-source.test.mjs` | `inference-source.mjs` 的 vitest 测试套件 |

### 代码库检查

| 文件 | 用途 |
|---|---|
| `check-open-source-boundary.mjs` | 开源边界检查：禁止二进制大文件（`.glb`、`.fbx`、`.onnx`、`.safetensors` 等）和无许可文件进入源代码树，限制源码文件大小上限（5MB） |
| `check-native-agent-integration.mjs` | 原生 Agent 集成检查：验证技能目录为真实目录（非符号链接）、`sync-agent-skills` 同步状态、Agent MCP 配置一致性 |
| `check-build-chunk-budget.mjs` | Vite 构建产物 chunk 大小预算检查：应用 chunk 超出 800KB 时警告（非硬性阻断，用于增长信号监测） |
| `checkServerImportBoundaries.ts` | 服务端导入边界检查：通过 TypeScript AST 解析，确保 Gateway 代码不导入仅限浏览器的 React/Three.js 包，验证纯 Agent/Stage/DCC 模块隔离 |

### 启动器

| 文件 | 用途 |
|---|---|
| `stage-cli.mjs` | Stage CLI：通过 HTTP 调用 Director Gateway。优先 `director_workbench`、`director_creative`、`director_dcc`、`stage_video`。兼容层：`stage_read`、`stage_scene`、`stage_object`、`stage_camera`、`stage_show`。`npm run stage -- --help` |
| `blender.mjs` | Blender 启动器：查找 Blender 4.2+ 可执行文件，启动 WorldEngine Blender 后端（`worldengine_backend.py`），支持 `run` 和 `test` 命令 |

### Agent 集成

| 文件 | 用途 |
|---|---|
| `sync-agent-skills.mjs` | 将 `.claude/skills/director-workbench/` 同步到插件目录，并从 `agent-integrations.mjs` 写出各家 Agent 的 MCP/指令适配文件 |
| `agent-integrations.mjs` | Director MCP 启动定义与生成式适配（`.cursor/mcp.json`、`.codex/config.toml`、`CLAUDE.md` 等）；`repo:check` 要求这些文件与生成结果一致 |
| `agent-integrations.test.mjs` | `agent-integrations.mjs` 的 vitest 测试套件 |
| `dsh-director.mjs` | 写入 Director overlay 并启动固定版本的 DeepSeek Harness Web（`npm run dsh`） |

### 其他

| 文件 | 用途 |
|---|---|
| `normalize-generated-mcp-bundle.mjs` | 规范化 MCP 插件 bundle：去除 esbuild 生成的 `server.mjs` 行尾空白，确保输出可复现 |
| `generate_open_mannequin.py` | 生成 StoryAI 开放人偶 GLB：Blender Python 脚本，从程序化几何体和材质生成可再分发的 MIT 许可人偶模型 |
| `package_mixamo_animations.py` | 打包 Mixamo 动画：Blender Python 脚本，将本地 Mixamo FBX 动画文件转换为确定性 GLB 剪辑，生成含源来源和许可证信息的 `catalog.json` |

---

## package.json 脚本调用关系

以下 `package.json` 脚本直接调用 `tools/scripts/` 中的文件：

| npm 脚本 | 调用的脚本 |
|---|---|
| `npm run assets:status` | `tools/scripts/director-assets.mjs status` |
| `npm run assets:install` | `tools/scripts/director-assets.mjs install` |
| `npm run assets:verify` | `tools/scripts/director-assets.mjs verify --required-only` |
| `npm run assets:release-check` | `tools/scripts/director-assets.mjs release-check` |
| `npm run test:assets` | `tools/scripts/run-local-asset-tests.mjs` |
| `npm run build` | `tools/scripts/check-build-chunk-budget.mjs`（在 `tsc` 和 `vite build` 之后） |
| `npm run build:mcp-plugin` | `tools/scripts/normalize-generated-mcp-bundle.mjs`（在 esbuild 之后） |
| `npm run setup:ltx2` | `tools/scripts/bootstrap-ltx2-source.mjs` |
| `npm run setup:hunyuan3d` | `tools/scripts/bootstrap-inference-source.mjs vendor/hunyuan3d.lock.json` |
| `npm run setup:trellis` | `tools/scripts/bootstrap-inference-source.mjs vendor/trellis.lock.json` |
| `npm run setup:ardy` | `tools/scripts/bootstrap-inference-source.mjs vendor/ardy.lock.json` |
| `npm run stage` | `tools/scripts/stage-cli.mjs` |
| `npm run lint` | `tools/scripts/checkServerImportBoundaries.ts`（在 ESLint 之后） |
| `npm run repo:check` | `tools/scripts/check-open-source-boundary.mjs` + `tools/scripts/check-native-agent-integration.mjs` |
| `npm run sync:skills` | `tools/scripts/sync-agent-skills.mjs` |
| `npm run sync:blender-operations` | `tools/scripts/sync-blender-operation-manifest.mjs` |
| `npm run dsh` | `tools/scripts/dsh-director.mjs` |
| `npm run dsh:prepare` | `tools/scripts/dsh-director.mjs --prepare-only` |
| `npm run blender` | `tools/scripts/blender.mjs run` |
| `npm run blender:test` | `tools/scripts/blender.mjs test` |

以下脚本未在 `package.json` 中以 `npm run` 直接暴露，需手动调用：

- `asset-ingest.ts` — 通过 `npx tsx tools/scripts/asset-ingest.ts` 运行
- `generate-flick-metadata.mjs` — 通过 `node tools/scripts/generate-flick-metadata.mjs` 运行
- `generate_open_mannequin.py` — 通过 `blender --background --python tools/scripts/generate_open_mannequin.py -- --output <path>` 运行
- `package_mixamo_animations.py` — 通过 `blender --background --python tools/scripts/package_mixamo_animations.py -- --source-dir <dir> --output-dir <dir>` 运行
