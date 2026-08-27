---
title: 配置
description: 端口、环境变量、持久化 key 与构建命令。
---

## Gateway

| 变量                       | 默认值                  | 用途                                           |
| -------------------------- | ----------------------- | ---------------------------------------------- |
| `STAGE_GATEWAY_HOST`       | `127.0.0.1`             | Gateway 绑定主机                               |
| `STAGE_GATEWAY_PORT`       | `8787`                  | Gateway 端口                                   |
| `STAGE_GATEWAY_URL`        | `http://127.0.0.1:8787` | CLI、MCP 和 provider 适配器使用的 URL          |
| `STAGE_AGENT_SESSION`      | `cli-default`           | CLI ref-session ID                             |
| `DIRECTOR_MCP_SESSION_ID`  | 自动生成                | 稳定的 MCP ref-session ID                      |
| `DIRECTOR_GATEWAY_TOKEN`   | 每进程随机              | 可选的固定本地 gateway token（至少 24 个字符） |
| `DIRECTOR_ALLOWED_ORIGINS` | loopback Director URL   | 额外的、逗号分隔的可信浏览器 origin            |
| `DIRECTOR_DATA_DIRECTORY`  | `data`                  | Gateway 与原生项目的可变数据根目录             |

Gateway 拒绝非 loopback 绑定。原生 CLI/MCP 客户端会自动 bootstrap process token；原始 HTTP 客户端从
`/te-man/director/agent/bootstrap` 获取 token，并通过 `X-Director-Browser-Token` 发送。该认证 token 与观察返回的精确工作区 `target_token` 不同。

## 协作房间

| 变量                                     | 默认值              | 用途                                                                           |
| ---------------------------------------- | ------------------- | ------------------------------------------------------------------------------ |
| `DIRECTOR_COLLAB_ROOM_AUTH`              | 未设置（本地信任）  | 设为 `required` 时，没有有效邀请 capability token 的房间加入会被拒绝           |
| `DIRECTOR_COLLAB_INVITE_SECRET`          | 进程 gateway secret | 邀请 token 的稳定 HMAC secret；设置后邀请可跨 gateway 重启存活                 |
| `DIRECTOR_COLLAB_PERSISTENCE`            | 未设置（内存）      | 设为 `1` 时在磁盘持久化 Yjs 房间快照（压缩 + 损坏更新隔离）及邀请吊销列表      |
| `DIRECTOR_COLLAB_EMPTY_ROOM_TTL_SECONDS` | 未设置（0）         | 最后一名成员离开后，空房间内存文档的保留宽限期（上限 24 小时；0 表示立即销毁） |
| `DIRECTOR_COLLAB_INVITE_RATE_LIMIT_PER_MINUTE` | 未设置（0 / 关闭） | 可选的邀请签发+吊销 HTTP 滑动窗口上限（按客户端键）；超额返回 `invite_rate_limited` 与 `Retry-After` |
| `VITE_DIRECTOR_COLLAB_INVITE_TOKEN`      | 未设置              | 前端构建/环境提供的邀请 token，浏览器 transport 会附加到 `collab.join`         |

本地信任模式（默认）下，每个已通过升级鉴权的 socket 都以 editor 身份加入，与引入鉴权前的行为一致。
设置 `DIRECTOR_COLLAB_ROOM_AUTH=required` 后，操作者通过 `POST /api/collab/invites` 铸造邀请
（`{room, role, ttl_seconds}` — `role` 为 `editor` 或 `viewer`，`room` 可以是 `project-a/*` 这样的
前缀 capability；响应包含唯一的邀请 id `jti`）。`GET /api/collab/auth` 报告当前模式与配置的
`invite_rate_limit_per_minute`（0 = 关闭），与 rooms ops 及 `/health` 协作 stanza 一致。viewer 邀请
可以接收文档并共享 awareness，但不能写入。

邀请可以通过 `POST /api/collab/invites/revoke` 吊销，参数为 `token`（按 `jti` 吊销该邀请）或
`room`（按范围设置吊销截止点：该范围内不晚于吊销时刻铸造的所有邀请都被拒绝，包括没有 `jti` 的
旧版邀请），二者恰好提供一个。吊销同时会结束在线会话：已用该邀请加入的成员会收到永久性
`unauthorized` 错误并被踢出，响应中的 `disconnected_peers` 与 `disconnected_rooms` 如实报告
影响范围。邀请过期同样约束在线会话：已加入成员的邀请到达 `expires_at` 时，网关会用同样的
永久性 `unauthorized` 错误将其踢出，而不是让会话超出 capability 的有效期继续存活。
只有在 `DIRECTOR_COLLAB_PERSISTENCE=1` 时吊销记录才跨重启存活。

