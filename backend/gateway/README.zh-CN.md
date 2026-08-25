# 网关控制平面

> 语言:**中文** · [English](README.md)

Director(WorldEngine)的 TypeScript 网关控制平面。它提供 Agent 运行框架(CLI 与托管 API 模型适配器)、项目与场景管理、媒体生成与转码、协作 WebSocket 中心、HTTP API 路由,以及面向 MCP(Model Context Protocol)客户端的结构化工具接口。

- **运行时**:`tsx`(TypeScript 执行)、Node.js HTTP 服务器(无 Hono,使用原生 `node:http`)、`ws` WebSocket、`Yjs` CRDT + `y-protocols/awareness`、`Zod` 模式校验、`node:sqlite`(SQLite)会话持久化、`node-pty` 终端
- **启动**:
  - `npm run dev:gateway` — 网关开发服务器,端口 8787
  - `npm run mcp` — 独立 MCP 服务器(stdio 传输)
  - `npm run dev` — 网关与 Vite UI 同时启动

---

## 顶层文件

### 核心实现

| 路径 | 用途 |
|------|---------|
| `agent-gateway.ts` | 网关主入口:创建 HTTP 服务器、WebSocket 升级、Agent 计划/执行编排、Stage 捕获与工作台路由 |
| `bootstrap.ts` | 网关引导装配:实例化所有服务(Auth、Agent 运行框架、协作、DCC、Film、Generation、Transcode 等)并注入 HTTP 路由 |
| `mcp-server.ts` | MCP 服务器入口:注册三组工具集(`director_workbench`、`director_creative`、`director_dcc`),通过 stdio 与 MCP 客户端通信,经 HTTP 代理至网关 |
| `agentPlanStore.ts` | 短时 assistant plan 缓存，供 plan/apply 使用 |
| `agentNaiveBoundary.ts` | Agent 操作边界:分类变更与只读操作、生成幂等键、管理会话目标绑定、应用观察守卫 |
| `agentPlanDelivery.ts` | 自动交付:将 `author` 操作结果转换为带质量配置与渲染通道的 `deliver` 渲染操作 |
| `agentPlanSchema.json` | Agent 计划的 JSON Schema:为 CLI 结构化输出定义 `summary`、`suggested_next`、`operations` 数组结构 |
| `gatewayAuth.ts` | 网关鉴权:令牌生成、浏览器来源白名单、请求授权、预览 URL 签名 |
| `gatewaySchemas.ts` | 网关 Zod 模式:`assistantPlanRequest`、`assistantApplyRequest`、`terminalMessage`(hello、term.open、term.input、term.resize)等 |
| `collaborationWebSocketHub.ts` | 协作 WebSocket 中心:Yjs 文档 + Awareness 房间管理,多客户端实时同步(最多 256 个房间,每房间 64 个对端) |
| `terminalSessionManager.ts` | 终端会话管理器:通过 node-pty 为 Codex/Claude CLI 创建 PTY 终端,WebSocket 传输 I/O |
| `jsonRpcProcess.ts` | JSON-RPC 子进程封装:派生子进程,通过 stdout 行协议发送请求/接收响应,支持通知与 stderr 监听 |
| `plannerDraft.ts` | 计划草案解码:解码 Claude 传输信封,提取 `operations` 数组,校验失败时生成重试提示 |
| `plannerFailure.ts` | 规划器失败处理:清洗 stderr 摘要(对密钥/凭证脱敏),生成用户友好的错误消息,内部诊断日志 |
| `atomicJsonFile.ts` | 原子 JSON 文件写入:先写入临时文件再重命名,保证原子性 |
| `boundedTextBuffer.ts` | 有界文本缓冲:保留最新字节,溢出时以标记截断,用于安全的进程输出截断 |
| `browserClientDiscovery.ts` | 浏览器客户端发现:按优先级为请求尝试多个浏览器标签页,支持精确租约与回退发现 |
| `browserCommandTimeout.ts` | 浏览器命令超时:区分变更(结果未知,必须观察)与只读(可安全重试)的超时错误 |
| `capturePayload.ts` | 捕获载荷解析:解析 base64 数据 URL(PNG/JPEG/WebP),校验 MIME 类型与大小上限(12 MB) |
| `mcpToolResponse.ts` | MCP 工具响应构建器:标准化 `ok`、`code`、`result`、`error`、`suggested_next` 字段,带 UI 事件与场景提示 |
| `processTermination.ts` | 进程终止工具:跨平台进程树信号(POSIX 进程组、Windows taskkill),优雅终止 |
| `refSessions.ts` | 引用会话注册表:内存中会话级键值引用存储,带 TTL 过期与容量上限 |
| `workbenchClientRouting.ts` | 工作台客户端路由:按工作区(stage/canvas/video)与捕获就绪度对浏览器客户端排序 |
| `tsconfig.json` | 薄 `extends`，指向 `tools/tsconfig.json`，供 IDE 类型检查本目录 |

