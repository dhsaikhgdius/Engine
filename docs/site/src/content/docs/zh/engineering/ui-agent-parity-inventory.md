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
- **ui-only** — 仍只通过 `commitMutation` / `withProjectPatch` 写项目。标注为*（有意保持本地）*的
  行在 store 中带有明确的分歧原因注释，不属于迁移候选；其余要么尚无 semantic action，要么待编译。
- **human-only-interactive** — 有意不经 authoring：逐帧交互手感、DCC 投影、运行时测量、选择、
  历史与项目生命周期。

## 覆盖率摘要

| 类别                            | 数量              |
| ------------------------------- | ----------------- |
| shared Stage 项目 mutator       | 80                |
| ui-only Stage 项目 mutator      | 7                 |
| 覆盖率（shared / 项目 mutator） | **80 / 87 ≈ 92%** |

仍为 ui-only 的入口，要么尚无 semantic action（object list），
要么在 store 中带注释、有意保持本地写入（快照相机、预置/人群角色新建）。

对等性由
`frontend/director/tests/agent/dispatchDirectorAuthoringActions.test.ts` 回归保护：同一份
`DirectorProject` 分别经 store mutator 与直接 `applyDirectorAuthoringActions` 变更，
`getDirectorProjectRevision` 必须一致。

## 对象与变换

