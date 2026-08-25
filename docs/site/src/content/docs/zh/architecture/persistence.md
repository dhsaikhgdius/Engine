---
title: 持久化与同步
description: 了解浏览器快照、网关文件、版本和 Agent 会话存储。
---

Director 为编辑器状态、紧凑 Stage 状态、制片元数据和 Agent 会话使用独立存储。

## 浏览器编辑器状态

完整编辑器快照存储在：

```text
storyai-3d-director-desk-demo
storyai-3d-director-desk-demo:<instanceId>
```

`instanceId` 查询参数用于隔离独立的嵌入式工作区。

项目持久化采用 1000 ms 去抖。待写入快照会在 `pagehide` 时刷新。直接替换项目和其他边界操作可以请求立即写入。

画布和视频编辑器使用独立的版本 2 场景范围 envelope。节点、边、轨道、片段、设置和播放头按 creative scope 持久化；导入媒体字节会在 IndexedDB 中去重。切换标签页不会让另一个可见工作区自动成为可接受的 Agent 目标。每个浏览器连接都会声明 client、instance、scene 和 creative-scope 身份，网关随后会将 Workbench/Creative 调用绑定到这个精确元组的不透明 token。

## 本地模型库

本地模型元数据使用：

```text
storyai-3d-director-local-model-library
```

浏览器配额失败不会让当前编辑器会话不可用。大型源文件仍应作为项目资产管理，不要假设浏览器存储无限大。

## UI 偏好

示例：

| Key                            | 用途                                           |
| ------------------------------ | ---------------------------------------------- |
| `director.ui.locale`           | 界面语言                                       |
| `director.performance.profile` | 旧偏好 key；Director 会统一迁移为 High quality |
| 会话范围相机覆盖层 key         | 可拖动相机面板位置                             |
| 会话范围缩略图 key             | 场景/相机缩略图缓存                            |

## 网关数据

| 路径                                   | 内容                                                              |
| -------------------------------------- | ----------------------------------------------------------------- |
| `data/stage-scene.json`                | 经过校验的 StageScene v5                                          |
| `data/director-workbench.json`         | 网关侧完整工作台项目                                              |
| `data/director-production-state.json`  | 制片清单，以及每个场景经过校验并独立带版本的 DirectorProject 文档 |
| `data/latest-preview.png`              | 最近一次捕获                                                      |
| `data/director-agent-plan.schema.json` | 生成的旧版 plan schema                                            |
| `data/director-agent-sessions.sqlite`  | 持久化 Agent 会话和事件                                           |

## 同步

网关只会向同一场景和 creative scope 中兼容的 workbench peer 广播经过校验的项目变更。版本、快照 fingerprint、精确目标 token、schema 解析和图检查共同防止格式错误、过期或跨项目更新悄悄替换有效状态。

场景文档自动保存会串行执行并检查独立 revision；旧浏览器不会覆盖服务端新内容。旧的 `data/director-production.json` 只会在首次建立合并状态时作为迁移输入读取。

## 提交策略

默认不要提交生成的运行时状态：

- SQLite 会话文件和 WAL 产物；
- 捕获和预览；
- 已准备的视频任务；
- 临时图像模型任务；
- 浏览器本地快照。

应提交源资产、有意保留的 fixture、文档和可复现配置。
