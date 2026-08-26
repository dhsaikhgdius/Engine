---
title: Director 创作生产对齐关卡
description: Director 对专业 previs、相机、角色、媒体、Agent 和恢复路径的完成要求。
---

这里定义 Director 什么时候足以支撑真实的创作生产，而不是只拥有看起来相似的控件。
完成意味着同一个制作状态能被 UI、Agent、导出和审计一致地解释。

## 当前 P0 基线

- `DirectorProject v1` 与 `StageScene v5` 有显式 adapter；
- 相机拥有 filmback、crop、lens、focus、DOF 和 clean capture；
- Performance Take、Coverage Shot、精确帧和 revision guard 已进入核心模型；
- Canvas/Video、MCP、HTTP、CLI 和 browser API 共享语义操作；
- 一次性 Canvas/Video UI mutation 经 `dispatchCreativeWorkspaceOperations` 与 Agent 共用同一
  dispatch 路径，自动填入 fingerprint guard 与幂等键，UI 与 Agent 编辑产出相同 revision 与回执；
  连续拖拽/裁剪/滑杆交互保留本地历史批处理（覆盖范围见
  [UI/Agent 对等清单](/zh/engineering/ui-agent-parity-inventory/)）；
- ShotIR、audit、PNG frame package 和 hash-bound evidence 已有基础实现。

## 后续关卡

### P0：production graph

统一 asset、beat、shot、artifact、usage、review 和 approval 身份，同时保留各编辑器
负责自己的详细状态。

### P1：专业互操作与 coverage

支持可审查的 Blender 回传、OpenUSD/Unreal package、多个相机复用一个表演、可降级但不
静默丢失语义的 adapter，并把交付包绑定精确 revision 与 fingerprint。

## 先复用，再发明

行为研究、源码复用、模型资产和许可证必须分开登记。MIT/Apache 适配保留 notice 和
修改义务；限制性或不明确许可只允许 clean-room 行为研究，不能把受保护实现换名复制。

## 旅程级验收

至少验证以下旅程：

1. 新项目 → 资产目录 → Stage blocking → 相机 coverage → clean frame；
2. Agent observe → 原子 author → audit → 修复 → 再 audit；
3. Canvas reference → generation job → immutable version → Video editorial；
4. revision conflict、provider timeout、worker restart、取消和 outcome-unknown 恢复；
5. Blender export → receipt → reviewable return package（当前 v1 只承诺单向）。

## 产品参考

竞品研究只用于能力与验收要求，不能成为 Director 的第二套产品模型。每条能力都需要
对应的 schema、UI/Agent 路径、测试、证据和许可证决定。