| Mutator                                                                                                 | 文件               | Semantic action                                                                                     | 状态                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deleteObjects` / `deleteSelectedObject`                                                                | `directorStore.ts` | `update_object`（脱离子级）+ `delete_objects`                                                       | shared                                                                                                                                                                                                        |
| `updateObjectTransform`                                                                                 | `directorStore.ts` | `update_object`                                                                                     | shared（相机 rig、composite 父级、object-focused 相机刷新仍走旧写入）                                                                                                                                         |
| `toggleObjectVisible` / `toggleObjectLocked`                                                            | `directorStore.ts` | `update_object`                                                                                     | shared（相机 rig 仍走旧写入）                                                                                                                                                                                 |
| `toggleObjectInteraction`                                                                               | `directorStore.ts` | `update_object`（经 `updateObjectTransform`）                                                       | shared                                                                                                                                                                                                        |
| `setObjectAnimation`                                                                                    | `directorStore.ts` | `set_animation`                                                                                     | shared                                                                                                                                                                                                        |
| `updateObjectTransforms`（多选）                                                                        | `directorStore.ts` | `update_object` 批量                                                                                | shared（批次内含相机 rig、composite 父级或 object-focused 相机目标时整体走旧写入）                                                                                                                            |
| `batchUpdateObjects` / `resetObjectTransforms`                                                          | `directorStore.ts` | `update_object` 批量                                                                                | shared（composite 父级的变换传播、object-focused 相机刷新，以及对已 provision 的原生 Blender 对象的颜色/材质/图层 patch 仍走旧写入）                                                                          |
| `alignObjects` / `distributeObjects`                                                                    | `directorStore.ts` | `align_objects` / `distribute_objects`                                                              | shared（object-focused 相机目标仍走旧写入）                                                                                                                                                                   |
| `isolateObjects` / `showAllObjects`                                                                     | `directorStore.ts` | `isolate_objects` + `set_object_layer_state` / `show_all_objects`                                   | shared（存在隐藏相机 rig 时的全部显示仍走旧写入）                                                                                                                                                             |
| `setObjectPivot`                                                                                        | `directorStore.ts` | `set_object_pivot`                                                                                  | shared                                                                                                                                                                                                        |
| `dropObjectToGround` / `updateCrowdTransform` / `dropCrowdToGround`                                     | `directorStore.ts` | `update_object` 变换 / `placement_mode` patch（人群逐成员展开）                                     | shared（composite 父级、object-focused 相机，以及对已 provision 的原生 Blender 对象的落地仍走旧写入）                                                                                                         |
| `updateObjectName` / `updateCrowdLabel`                                                                 | `directorStore.ts` | `update_object` `name` / `crowd_label`；相机 rig 经 `update_camera` 改名                            | shared（fov 不稳定的快照相机、未绑定资产的角色改名、输入中的空白人群标签仍走旧写入）                                                                                                                          |
| `updateObjectColor` / `updateCrowdColor`                                                                | `directorStore.ts` | `update_object` `color`（人群逐成员展开）                                                           | shared（相机 rig 与已 provision 的原生 Blender 对象/成员仍走旧写入）                                                                                                                                          |
| `updateObjectMaterial` / `updateObjectMaterialTexture`                                                  | `directorStore.ts` | `update_object` 材质 patch，预合并以匹配 store 的局部合并语义                                       | shared（composite 父级、相机 rig 与已 provision 的原生 Blender 对象仍走旧写入）                                                                                                                               |
| `setObjectVehicleProfile`                                                                               | `directorStore.ts` | `set_vehicle_profile` / `clear_vehicle_profile`                                                     | shared（仅未锁定的 prop/scene 对象可 author；其余仍走旧写入）                                                                                                                                                 |
| `updateObjectReferenceBindings`                                                                         | `directorStore.ts` | `update_object` `reference_bindings`                                                                | shared（相机 rig 与已 provision 的原生 Blender 对象仍走旧写入）                                                                                                                                               |
| `createCompositeObject` / `addObjectsToComposite` / `removeObjectsFromComposite`                        | `directorStore.ts` | `group_objects` / `update_object` `parent_id` patch                                                 | shared（已 provision 的原生 Blender 子对象仍走旧写入）                                                                                                                                                        |
| `createObjectList` / `addObjectsToObjectList` / `removeObjectsFromObjectList` / `updateObjectListLabel` | `directorStore.ts` | 无 semantic action；object list 是 UI 选择辅助，不是 composite 分组                                 | ui-only（有意保持本地）                                                                                                                                                                                       |
| `pasteClipboardObjects`                                                                                 | `directorStore.ts` | `duplicate_objects`（每次粘贴一个 action；两条路径以完全相同的规则分配 id、名称、偏移与人群重映射） | shared（与实时对象不再一致的过期剪贴板快照、缺失 linked shot 的相机对象、无 model 资产的原生 Blender 对象，以及有 object-focused 相机参与的粘贴——作为被复制源、聚焦被复制源或存储 target 已漂移——仍走旧写入） |

## 相机

| Mutator              | 文件               | Semantic action                                                                                                                                    | 状态                                                                                   |
| -------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `updateCamera`       | `directorStore.ts` | `update_camera`（同步 linked rig object）                                                                                                          | shared（capture/动画 patch、旋转或缩放的 rig transform、frustum 深度内特写仍走旧写入） |
| `setActiveCamera`    | `directorStore.ts` | `set_active_camera`                                                                                                                                | shared                                                                                 |
| `addCameraShot`      | `directorStore.ts` | 与 `add_camera` 存在分歧：快照相机保留 viewport 的精确 fov 而 `add_camera` 由焦距推导 fov，顺序 `cam_N` id 与激活相机光学继承也不是 authoring 概念 | ui-only（有意保持本地）                                                                |
| `setCameraAnimation` | `directorStore.ts` | `set_animation`                                                                                                                                    | shared                                                                                 |
| `addCameraCaptures`  | `directorStore.ts` | `add_camera_captures`                                                                                                                              | shared                                                                                 |

## 角色

| Mutator                                                      | 文件               | Semantic action                                   | 状态                                                               |
| ------------------------------------------------------------ | ------------------ | ------------------------------------------------- | ------------------------------------------------------------------ |
| `applyPosePreset` / `applyCrowdPosePreset`                   | `directorStore.ts` | `update_object`（`pose_preset_id`）               | shared                                                             |
| `updatePoseControl` / `updateCrowdPoseControl`               | `directorStore.ts` | `set_character_pose_controls`                     | shared                                                             |
| `setCharacterMotion` / `setCrowdCharacterMotion`             | `directorStore.ts` | `set_character_motion` / `clear_character_motion` | shared（迁移期 `authored` root motion 仍走旧写入）                 |
| `setCharacterIkEffector` / `setCrowdCharacterIkEffector`     | `directorStore.ts` | `set_character_ik`                                | shared                                                             |
| `clearCharacterIkEffector` / `clearCrowdCharacterIkEffector` | `directorStore.ts` | `clear_character_ik`                              | shared                                                             |
| `updateCharacterBodyType`                                    | `directorStore.ts` | `update_object` `body_type`                       | shared（object-focused 相机因 UI 焦点高度刷新仍走旧写入）          |
| `updateUniformScale` / `updateCrowdUniformScale`             | `directorStore.ts` | `update_object` 变换 scale（人群逐成员展开）      | shared（相机 rig、composite 父级与 object-focused 相机仍走旧写入） |

## 灯光

| Mutator       | 文件               | Semantic action | 状态                                             |
| ------------- | ------------------ | --------------- | ------------------------------------------------ |
| `addLight`    | `directorStore.ts` | `add_light`     | shared                                           |
| `updateLight` | `directorStore.ts` | `update_light`  | shared（灯光类型切换会重置类型字段，仍走旧写入） |
| `removeLight` | `directorStore.ts` | `delete_lights` | shared                                           |

## 场景、世界与 Storyboard

| Mutator                                                                     | 文件               | Semantic action                                                                             | 状态                                                                                                             |
| --------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `updateScene`                                                               | `directorStore.ts` | `set_scene`                                                                                 | shared（`set_scene` 无法表达的 patch key 仍走旧写入）                                                            |
| `updateWorldSettings`                                                       | `directorStore.ts` | `set_world_settings`                                                                        | shared                                                                                                           |
| `upsertWorldEffect`                                                         | `directorStore.ts` | `add_world_effect` / `update_world_effect`                                                  | shared（锁定条目与非默认 add 标记仍走旧写入）                                                                    |
| `removeWorldEffects`                                                        | `directorStore.ts` | `remove_world_effects`                                                                      | shared                                                                                                           |
| `upsertWorldWaterBody` / `removeWorldWaterBodies`                           | `directorStore.ts` | `add_world_water_body` / `update_world_water_body` / `remove_world_water_bodies`            | shared                                                                                                           |
| `upsertWorldWildlifeGroup` / `removeWorldWildlifeGroups`                    | `directorStore.ts` | `add_world_wildlife_group` / `update_world_wildlife_group` / `remove_world_wildlife_groups` | shared（依赖默认飞行高度带的 add 仍走旧写入）                                                                    |
| `upsertWorldRoad` / `removeWorldRoads`                                      | `directorStore.ts` | `add_world_road` / `update_world_road` / `remove_world_roads`                               | shared                                                                                                           |
| `updateStoryboard`                                                          | `directorStore.ts` | `set_storyboard`                                                                            | shared                                                                                                           |
| `addSceneAnnotation` / `updateSceneAnnotation` / `removeSceneAnnotation`    | `directorStore.ts` | `add_annotation` / `update_annotation` / `remove_annotations`                               | shared                                                                                                           |
| `addSceneMeasurement` / `updateSceneMeasurement` / `removeSceneMeasurement` | `directorStore.ts` | `add_measurement` / `update_measurement` / `remove_measurements`                            | shared                                                                                                           |
| `setObjectLayerState`                                                       | `directorStore.ts` | `set_object_layer_state`                                                                    | shared（跳过无变化写入以保持撤销栈干净）                                                                         |
| `moveObjectLayer`                                                           | `directorStore.ts` | `reorder_object_layer`                                                                      | shared                                                                                                           |
| `removePanoramaAsset`                                                       | `directorStore.ts` | `remove_assets`（移除全景资产 id 时清空 `panoramaAssetId`）                                 | shared（当角色仍需要默认 Mixamo 资产但 `assets` 中缺失时，migrate 会回灌该资产——此时仍走只删除全景条目的旧写入） |

## 时间线音频

| Mutator                                                                                                                                 | 文件               | Semantic action                                                                                                             | 状态   |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------- | ------ |
| `addTimelineAudioClip` / `updateTimelineAudioClip` / `moveTimelineAudioClip` / `removeTimelineAudioClip` / `setTimelineAudioTrackMuted` | `directorStore.ts` | `add_timeline_audio_clip` / `update_timeline_audio_clip` / `remove_timeline_audio_clips` / `set_timeline_audio_track_muted` | shared |

## 资产与新建流程

| Mutator                                     | 文件               | Semantic action                                                                                                               | 状态                                                                                                                  |
| ------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `addImportedAsset`                          | `directorStore.ts` | `upsert_asset`；全景另加 `set_panorama_asset`；模型落场景另加 `add_object`（角色带 `placement_mode` / `body_type` / `color`） | shared（目录-only、全景与模型落场景含 Mixamo 角色；authoring 拒绝时回退旧写入）                                       |
| `setAssetRealWorldSize`                     | `directorStore.ts` | `upsert_asset` 写入补丁后的 `realWorldSizeM` / `sizeSource`                                                                   | shared（清空为 `null` 仍走旧写入，避免 migrate 的 2 m 估计回填把道具检查器再次填满）                                  |
| `removeImportedAsset`                       | `directorStore.ts` | `remove_assets`（`cascade`）                                                                                                  | shared（当级联还会删除子对象、清除 look target、相机 follow/path 绑定或材质纹理引用时，仍走保持这些引用不动的旧写入） |
| `addObjectFromAsset`                        | `directorStore.ts` | `add_object`（角色另带 `placement_mode` / `body_type` / `color`；`asset_id` 时打上 `nativeSource`）                           | shared                                                                                                                |
| `addPresetCharacter` / `addCrowdCharacters` | `directorStore.ts` | 与 `add_object` 存在分歧：预置新增保留每次的体型与轮换配色，人群分组（`crowdId`）是 `add_object` 无法 author 的 UI 状态       | ui-only（有意保持本地）                                                                                               |
| `addGeometryPrimitive`                      | `directorStore.ts` | `add_object` 带 `geometry_type`（进程内 authoring 接受；仅公开 workbench agent wire 拒绝）                                    | shared                                                                                                                |

## Human-only 交互面

以下入口有意保持直接写入；把它们逐帧强制走 authoring 会破坏交互手感，或把 DCC/运行时投影与
用户创作意图混为一谈。

| Mutator                                                                                                           | 文件               | 原因                                                            | 状态                   |
| ----------------------------------------------------------------------------------------------------------------- | ------------------ | --------------------------------------------------------------- | ---------------------- |
| `beginUndoBatch` / `endUndoBatch` + 所有 shared mutator 的批次内回退                                              | `directorStore.ts` | TransformControls / 滑块 RAF 批次；指针抬起后合并为一条撤销记录 | human-only-interactive |
| Viewport 导航与 pilot 手感（`setViewMode`、`setTransformMode`、`setViewport*`、`resetViewportNavigation`）        | `directorStore.ts` | `commitUiPatch` UI 状态；不写项目                               | human-only-interactive |
| 选择与 inspector（`selectObject`、`selectObjects`、`selectCrowd`、`toggleObjectSelection`、`openSceneInspector`） | `directorStore.ts` | UI 状态；不写项目                                               | human-only-interactive |
| `syncBlenderScene` / `prepareBlenderSync` / `ensureNativeSceneBinding`                                            | `directorStore.ts` | 权威 Blender 场景的 DCC 投影，不是用户创作                      | human-only-interactive |
| `setObjectMeasuredLocalBounds`                                                                                    | `directorStore.ts` | 运行时几何测量，`trackUndo: false`                              | human-only-interactive |
| `copySelectedObjects`                                                                                             | `directorStore.ts` | 仅剪贴板 UI 状态（粘贴才写项目）                                | human-only-interactive |
| `undo` / `redo`                                                                                                   | `directorStore.ts` | 全量快照的历史回放                                              | human-only-interactive |
| `replaceProject` / `applyAuthoredProject` / `openScopedScene` / `saveLatestSnapshot` / `restoreLatestSnapshot`    | `directorStore.ts` | 项目生命周期与持久化，含共享 dispatch 的落点                    | human-only-interactive |

## Canvas / Video

Canvas 与 Video 通过 `director_creative`
（`packages/protocol/src/creativeWorkspaceProtocol.ts`）暴露类型化 Agent JSON 操作。一次性 UI
mutation 现在经 `dispatchCreativeWorkspaceOperations`
（`frontend/director/src/agent/dispatchCreativeWorkspaceOperations.ts`）走与 Agent envelope
相同的执行器：两条路径都填入 snapshot fingerprint guard 与幂等键，并产出相同 revision
（路线图 M1 的 1e/1f 批次）。对等性由
`frontend/director/tests/agent/dispatchCreativeWorkspaceOperations.test.ts` 回归覆盖。

当前已共享：

- Canvas 节点/边/布局/置顶/分区/视口创作（`canvas.node.*`、含 `canvas.node.bring_to_front` /
  `canvas.node.assign_section`、`canvas.section.*`、`canvas.board.set_viewport` /
  `canvas.board.fit_content`、`canvas.edge.*`、`canvas.dag.layout`）、素材导入入册
  （`gallery.media.update`）以及撤销/重做按钮（`workspace.undo` / `workspace.redo`）。观察面暴露
  `board.sections`、`node.section_id` 与 `board.viewport`。
- Video 剪辑检查器编辑、分割、删除（含 ripple）、交叉溶解、键盘离散淡变步进、“+”按钮加入首个
  空闲槽位（`edit.clip.add`）、轨道管理、设置、导入入册，以及撤销/重做（按钮与快捷键）。
- Canvas 到时间线的桥（`edit.clip.add` + `workspace.switch`）、Stage 截图导入为单个原子
  `execute_batch`（入册 + 节点添加一起回滚），以及媒体评审星级/标签写入
  （`gallery.media.update`，仅当契约不认识该 media id 时回退直接写 store）。
- Canvas/Video 文件选择器的离线素材重连经 `dispatchCreativeWorkspaceMediaRelink` →
  `executeCreativeWorkspaceMediaRelinkFile`（与 Agent 在把 `media.relink` 线源解析为 `File`
  之后进入的同一执行体）。
- Video Editor 代理文件选择：先导入候选，再经 `dispatchCreativeWorkspaceOperations` 执行
  `media.proxy.attach`（与 Agent 在两个已入册 id 上使用的同一 linker）。
- Video 显式覆盖放置：媒体落点、键盘逐帧微移、后接复制共用 `edit.clip.add` /
  `edit.clip.update` 且 `overwrite: true`（add 可带 `in_sec`/`opacity`/`volume` 以保留复制后的
  完整观感）。两条路径经 `commitClipPlacement` 跑同一 `resolveDirectorTrackOverwrite` 解析器。
- 无媒体文字/字幕剪辑：`edit.clip.add` 接受虚拟 `text:` / `text:caption:…` media id（无需 Gallery
  资产，仅视频轨道）。Video「标题文字」与字幕/SRT 导入、转写入轨走与 Agent 相同的操作；字幕显示名受
  共享剪辑名 200 字上限约束。

仍为直接写入，附原因：

- 连续交互——节点拖拽、剪辑拖拽/裁剪、淡变拖拽、范围滑杆、实时输入——保留本地批处理历史
  （`beginHistoryBatch`/`endHistoryBatch`），与 Stage 滑块/gizmo 策略一致。拖拽/裁剪 pointer-up
  仍本地 `commitClipPlacement`（离散微移/后接复制/显式落点已共享，见上）。Canvas 连续指针平移/
  滚轮缩放保持本地。
- Canvas 画板视口离散写入——`canvas.board.set_viewport` 与 `canvas.board.fit_content`（工具栏/
  布局后适应）走共享 agent 契约；连续平移/滚轮仍本地。缩放钳制在 `[0.1, 2.5]`；无现场 DOM
  尺寸时 fit 默认 1280×800 表面。
- Canvas 流水线产物入册、旧评审镜像迁移与批量清除评审——多 store 或迁移簿记流程。
