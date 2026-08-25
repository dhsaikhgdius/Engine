---
title: 快速开始
description: 从新克隆的仓库启动 Director,并完成一个经过验证的场景。
---

Director 是带有 Agent 控制面的浏览器端 3D 制片台。人可以在界面里可视化地搭建场景;Agent 通过
类型化契约检查和修改同一个项目;双方最终都以可验证的渲染证据收尾,而不是一句未经验证的
"命令执行成功"。

本节是从新克隆仓库到第一个可验证场景的最短路径。

## 前置条件

第一次执行 `npm install` 之前,先核对[安装与运行](/zh/getting-started/install/#环境要求):
Node.js 22 LTS、npm 10+、支持 WebGL 2 的浏览器;只有在需要集成 Blender 后端时,
才需要可选的 Blender 4.2+。

## 推荐路径

1. [安装并运行 Director](/zh/getting-started/install/) — `npm install`,然后 `npm run dev`。
2. 在浏览器打开编辑器 <http://127.0.0.1:5175>,并确认网关健康检查
   <http://127.0.0.1:8787/health> 有响应。
3. 完成[快速上手](/zh/getting-started/quick-start/)场景,可以在编辑器里做,也可以通过 CLI。
4. 按照下面的方向选择继续阅读的路线。

## 服务

`npm run dev` 会启动第一个场景所需的两个进程:**给人用的编辑器**在 `5175` 端口,
**Agent 网关**在 `8787` 端口。浏览器打开 UI;只有健康检查、HTTP、MCP 和 CLI 才用
`8787`。文档站在 `4321`,需要单独执行 `npm run docs:dev`。

| 服务        | 默认地址                       | 用途                                             |
| ----------- | ------------------------------ | ------------------------------------------------ |
| Director UI | `http://127.0.0.1:5175`        | 完整 3D 编辑器、Agent 工作台与 Blender 集成 |
| Agent 网关  | `http://127.0.0.1:8787`        | HTTP、WebSocket、捕获、制片和 Agent API          |
| 健康检查    | `http://127.0.0.1:8787/health` | 检查网关是否可用                                 |
| 文档站      | `http://127.0.0.1:4321`        | 当前文档网站,用 `npm run docs:dev` 单独启动      |

## 选择你的路线

- **我手动操作编辑器。** 先读 [3D 编辑器概览](/zh/editor/),再读
  [场景与资产](/zh/editor/scenes-and-assets/)和[人物、动作与 IK](/zh/editor/characters/)。
- **我要连接 Agent。** 先读 [Agent-native 制片](/zh/concepts/agent-native-production/)理解
  模型,再读 [Agent 控制](/zh/agents/)了解具体接口。
- **我想要一个完整的实战示例。** 跟随[端到端可验证镜头](/zh/tutorials/verified-shot/)教程。

_白模_、_干净捕获_、_修订守卫_ 这类术语在[术语表](/zh/concepts/glossary/)中统一定义,
全站文档保持一致的用法。

底层文档模型——`DirectorProject`、紧凑的 `StageScene` 投影以及 Blender 绑定——见
[数据模型](/zh/architecture/data-models/)。完成快速上手并不需要了解它。
