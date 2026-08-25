---
title: 架构
description: 了解 Director 的 UI、数据、校验、网关和集成层。
---

Director 将制片状态、渲染、协议兼容和外部 Agent 传输分开。

## 分层

```text
React 应用和 DOM 编辑器外壳
  └─ React Three Fiber 视口和预览画布
      ├─ Zustand Director 运行时 store
      │   └─ DirectorProject v1 + Zod 校验
      │       ├─ Director 工作台执行器
      │       └─ Stage adapter → StageScene v5 → 共享 Stage 命令引擎
      ├─ Blender 场景层
      │   └─ 共享临时原生快照 → 预览、选择、检查器、相机、碰撞
      └─ 场景范围 Creative 工作区 + 持久媒体库
          └─ Canvas / Video 执行器 + 快照 fingerprint + 制片审计

本地 Agent 网关
  ├─ 精确目标 HTTP 和 WebSocket 路由
  ├─ MCP stdio 代理
  ├─ 制片清单和场景持久化
  ├─ 捕获协调
  ├─ Codex / Claude provider adapter
  └─ SQLite Agent 会话 store

Blender 原生运行时
  ├─ 一份绑定的权威场景 + 带 revision 的 live protocol
  ├─ 根对象投影与 Director 事务桥
  └─ 原生 mesh、材质、UV、modifier、armature、action 与 NLA 所有权
```

## UI 与渲染

完整 Director 编辑器位于 `frontend/director/src/comprehensive` 下。DOM 面板负责普通应用 UI；React Three Fiber 负责 3D 构图、相机、辅助元素和捕获。高频帧更新留在场景运行时内，避免触发大范围 React 应用更新。

## 原生场景后端

原生后端是同一 Director 工作流中绑定的无头 Blender 4.2+ 场景。`DirectorProject.nativeScene`
把制片绑定到一份权威原生场景；Director 持久化制片语义与根对象投影，Blender 持久化原生子数据。
唯一场景层轮询原生运行时并发布共享临时快照，因此 Stage 和检查器不会创建平行场景副本或各自刷新。
兼容 Director 人物通过一个窄 capability adapter 把 canonical Action/Pose 语义映射到原生 armature；
不支持的 IK 会被明确拒绝，而不是维护第二套人物模型。
详见[数据模型](/zh/architecture/data-models/#blender-原生场景绑定)与
[Blender 原生后端](/zh/engineering/blender_bridge/)。

## 校验

Zod schema 校验不可信边界：

- Stage 场景 JSON；
- Director 项目导入和检查点替换；
- 制片清单和变更；
- assistant plan/apply payload；
- terminal 和 workbench 消息；
- Creative 工作区请求和操作批次；
- Agent 会话记录。

结构校验与语义校验分开。结构正确的操作仍可能失败，例如对象 ID 不存在，或分镜中的相机引用已经断裂。

## 网关

`backend/gateway/agent-gateway.ts` 负责服务启动和共享资源。路由模块拆分制片、assistant、会话和 Stage 端点。工具执行留在本地，并且只写入经过校验的状态。浏览器目标 token 将 Workbench 和 Creative 流量绑定到一个精确的标签页、实例、场景和 creative scope；旧目标会安全失败，而不会选择其他客户端。

## Provider 中立

Provider adapter 将不同的会话和流式协议归一到共享的 `AgentSession` 与 `AgentEvent` 契约。场景创作仍使用同一套 Director 工具，因此不同 provider 的文本协议不会演变成第二套场景模型。

新增 provider、编辑器集成或模型运行时前，请阅读[控制面与 Python Worker 架构](/zh/architecture/control-plane/)
以及[Server 导入边界契约](/zh/architecture/server-import-boundaries/)。
