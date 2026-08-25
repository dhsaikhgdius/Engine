---
title: 控制面与 Python Worker
description: 了解浏览器、TypeScript 控制面、Agent Harness 和 Python 推理边界。
---

Director 将制片工作分成三个明确的运行平面：

```text
浏览器执行面
  React/R3F、3D Stage、Canvas、Video Editor、clean frame 捕获
        │ 认证 HTTP / WebSocket + 精确浏览器目标
TypeScript 控制面
  Gateway 鉴权、Agent 会话、API Harness、多 Agent 运行、
  角色权限、manifest、provider adapter
        │ OpenAI-compatible API / provider HTTP / spawn 官方 CLI
官方模型源码（`vendor/`）
  LTX-2 DistilledPipeline、Hunyuan3D、TRELLIS、ARDY
```

## 浏览器执行面

浏览器负责 React 状态、WebGL、浏览器媒体，以及必须应用到实时标签页或通过渲染像素验证的操作。
`frontend/director/src/comprehensive/editor/api` 是前端访问控制面的统一传输边界。每个目标绑定一个标签页、Director
实例、场景、creative scope 和协议版本；目标过期时安全失败。

浏览器不会收到 Agent API key，只会在 bootstrap 后使用短期 Gateway capability。

## TypeScript 控制面

`backend/gateway/` 下的 Node Gateway 负责鉴权、配置、Session 持久化、角色权限、多 Agent 编排、视频 manifest 和
provider adapter，不加载模型权重。API Harness 根据服务端 Profile 选择原生 OpenAI、原生 Anthropic
Messages 或 OpenAI-compatible Model Driver；统一的 canonical 工具循环负责校验调用、执行角色权限、
把 Director 工具发送到精确目标，并持久化脱敏的 provider-neutral 对话事件。

当前制片图是可持久化的串行 DAG：

```text
showrunner → screenwriter → continuity-supervisor → shot-planner
  → stage-director → cinematographer → visual-critic
  → repair-operator → visual-critic → generation-operator → editor
```

每个角色拥有独立 Agent Session 和固化到节点的 Profile，接收结构化上游 artifact 并产生带哈希的
artifact；第二个视觉 Critic 是修复后的复验。恢复时保留已成功节点及其 Profile；
取消时等待后台清理完成。只读角色不能调用场景变更或视频生成；`generation-operator` 可以调用
`stage_video`，但不能调用无关的场景变更工具。

## 官方模型源码

网关对 `vendor/ltx-2` spawn `tools/scripts/ltx23-generate.py`，一次跑完 DistilledPipeline。
没有常驻 FastAPI worker。LTX 要求宽高是 64 的倍数、帧数满足 `8k+1`。Director 同时记录请求的
交付尺寸和解析后的推理尺寸，以及 seed、音频开关、prompt 增强、场景摘要、警告和 provider receipt。
成片写在 `data/video-jobs/<id>/output.mp4`。

## 持久化与恢复

| 状态                      | 所有者            | 位置                                  |
| ------------------------- | ----------------- | ------------------------------------- |
| Agent Session/事件        | TypeScript 控制面 | `data/director-agent-sessions.sqlite` |
| Multi-Agent 运行/artifact | TypeScript 控制面 | `data/multi-agent-runs/`              |
| Director 视频 manifest    | TypeScript 控制面 | `data/video-jobs/`                    |
| LTX-2.3 MP4               | 网关 spawn        | `data/video-jobs/<id>/output.mp4`     |

完整的端点、环境变量和扩展契约参见[控制面架构记录](/zh/engineering/architecture/control-plane/)。
