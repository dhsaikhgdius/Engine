---
title: 多 Agent 制作
description: 把电影角色路由到不同模型 Profile，并运行 Director 的持久化串行制作图。
---

Director 可以通过同一套持久化 session harness 运行本地 coding Agent 和托管模型 API。
**Profile** 是服务端持有的模型/运行时配置；**电影角色**负责限定工作指令，并通过共享的
`filmRoleToolPolicy.ts` 约束 MCP、本地 Agent harness 与托管 API adapter 可调用的工具。
原始 HTTP 与人类 UI 操作不受该策略约束。

当前实现是固定、持久化的**串行制作图**，不是动态 DAG。它不会并行调度节点，也不会让模型在
运行中重写执行图。

## 配置托管 Profile

启动 gateway 前设置 `DIRECTOR_AGENT_PROFILES_JSON`。它是严格 JSON 数组；未知字段、重复或保留
ID、无效 URL、无效凭据环境变量名都会使启动失败。

```bash
export OPENAI_API_KEY='...'
export ANTHROPIC_API_KEY='...'
export DIRECTOR_AGENT_PROFILES_JSON='[
  {
    "id":"openai-director",
    "label":"OpenAI Director",
    "driver":"openai",
    "model":"your-openai-model-id"
  },
  {
    "id":"claude-camera",
    "label":"Claude Camera",
    "driver":"anthropic",
    "model":"your-anthropic-model-id"
  },
  {
    "id":"openai-critic",
    "label":"OpenAI Visual Critic",
    "driver":"openai",
    "model":"your-vision-model-id"
  }
]'
```

托管 driver 支持 `openai`、`anthropic` 和 `openai-compatible`。OpenAI 与 Anthropic 使用各自
原生协议。OpenAI-compatible Profile 必须提供 `baseUrl`；只有 endpoint 本身位于 loopback 时
才能不配置凭据。secret 始终留在 gateway，不会出现在发现接口、event 或持久化 conversation 中。

对应 CLI 可用时，下列本地 Profile 会自动注册：

| Profile ID     | Provider | Runtime                    |
| -------------- | -------- | -------------------------- |
| `codex-local`  | `codex`  | Codex app server           |
| `claude-local` | `claude` | Claude streaming JSON      |
| `api-default`  | `api`    | 旧版 OpenAI-compatible API |

通过 `GET /api/agent/profiles` 只读取公开元数据。响应包含可用性、模型、endpoint host 和 capability
标志，但不会包含 API key 或保存 key 的环境变量名。

## 把角色路由到 Profile

服务端默认路由是严格的、可部分配置的 role map：

```bash
export DIRECTOR_AGENT_ROLE_PROFILES_JSON='{
  "stage-director":"openai-director",
  "cinematographer":"claude-camera",
  "visual-critic":"openai-critic",
  "repair-operator":"openai-director"
}'
```

每个节点只在创建 run 时解析一次 Profile，优先级为：

1. production-run 请求中的 `profileByRole[role]`；
2. `DIRECTOR_AGENT_ROLE_PROFILES_JSON` 中的同名角色；
3. run 的 `profileId` fallback，默认是 `api-default`。

解析结果会写入持久化 node，因此 resume 不会把已经完成或尚未执行的节点静默切换到后来修改的
模型配置。

一个 run 只有一个 `provider`，所有选中 Profile 必须属于该 provider。OpenAI、Anthropic 和
compatible 托管 Profile 都属于 `api`，所以可以互相混用；同一个 run 不能同时使用
`codex-local` 和 API Profile。创建前还会检查每个 Profile 的工具能力；`visual-critic` 必须同时
具有 vision 和 tools。

## 默认制作图

省略 `roles` 时，Director 按以下顺序创建节点：

```text
showrunner
  → screenwriter
  → continuity-supervisor
  → shot-planner
  → stage-director
  → cinematographer
  → visual-critic
  → repair-operator
  → visual-critic
  → generation-operator
  → editor
```

第二次 Critic 用来检查修复结果。请求可以提供更短的有序 `roles` 数组，但执行仍然是串行的。
节点优先接收显式分配的 input artifact；没有显式输入时，最多继承最近三个上游 artifact。

每个节点都会创建持久 Agent session。最终文本和受大小限制的结构化工具回执会变成不可变的
SHA-256 artifact。只有完成的工具结果真正包含 revision、package 或 generation job 证据时，
Director 才会将其标为 `director-receipt` 或 `generation-receipt`；只有文字说明时仍是
`role-report`。

## 角色护栏

MCP、本地 Agent harness 与托管 API adapter 在 `backend/gateway/agents/filmRoleToolPolicy.ts`
中共享以下工具策略：

| 角色组                                 | 允许的工作                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------ |
| Showrunner、编剧、连续性监督、镜头规划 | Stage 读取，以及只读 Workbench/creative 操作                                   |
| Stage director、摄影、修复             | Stage 与 Workbench 创作；禁止 `stage_video` 和 creative 编辑                   |
| Visual critic                          | Stage 读取、Blender inspect、Workbench capture/shot_ir，以及只读 creative |
| Generation operator                    | `stage_video`、Canvas pipeline configure/start/cancel，其余只读                |
| Editor                                 | Creative workspace 操作和 Stage 读取                                           |

工具输入仍必须通过 HTTP/MCP 共用的运行时 schema。角色策略只是额外限制，不能替代 target、revision、
idempotency、资产和质量护栏。

## 精确目标绑定

每个 run 都绑定到最新 Workbench observe 返回的完整 target：

```json
{
  "token": "opaque-target-token",
  "client_id": "browser-client-id",
  "instance_id": "project-instance-id",
  "scene_id": "scene-id",
  "creative_scope_id": "scope-id",
  "contract_version": 2
}
```

Gateway 会检查所有字段，而不是只检查 token。tab 断开、加载了另一个 instance、切换 scene/scope，
或返回 target 不匹配时，操作都会 fail closed。Director 不会回退到另一个可见 tab。目标发生实质
变化后，应重新 observe 并创建新的 run。

## 持久化与恢复

Run 以原子写入方式保存到 `data/multi-agent-runs/`；Agent session 和 event 使用 SQLite WAL
保存到 `data/director-agent-sessions.sqlite`。

- `POST /api/agent/runs` 在持久化 run 并调度执行后返回 `202`。
- 使用 `GET /api/agent/runs/{id}` 轮询 node 状态、artifact 和 error。
- `POST /api/agent/runs/{id}/cancel` 中断当前 session，并把运行中和待执行节点标成 cancelled。
- `POST /api/agent/runs/{id}/resume` 保留 succeeded 节点，把其他节点重置为 pending，并复用固定的
  Profile ID 与 target。

节点失败后，后续节点不会执行。Resume 前应重新连接同一个精确 target，并解决返回的 provider、
审批、capability 或工具错误。不要手工修改 run JSON。

## 当前限制

- 制作图是串行有序列表，不是依赖感知或由模型生成的 DAG。
- 没有并行节点、推测分支、自动重规划或投票机制。
- 当前 Workbench 面板暴露的是以 Stage 为中心的精简链；完整默认图通过 HTTP run API 使用。
- 创建前会检查 provider 可用性与 capability，但远端模型或浏览器 target 仍可能在运行中失败。
- 成功回执只能证明工具结果，不能证明审美质量；进入生成或剪辑批准前，Visual Critic 必须检查
  clean image 证据。

Bootstrap、鉴权与可运行请求示例见 [HTTP API](/zh/reference/http-api/)。