房间生命周期与运维（全部位于 master gateway token 之后，只返回计数、哈希与时间戳——绝不返回
文档内容、邀请 token 或文件系统路径）：

- `GET /api/collab/rooms` — 合并的实时 + 持久房间状态：成员/editor/viewer 计数、快照字节数与
  年龄、待压缩更新数、隔离区计数、鉴权模式、空房间 TTL、邀请速率限制策略以及吊销计数。
  未鉴权的 `GET /health` 也会暴露红acted 的 `collaboration` stanza（`mode`、`persistence`、
  `empty_room_ttl_seconds`、`invite_rate_limit_per_minute`、`active_rooms`、`retained_rooms`），
  便于运维在不调用已鉴权 collab 路由的情况下确认团队模式标志。
- `GET /api/collab/rooms/quarantine?room=<id>` — 单个房间的有界损坏更新隔离索引
  （id、SHA-256 哈希、大小、原因）。
- `POST /api/collab/rooms/close` — `{room, archive?}`：成员收到 `room_closed` 错误，待压缩更新
  刷入快照后内存文档被销毁。`archive: true` 时还会把持久历史移入归档目录，后续加入从空文档开始。

最后一名成员离开房间时，待压缩的持久更新会刷入规范快照；快照会一直保留，直到操作者归档房间。
协作 HTTP 响应携带 `Cache-Control: no-store` 与 `Referrer-Policy: no-referrer`，因为它们传输
capability token。

## Provider 命令

| 变量                 | 默认值   |
| -------------------- | -------- |
| `CODEX_CLI_COMMAND`  | `codex`  |
| `CLAUDE_CLI_COMMAND` | `claude` |

## Hosted Agent API

Agent 工作区的「配置 API」面板会把 provider 写到 data 目录的 `agent-api-providers.json`，
并在运行时热加载到模型选择器。`DIRECTOR_AGENT_PROFILES_JSON` 是严格校验的服务端 Profile JSON 数组。每项使用
`driver: "openai"`、`"anthropic"` 或 `"openai-compatible"`，并提供 `id`、`label`、`model`；
还可指定 `baseUrl`、`apiKeyEnv`、`maxToolRounds` 和能力覆盖。三类 Driver 默认分别读取
`OPENAI_API_KEY`、`ANTHROPIC_API_KEY` 与 `DIRECTOR_AGENT_API_KEY`。

| 变量                                | 用途                                   |
| ----------------------------------- | -------------------------------------- |
| `DIRECTOR_AGENT_PROFILES_JSON`      | 多模型 Hosted Agent Profile 严格配置   |
| `DIRECTOR_AGENT_ROLE_PROFILES_JSON` | FilmRole 到 Profile 的局部路由对象     |
| `OPENAI_API_KEY`                    | 原生 OpenAI Profile 的仅后端凭据       |
| `OPENAI_BASE_URL`                   | 可选 OpenAI API 根地址覆盖             |
| `ANTHROPIC_API_KEY`                 | 原生 Anthropic Profile 的仅后端凭据    |
| `ANTHROPIC_BASE_URL`                | 可选 Anthropic Messages API 根地址覆盖 |

旧版 OpenAI-compatible 配置仍会生成 `api-default` Profile：

| 变量                                 | 用途                                 |
| ------------------------------------ | ------------------------------------ |
| `DIRECTOR_AGENT_API_BASE_URL`        | OpenAI-compatible API 根地址         |
| `DIRECTOR_AGENT_API_KEY`             | 仅后端保存的 bearer credential       |
| `DIRECTOR_AGENT_API_MODEL`           | 发送到 `/chat/completions` 的模型 ID |
| `DIRECTOR_AGENT_API_LABEL`           | 对外显示的 profile 名称              |
| `DIRECTOR_AGENT_API_MAX_TOOL_ROUNDS` | 有界工具循环上限，范围 1 到 48       |

