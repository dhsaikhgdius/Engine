---
title: Agent 运行时内核
---

## 状态

已实现。Director 在 TypeScript Gateway 中只拥有一套 Agent 运行时内核。Provider Bridge 可以翻译外部协议，但不能再拥有独立的会话状态、消息队列或 Director 工具策略。

## 运行链路

```text
AgentSessionStore
  → 共享会话投影
  → Durable Inbox
  → AgentHarness owned run
  → Provider Bridge
  → 统一工具注册与执行管线
  → 进程级精确目标调度器
  → Director 项目或 Blender 原生场景
```

持久事件流是生命周期的唯一事实来源。`agent_sessions` 只是物化投影，并与事件在同一事务中更新。浏览器直接使用 `@director/agent-engine/session-projection` 中的同一 reducer，不再维护第二套生命周期状态机。

## 不变量

1. 只要 Session 仍被保留，它的有序事件流就保持完整。Session 级保留策略可以删除过期 Session 及其所有从属数据，但追加事件时不会再删除早期事件。
2. 队列载荷变化与 `queue.updated` 在同一事务中提交。Gateway 停止时仍处于 running 的消息会在下次启动时回到队列，未闭合 Turn 会转为 interrupted。
3. 一个 Session 同时最多拥有一个活动 Turn。`whenIdle()` 同时等待 owned turn 和已经调度的 Inbox drain。
4. 关闭时先停止 Provider，记录仍未结束的 Turn，等待运行时静止，冲刷流式缓冲，最后才关闭 SQLite。
5. Codex 动态工具和 Hosted 模型工具共享同一个工具注册、角色策略、超时、精确目标校验、Revision 记忆、结果投影、溢出存储和结果归一化。Gateway 进程内的调用直接走 `handleStageRoute`，不再经 localhost HTTP 回环；MCP、CLI 和 `blender_native` 仍使用 `POST /api/tools/*`。
6. 明确只读的工具窗口可以有界并发，返回给模型的结果仍保持原始调用顺序。指向同一精确 Director 目标的 Workbench/Creative 调用会跨 Session、跨 Provider 共享进程级读写队列；修改独占执行，排队期间取消的请求不会下发到浏览器。Blender 保留自身带 Revision 的事务边界。

## 主要模块

| 模块                                                  | 职责                                                        |
| ----------------------------------------------------- | ----------------------------------------------------------- |
| `packages/agent-engine/src/agentSessionProjection.ts` | 前后端共享的事件到 Session reducer                          |
| `backend/gateway/agentSessionStore.ts`                | SQLite 事件流、投影、Inbox、恢复与批量追加                  |
| `backend/gateway/agentHarness.ts`                     | Turn 所有权、队列调度、取消与安静关闭                       |
| `backend/gateway/agents/agentToolRegistry.ts`         | 统一工具定义、超时和执行模式                                |
| `backend/gateway/agents/workspace/`                   | 工作区工具与受沙箱限制的前台 Bash                           |
| `backend/gateway/agents/web/`                         | Hosted `web_search` / `web_fetch`（DSH 能力缝，DeepSeek 官方 + Exa + HTTP） |
| `backend/gateway/agents/agentPluginSettingsStore.ts`  | 插件页：搜索提供方/密钥、Agent 循环并行度                   |
| `backend/gateway/agents/agentToolPipeline.ts`         | 策略、目标路由、执行和有界模型结果                          |
| `backend/gateway/agents/localDirectorToolDispatch.ts` | Hosted / Codex 进程内 Stage 路由分发                        |
| `backend/gateway/agents/agentToolScheduler.ts`        | 有序调用窗口与进程级精确目标屏障                            |
| `backend/gateway/agentAdapters.ts`                    | Codex、Claude 协议翻译                                          |

Claude 仍通过便携 MCP 进程通信，因为该传输由 CLI 管理。它们共享相同的 Gateway 契约和角色策略；Provider 特有的消息格式只保留在 Bridge 边界。

## Workspace Bash 边界

Hosted Bash 不是给外部 Coding CLI 使用的 node-pty 终端。每次调用只启动一个新的、非交互、前台进程，并返回 stdout、stderr、退出码、超时、截断和沙箱拒绝事实。非零退出码表示命令执行完成，不是 Gateway 传输失败。

Gateway 在运行时选择 macOS Seatbelt 或 Linux Bubblewrap；两者都不可用时，能力会明确显示 unavailable，并拒绝执行，不会静默退化为裸 Shell。写入只允许发生在 Director 工作区和临时目录，子进程环境会过滤 Gateway 凭据。后台 Job 与权限提升仍是独立的后续能力。

## 尚未统一的边界

Agent 检查点当前保存 Director 项目快照。Blender 原生 Revision 会进入事件流，但还不能与项目快照一起原子恢复。后续统一检查点必须绑定 Director Project Revision 与 Blender Scene Revision 或原生 Savepoint；在完成前，恢复接口必须继续明确标记为 Director-only scope。
