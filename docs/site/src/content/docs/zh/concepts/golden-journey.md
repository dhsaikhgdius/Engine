---
title: 黄金旅程
description: 把一个镜头从意图带到可验证交付的六个步骤，以及 verified shot 的定义。
---

黄金旅程是 Director 为之优化的工作流：一个镜头，从一句意图到绑定 revision 的视觉证据。
每个功能都必须强化其中一步——这是[产品宪法](/zh/concepts/product-constitution/)的第一个
准入问题。

## 六个步骤

| 步骤 | 名称 | 发生什么                                                                          | 完成标准                                 |
| ---- | ---- | --------------------------------------------------------------------------------- | ---------------------------------------- |
| J1   | 意图 | 在 Canvas 上落下镜头 brief：镜头要表达什么、参考与血缘                            | 意图成为可定位的节点，而不是一条聊天消息 |
| J2   | 搭建 | 构建公制白模：实例化真实 catalog、Blender 或生成 3D 资产                          | 布局与尺度在黏土质感下读得正确           |
| J3   | 取景 | 添加物理相机与 take：镜头、传感器、对表演的 coverage                              | 构图在 35–65 mm clean capture 上成立     |
| J4   | 验证 | audit、correct 与 deliver：把 audit、clean capture 与 package 哈希绑定到 revision | 一份交付回执——镜头成为 **verified shot** |
| J5   | 生成 | 以已验证的取景与 render passes 为条件做视频生成；任务追踪到回执                   | 带真实 job 回执的生成产物进入 Gallery    |
| J6   | 成片 | 在视频编辑器里剪画面与声音；审阅、导出或交接到 DCC/引擎                           | 剪辑引用 verified shot，导出带回执       |

旅程是循环而不是瀑布：audit 失败回到 J2 或 J3，生成被否回到 J4 产生新 revision，剪辑上的
批注重新打开 J1。永远不变的是证据的方向——每一步消费上一步的回执。

## verified shot 是什么

**verified shot** 是一份交付回执，不是一种感觉。它要求以下各项全部绑定到同一个已验收项目
版本：

- `ready:true`、`status:"delivered"` 与 `capture_verified:true`；
- 通过的 `audit`——引用、落地、重叠与取景；
- 移除所有编辑器辅助元素的 clean capture，以及请求的 render passes；
- 符合预期的 revision 与 package fingerprint；
- 人类或 Critic 对 clean 画面的检查——`audit.ready` 本身永远不等于验收。

想亲手产出一个，请跟随[端到端可验证镜头教程](/zh/tutorials/verified-shot/)；它用真实命令
走完 J2–J4。

## 控制循环

旅程的每一步都由同一套 Agent 循环驱动：

```text
capabilities/catalog → observe → 原子提交一个意图 → observe/diff → audit/correct → deliver
```

发现防止虚构词汇，观察提供真实 ID 与 revision guard，一个原子批次提交意图，交付绑定证据。
完整契约——target、guard、幂等与失败恢复——见
[Agent-native 制片](/zh/concepts/agent-native-production/)。