API key 及其环境变量名不会出现在发现接口、事件或持久化 Session JSON 中。Conversation v2
保存 provider-neutral 消息，截图像素仅临时附加到当前模型请求。

## Agent 工作区（SQL 持久化的指令 / 技能 / 记忆）

产品内 Agent 工作区把指令、经验、技能引用与带 TTL 的记忆条目持久化到 data 目录下的
`agent-workspace.sqlite`，通过 **Settings → Agent 工作区** 面板与 `/api/agent/workspace/*`
编辑。harness 按优先级从低到高合并指令层：**仓库技能 → DB 工作区（org → user）→ 会话覆盖**。

| 变量                            | 用途                                                                        |
| ------------------------------- | --------------------------------------------------------------------------- |
| `DIRECTOR_SESSION_INSTRUCTIONS` | 临时的单会话指令覆盖（优先级最高，不持久化）                                |
| `DIRECTOR_WORKSPACE_REFRESH_MS` | DSH 插件刷新工作区提示词的周期；`0` 关闭，钳制在 5 秒–10 分钟（默认 30 秒） |

与 `DIRECTOR_AGENT_PROFILES_JSON` 的合并策略：二者是相互独立的轴，不做互相迁移。模型/供应商
Profile（含全部凭据）保留在 Profile 轴：`DIRECTOR_AGENT_PROFILES_JSON`（环境）与
`agent-api-providers.json`（用户）合并，环境优先、id 冲突时用户覆盖、保留 id
（`api-default`、本地 CLI）始终归环境。工作区只存指令、经验、技能引用与记忆；其导出 bundle
在结构上不可能携带供应商凭据。工作区提示词与 harness 诊断共用同一套 redaction 规则；记忆是
用户掌控的不可信数据，永远不会自动注入任何提示词。

`web_search` 与 `web_fetch` 是 DeepSeek Harness 的工具。通过 `npm run dsh` 运行 harness 时，
它们来自锁定的官方 DSH 发行版（`vendor/deepseek-harness`），并通过 harness 自身的设置配置。
网关不再内置这两个工具的树内副本，也没有 `agent-plugin-settings.json` 存储；Director 专属的
Stage / Canvas / Video / Blender 工具通过 `packages/dsh-plugin-workbench` 接入 DSH。Director
的影片角色策略（`backend/gateway/agents/filmRoleToolPolicy.ts`）仍然对 Film role 隐藏网络工具，
托管影片管线 Profile 执行的是没有工具循环的结构化单次补全。

角色路由引用 `DIRECTOR_AGENT_PROFILES_JSON` 声明的同一组 ID：

```bash
export DIRECTOR_AGENT_ROLE_PROFILES_JSON='{
  "stage-director":"openai-director",
  "cinematographer":"claude-camera",
  "visual-critic":"openai-critic",
  "repair-operator":"claude-repair"
}'
```

该对象会严格拒绝未知角色和空 Profile ID，但允许只覆盖部分角色；未映射角色会回退到
Production Run 选择的 Profile，最终仍可使用 `api-default`。Run 启动前会检查 Profile 可用性、
工具能力以及 Critic 的视觉能力；最终 Profile 会固化到每个持久化节点，恢复执行也不会换模型。

## LTX-2.3

该 provider 当前为 **Experimental**。网关 spawn 测试已通过。在取得真实 GPU artifact
持久化回执前，配置成功不能写成推理成功。见[功能状态](/zh/reference/feature-status/)。

命名：**LTX-2.3** 是产品和 provider id（`DIRECTOR_VIDEO_PROVIDER=ltx-2.3`）。
`DIRECTOR_ACCEPT_LTX2_LICENSE`、`npm run setup:ltx2` 和 submodule `vendor/ltx-2` 里的
**LTX2** 是同一套集成的上游 LTX-2 系列 / 许可证名称，不是第二个视频模型。

