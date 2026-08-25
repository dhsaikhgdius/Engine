---
title: Agent 运行时内核
---

## 状态

已被 DeepSeek Harness 切换（2026-08-17）取代。Director 不再托管树内 Agent 运行循环。Agent 会话、
工具循环、提示词组装、会话持久化，以及通用工作区（`read` / `write` / `edit` / `glob` / `grep` /
`bash` / `todo_write`）、网络（`web_search` / `web_fetch`）、Job 和子代理工具，全部来自官方
DeepSeek Harness 子模块（`vendor/deepseek-harness`），通过 `npm run dsh` 启动在
`http://127.0.0.1:3080`。

Director 专属的 Stage、Canvas、视频编辑器和 Blender 工具由 `packages/dsh-plugin-workbench`
中的 Cordis 插件提供给 DSH。每个插件工具都会 POST 到正在运行的 Gateway 的
`POST /api/tools/:name` 接口。MCP 客户端（`backend/gateway/mcp-server.ts`）和 Stage CLI
（`tools/scripts/stage-cli.mjs`）调用同一 HTTP 接口。不要再添加树内工具循环、会话存储分叉，
或 DSH 工作区/网络/Job 工具的托管副本。

## 运行链路

```text
DeepSeek Harness 会话（vendor/deepseek-harness，npm run dsh）
  → @director/dsh-plugin-workbench 工具调用
  → Gateway POST /api/tools/*（routes/stageRoutes.ts）
  → 进程级精确目标调度器
  → Director 项目或 Blender 原生场景
```

MCP 与 CLI 客户端不经过 harness，直接从 `POST /api/tools/*` 进入。

## Gateway 仍然拥有的部分

1. **工具 HTTP 接口与精确目标调度。** `routes/stageRoutes.ts` 加上
   `agents/agentToolScheduler.ts`：明确只读的调用可以有界并发执行，并按原始调用顺序返回；
   绑定到同一精确 Director 目标的调用跨会话、跨客户端共享进程级读写队列；修改独占执行，
   排队期间取消的请求不会下发到浏览器。Blender 保留自身带 Revision 的事务边界。
2. **紧凑操作信封。** 每个域工具只对外公布一个紧凑信封（`agents/agentToolRegistry.ts`，
   从 DSH 插件再导出）。精确字段通过 `describe` 和 `capabilities` 按需披露，Gateway 仍按
   完整严格 Schema 校验每次执行。大型操作联合类型因此不会在每个工具回合消耗模型上下文。
3. **影片角色工具策略。** `agents/filmRoleToolPolicy.ts` 按 `FilmRoleId` 限制可见与可调用的
   工具和操作；MCP 与 DSH 插件应用同一策略。
4. **面向模型的结果投影。** `agents/agentToolResultProjection.ts` 将超大工具结果（超过 48 项的
   重集合，或超过 12,288 字节预算的信封）压缩为计数、有界 id 样本和检索提示。MCP 响应构建器
   （`mcpToolResponse.ts`）与 DSH 插件都使用它；原始 HTTP/CLI 响应保持完整。截图字节不会进入
   序列化的模型 JSON——图像只作为 MCP image block 传输。
5. **无状态客户端的 Revision 记忆。** `agents/agentToolMemory.ts` 让 MCP 服务器把最近观察到的
   工作台 Revision 注入受守卫的写操作，并在 Revision 过期时重试一次。
6. **结构化 LLM 调用的模型提供方配置。** `agents/agentProfileRegistry.ts`、
   `agents/agentApiProviderStore.ts`、`agents/agentApiModels.ts` 与
   `agents/modelProviderIntegration.ts` 为影片管线和多 Agent 生产运行解析托管 API Profile，
   底层是 `packages/model-provider` 中的 wire Driver。它们服务于结构化影片管线调用，
   不是对话循环。

## 主要模块

| 模块                                                  | 职责                                                       |
| ----------------------------------------------------- | ---------------------------------------------------------- |
| `vendor/deepseek-harness`                             | Agent 循环、会话、工作区/网络/Job/子代理工具（子模块）     |
| `packages/dsh-plugin-workbench/`                      | Director Stage / Canvas / Video / Blender 工具的 DSH 插件  |
| `backend/gateway/routes/stageRoutes.ts`               | 工具 HTTP 接口、目标发现、截图、受守卫写操作               |
| `backend/gateway/agents/agentToolScheduler.ts`        | 有序调用窗口与进程级精确目标屏障                           |
| `backend/gateway/agents/agentToolRegistry.ts`         | 紧凑 wire Schema 与超时，从 DSH 插件再导出                 |
| `backend/gateway/agents/agentToolResultProjection.ts` | 超大模型结果的计数 + id 样本摘要                           |
| `backend/gateway/agents/filmRoleToolPolicy.ts`        | FilmRole 工具与操作策略                                    |
| `backend/gateway/mcp-server.ts` / `mcpToolResponse.ts`| MCP stdio 接口，带投影与截图字节剥离                       |
| `packages/model-provider/src/runtime/`                | 结构化调用的 Provider wire、流式、重试与用量               |

切换时已删除——不要再记述或重建：树内 `AgentHarness` 运行循环
（`backend/gateway/agentHarness.ts`）、`agentSessionStore.ts`、`agentAdapters.ts`、托管工作区
工具副本（`backend/gateway/agents/workspace/`）、托管 `web_search` / `web_fetch` 副本
（`backend/gateway/agents/web/`）、`agents/agentToolPipeline.ts`、
`agents/localDirectorToolDispatch.ts`、`agents/agentPluginSettingsStore.ts`，以及托管会话历史、
回放与界面计量模块。