### 测试文件

测试放在 `tests/`，目录结构与网关源码对应。

| 路径 | 用途 |
|------|---------|
| `tests/agentNaiveBoundary.test.ts` | Agent 操作边界测试 |
| `tests/agentPlanApply.integration.test.ts` | Agent 计划应用集成测试 |
| `tests/agentPlanDelivery.test.ts` | 自动交付逻辑测试 |
| `tests/agentGatewayHttp.integration.test.ts` | 网关 HTTP 集成测试 |
| `tests/atomicJsonFile.test.ts` | 原子文件写入测试 |
| `tests/boundedTextBuffer.test.ts` | 有界文本缓冲测试 |
| `tests/browserClientDiscovery.test.ts` | 浏览器客户端发现测试 |
| `tests/capturePayload.test.ts` | 捕获载荷解析测试 |
| `tests/collaborationWebSocketHub.test.ts` | 协作 WebSocket 中心测试 |
| `tests/gatewayAuth.test.ts` | 网关鉴权测试 |
| `tests/gatewaySchemas.test.ts` | 网关模式测试 |
| `tests/jsonRpcProcess.test.ts` | JSON-RPC 进程测试 |
| `tests/mcpFilmRolePolicy.integration.test.ts` | MCP 影片角色策略集成测试 |
| `tests/mcpToolResponse.test.ts` | MCP 工具响应测试 |
| `tests/plannerDraft.test.ts` | 规划器草案解码测试 |
| `tests/plannerFailure.test.ts` | 规划器失败处理测试 |
| `tests/refSessions.test.ts` | 引用会话注册表测试 |
| `tests/serverImportBoundary.test.ts` | 服务器导入边界检查:确保服务器代码不导入浏览器运行时模块 |
| `tests/stageCli.test.ts` | Stage CLI 集成测试:通过 `stage-cli.mjs` 对网关做冒烟测试 |
| `tests/terminalSessionManager.test.ts` | 终端会话管理器测试 |
| `tests/workbenchClientRouting.test.ts` | 工作台客户端路由测试 |

---

## 子目录

| 目录 | 用途 |
|-----------|---------|
| `agents/` | Agent 运行时组件:Agent 配置、API 提供方存储、工具注册表/Schema、工具记忆、调度器、结果投影、角色策略。Agent 循环本体在 DeepSeek Harness(`vendor/deepseek-harness`),Director 插件在 `packages/dsh-plugin-workbench/` |
| `artifacts/` | 产物版本与审批:生产产物版本管理、审批工作流、晋升指针 |
| `controlPlane/` | 控制平面配置:统一环境变量解析、Zod 模式、托管 Agent 默认值 |
| `dcc/` | DCC 集成:Blender 桥接、场景导入/导出、Blender 原生会话、glTF 准备 |
| `episode/` | 剧集打包:将分镜视频、动作轨道、字幕打包为可交付的剧集产物 |
| `film/` | 影片管线:规划 Agent、渲染协调、音频混音、时间线导出、结构化 LLM 调用 |
| `generation/` | 生成运行时:ComfyUI 图像/视频生成、3D 生成(Infinigen 等)、工作流存储、启动对账 |
| `jobs/` | 生产任务存储:任务记录、状态流转、幂等键、Canvas 占位符 |
| `media/` | 媒体转码:基于 ffmpeg 的转码执行器、输入暂存、带转写的共享上传端点 |
| `motion/` | 动作生成:NVIDIA ARDY 文本到动作生成桥接(本地或 SSH) |
| `multiAgent/` | 多 Agent 编排:生产运行编排器(按角色顺序执行影片图)、运行存储 |
| `production/` | 生产状态:场景项目状态管理、幂等变更协调器 |
| `promptExpansion/` | 提示词扩展:使用影片 LLM 重写生成提示词,包含图像/视频提示词扩展器与资产大小估算 |
| `reconstruction/` | 场景重建:从捕获图像(Python worker)进行 3D 场景重建、参考场景分析 |
| `routes/` | HTTP 路由:按功能域划分的路由处理器(Stage、Assistant、Generation、DCC、Film、Production 等) |
| `testing/` | 测试工具:最小化 `DirectorProject` 夹具工厂 |
| `transcription/` | 媒体转写:音频/视频转写执行器、输入暂存、分块 |
| `video/` | 视频生成:多提供商(ComfyUI、LTX 0.9.2.3、Minimax H3)视频生成服务 |

