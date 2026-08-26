---
title: UI/Agent 对等清单 — Stage DirectorStore
description: Stage DirectorStore 项目 mutator 清单，以及每个 mutator 是否已与 Agent 共享 authoring dispatch 路径。
---

这是 [Agent-Native 路线图](/zh/engineering/agent_native_roadmap/) 的 Milestone 0 清单：列出 Stage
`DirectorStore`（`frontend/director/src/comprehensive/editor/store/directorStore.ts`，下文简写为
`directorStore.ts`）上的全部变更入口、对应的 semantic authoring action，以及 UI 与 Agent 是否已经
通过同一 executor 产出相同的项目 revision。

最近核验：**2026-08-26**。

## 状态说明

- **shared** — 单次 UI 调用经 `dispatchDirectorAuthoringActions`
  （`frontend/director/src/agent/dispatchDirectorAuthoringActions.ts`）执行，内部与 Agent 共用
  `applyDirectorAuthoringActions`，两条路径产出相同 revision。编译辅助函数在
  `frontend/director/src/agent/compileDirectorUiAuthoringActions.ts`。所有 shared mutator 在
  滑块/gizmo 撤销批次内（`undoBatchDepth > 0`）以及行内注明的不可表达 patch 上，回退到旧的直接写入。
- **ui-only** — 仍只通过 `commitMutation` / `withProjectPatch` 写项目。同一意图下 Agent 尚无
  revision 一致性保证。标注「有意保持本地」的行在代码内有明确理由，不属于待补的编译缺口。
- **human-only-interactive** — 有意不经 authoring：逐帧交互手感、DCC 投影、运行时测量、选择、
  历史与项目生命周期。

## 覆盖率摘要

| 类别 | 数量 |
| ------------------------------ | ----- |
| shared Stage 项目 mutator | 69 |
| ui-only Stage 项目 mutator | 18 |
| 覆盖率（shared / 项目 mutator） | **69 / 87 ≈ 79%** |

对等性由
`frontend/director/tests/agent/dispatchDirectorAuthoringActions.test.ts` 回归保护：同一份
`DirectorProject` 分别经 store mutator 与直接 `applyDirectorAuthoringActions` 变更，
`getDirectorProjectRevision` 必须一致。

## 对象与变换

| Mutator | 文件 | Semantic action | 状态 |
| --- | --- | --- | --- |
| `deleteObjects` / `deleteSelectedObject` | `directorStore.ts` | `update_object`（脱离子级）+ `delete_objects` | shared |
| `updateObjectTransform` | `directorStore.ts` | `update_object` | shared（相机 rig、composite 父级、object-focused 相机刷新仍走旧写入） |
| `toggleObjectVisible` / `toggleObjectLocked` | `directorStore.ts` | `update_object` | shared（相机 rig 仍走旧写入） |
| `toggleObjectInteraction` | `directorStore.ts` | `update_object`（经 `updateObjectTransform`） | shared |
| `setObjectAnimation` | `directorStore.ts` | `set_animation` | shared |
| `updateObjectTransforms`（多选） | `directorStore.ts` | `update_object` 批量 | shared（批次含相机 rig、composite 父级或 object-focused 相机时仍走旧写入） |
| `batchUpdateObjects` / `resetObjectTransforms` | `directorStore.ts` | `update_object` 批量 | shared（composite 父级变换传播与 object-focused 相机刷新仍走旧写入） |
| `alignObjects` / `distributeObjects` | `directorStore.ts` | `align_objects` / `distribute_objects` | shared（被 object-focused 相机跟随的选区仍走旧写入） |
| `isolateObjects` / `showAllObjects` | `directorStore.ts` | `isolate_objects` + `set_object_layer_state` / `show_all_objects` | shared（涉及隐藏相机对象的显示恢复仍走旧写入） |
| `setObjectPivot` | `directorStore.ts` | `set_object_pivot` | shared |
| `dropObjectToGround` / `updateCrowdTransform` / `dropCrowdToGround` | `directorStore.ts` | `update_object`（尚未编译） | ui-only |
| `updateObjectName` | `directorStore.ts` | `update_object` / `update_camera`（相机 rig） | shared（fov 已漂移的 snapshot 相机与未绑定资产的角色仍走旧写入） |
| `updateObjectColor` | `directorStore.ts` | `update_object` | shared（相机 rig 与已 provision 的 Blender 原生对象仍走旧写入） |
| `updateCrowdLabel` / `updateCrowdColor` | `directorStore.ts` | `update_object` 群体扇出（尚未编译） | ui-only |
| `updateObjectMaterial` / `updateObjectMaterialTexture` | `directorStore.ts` | `update_object` 材质 patch | shared（composite 父级、相机 rig 与已 provision 的 Blender 原生对象仍走旧写入） |
| `setObjectVehicleProfile` | `directorStore.ts` | `set_vehicle_profile` / `clear_vehicle_profile` | shared（仅未锁定的 prop/scene 对象走共享路径；其余仍走旧写入） |
| `updateObjectReferenceBindings` | `directorStore.ts` | `update_object`（`reference_bindings`） | shared（相机 rig 与已 provision 的 Blender 原生对象仍走旧写入） |
| `createCompositeObject` / `addObjectsToComposite` / `removeObjectsFromComposite` | `directorStore.ts` | `group_objects` / `update_object` parent patch | shared（含已 provision 的 Blender 原生对象的 composite 仍走旧写入） |
| `createObjectList` / `addObjectsToObjectList` / `removeObjectsFromObjectList` / `updateObjectListLabel` | `directorStore.ts` | 无 semantic action（对象列表是 UI 选择辅助，不是 composite 组） | ui-only（有意保持本地） |
| `pasteClipboardObjects` | `directorStore.ts` | `add_object` 批量（尚未编译；已记录 gap） | ui-only |

