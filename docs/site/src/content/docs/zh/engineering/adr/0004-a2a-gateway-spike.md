---
title: ADR 0004：A2A gateway spike——不上线 A2A runtime
description: 评估将 Director gateway 包装为 Google A2A agent 的 go/no-go 结论：runtime no-go，仅发布 discovery-only agent card。
---

- **状态：** Rejected（live A2A runtime；改为交付 discovery-only agent card）
- **决策负责人：** Director gateway 与 protocol maintainers
- **相关：** [Agent-Native 路线图 M7](/zh/engineering/agent_native_roadmap/)、
  [ADR 0003](/zh/engineering/adr/0003-import-export-receipts/)、[HTTP API](/zh/reference/http-api/)

## 背景

路线图 Milestone 7 要求对「把 Director gateway 包装为
[Google A2A](https://a2a-protocol.org/)（agent-to-agent）agent」给出书面 go/no-go 结论：
发布 Agent Card、接受 A2A JSON-RPC task，让外部 agent 作为远程对端驱动 Director。

相关的控制面已经存在：

- **MCP stdio**（`backend/gateway/mcp-server.ts`）向 MCP host 暴露 `director_workbench`、
  `director_creative`、`director_dcc` 等类型化工具。
- **HTTP** `POST /api/tools/{tool-name}` 用同一套 Zod schema 执行同样的工具。
- **`GET /api/control-plane/tool-manifest`** 发布由执行 schema 派生的机器可读
  `director-tool-manifest-v1` catalog。
- **Gateway 鉴权按设计仅限 loopback**：control plane 拒绝非 loopback 的
  `STAGE_GATEWAY_HOST` bind，所有 `/api/*` 请求携带进程周期的
  `X-Director-Browser-Token`。对公网暴露显式标注为 **Limited**；联网部署必须经由
  有鉴权的 reverse proxy。
- 变更绑定 **exact-target lease**（token + client + instance + scene + scope）与
  `expected_revision` / fingerprint 守卫；**film-role policy** 已覆盖 MCP、本地 harness
  与托管 adapter（原始 HTTP 的 role 闸门属于 M3 剩余项）。

## Spike：A2A 到 Director 的映射

| A2A 概念                                  | Director 现状                                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Agent Card `skills`                       | 可干净映射到类型化工具：`director_workbench`（Stage）、`director_creative`（Canvas/Video）、`blender_native`（DCC）、`stage_video`（生成） |
| Agent Card `url`（A2A JSON-RPC endpoint） | 不存在。执行面是 MCP stdio 加 loopback HTTP，没有可指向的远程 JSON-RPC 服务                                               |
| `message/send`、Task 生命周期、streaming  | 会在单一 gateway tool loop 之外形成**第二套执行协议**，附带自己的 task store、streaming 与 push notification 语义         |
| OAuth2/HTTPS `securitySchemes`            | 不匹配：gateway 使用 loopback 进程 token 并拒绝非 loopback bind；没有 OAuth issuer、TLS 终结或按对端的身份体系              |
| 任意远程对端                              | Director 的 naive-caller boundary 注入 exact-target lease、revision 与 idempotency key；A2A 消息没有承载这些守卫的原生字段 |

## 决策

现在实现 live A2A server 为 **no-go**。发布 **discovery-only** agent card 为 **go**：
它把 A2A-aware 客户端指向 Director 实际执行的控制面——MCP 与 HTTP tool manifest——
而不是再立一套执行协议。

该卡片由 gateway 以 `GET /api/control-plane/a2a-agent-card` 提供
（`backend/gateway/controlPlane/a2aAgentCard.ts`），与 tool manifest 出自同一 builder，
不会与注册表漂移。它在构造上保持诚实：

- `discovery_only: true`，A2A JSON-RPC endpoint 为 `null`；
- `url` 是 loopback gateway origin，绝不是公网 A2A 服务；
- skills 镜像实时 tool manifest 中的 `director_workbench`、`director_creative`、
  `blender_native` 与 `stage_video`；
- streaming、push notification 与 task history 全部为 `false`；
- 不含任何 secret、token 或凭据环境变量名。

## 后果

### 正面

- A2A 生态今天即可如实发现 Director，且不增加任何攻击面；
- 无需维护与 gateway tool loop 并行的第二套 task executor、session store 或 streaming；
- loopback / 进程 token 安全模型不变。

### 成本

- 跨 app 调用方必须使用 MCP 或 Director HTTP；纯 A2A 客户端无法执行任务；
- 多一份需要与 manifest 对齐的发现响应（两者同源派生，已缓解）。

## 拒绝的替代方案

1. **完整 A2A runtime（JSON-RPC endpoint、task streaming、push notification）。** 拒绝：
   它要求 loopback gateway 有意不具备的远程 HTTPS + OAuth 式鉴权，会复制执行边界，且没有
   具体消费方。除非合作产品明确需要，否则持续推迟。
2. **仓库内静态卡片文件、不提供服务。** 拒绝：手工维护的 JSON 会与实时工具注册表漂移；
   已交付的卡片由 `buildDirectorToolManifest()` 构建。
3. **仍在卡片上公布远程 A2A endpoint URL。** 拒绝：这是安全回退——会把对端引向绕过
   gateway 鉴权的路径，或误报 Limited 的公网暴露姿态。

## 安全

卡片绝不能公布绕过 gateway 鉴权的远程 A2A endpoint。它与其他 `/api/*` 路由一样位于
`X-Director-Browser-Token` 鉴权之后，只返回 loopback URL，不含 secret。在没有
control-plane 架构文档要求的鉴权 reverse proxy 时，把它重新发布到远程 origin 不受支持。

## 里程碑与重启条件

本 ADR 关闭 M7 的 A2A spike。完整 A2A runtime 持续推迟，除非合作产品具体要求 A2A task
执行；届时应以新 ADR 重启，覆盖远程鉴权、task 到 lease 的映射以及 A2A 边界上的 role
policy。
