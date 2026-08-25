# @director/protocol — 传输契约

> 语言：**中文** · [English](README.md)

Director 核心共享传输契约。包含 Zod schema 定义、协议常量、JSON 定义和测试辅助工具，被前端 Director、Gateway 和 Blender 会话共同使用。

**Package:** `@director/protocol` — `"main": "./src/index.ts"` — 依赖：`zod`

## 文件清单

| 路径 | 中文用途 |
| --- | --- |
| `index.ts` | 桶导出，汇总所有公共合约 |
| `primitives.ts` | 基础工具函数：clamp、isRecord、protocolKeys、资产目录声明规范化 |
| `stableJson.ts` | 确定性 JSON 序列化（locale-aware / code-point 排序），用于指纹与哈希 |
| `strictProtocolVariant.ts` | Zod 辅助工厂：strictAction、strictOperation、strictKind 等判别联合构建器 |
| `agentGatewayProtocol.ts` | Agent 网关 HTTP 传输合约：Assistant 聊天状态、命令状态、目标配置 |
| `agentTools.ts` | Agent 工具名称枚举与分类（Stage 命令 vs 工作台 vs 创意空间） |
| `agentTools.json` | Agent 工具名称→类别映射数据 |
| `agentSessionCapabilities.json` | Agent 会话能力声明数据 |
| `stageProtocol.ts` | Stage 常量：几何体类型、相机移动方式、抖动、步态等枚举 schema |
| `creativeWorkspaceProtocol.ts` | Canvas/视频编辑器 Agent 表面的传输合约：节点、边、剪辑、时间轴操作 |
| `productionJobProtocol.ts` | 生产作业协议：作业状态、类型、输入 schema（ComfyUI、生成 3D、转录等） |
| `productionJobKinds.json` | 生产作业类型与状态枚举数据 |
| `videoGenerationProtocol.ts` | 视频生成合约：provider 标识、作业状态、渲染输入、LTX 约束 |
| `comfyGenerationProtocol.ts` | ComfyUI 生成协议：媒体类型、参数 schema、节点定义、prompt 来源 |
| `generated3dProtocol.ts` | 3D 生成协议：provider 标识、模式、拓扑、作业输入 schema |
| `episodeProtocol.ts` | 合成数据 Episode 合约：manifest、action track、captions 的帧级索引 |
| `mediaTranscriptionProtocol.ts` | 媒体转录协议：转录片段、完整转录结果 schema |
| `productionArtifactProtocol.ts` | 作品 artifact 版本化、promotion 与审批合约 |
| `captureReconstructionProtocol.ts` | 捕获重建合约：RGB-D 场景重建、墙壁/物体/关键视图 schema |
| `referenceSceneReconstructionProtocol.ts` | 参考场景重建协议：几何体、光源、图像输入 schema |
| `assetCatalogProtocol.ts` | 资产目录 v2 schema：标识符、类型、格式、许可证元数据 |
| `directorCameraProtocol.ts` | 相机协议：宽高比枚举（16:9, 9:16, 2.39:1 等） |
| `directorColorMetadata.ts` | 色彩元数据合约：色域、传输函数、矩阵、范围、角色 |
| `directorProceduralProtocol.ts` | 程序化生成协议：线性/径向阵列、网格、散布、随机变换操作 |
| `directorProductionProtocol.ts` | 制片协议：场景引用、编辑镜头、制片记录 schema |
| `directorCollaborationGatewayProtocol.ts` | 协作网关协议：房间、WebSocket 消息、base64 载荷 schema |
| `filmPipelineProtocol.ts` | 电影流水线协议：角色、镜头、场次、管线阶段等 artifact |
| `filmProductionProtocol.ts` | 电影制片协议：工作流、简报、角色交付物 schema |
| `filmRoles.ts` | 电影角色 ID 枚举：showrunner、screenwriter、cinematographer 等 12 个角色 |
| `filmTimelineOtio.ts` | OTIO 时间轴构建器：从 FilmRun 生成 OTIO JSON，供 Video Editor 导入 |
| `worldSystemsProtocol.ts` | 世界系统协议：环境效果、水体、野生动物、天气/时间设置 |
| `blenderLiveProtocol.ts` | Blender 实时协议：原生工具请求、变换、图元、灯光、材质操作 |
| `blenderKernel.ts` | Blender 内核策略：冻结的类型化建模操作与 operator/RNA 允许列表 |
| `vehicleProtocol.ts` | 可驾驶载具协议：车辆配置文件（质量、引擎力、悬挂等） |

本地二进制资产验收测试由 [`tests/localAssetTest.ts`](tests/localAssetTest.ts) 门控（`DIRECTOR_LOCAL_ASSET_TESTS=1`）。该辅助不是传输契约，也不从 `src/` 导出。

## 构建

`npm run build` 类型检查所有协议文件。Blender 内核策略需与 Python 副本同步：`integrations/blender/live/addons/worldengine_studio/kernel_policy.py`。