---

### `agents/` 文件清单

| 路径 | 用途 |
|------|---------|
| `agents/agentProfileRegistry.ts` | Agent 配置注册表:解析本地与托管 Agent 的能力、驱动、模型配置 |
| `agents/agentApiModels.ts` | API 提供方模型发现:拉取并校验用户自配提供方的模型列表 |
| `agents/agentApiProviderStore.ts` | API 提供方存储:持久化用户配置的托管模型提供方(端点、驱动、模型) |
| `agents/agentToolRegistry.ts` | 工具注册表:Director 工具的紧凑 wire schema、定义、超时、读/写模式 |
| `agents/agentToolMemory.ts` | 工具记忆:按 `idempotency_key` 做幂等回放与重复调用检测 |
| `agents/agentToolOutcomes.ts` | 工具结果分类:将工具结果分类为 `completed`/`failed`/`timed_out`/`stale_revision`/`outcome_unknown` |
| `agents/agentToolResultProjection.ts` | 工具结果投影再导出:规范实现位于 `packages/dsh-plugin-workbench/src/toolResultProjection.ts`,已接入 DSH 插件与 MCP 服务器两个模型面 |
| `agents/agentToolScheduler.ts` | 工具调度器:有序调用窗口、读并行、进程级同目标写屏障 |
| `agents/localAgentCliAvailability.ts` | 本地 CLI 可用性:网关启动时探测 Codex/Claude CLI 是否存在 |
| `agents/modelProviderIntegration.ts` | 模型提供方集成:为网关注册内置 `@director/model-provider` 工厂 |
| `agents/filmRoleToolPolicy.ts` | 影片角色工具策略:按 `FilmRoleId` 限制可用工具与操作(只读 vs 写) |

### `artifacts/` 文件清单

| 路径 | 用途 |
|------|---------|
| `artifacts/productionArtifactStore.ts` | 产物存储:版本管理、审批工作流、带 SHA-256 指纹的晋升指针 |

### `controlPlane/` 文件清单

| 路径 | 用途 |
|------|---------|
| `controlPlane/controlPlaneConfig.ts` | 控制平面配置:环境变量解析、Zod 校验、Agent 默认值、ComfyUI 节点定义 |
| `controlPlane/hostedAgentDefaults.json` | 托管 Agent 默认配置 JSON |

### `dcc/` 文件清单

| 路径 | 用途 |
|------|---------|
| `dcc/blenderBridge.ts` | Blender 桥接:派生 Blender 执行场景包导入,返回预览与报告 |
| `dcc/blenderSceneImport.ts` | Blender 场景导入:将 Director 场景图导出为 GLB/glTF 包供 Blender 使用 |
| `dcc/blenderReturnImport.ts` | Blender 回返导入:解析 Blender 导出的结果包,将资产注册回 Director |
| `dcc/dccExchangePackage.ts` | DCC 交换包:跨 DCC 工具的可移植交换格式,带资产清单、预览、SHA-256 完整性 |
| `dcc/dccProviderRegistry.ts` | DCC 提供商注册表:管理已配置的 DCC 工具描述符、状态、可用性 |
| `dcc/gltfPrepare.ts` | glTF 准备:为 Blender 导入预处理 glTF 文件(纹理复制、路径修正) |
| `dcc/blenderNativeSession.ts` | Blender 原生会话:Blender 服务的 HTTP 客户端封装(命令批、场景快照、作业) |
| `dcc/blenderNativeTool.ts` | Blender 原生工具:暴露 Blender 读/写操作的 MCP 工具定义 |

