---
title: ADR 0003：互操作计划、清单与回执
description: 将外部导入导出拆成可审查的计划、manifest 和 commit receipt。
---

- **状态：** 对已交付 adapter 为 Accepted（核验于 2026-08-25）—— creative interchange
  `plan-import` → `import` 与 `plan-export` → `export`（Fountain、OTIO/OTIOZ、glTF/GLB、
  USD/USDZ；OBJ/STL 导出带 SHA-256 文件回执）即运行时的 plan/receipt 路径
  （`frontend/director/src/agent/creativeWorkspaceSemanticOperations.ts` + 导入/导出测试）；
  Blender `.blend` 导入使用服务端持久化 plan 与受守卫的原子 apply。未列出的 adapter
  路径仍为 Proposed。

## 背景

导入导出同时涉及 schema、资产、坐标系、时间基准、媒体二进制和外部工具能力。直接
写入或直接导出容易隐藏降级、部分失败和错误覆盖。

## 决策

互操作分成三个阶段：

1. **Plan**：读取输入并列出身份匹配、创建/link/merge/replace 意图、能力差距和风险；
2. **Manifest**：固定 schema、版本、哈希、单位、时间基准、来源和计划 fingerprint；
3. **Receipt**：实际 commit 后记录写入的对象、输出 artifact、警告、降级和失败。

### 导入

导入先生成 `ImportPlan`，声明将创建、链接、合并还是替换哪些实体。只有在校验通过且
用户或 Agent 明确提交后，才写入 Director 状态。

### 导出

导出先生成 `ExportManifest`，列出目标格式的能力、降级语义和完整输入 fingerprint。
写入完成后产生不可变 `ExportReceipt`，可追踪到准确 project revision 和 artifact。

## 后果

### 正面

- 用户可以在写入前审查差异和能力损失；
- 失败不会伪装成成功，也不会静默覆盖现有版本；
- DCC、视频和媒体适配器拥有统一证据边界。

### 成本

- 每种适配器都要维护 plan、manifest 和 receipt；
- 需要保存较多元数据并实现 fingerprint 比较；
- 简单导出也会多一个准备阶段。

## 拒绝的替代方案

- 直接把对象序列化到目标格式；
- 只返回一个成功/失败布尔值；
- 用目标文件时间戳代替来源身份和版本。

## 验收

应覆盖 dry-run、能力降级、部分失败、重试、相同 fingerprint replay、payload 冲突、
路径重定位和 receipt 与最终二进制的哈希绑定。
