---
title: Director 控制面架构
description: 浏览器执行面、TypeScript gateway、Agent harness 和 Python worker 的边界与恢复契约。
---

## 范围与当前状态

Director 运行在三个明确的平面：浏览器执行面、TypeScript control plane 和 Python
inference plane。当前控制面已提供 gateway、Agent session、provider adapter、持久化
receipt、multi-agent run 和 LTX-2.3 worker 接口；更复杂的 graph 与跨 DCC round trip
仍是部分实现或提案。

## 进程拓扑

```text
浏览器执行面
  React/R3F、3D Stage、Canvas、Video Editor、clean capture
        │ authenticated HTTP / WebSocket + exact browser target
TypeScript 控制面
  gateway auth、Agent session、API Harness、multi-agent run、role policy
        │ OpenAI-compatible API / provider HTTP v1
Python 推理面
  FastAPI、Pydantic、durable queue、resident GPU model、artifacts
```

浏览器持有 React 状态、WebGL、媒体和必须通过 live tab 验证的操作。Node gateway 持有
认证、配置、session、provider、production graph 与视频 manifest，但不加载模型权重。
Python worker 只负责模型推理、队列和输出 artifact。

## 浏览器执行面

请求必须绑定准确的 tab、Director instance、scene、creative scope 和 protocol version。
过期 target 必须 fail closed，不能把写操作重定向到另一页。浏览器不接触 Agent API key
或 LTX credential，只使用 bootstrap 得到的短期 capability。

## TypeScript 控制面

Node server 负责：

- gateway authentication、配置和 loopback exposure；
- Agent session、红acted conversation event 和 role policy；
- native OpenAI、Anthropic Messages 与 OpenAI-compatible model driver；
- 多 Agent production graph、job manifest、provider adapter 和恢复；
- 对外 HTTP、WebSocket、CLI、MCP 与 browser API 的统一 tool loop；
- 只读发现面：`GET /api/control-plane/capabilities`（脱敏配置）、
  `GET /api/control-plane/tool-manifest`（机器可读 `director-tool-manifest-v1` 工具
  catalog：surface、op 枚举、HTTP 绑定、legacy `stage_*` 标记；绝不包含 secret）与
  `GET /api/control-plane/a2a-agent-card`（ADR 0004 决定的 discovery-only
  `director-a2a-agent-card-v1` 卡片：无 live A2A endpoint，指向 MCP 与 tool manifest；
  绝不包含 secret）。

Canonical tool loop 是：校验请求 → 检查 role policy → 执行 exact target tool → 持久化
redacted event → 返回结构化结果。自 2026-08-25 起，role policy 也在 gateway 工具边界本身
生效：`backend/gateway/agents/httpToolGovernance.ts` 在每条 `/api/tools/*` 路由上应用共享的
电影角色策略（`x-director-film-role` header，其次 `DIRECTOR_FILM_ROLE`，403 拒绝体与 MCP
一致），原始 HTTP、Stage CLI 与 DSH plugin 无法绕过；每次调用都追加到按 source 标记的审计
轨迹（`backend/gateway/agentToolAuditStore.ts`，经鉴权的 `GET /api/agent/tool-audit`
可查询）。

Hosted Agent 的前台委派仍由同一个控制面负责。`subagent` 让 `AgentHarness` 创建一个继承
父级 Profile、角色、工作区与精确浏览器目标的 `api` 子 Session，但把它标记为隔离上下文，
历史重建不会把父对话摊进子级。子级最终答案通过父级普通工具结果返回；父级取消信号会中断
前台子级。被委派的子级不再获得 `subagent`，所以当前只有一层。后台子级直接把同一个
持久 Session 作为 Job 记录，`job_output`、`job_list`、`job_kill` 不复制第二份状态。
通用 Producer Jobs、自动完成唤醒与可续跑子代理控制工具尚未实现。

## 持久化状态

| 状态                     | owner                    | 位置                                  |
| ------------------------ | ------------------------ | ------------------------------------- |
| Agent session/event      | TypeScript control plane | `data/director-agent-sessions.sqlite` |
| Multi-agent run/artifact | TypeScript control plane | `data/multi-agent-runs/`              |
| Director video manifest  | TypeScript control plane | `data/video-jobs/`                    |
| Worker job 与 MP4        | Python worker            | `LTX23_OUTPUT_DIR`                    |

控制面 receipt 与 worker receipt 有意分开：前者记录制作意图，后者记录模型执行。重启
时未完成任务必须进入可重试或 outcome-unknown，而不能报告为成功。

## Agent runtime 与生产图

当前 production graph 是可恢复的串行 DAG：

```text
showrunner → screenwriter → continuity-supervisor → shot-planner
  → stage-director → cinematographer → visual-critic
  → repair-operator → visual-critic → generation-operator → editor
```

每个 role 接收结构化 artifact，使用持久化的 role-specific Profile，并输出 hash-addressed
artifact。只读 role 不能调用 scene mutation 或 video-generation；generation-operator 只
能调用允许的 `stage_video` 能力。

## LTX-2.3

网关对 `vendor/ltx-2` spawn `tools/scripts/ltx23-generate.py`。没有常驻 FastAPI worker。
LTX 尺寸必须是 64 的倍数，帧数满足 `8k+1`。Director 另外保存交付尺寸、推理尺寸、seed、
audio、prompt enhancement、scene digest、warning 和 provider receipt。成片写在
`data/video-jobs/<id>/output.mp4`。

## 扩展规则

新增控制面能力时，先定义版本化 contract、权限、幂等性、revision/fingerprint guard、
失败与恢复，再接入 UI、MCP、CLI 或 provider。任何跨平面边界都必须有可审查的 receipt，
不能通过隐式 import 或坐标点击绕过验证。