### `episode/` 文件清单

| 路径 | 用途 |
|------|---------|
| `episode/episodePackageExecutor.ts` | 剧集打包执行器:将 MP4、动作轨道、字幕打包为经完整性校验的剧集产物 |

### `film/` 文件清单

| 路径 | 用途 |
|------|---------|
| `film/createFilmPipeline.ts` | 影片管线装配:从控制平面配置装配 LLM 驱动、音频、渲染、媒体生成器 |
| `film/filmPipelineOrchestrator.ts` | 管线编排器:协调完整影片分镜规划、渲染、音频生成流程 |
| `film/filmPlanningAgents.ts` | 影片规划 Agent:使用 LLM 进行分镜规划、镜头设计、场景描述 |
| `film/filmRenderCoordinator.ts` | 渲染协调器:管理镜头渲染任务派发、音频混音钩子 |
| `film/filmRunStore.ts` | 影片运行存储:持久化影片管线运行记录与状态 |
| `film/filmAudioPipeline.ts` | 音频管线:TTS(OpenAI Speech)与音频混音 |
| `film/filmStageAnchors.ts` | Stage 锚点解析器:将影片分镜中的 Stage 引用解析为实际场景锚点 |
| `film/filmTimelineExport.ts` | 时间线导出:使用 ffmpeg/ffprobe 导出影片时间线 |
| `film/filmMediaProviders.ts` | 媒体提供商:托管图像/视频 API 生成器 |
| `film/filmFfmpeg.ts` | ffmpeg 工具:共享的 ffmpeg/ffprobe 二进制路径管理 |
| `film/structuredCall.ts` | 结构化 LLM 调用:带 JSON Schema 约束的 LLM 调用封装 |

### `generation/` 文件清单

| 路径 | 用途 |
|------|---------|
| `generation/createComfyGenerationRuntime.ts` | ComfyUI 运行时装配:创建执行器、节点池、工作流存储 |
| `generation/createGenerated3DRuntime.ts` | 3D 生成运行时装配:创建 3D 执行器、提供商注册表、晋升存储 |
| `generation/comfyGenerationExecutor.ts` | ComfyUI 执行器:向 ComfyUI 提交提示词、轮询结果、下载输出 |
| `generation/comfyNodePool.ts` | ComfyUI 节点池:管理工作流节点定义与可用性 |
| `generation/comfyWorkflow.ts` | ComfyUI 工作流:工作流 JSON 模板加载与参数替换 |
| `generation/comfyWorkflowStore.ts` | 工作流存储:管理已配置的 ComfyUI 工作流定义 |
| `generation/generated3dExecutor.ts` | 3D 生成执行器:提交 3D 生成任务、轮询、管理生命周期 |
| `generation/generated3dProviders.ts` | 3D 提供商注册表:管理多个 3D 生成提供商(如 Infinigen) |
| `generation/generated3dNormalizer.ts` | 3D 结果归一化器:将不同提供商的输出归一化为标准格式 |
| `generation/generated3dPromotionStore.ts` | 3D 晋升存储:管理生成资产到项目资产的晋升流程 |
| `generation/generated3dSourceStore.ts` | 3D 源存储:管理生成 3D 资产的源文件 |
| `generation/infinigenGenerated3dProvider.ts` | Infinigen 3D 提供商:集成 Infinigen 程序化 3D 世界生成 |
| `generation/startupReconciliation.ts` | 启动对账:网关重启后恢复未完成的任务状态 |

### `jobs/` 文件清单

| 路径 | 用途 |
|------|---------|
| `jobs/productionJobStore.ts` | 任务存储:生产任务 CRUD、状态流转、幂等键、指纹、Canvas 占位符渲染 |
| `jobs/canvasPlaceholderArtifact.ts` | Canvas 占位符:为尚无输出的任务生成占位 PNG |

### `media/` 文件清单

