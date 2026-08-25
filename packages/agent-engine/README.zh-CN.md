# @director/agent-engine — Agent 引擎

> 语言：**中文** · [English](README.md)

Director Agent 引擎。包含工作台合约、命令执行、创作动作、审计、自动化、空间创作、分镜、生成工作台等核心逻辑，被前端与后端共享。

**Package:** `@director/agent-engine` — `"main": "./src/index.ts"` — 依赖：`zod`, `@director/protocol`, `@director/project-schema`, `@director/stage-protocol`, `@director/dcc-interchange`

`index.ts` 桶导出仅包含通用（Node + 浏览器）安全文件。浏览器 Zustand/DOM 执行在 `frontend/director/src/agent/`。

## 文件清单


| 路径                                         | 中文用途                                                                             |
| ------------------------------------------ | -------------------------------------------------------------------------------- |
| `index.ts`                                 | 桶导出（仅通用安全文件）                                                                     |
| `agentIds.ts`                              | Agent 标识符：`DIRECTOR_AGENT_IDS`（codex, claude）与会话 provider ID                     |
| `agentPlan.ts`                             | Agent 计划：操作定义、计划结构、Stage/Creative/Blender/Video 工具执行路由                           |
| `agentPlanFold.ts`                         | 从会话事件中提取最新结构化计划（fold）                                                            |
| `agentSceneRunProjection.ts`               | 从 Director/Blender 事件纯推导当前 3D 搭建闭环：场景、白膜、验证与局部修复                                 |
| `agentRuntimeSchema.ts`                    | Agent 运行时 schema：profile ID、runtime 类型、角色-Profile 映射                             |
| `agentSessionSchema.ts`                    | Agent 会话 schema：会话状态、事件类型、capabilities、消息 schema                                 |
| `agentSessionProtocol.json`                | Agent 会话协议数据：状态与事件类型枚举                                                           |
| `commandEngine.ts`                         | Stage 命令执行引擎：`executeStageTool` 核心实现，约 976 行                                     |
| `stageCommandSchema.ts`                    | Stage 命令 Zod schema：scene_state、create、update、delete、camera 等操作                  |
| `stageCommandPresentation.json`            | Stage 命令帮助文本模板                                                                   |
| `stageFeedback.ts`                         | Stage 反馈：变更实体、场景提示、验证结果 schema                                                   |
| `jsonPatch.ts`                             | JSON Patch（RFC 6902）实现：add、remove、replace 操作                                     |
| `multiAgentRunSchema.ts`                   | 多 Agent 运行 schema：production run ID、状态、角色映射                                      |
| `videoModelContract.ts`                    | 视频模型输入验证：解析 `stage_video` 操作并校验场景就绪状态                                            |
| `directorWorkbenchContract.ts`             | Director 工作台合约：全部操作 schema（observe、author、patch、generation、storyboard 等），约 865 行 |
| `directorWorkbenchDescribe.ts`             | 工作台合约渐进式披露：按需返回单个操作或创作动作的 JSON Schema                                            |
| `directorWorkbenchObserve.ts`              | 仅基于项目文档的 observe 载荷，供浏览器执行器与网关断线只读降级使用                                      |
| `directorAuthoring.ts`                     | 创作动作定义与执行：约 2943 行，涵盖对象、相机、灯光、角色、动画、世界等所有创作操作                                    |
| `directorAudit.ts`                         | 项目审计：检查结构完整性、引用一致性、空间冲突，生成修复建议                                                   |
| `directorAutomation.ts`                    | 自动化库：macro 定义、参数化、memory 存储，支持导入/导出                                              |
| `directorBlocking.ts`                      | 角色走位（Blocking）：编排角色位置、朝向、姿态预设                                                    |
| `directorProjectGraph.ts`                  | 项目图完整性检查：ID 唯一性、引用校验                                                             |
| `directorSpatialAuthoring.ts`              | 空间创作：place_relative、arrange、align、distribute 等空间操作                               |
| `directorSpatialGeometry.ts`               | 空间几何计算：角色包围盒、平面足迹半径、支撑半径                                                         |
| `directorProceduralAuthoring.ts`           | 程序化创作：apply_procedural 操作，将程序化 recipe 展开为低层创作动作                                  |
| `directorStageAdapter.ts`                  | Stage 适配器：DirectorProject ↔ StageScene 双向转换                                      |
| `creativeWorkspaceAgentSchemas.ts`         | 创意空间 Zod schema 与空快照夹具（无 store）                                                  |
| `creativeWorkspaceAgentQuality.ts`         | 创意空间质量审计：board 完整性、剪辑重叠、媒体引用等检查                                                  |
| `characterMotionCatalog.ts`                | 打包 Mixamo 动作目录，供运行时、检查器和 Agent 能力使用                                                |
| `directorAgentAssetCatalog.ts`             | Agent 面向的打包 3D 资产目录                                                                  |
| `directorDefaultProject.ts`                | 无 store 的默认 Director 项目工厂                                                            |
| `creativeWorkspaceAgentCapabilities.json`  | 创意空间 Agent 能力声明数据                                                                |
| `directorWorkbenchCapabilities.json`       | Director 工作台能力声明数据                                                               |


浏览器工作台执行（`gatewayClient`、`directorWorkbenchExecutor`、捕获/生成/分镜处理）在 `frontend/director/src/agent/`。那些模块可以导入本包；本包不得导入浏览器 Zustand store。

## 构建

作为 npm workspace 参与根目录 `npm run build` 类型检查。桶导出有意识排除浏览器专属文件，确保 Node.js 端（Gateway、MCP 服务器）可安全导入。