| 变量                                                    | 用途                                                               |
| ------------------------------------------------------- | ------------------------------------------------------------------ |
| `DIRECTOR_VIDEO_PROVIDER`                               | 默认 provider：`ltx-2.3`、`comfyui` 或 `minimax-h3`                |
| `DIRECTOR_ACCEPT_LTX2_LICENSE`                          | 审阅 LTX-2 Community License 后设为 `1`                            |
| `DIRECTOR_LTX2_SOURCE_DIR`                              | 覆盖 `vendor/ltx-2` 检出                                           |
| `DIRECTOR_LTX23_MODEL`                                  | 记录在制作 manifest 中的模型名称                                   |
| `LTX23_DISTILLED_CHECKPOINT_PATH`                       | 官方 distilled checkpoint                                          |
| `LTX23_SPATIAL_UPSAMPLER_PATH`                          | 官方 spatial upsampler                                             |
| `LTX23_GEMMA_ROOT`                                      | 本地 Gemma encoder 目录                                            |
| `LTX23_DEVICE` / `LTX23_QUANTIZATION` / `LTX23_OFFLOAD` | 可选 DistilledPipeline 策略                                        |
| `DIRECTOR_MINIMAX_API_KEY`                              | MiniMax 平台 API key（配置后启用 `minimax-h3` provider）           |
| `DIRECTOR_MINIMAX_BASE_URL`                             | 默认 `https://api.minimax.io`，国内可用 `https://api.minimaxi.com` |
| `DIRECTOR_MINIMAX_VIDEO_MODEL`                          | 托管模型名，默认 `MiniMax-H3`                                      |

## 锁定的 Hunyuan3D、TRELLIS 与 ARDY 源码

这些 Git 子模块按需克隆。CI 不会初始化它们。权重不进源码仓库。

| 变量 / 命令                                                                                  | 用途                                                             |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `DIRECTOR_ACCEPT_HUNYUAN3D_LICENSE=1` 然后 `npm run setup:hunyuan3d`                         | 审阅社区许可后锁定 Hunyuan3D-2                                   |
| `npm run setup:trellis`                                                                      | 锁定 Microsoft TRELLIS（源码 MIT；部分渲染/网格依赖不同）        |
| `npm run setup:ardy`                                                                         | 锁定 NVIDIA ARDY；之后网关默认把 `DIRECTOR_ARDY_REPO` 指向该检出 |
| `DIRECTOR_HUNYUAN3D_SOURCE_DIR` / `DIRECTOR_TRELLIS_SOURCE_DIR` / `DIRECTOR_ARDY_SOURCE_DIR` | 覆盖已在 GPU 主机上的检出                                        |
| `DIRECTOR_ARDY_REPO`                                                                         | 显式 ARDY 路径；与 `DIRECTOR_ARDY_SSH_HOST` 一起用于远程 GPU     |

详见 `vendor/`（`ltx-2`、`hunyuan3d`、`trellis`、`ardy` 及其 `*.lock.json`）。

## 可选 ComfyUI 生成运行时

| 变量                             | 用途                                                       |
| -------------------------------- | ---------------------------------------------------------- |
| `COMFYUI_URL`                    | 单节点 fallback ComfyUI URL                                |
| `COMFYUI_NODES_JSON`             | 严格节点数组：id、label、baseUrl、enabled 与 maxConcurrent |
| `COMFYUI_IMAGE_WORKFLOW_PATH`    | Director 内部可选的 API 格式图片工作流                     |
| `COMFYUI_VIDEO_WORKFLOW_PATH`    | Director 内部可选的 API 格式视频工作流                     |
| `DIRECTOR_GENERATION_POLL_MS`    | History 轮询间隔，限制 100–10,000 ms，默认 `750`           |
| `DIRECTOR_GENERATION_TIMEOUT_MS` | 单次 attempt 超时，限制 10 秒–24 小时，默认 30 分钟        |

运行时导入的工作流和节点定义原子保存到 `data/comfy-workflows/` 与 `data/comfy-nodes.json`。
Provider 输出和生成回执保存在 `data/production-jobs/` 的 attempt 专属目录；浏览器只能通过鉴权
artifact route 读取。

## Blender 原生后端

| 变量                                            | 默认值                                              | 用途                                                                 |
| ----------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------- |
| `BLENDER_BIN`                                   | 标准本地安装，其次为已有的 `.runtime/blender-build` | 显式 Blender 可执行文件。                                            |
| `WORLDENGINE_SESSION_PORT`                      | `8791`                                              | 原生场景 session 端口                                                |
| `DIRECTOR_BLENDER_PROJECT_FILE`                 | `<data root>/blender/director-native.blend`         | 绑定的原生项目文件。                                                 |
| `DIRECTOR_BLENDER_URL` / `TOKEN` / `TIMEOUT_MS` | `http://127.0.0.1:8791`                             | Gateway 到原生 session（单次 HTTP 轮询；原生 job 最多等待 280 秒）。 |
| `SKETCHFAB_API_TOKEN`                           | 未设置                                              | Blender 侧 `sketchfab_search` / `sketchfab_import` 所用令牌。        |