## 相机

| Mutator | 文件 | Semantic action | 状态 |
| --- | --- | --- | --- |
| `updateCamera` | `directorStore.ts` | `update_camera`（同步 linked rig object） | shared（capture/动画 patch、旋转或缩放的 rig transform、frustum 深度内特写仍走旧写入） |
| `setActiveCamera` | `directorStore.ts` | `set_active_camera` | shared |
| `addCameraShot` | `directorStore.ts` | `add_camera`（未接入） | ui-only（有意保持本地：snapshot 相机要保留视口精确 fov 而 `add_camera` 由焦距推导 fov，顺序 `cam_N` id 与活动相机光学继承是 UI 约定，且选中态与写入在同一次提交内） |
| `setCameraAnimation` | `directorStore.ts` | `set_animation` | shared |
| `addCameraCaptures` | `directorStore.ts` | 尚无 semantic action（capture 证据写入） | ui-only |

## 角色

| Mutator | 文件 | Semantic action | 状态 |
| --- | --- | --- | --- |
| `applyPosePreset` / `applyCrowdPosePreset` | `directorStore.ts` | `update_object`（`pose_preset_id`） | shared |
| `updatePoseControl` / `updateCrowdPoseControl` | `directorStore.ts` | `set_character_pose_controls` | shared |
| `setCharacterMotion` / `setCrowdCharacterMotion` | `directorStore.ts` | `set_character_motion` / `clear_character_motion` | shared（迁移期 `authored` root motion 仍走旧写入） |
| `setCharacterIkEffector` / `setCrowdCharacterIkEffector` | `directorStore.ts` | `set_character_ik` | shared |
| `clearCharacterIkEffector` / `clearCrowdCharacterIkEffector` | `directorStore.ts` | `clear_character_ik` | shared |
| `updateCharacterBodyType` | `directorStore.ts` | `update_object`（尚未编译；需刷新 focused 相机） | ui-only |
| `updateUniformScale` / `updateCrowdUniformScale` | `directorStore.ts` | `update_object`（尚未编译） | ui-only |

## 灯光

| Mutator | 文件 | Semantic action | 状态 |
| --- | --- | --- | --- |
| `addLight` | `directorStore.ts` | `add_light` | shared |
| `updateLight` | `directorStore.ts` | `update_light` | shared（灯光类型切换会重置类型字段，仍走旧写入） |
| `removeLight` | `directorStore.ts` | `delete_lights` | shared |

## 场景、世界与 Storyboard

| Mutator | 文件 | Semantic action | 状态 |
| --- | --- | --- | --- |
| `updateScene` | `directorStore.ts` | `set_scene` | shared |
| `updateWorldSettings` | `directorStore.ts` | `set_world_settings` | shared |
| `upsertWorldEffect` | `directorStore.ts` | `add_world_effect` / `update_world_effect`（含火势 `propagation`） | shared（锁定条目、隐藏/锁定的新增、锚定到缺失对象的条目仍走旧写入） |
| `removeWorldEffects` | `directorStore.ts` | `remove_world_effects` | shared |
| `upsertWorldWaterBody` / `removeWorldWaterBodies` | `directorStore.ts` | `add_world_water_body` / `update_world_water_body` / `remove_world_water_bodies` | shared |
| `upsertWorldWildlifeGroup` / `removeWorldWildlifeGroups` | `directorStore.ts` | `add_world_wildlife_group` / `update_world_wildlife_group` / `remove_world_wildlife_groups` | shared（依赖默认飞行高度带的 add 仍走旧写入） |
| `upsertWorldRoad` / `removeWorldRoads` | `directorStore.ts` | `add_world_road` / `update_world_road` / `remove_world_roads` | shared |
| `updateStoryboard` | `directorStore.ts` | `set_storyboard` | shared |
| `addSceneAnnotation` / `updateSceneAnnotation` / `removeSceneAnnotation` | `directorStore.ts` | `add_annotation` / `update_annotation` / `remove_annotations` | shared |
| `addSceneMeasurement` / `updateSceneMeasurement` / `removeSceneMeasurement` | `directorStore.ts` | `add_measurement` / `update_measurement` / `remove_measurements` | shared |
| `setObjectLayerState` | `directorStore.ts` | `set_object_layer_state` | shared |
| `moveObjectLayer` | `directorStore.ts` | `reorder_object_layer` | shared |
| `removePanoramaAsset` | `directorStore.ts` | `remove_assets` | shared（没有目录条目的悬空 panorama 引用仍走旧写入） |

