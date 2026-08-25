---
title: Server 导入边界
description: 保持 server 运行时边界清晰，避免浏览器代码、模型 worker 和服务端模块互相泄漏。
---

Server 代码必须保持 Node gateway、浏览器执行面和 Python inference worker 的边界。
浏览器模块不能导入 Node-only 依赖，server 不能把模型权重或浏览器状态带入控制面，
worker 也不能绕过 gateway 直接修改 Director 项目。

## 规则

- `backend/gateway/` 只导入官方 workspace 包（`@director/protocol`、`@director/agent-engine`、`@director/project-schema`、`@director/stage-protocol`、`@director/dcc-*`、`@director/model-provider`、`@director/di`）以及 Gateway 本地模块；
- `frontend/director/src/` 的浏览器代码通过明确的 API/client 边界访问 Gateway；
- 共享类型放在 `packages/` 的无副作用模块中；
- Node-only 的 `fs`、`path`、子进程和密钥读取不能进入浏览器 bundle；
- worker 只接收校验后的 job request，并通过 receipt 返回状态与 artifact；
- 外部 provider adapter 不得成为第二套 Director scene model。

Gateway 不再保留临时的 frontend import 例外。Stage 执行、创作与 session schema 都通过 `@director/agent-engine` 进入控制面。
