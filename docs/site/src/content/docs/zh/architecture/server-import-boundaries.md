---
title: Server 导入边界
description: 保持 TypeScript 控制面与仅浏览器可用的编辑器运行时代码隔离。
---

`backend/gateway/**` 是 TypeScript 控制面。它可以使用 Node 库和正式的 workspace 包：
`@director/protocol`、`@director/agent-engine`、`@director/project-schema`、`@director/stage-protocol`、
`@director/dcc-protocol`、`@director/dcc-interchange`、`@director/model-provider`、`@director/di`。

它不能导入 React、React Three Fiber、Zustand store、Xterm、UI 面板、编辑器 canvas、浏览器 store，或
`window`、`document`、`localStorage`、`indexedDB` 等浏览器全局对象。前端行为必须通过经过校验的
HTTP/WebSocket 契约跨越边界。

边界检查器是 `tools/scripts/checkServerImportBoundaries.ts`；ESLint 和 server 边界测试会检查静态、导出、动态及
`require` 导入。Gateway 不再保留临时的 frontend import 例外。

```text
packages/*                       共享契约与无进程副作用的运行时
backend/gateway/                 Node 控制面与外部集成
frontend/director/src/           浏览器编辑器、WebGL、store、面板和捕获
vendor/                          网关按需 spawn 的官方 Python 模型源码
```
