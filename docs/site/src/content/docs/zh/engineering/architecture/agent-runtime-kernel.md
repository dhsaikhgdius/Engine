---
title: Agent 运行时内核
---

## 状态

已被 DeepSeek Harness 集成取代。Director 不再自研 Agent 运行时内核:工具循环、会话存储、提示词组装以及 workspace / web / job 工具全部来自 `vendor/deepseek-harness`(DSH)。Director 的创作面是 Cordis 插件 `packages/dsh-plugin-workbench/`,它把 Director 工具与系统指导注册进 DSH。本页早期描述的自研模块(`AgentSessionStore`、`AgentHarness`、`agentToolPipeline`、Provider 适配器)已从 Gateway 中删除。

## 运行链路

```text
DSH 会话(vendor/deepseek-harness,循环 + 会话 + 提示词)
  → Cordis 插件 packages/dsh-plugin-workbench(director_workbench / director_creative /
    stage_video / blender_native / director_model_routes)
  → Gateway POST /api/tools/:name
  → handleStageRoute(backend/gateway/routes/stageRoutes.ts)
  → 调度窗口 / Revision 守卫 / 角色策略
  → Director 项目(浏览器 Stage)或 Blender 原生场景
```

编码 Agent(Cursor、Claude Code、Codex)通过 `backend/gateway/mcp-server.ts` 走同一套 Gateway 契约,MCP 面暴露 `director_workbench`、`director_creative`、`director_dcc`。两个面共用同一份严格 Schema 校验与同一套工具结果投影。

## 不变量

1. Gateway 对 Agent 循环无状态。会话历史、Turn 所有权、队列与压缩归 DSH 所有;Director 不再重复实现。
2. 每次修改都会用 `expected_revision` 对照实时项目校验,并返回新 Revision。Stale-revision 拒绝会携带当前 Revision,调用方可以重新 observe 后重试。
3. 明确只读的工具窗口可以有界并发,返回给模型的结果仍保持原始调用顺序。指向同一精确 Director 目标的调用会跨会话、跨表面共享进程级读写队列(`agents/agentToolScheduler.ts`);修改独占执行。Blender 保留自身带 Revision 的事务边界。
4. 领域工具对所有模型表面只公布一个紧凑操作信封。精确字段通过 `describe` 与 `capabilities` 渐进披露(`agents/agentToolRegistry.ts`),Gateway 仍按完整严格 Schema 校验每次执行。
5. 超大工具结果在到达模型前会被摘要。规范投影实现位于 `packages/dsh-plugin-workbench/src/toolResultProjection.ts`,已接入 DSH 插件结果路径与 `createMcpToolResponse`;编码媒体载荷会从文本/JSON 中剥离,只经附件通道传输一次。
6. 修改操作携带 `idempotency_key`;重放由工具记忆(`agents/agentToolMemory.ts`)直接应答,不会重复执行。
7. 公开 authoring 调用设置 Stage `geometry_type` 会被拒绝。缺失建筑用 `blender_native`(`create_blockout` / `create_opening`)建模或用 `generated_3d` 生成;白膜是 clay look,不是堆 Stage 盒子。

## 主要模块

| 模块                                                    | 职责                                                       |
| ------------------------------------------------------- | ---------------------------------------------------------- |
| `vendor/deepseek-harness`                                | 工具循环、会话存储、提示词组装、workspace/web/job 工具     |
| `packages/dsh-plugin-workbench/src/register.ts`          | Director 工具注册与 `DIRECTOR_AGENT_GUIDANCE`              |
| `packages/dsh-plugin-workbench/src/catalog.ts`           | 从 `packages/protocol` Zod 投影出的模型侧工具 Schema       |
| `packages/dsh-plugin-workbench/src/toolResultProjection.ts` | 规范的超大结果摘要与媒体剥离实现                       |
| `backend/gateway/routes/stageRoutes.ts`                  | 所有表面共用的 `POST /api/tools/:name` 执行                |
| `backend/gateway/agents/agentToolRegistry.ts`            | 统一紧凑 wire schema、定义、超时与读/写模式                |
| `backend/gateway/agents/agentToolScheduler.ts`           | 有序调用窗口与进程级精确目标屏障                           |
| `backend/gateway/agents/agentToolMemory.ts`              | 按 `idempotency_key` 的幂等重放                            |
| `backend/gateway/agents/agentToolOutcomes.ts`            | 结果归一化(`completed` / `failed` / `stale_revision` …)  |
| `backend/gateway/agents/filmRoleToolPolicy.ts`           | 按角色限制工具与操作                                       |
| `backend/gateway/mcp-server.ts`                          | 编码 Agent 的 MCP 表面(Cursor / Claude Code / Codex)     |

`npm run dsh` 准备 Director workbench overlay 并在 `:3080` 启动固定版本的 DSH Web;`npm run mcp` 启动面向编码 Agent 的 MCP 服务器,对接 `:8787` 的 Gateway。

## 尚未统一的边界

Director 项目 Revision 与 Blender 原生场景 Revision 是两条独立的事务边界。Blender 编辑会话由自身的快照指纹与 Revision 链保护;目前没有把 Director 项目 Revision 与 Blender 场景 Revision 原子绑定的统一检查点。在统一检查点出现之前,恢复接口必须继续明确标记为 Director-only scope。
