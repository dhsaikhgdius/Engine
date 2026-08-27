---
title: "ADR 0005：Verified shot 北极星"
---

- **状态：** Accepted（2026-08-27）
- **决策负责人：** Director 维护者
- **相关：** [产品宪法](/zh/concepts/product-constitution/)、
  [黄金旅程](/zh/concepts/golden-journey/)、
  [Agent 原生生产](/zh/concepts/agent-native-production/)、
  [竞品能力并集](/zh/research/competitive-union/)

## 背景

仓库里积累了多份强叙事输入——竞品能力并集、Agent 原生路线图、研究综述，以及实验性的 game
slice。它们各自有用，但放在一起容易被误读为互相竞争的产品方向。贡献者和 Agent 需要一句能裁决
范围问题的话；研究输入也需要明确的归档状态，避免一份锁定的审计被当作待办清单。

## 决策

采纳[产品宪法](/zh/concepts/product-constitution/)作为 Director 的决策过滤器。它的北极星是
**经过验证的镜头工厂**（verified shot factory）：从导演意图到已交付镜头只有一条生产线，每一步
都有类型、绑定 revision、可验证。每个变更都要回答宪法的三个准入问题（理念三问）：

1. 它强化[黄金旅程](/zh/concepts/golden-journey/)的哪一步（J1–J6）？
2. Agent 能端到端驱动它吗——可发现、可精确定位、有守卫、幂等且可观察？
3. 它产生什么绑定 revision 的证据——回执、audit、diff，还是 clean capture？

Pull request 另外携带固定的层级标注：**core** 是唯一的「意图到镜头」生产线；**adapter** 把
外部工具、格式与模型映射到 core 契约；**experiment** 保持隔离、诚实标注，永远不是第二条管线。
`director_game` 是 experiment，不是第二条影片管线。

[竞品能力并集](/zh/research/competitive-union/)这类研究文档是已归档的研究输入，不是产品路线图。
它们保留内容与来源价值，顶部带有指向本 ADR 的归档提示，并且不决定或排序交付工作。

## 影响

- `AGENTS.md` 带有 North Star 小节，两份 README 带有一行理念句，人类和 Agent 首先读到同一句话。
- PR 模板要求填写理念三问、Layer 标注、证据链接和宪法自查，每次合并都重申这部宪法。
- 可能被读作路线图的研究页顶部带有指向本 ADR 的归档提示。
- 范围争议以宪法与理念三问裁决，而不是以任何一份研究文档裁决。
