---
title: 产品宪法
description: 决定 Director 能不能做、要不要做的北极星、十条原则与三个准入问题。
---

本页是 Director 的决策过滤器。功能请求、重构或路线图争论僵持不下时，回到这里裁决。
[黄金旅程](/zh/concepts/golden-journey/)展示这些原则落地后的工作流；
[Agent-native 制片](/zh/concepts/agent-native-production/)定义它们要求的契约。

## 北极星

**Director 是一座可验证镜头工厂（verified shot factory）**：它把创作意图变成镜头，而镜头的
布局、光学与像素都可证明地绑定到同一个已验收项目版本——人类与 Agent 通过同一个项目完成。

其余一切——Stage、Canvas、视频编辑器、生成管线、Blender 桥、Agent 工具——都是为了让下一个
可验证镜头更便宜、更快或更可信。

## 十条原则

1. **验证优先于生成。** 镜头的完成标准是交付回执把 audit、clean capture 与 package 哈希绑定
   到同一 revision，而不是模型返回了像素。
2. **一个项目，所有控制面。** 浏览器 UI、MCP、HTTP 与 CLI 读写同一份 `DirectorProject`。
   没有影子状态，没有只给 Agent 或只给人类的功能。
3. **发现，绝不猜测。** `capabilities` 与 `catalog` 是唯一词汇表。虚构操作、资产 ID 或坐标
   是 bug，不是创意。
4. **一个意图，一个原子批次。** 每次修改都携带 revision guard 与幂等键。整个意图作为一个撤销
   单元完整提交，否则什么都不改变。
5. **便宜的决定先做。** 布局、尺度、镜头与连续性在公制白模中确定——错误只花几秒；绝不留到
   昂贵的生成之后才发现。
6. **语义操作优先于坐标。** 相对放置、朝向目标、组合走位。屏幕坐标自动化与猜测的世界坐标是
   最后手段，不是默认。
7. **只用真实几何。** 场景实例化 catalog 网格、Blender 创作的几何或已晋级的生成 3D 资产。
   白模是黏土质感，不是一堆 Stage 方块。
8. **确定性检查先于品味。** `audit` 捕获机器能捕获的问题；人类或 Critic 评判 35–65 mm 的
   clean capture。`audit.ready` 永远不等于视觉验收。
9. **回执，而非乐观。** 每个操作与任务都报告实际提交的内容。没有回执的声称、没有检查的回执，
   都不是证据。
10. **复用生态。** 官方第三方项目保持 vendored submodule，Agent harness 是 DeepSeek
    Harness，词汇表活在分级教学渠道里——不做树内 fork，不做第二个工具循环，不加第五个
    文档渠道。

## 我们是什么 / 不是什么

**我们是：**

- 一张制片桌：把一个镜头从意图带到绑定 revision 的视觉证据；
- 一个 Agent-native 控制面：普通 Agent 能安全地创作、验证与修复；
- 一条白模到生成的管线：用经过验证的 3D 取景为视频模型提供条件；
- 连接 Stage、Canvas、视频编辑器、Gallery 与 DCC 交接的项目记录。

**我们不是：**

- prompt 出视频的玩具——没有可审计取景的裸生成不在范围内；
- 游戏引擎或 DCC 替代品——原生几何以 Blender 为准，引擎接收导出而不是被重新实现；
- 第二个 Agent harness——Director 用领域工具扩展 DeepSeek Harness，而不是 fork 工具循环；
- 资产商店——catalog 的存在是为了让镜头可验证，不是为了卖内容。

## WorldEngine 与 Director 的命名

- **WorldEngine** 是仓库与平台：Gateway、共享 packages、管线、integrations 与 vendored
  推理项目。
- **Director** 是建立在其上的浏览器产品：人类指挥、Agent 控制的制片桌。

所有面向用户的内容（UI 文案、文档、工具名）用 _Director_；只有指仓库或平台层时才用
_WorldEngine_。规范的一行定义见[术语表](/zh/concepts/glossary/)。

## 三个准入问题

每个新功能上线前必须对以下三问全部回答"是"：

1. **它强化黄金旅程的哪一步？** 在[黄金旅程](/zh/concepts/golden-journey/)中指出具体一步
   （J1–J6）。哪一步都不服务的功能不上线。
2. **Agent 能端到端驱动它吗？** 它必须能通过 `capabilities` 发现、通过精确目标定位、有守卫、
   幂等且可观察——不能只有 UI，也不能只有 Agent。
3. **它产生证据吗？** 它的成功必须能对照 revision 检验：回执、audit、diff 或 clean
   capture。成功无法验证的功能不算完成。

改变这些答案的决定记录为[架构决策记录](/zh/engineering/adr/)；ADR 0005 记录了本宪法的采纳。