原生 launcher 会把 `BLENDER_USER_SCRIPTS` 指向 `integrations/blender/live`，并禁止输出
Python bytecode。除非某个制片明确拥有另一条路径，应把项目文件保留在配置的数据根目录中。

## 引擎连接器（Unreal / Unity / Godot）

| 变量                         | 默认值                                 | 用途                                           |
| ---------------------------- | -------------------------------------- | ---------------------------------------------- |
| `DIRECTOR_UNREAL_EDITOR_BIN` | 常见安装路径，其次 `PATH` 发现         | 无头 Unreal 交接用的 `UnrealEditor-Cmd`        |
| `DIRECTOR_UNREAL_PROJECT`    | 未设置                                 | 已安装 `DirectorBridge` 插件的 `.uproject`     |
| `DIRECTOR_UNITY_BIN`         | 常见安装路径，其次 `PATH` 发现         | `-batchmode` 交接用的 Unity 编辑器可执行文件   |
| `DIRECTOR_UNITY_PROJECT`     | 未设置                                 | 含 `com.director.bridge` 包的 Unity 工程目录   |
| `DIRECTOR_GODOT_BIN`         | `PATH` 上的 `godot`/`godot4`，常见路径 | Godot 4 `--headless` 交接可执行文件            |
| `DIRECTOR_GODOT_PROJECT`     | 未设置                                 | 已启用 `director_bridge` 插件的 Godot 工程目录 |

探测到可执行文件只会使提供商 `installed`，绝不会变成 `nativeReady`。原生引擎操作要求完整健康检查
通过（连接器文件、带版本探测的可执行文件、已配置工程、工程内已安装连接器）。Godot 还额外要求
`project.godot` 中已启用该插件（`[editor_plugins]`），以及连接器版本与工作区一致的固定入口
`--mode health` JSON 输出；探测覆盖 macOS、Linux（含 Flatpak 与 Snap）与 Windows 安装位置，
且仅接受 Godot 4.x。引擎作业产物在 `data/dcc-jobs/<provider>/`。

## 应用命令

| 命令                               | 用途                                                |
| ---------------------------------- | --------------------------------------------------- |
| `npm run dev`                      | UI 与 gateway 的 watch 模式                         |
| `npm run dev:ui`                   | 仅 Vite UI                                          |
| `npm run dev:gateway`              | 仅 gateway，watch 模式                              |
| `npm run gateway`                  | 不使用 watch 的 gateway                             |
| `npm run blender`                  | 集成原生 Director 产品                              |
| `npm run blender:test`             | 运行 Blender 原生冒烟测试套件                       |
| `npm run mcp`                      | 源 MCP server                                       |
| `npm run stage -- <tool> '<json>'` | CLI 工具调用（`--help`；优先 `director_workbench`） |
| `npm test`                         | 全部 Vitest suite                                   |
| `npm run test:comprehensive`       | 编辑器测试                                          |
| `npm run test:agent`               | Agent 与 Stage 测试                                 |
| `npm run lint`                     | ESLint                                              |
| `npm run format:check`             | Prettier 检查                                       |
| `npm run build`                    | 类型检查、UI 构建和 bundled MCP 构建                |
| `npm run docs:dev`                 | 文档开发服务器                                      |
| `npm run docs:build`               | 静态文档构建                                        |

文档站本地 canonical URL 与 sitemap 默认使用 `http://127.0.0.1:4321`。部署到线上时，应在构建
文档前把 `DIRECTOR_DOCS_SITE_URL` 设置为公开 HTTPS origin。

## Vite

应用使用端口 `5175`，并启用 `strictPort: true`（`tools/vite.config.ts`）。模型资产支持 FBX、OBJ、GLB 和 GLTF。vendor chunk 会拆分 Three.js core、R3F、React、Agent、terminal 和 icon 代码，以获得更稳定的缓存。Vite、Vitest、ESLint、TypeScript 与 PostCSS/Tailwind 配置在 `tools/`；`package.json` 留在仓库根。优先使用 `npm run …` 脚本，它们会显式传入 `--config` / `-p`。
