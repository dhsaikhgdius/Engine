---
title: 为什么选 Director
description: Director 解决的问题，以及它与 Runway、Unreal、Cursor、Blender 之间的边界。
---

## 问题

AI 视频生成能产出漂亮的画面，却不接受指导：布局、镜头与连续性每次 roll 都会变，团队把预算
烧在反复改 prompt 上，而不是导演镜头。3D 工具给了完全的控制，却没有 Agent 能信任的契约——
没有可发现的词汇表，没有守卫的修改，没有绑定 revision 的证据能证明镜头确实正确。结果是
"我能描述这个镜头"与"我能证明这个镜头"之间的鸿沟：人类在不透明的 UI 里点来点去，Agent
幻觉出 ID 和坐标，没人说得清哪些像素对应哪个已验收状态。

Director 弥合这道鸿沟。人类在浏览器里以可视化方式指挥场景，Agent 通过带类型的 MCP、HTTP
与 CLI 控制面检查并修改同一个项目。构图在公制白模中确定——错误只花几秒；由确定性 audit 与
clean capture 验证；然后才交给生成。因此每个交付的镜头都携带绑定到同一项目版本的证据。

## 边界在哪里

- **vs Runway** —— Runway 用 prompt 生成镜头然后碰运气；Director 先在可验证的 3D 中确定
  布局、镜头与连续性，再以这份取景为条件做生成。
- **vs Unreal** —— Unreal 是在引擎深度里构建世界的实时引擎；Director 是停留在镜头层面的
  制片桌，通过 DCC 交接导出到引擎，而不是替代它们。
- **vs Cursor** —— Cursor 让 Agent 成为代码库的一等公民；Director 把同样的纪律——发现、
  守卫的原子修改、可验证的结果——应用到电影项目而不是源码文件。
- **vs Blender** —— Blender 创作几何，并通过 Director 的实时桥对原生网格保持权威；
  Director 负责几何之外的制片语义：相机、take、coverage、audit 与交付。

## 下一步

维持这些边界的规则——北极星、十条原则与新功能的三个准入问题——见
[产品宪法](/zh/concepts/product-constitution/)。要看这些原则产生的工作流，请跟随
[黄金旅程](/zh/concepts/golden-journey/)。