## 时间线音频

| Mutator | 文件 | Semantic action | 状态 |
| --- | --- | --- | --- |
| `addTimelineAudioClip` / `updateTimelineAudioClip` / `moveTimelineAudioClip` / `removeTimelineAudioClip` / `setTimelineAudioTrackMuted` | `directorStore.ts` | `set_scene` timeline 整体替换 | shared（音量滑杆撤销批次仍走旧写入） |

## 资产与新建流程

| Mutator | 文件 | Semantic action | 状态 |
| --- | --- | --- | --- |
| `addImportedAsset` | `directorStore.ts` | `upsert_asset` | 仅库导入（不实例化进场景）走 shared；场景实例化与 panorama 绑定导入仍走旧写入（对象构建包含 authoring 无法表达的 UI 约定） |
| `setAssetRealWorldSize` | `directorStore.ts` | `upsert_asset` | shared（清除尺寸仍走旧写入，避免米制 backfill 重新估算被清除的值） |
| `removeImportedAsset` | `directorStore.ts` | `update_object`（脱离子级）+ `remove_assets` cascade | shared |
| `addObjectFromAsset` / `addPresetCharacter` / `addCrowdCharacters` | `directorStore.ts` | `add_object`（未接入） | ui-only（有意保持本地：对象构建要写入 `add_object` 不表达的 Blender `nativeSource` provisioning 标记与 rig 默认值） |
| `addGeometryPrimitive` | `directorStore.ts` | `add_object`（进程内 white-box `geometry_type`） | shared |

## Human-only 交互面

以下入口有意保持直接写入；把它们逐帧强制走 authoring 会破坏交互手感，或把 DCC/运行时投影与
用户创作意图混为一谈。

| Mutator | 文件 | 原因 | 状态 |
| --- | --- | --- | --- |
| `beginUndoBatch` / `endUndoBatch` + 所有 shared mutator 的批次内回退 | `directorStore.ts` | TransformControls / 滑块 RAF 批次；指针抬起后合并为一条撤销记录 | human-only-interactive |
| Viewport 导航与 pilot 手感（`setViewMode`、`setTransformMode`、`setViewport*`、`resetViewportNavigation`） | `directorStore.ts` | `commitUiPatch` UI 状态；不写项目 | human-only-interactive |
| 选择与 inspector（`selectObject`、`selectObjects`、`selectCrowd`、`toggleObjectSelection`、`openSceneInspector`） | `directorStore.ts` | UI 状态；不写项目 | human-only-interactive |
| `syncBlenderScene` / `prepareBlenderSync` / `ensureNativeSceneBinding` | `directorStore.ts` | 权威 Blender 场景的 DCC 投影，不是用户创作 | human-only-interactive |
| `setObjectMeasuredLocalBounds` | `directorStore.ts` | 运行时几何测量，`trackUndo: false` | human-only-interactive |
| `copySelectedObjects` | `directorStore.ts` | 仅剪贴板 UI 状态（粘贴才写项目） | human-only-interactive |
| `undo` / `redo` | `directorStore.ts` | 全量快照的历史回放 | human-only-interactive |
| `replaceProject` / `applyAuthoredProject` / `openScopedScene` / `saveLatestSnapshot` / `restoreLatestSnapshot` | `directorStore.ts` | 项目生命周期与持久化，含共享 dispatch 的落点 | human-only-interactive |

## Canvas / Video

Canvas 与 Video 已通过 `director_creative`
（`packages/protocol/src/creativeWorkspaceProtocol.ts`）暴露类型化 Agent JSON 操作。二者的 UI
store 仍直接 patch workspace snapshot，**不在**本 Stage 清单范围内；把它们迁到 creative 契约是
路线图 M1 的 1e/1f 批次，尚未完成。
