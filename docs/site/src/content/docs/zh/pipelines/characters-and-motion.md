---
title: 角色、绑定与动作
description: 经过校验的人形资产、确定性骨骼动作、语义关节控制、IK 与 Agent 原生发现。
---

Director 将角色视为经过许可、测量并哈希的运行时资产，而不是任意模型 URL。打包目录数量以
[功能状态](/zh/reference/feature-status/#目录数量)为准（最近核验为 108 个 Mixamo 人形和 14 个
真实骨骼动作片段）。

## 运行时顺序

每一帧都会按同一个稳定栈求值：

1. 根据项目帧采样骨骼动作；
2. 应用受限的语义控制，例如 `head.yaw` 或 `leftElbow.bend`；
3. 求解以本地米制表示的手部和脚部 IK 目标；
4. 更新蒙皮并渲染；
5. 在干净捕获中排除所有骨骼、gizmo、网格和标签。

这样拖动时间线、静帧捕获、确定性导出和 Agent 验证会保持一致。

## Agent 发现

Agent 应搜索，而不是猜测：

```json
{
  "op": "catalog",
  "catalog": "character_assets",
  "query": "Abe",
  "offset": 0,
  "limit": 25
}
```

结果包含完整的 `asset` 对象、缩略图、测量高度和地面偏移、rig 元数据、哈希、来源和许可 URL。将 `asset` 原样传给 `upsert_asset`，再在同一个原子 `author` 批次中从 `add_object` 引用它的 ID。

使用 `catalog:"character_motions"` 发现有效动作片段 ID 和播放默认值。用 `set_character_motion` 应用动作，用 `set_character_pose_controls` 做类似 FK 的语义编辑，用 `set_character_ik` 设置手脚目标。创作后观察 `characters`，验证这三层是否都正确。

## 资产验收

库中的角色必须通过 GLB 校验、哈希检查、度量 pivot/高度测量、rig 和骨骼清单、材质/纹理预算、压力姿势蒙皮审查、动画重定向测试、真实渲染缩略图生成以及来源/许可审查。“能加载”不是验收标准。

完整的工程决策记录（包括资产来源、Blender Rigify 与 VRM 模板、拓扑和权重绘制建议、Three.js 重定向/IK 库、MediaPipe 捕获、MotionGPT/MDM 与图像转 3D 模型选项）维护在 `docs/site/src/content/docs/engineering/CHARACTER_ASSET_MOTION_PIPELINE.md`。