| 路径 | 用途 |
|------|---------|
| `media/createMediaTranscodeRuntime.ts` | 转码运行时装配:创建输入暂存与 ffmpeg 执行器 |
| `media/mediaTranscodeExecutor.ts` | 转码执行器:执行 ffmpeg 转码任务 |
| `media/mediaTranscodeInputStore.ts` | 转码输入暂存:内容寻址的媒体文件暂存,与转写共享 |
| `media/mediaProcessRunner.ts` | 媒体进程运行器:派生 ffmpeg/ffprobe 子进程,管理超时与输出 |

### `motion/` 文件清单

| 路径 | 用途 |
|------|---------|
| `motion/ardyMotionService.ts` | ARDY 动作服务:NVIDIA ARDY 文本到动作生成的网关桥接(本地或远程 Python 脚本) |

### `multiAgent/` 文件清单

| 路径 | 用途 |
|------|---------|
| `multiAgent/productionRunOrchestrator.ts` | 生产运行编排器:按影片角色顺序执行多 Agent 生产管线(showrunner → screenwriter → … → generation-operator) |
| `multiAgent/multiAgentRunStore.ts` | 多 Agent 运行存储:持久化生产运行记录 |

### `production/` 文件清单

| 路径 | 用途 |
|------|---------|
| `production/productionStateStore.ts` | 生产状态存储:场景项目状态的原子读/写、版本管理 |
| `production/productionMutationCoordinator.ts` | 变更协调器:幂等变更执行、冲突检测、版本校验 |

### `promptExpansion/` 文件清单

| 路径 | 用途 |
|------|---------|
| `promptExpansion/createPromptExpanders.ts` | 提示词扩展器装配:复用影片 LLM 创建图像/视频提示词扩展器 |
| `promptExpansion/imagePromptExpander.ts` | 图像提示词扩展器:将短提示词扩展为生成器优化版本 |
| `promptExpansion/videoPromptExpander.ts` | 视频提示词扩展器:将短提示词扩展为视频生成器优化版本 |
| `promptExpansion/assetSizeEstimator.ts` | 资产大小估算器:估算生成资产的文件大小 |

### `reconstruction/` 文件清单

| 路径 | 用途 |
|------|---------|
| `reconstruction/createCaptureReconstructionRuntime.ts` | 重建运行时装配:创建场景重建执行器,共享媒体转码输入暂存 |
| `reconstruction/captureReconstructionExecutor.ts` | 重建执行器:执行 Python 3D 重建 worker |
| `reconstruction/captureReconstructionPlan.ts` | 重建计划:解析并校验重建计划参数 |
| `reconstruction/referenceSceneAnalyzer.ts` | 参考场景分析器:分析参考图像以提取场景参数 |

### `routes/` 文件清单

| 路径 | 用途 |
|------|---------|
| `routes/assistantRoutes.ts` | Assistant 路由:`POST /api/assistant/plan` 与 `/api/assistant/apply` |
| `routes/stageRoutes.ts` | Stage 路由:核心工作台工具执行、捕获、项目操作 |
| `routes/agentSessionRoutes.ts` | Agent 会话路由:会话管理、引导、健康检查 |
| `routes/controlPlaneRoutes.ts` | 控制平面路由:配置查询、Agent 配置、能力 |
| `routes/generationRoutes.ts` | 生成路由:ComfyUI 图像/视频生成任务提交与查询 |
| `routes/generated3dRoutes.ts` | 3D 生成路由:3D 生成任务提交、查询、晋升 |
| `routes/generatedAssetRoutes.ts` | 生成资产路由:生成资产的管理与查询 |
| `routes/productionRoutes.ts` | 生产路由:项目场景状态、变更提交 |
| `routes/productionJobRoutes.ts` | 生产任务路由:任务状态查询、管理 |
| `routes/productionArtifactRoutes.ts` | 产物路由:产物版本管理、审批、晋升 |
| `routes/filmPipelineRoutes.ts` | 影片管线路由:影片分镜规划、渲染、运行管理 |
| `routes/multiAgentRunRoutes.ts` | 多 Agent 运行路由:生产运行创建、查询、状态 |
| `routes/dccRoutes.ts` | DCC 路由:Blender 导入/导出、DCC 交换包、提供商状态 |
| `routes/blenderLiveRoutes.ts` | Blender 路由:Blender 场景快照、命令批 |
| `routes/mediaTranscriptionRoutes.ts` | 转写路由:媒体转写任务提交与查询 |
| `routes/referenceSceneRoutes.ts` | 参考场景路由:参考图像分析 |
| `routes/captureReconstructionRoutes.ts` | 重建路由:场景重建任务提交与查询 |
| `routes/assetSizeRoutes.ts` | 资产大小路由:资产大小估算 |
| `routes/motionGenerationRoutes.ts` | 动作生成路由:ARDY 动作生成任务提交与查询 |

