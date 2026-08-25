---
title: 角色资产、Rig 与动作管线
description: 浏览器角色资产、骨骼控制、IK、retarget、动作来源和 Agent-native 契约。
---

## 决策摘要

角色不是任意模型 URL，而是经过许可、测量、哈希和验证的运行时 artifact。当前生产
基线是 `assets/library/mixamo-characters/catalog.json` 中的 **108 个 Mixamo humanoid**，默认人物
为目录资产 `mixamo:x-bot`；动作基线是 `assets/library/mixamo-animations/catalog.json` 中的 **14 个
真实骨骼 clip**。Blender authoring 使用 Rigify；需要跨工具交换时考虑 VRM 1.0。每个角色
都必须有稳定的高度、落地偏移、骨骼清单、材质预算、缩略图和来源。

`assets/library/director-characters/catalog.json` 是较早资产集，不再是当前 production baseline；
`frontend/director/src/comprehensive/editor/schema/characterAssetCatalog.ts` 是弃用的 FBX fixture。Agent 资产
单一入口是 `frontend/director/src/comprehensive/editor/schema/directorAgentAssetCatalog.ts`。

## 1. 资产来源

候选来源分为本地许可目录、人工制作的 GLB、Mixamo/VRM 等可交换格式和生成式 3D 候选。
生成模型只能作为候选，仍需 topology、法线、材质、rig、动画、尺寸、许可证和可复现
hash 检查。

不要把公开 URL 直接放进浏览器运行时。先下载、记录 provenance/license、规范化坐标和
贴图，生成 runtime proxy、thumbnail 与 catalog entry。

## 2. 浏览器角色的验收条件

### 建模与拓扑

- 网格必须有稳定法线、无退化面、合理 UV 和可接受 draw-call；
- 变形区域需要支持肩、髋、肘、膝、手指等 stress pose；
- LOD、纹理尺寸和材质数量应适配浏览器预算。

### 坐标与 pivot 契约

Director 使用 metre-scale、明确 up axis、handedness 和 floor plane。资产目录应保存
可见 bounds、root/pivot、人物高度和 floor offset。放置角色时先按 bounds 落地，再应用
用户指定 transform；不能用模型 origin 代替脚底。

### 材质与性能

记录纹理格式、颜色空间、压缩、透明度、shader feature、骨骼数量和 animation memory。
clean capture 不应出现骨骼、gizmo、网格、标签或 helper layer。

## 3. Rig 选择与可复用模板

### 当前生产模板：Mixamo humanoid

Mixamo 适合作为浏览器角色和基础动作的统一命名模板，但必须本地缓存并保存 license、
源文件 hash、骨骼映射和 retarget 测试结果。

### Blender authoring 模板：Rigify

Rigify 用于 DCC 中的控制器和姿势制作；交接前烘焙到稳定的 deform skeleton，并明确
控制器、约束、root motion 和 export action 的边界。

### Portable avatar 模板：VRM 1.0

VRM 可携带 humanoid mapping、表情、look-at 和元数据，但导入时仍需验证坐标、材质、
许可、骨骼命名、动作和浏览器兼容性。

## 4. 关节、骨骼与动作控制

底层可以使用 FK/骨骼 action，高层暴露语义控制，例如 `head.yaw`、`leftElbow.bend`、
`leftHand.target`。语义控制必须有范围、单位、左右侧定义和确定性结果。

### FK 与语义控制

FK 用于精确 action 播放；语义控制用于 Agent 和 UI 的局部调整。二者的应用顺序要固定，
并在 observe 中返回最终 pose，而不是只返回请求值。

### IK

手和脚的 IK 目标使用 metre-space、pole target、约束范围和 foot lock。求解失败时返回
明确 warning，不能把不可达目标静默夹到别处。

### Retarget 与实例

retarget 保存源 rig、目标 rig、关节映射、root motion、脚锁定、时间基准和修正参数。
同一动作可以供多个角色实例使用，但实例覆盖必须可撤销且不修改共享源 clip。

## 5. 动作获取与生成

来源包括人工 keyframe、动作库、MediaPipe 等捕获、retarget、MotionGPT/MDM 等研究模型
和未来图像/视频到动作服务。生成动作必须先成为带 provider、prompt、输入 hash、seed、
版本和许可证的 immutable artifact，再进入角色 timeline。

## 6. Agent-native 契约

### 发现

通过 `catalog:"character_assets"` 和 `catalog:"character_motions"` 返回完整 asset、
thumbnail、尺寸、rig、hash、来源和 license。Agent 不猜文件名或骨骼名。

### 原子 authoring

`upsert_asset`、`add_object`、`set_character_motion`、`set_character_pose_controls` 和
`set_character_ik` 可以组合成一个带 revision guard 的原子 batch。结果必须包含对象 ID、
最终 pose、floor/height、warning 和 diff。

### 感知与验收

observe 返回骨骼和动作状态；audit 检查落地、碰撞、骨骼、动作范围和 clean capture；视觉
交付绑定 exact frame、camera 和 project fingerprint。

### 未来生成 API

未来接口应提交明确的 prompt、reference、motion constraints、seed、provider、预算和
许可证；返回 durable job、immutable artifact version 和可比较的 preview。

## 7. 交付关卡

角色资产只有同时通过 GLB、hash、尺寸、rig/bone、材质/纹理、stress pose、retarget、
缩略图、来源和许可检查，才可进入 production catalog。不能把“模型能加载”当成验收。
