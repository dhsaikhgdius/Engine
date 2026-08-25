---
title: 安装与运行
description: 安装 Director、启动各项服务并验证本地环境。
---

## 环境要求

- 推荐 Node.js 22 LTS；
- npm 10 或更高版本；
- 支持 WebGL 2 的浏览器；
- macOS 在需要重建可选 native terminal dependency 时需 Xcode Command Line Tools；
- 使用集成 Blender 原生后端时，需要兼容的本地 Blender 4.2+ binary。

## 安装应用

在仓库根目录执行：

```bash
npm install
npm run dev
```

`npm run dev` 会同时启动 Vite UI（`5175`,给人用的编辑器）和 Agent 网关（`8787`,HTTP / MCP / CLI / 健康检查）。

运行时二进制资产有意不进入 Git。只含源码的 checkout 仍可 build 并运行 core tests；创建固定 revision 的
`assets/manifest.lock.json` 后，用 `npm run assets:install` 安装已清权资产。Mixamo 与许可未解决的镜像
仍由用户本地提供。详见[开源资产与 Hugging Face](/zh/development/open-source-assets/)。

打开：

- UI：<http://127.0.0.1:5175>
- Gateway 健康检查：<http://127.0.0.1:8787/health>

## 运行集成原生产品

只做常规 Director 布景时继续使用 `npm run dev`。需要绑定 Blender 场景、原生 Mesh editor
和原生 Rig 检查器时，在同一个仓库根目录运行：

```bash
npm run blender
```

Launcher 会检查 `BLENDER_BIN`，其次是已有的 `.runtime/blender-build`，再检查
兼容的本地 Blender。如果默认位置都不合适，通过 `BLENDER_BIN` 指定可执行文件。

```bash
npm run blender:test
```

原生项目默认保存在 `data/blender/director-native.blend`。制片需要显式项目文件时使用
`DIRECTOR_BLENDER_PROJECT_FILE` 覆盖。Director 与 Blender 仍是一份绑定制片；
`.blend` 导入和 DCC 往返只是独立、可选的文件工作流。

## 分别运行服务

```bash
npm run dev:ui
npm run dev:gateway
```

不使用 watch mode 启动 production gateway：

```bash
npm run gateway
```

## 安装与运行文档站

```bash
npm --prefix docs/site install
npm run docs:dev
```

打开 <http://127.0.0.1:4321>。线上构建应在 `npm run docs:build` 前把
`DIRECTOR_DOCS_SITE_URL` 设置为公开 HTTPS origin；本地构建默认使用
`http://127.0.0.1:4321`。

## 验证 checkout

```bash
npm test
npm run lint
npm run format:check
npm run build
npm run docs:build
```

应用构建会验证 TypeScript、创建 Vite bundle，并重建可移植 MCP 插件。文档构建验证导航、
Markdown/MDX 与内部链接。全部检查通过后，继续完成
[端到端可验证镜头](/zh/tutorials/verified-shot/)。

## 可选集成

### Coding Agent

安装想在 Agent 工作台中暴露的本地 CLI：

- `codex`
- `claude`

不可用的 CLI 会保持禁用，不会显示成伪可用 provider。也可以通过 Agent 工作区的「配置 API」面板一键添加
OpenAI、Anthropic、DeepSeek、Gemini、通义千问、Ollama、OpenRouter、Groq、MiniMax、智谱 GLM、xAI、Mistral，
或任意自定义兼容端点；密钥保存在本机 `agent-api-providers.json`。
`DIRECTOR_AGENT_PROFILES_JSON` 和仅服务端环境凭据仍然可用。旧版 `DIRECTOR_AGENT_API_BASE_URL`、
`DIRECTOR_AGENT_API_MODEL` 与 `DIRECTOR_AGENT_API_KEY` 仍会创建 `api-default`。

### LTX-2.3 视频生成

官方 LTX-2 源码在 `vendor/ltx-2`。审阅 Community License 后：

```bash
export DIRECTOR_ACCEPT_LTX2_LICENSE=1
npm run setup:ltx2
```

用 `LTX23_DISTILLED_CHECKPOINT_PATH`、`LTX23_SPATIAL_UPSAMPLER_PATH` 和 `LTX23_GEMMA_ROOT`
指向本地权重，并选择 `DIRECTOR_VIDEO_PROVIDER=ltx-2.3`。网关按作业 spawn 一次 DistilledPipeline；
`npm run dev` 只负责浏览器与 TypeScript 控制面。

该集成当前为实验状态。不要把 spawn 测试写成 GPU 成片已验证；详见[功能状态](/zh/reference/feature-status/)。

### 可选 ComfyUI 图片与视频生成

```bash
export COMFYUI_URL=http://127.0.0.1:8188
export COMFYUI_IMAGE_WORKFLOW_PATH=workflows/director-image-api.json
export COMFYUI_VIDEO_WORKFLOW_PATH=workflows/director-video-api.json
```

Workflow path 必须解析到 Director 仓库内部；也可以不预配路径，直接从 **Gallery → 生成**导入 API
格式 JSON。多节点可用严格 JSON 配置；Gallery 中保存的节点修改会写入 `data/comfy-nodes.json`，不保存凭据。

```bash
export COMFYUI_NODES_JSON='[
  {"id":"gpu-a","label":"GPU A","baseUrl":"http://127.0.0.1:8188","enabled":true,"maxConcurrent":1},
  {"id":"gpu-b","label":"GPU B","baseUrl":"http://192.168.1.42:8188","enabled":true,"maxConcurrent":1}
]'
```