### `tests/` 夹具

Gateway 测试按域放在 `tests/` 子目录（`agents/`、`routes/`、`dcc/`、`core/`、`workbench/`、`mcp/`、`planner/`、`cli/` 等），与 gateway 源码目录对应。共享夹具放在 `tests/fixtures/`。

| 路径 | 用途 |
|------|---------|
| `tests/fixtures/createTestDirectorProject.ts` | 测试项目工厂:创建最小化的有效 `DirectorProject` 夹具,不依赖浏览器持久化 |

### `transcription/` 文件清单

| 路径 | 用途 |
|------|---------|
| `transcription/createMediaTranscriptionRuntime.ts` | 转写运行时装配:创建输入暂存与转写执行器 |
| `transcription/mediaTranscriptionExecutor.ts` | 转写执行器:执行媒体转写任务 |
| `transcription/mediaTranscriptionInputStore.ts` | 转写输入暂存:内容寻址的媒体文件暂存 |
| `transcription/mediaTranscriptionChunker.ts` | 转写分块器:将长音频/视频分块以适配转写模型上下文窗口 |

### `video/` 文件清单

| 路径 | 用途 |
|------|---------|
| `video/createVideoGenerationService.ts` | 视频生成服务装配:从控制平面配置创建多提供商视频生成服务 |
| `video/videoGenerationService.ts` | 视频生成服务:统一视频生成接口,路由到具体提供商 |
| `video/providers/videoProvider.ts` | 视频提供商接口:定义 `VideoProvider` 抽象与 `VideoGenerationRequest`/`VideoGenerationResult` 类型 |
| `video/providers/comfyUiVideoProvider.ts` | ComfyUI 视频提供商:通过 ComfyUI 工作流生成视频 |
| `video/providers/ltx23SpawnProvider.ts` | LTX-2.3 提供商：网关 spawn 官方 DistilledPipeline |
| `video/providers/minimaxH3Provider.ts` | Minimax H3 提供商:通过 HTTP API 调用 Minimax H3 视频生成 |

---

## 运行与测试

| 命令 | 描述 |
|---------|-------------|
| `npm run dev:gateway` | 在端口 8787 启动网关开发服务器 |
| `npm run mcp` | 启动独立 MCP 服务器(stdio 传输) |
| `npm run stage -- director_workbench '{"op":"observe"}'` | Stage CLI 冒烟测试:通过 `stage-cli.mjs` 向网关发送 observe 请求（`npm run stage -- --help`） |
| `npm test` | 运行完整 vitest 测试套件（`tools/vitest.config.ts`） |
| `npx vitest run --config tools/vitest.config.ts backend/gateway/tests` | 仅运行网关测试 |

### 环境变量

关键环境变量通过 `controlPlane/controlPlaneConfig.ts` 解析,主要包括:

| 变量 | 用途 |
|----------|---------|
| `STAGE_GATEWAY_PORT` | 网关端口(默认 8787) |
| `STAGE_GATEWAY_URL` | MCP 服务器连接网关的 URL(默认 `http://127.0.0.1:8787`) |
| `DIRECTOR_GATEWAY_TOKEN` | 网关鉴权令牌(至少 24 个字符) |
| `DIRECTOR_AGENT_API_BASE_URL` | 托管 Agent API 基础 URL |
| `DIRECTOR_AGENT_API_KEY` | 托管 Agent API 密钥 |
| `DIRECTOR_AGENT_API_MODEL` | 托管 Agent 模型名称 |
| `DIRECTOR_AGENT_PROFILES_JSON` | 自定义 Agent 配置 JSON |
| `DIRECTOR_FILM_ROLE` | MCP 客户端角色(如 `stage-director`、`cinematographer`) |
| `DIRECTOR_MCP_SESSION_ID` | MCP 会话 ID |

完整配置目录见 `controlPlane/controlPlaneConfig.ts`。
