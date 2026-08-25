---
title: 数据模型
description: 了解 DirectorProject、StageScene、制作记录与 Agent 记录之间的关系。
---

## DirectorProject 版本 1

`DirectorProject` 是编辑器的完整模型：

```ts
interface DirectorProject {
  version: 1;
  nativeScene?: DirectorNativeScene;
  scene: SceneSettings;
  assets: DirectorAssetRef[];
  objects: DirectorObject[];
  cameras: DirectorCameraShot[];
  storyboard?: DirectorStoryboard;
  production?: DirectorProduction;
  activeCameraId: string | null;
  panoramaAssetId: string | null;
}
```

它负责编辑器场景设置、资产、层级、角色、相机、动画、分镜和当前引用。可选的
`production` 投影用于兼容旧版 v1 文档，同时把可复用的表演和镜头覆盖分开：

```ts
interface DirectorProduction {
  version: 1;
  takes: DirectorPerformanceTake[];
  sequences: DirectorCoverageSequence[];
  activeTakeId: string | null;
  activeSequenceId: string | null;
}
```

`DirectorPerformanceTake` 负责实体动画轨道。多个 `DirectorCoverageShot` 可以复用同一个
take，但选择不同的相机、光学参数和帧范围。`evaluateDirectorProductionAtFrame` 是这个关系的
纯求值器，不会修改可编辑项目。

## 产品边界

Director 是围绕 Blender 构建的制片导演台，不是 Blender 的浏览器版替代品。

| 在 Director 中继续发展                       | 保留在 Blender 中，不在 Director 重复实现                |
| -------------------------------------------- | -------------------------------------------------------- |
| 镜头身份、相机、走位、人物导演与时间线       | Mesh topology、Boolean/Extrude、modifier、Geometry Nodes |
| Agent 规划、语义对象 ID、审片、审计与审批    | 原生材质节点、UV、armature 内部编辑与 simulation         |
| Clean frame、白模、Mask、Depth、元数据与交付 | 通用 Edit Mode 与完整 Blender operator surface           |

Director 可以暴露完成制片流程所必需的窄接口，例如 provision 资产、执行一次类型化精修事务，或
检查精修结果；但不能继续生长为另一套通用建模软件。现有原生建模面板属于集成表面，除非镜头导演
或交付流程确实需要，否则停止扩展。

## Blender 原生场景绑定

Blender 集成直接扩展 `DirectorProject`，不会引入第二套项目模型，也不会再造一个更大的
资产基类：

```ts
interface DirectorNativeScene {
  engine: "blender";
  projectId: string;
  sceneEpoch?: string;
  revision?: number;
  contentRevision?: number;
}

interface DirectorNativeObjectSource {
  engine: "blender";
  objectId: string;
  provisioned?: boolean;
}

interface DirectorLocalBounds {
  min: [number, number, number];
  max: [number, number, number];
}
```

`nativeScene.projectId` 把一个 Director 项目绑定到一份 live 原生场景。每个原生根对象只有一个
Director 对象投影，`nativeSource.objectId` 在场景树、视口、检查器和原生事务 API 之间保持同一
身份。项目 ID 不匹配的快照会被忽略，不会把另一份 live 场景接到当前项目上。只有可见且获得焦点的
Director 页面可以自动绑定和提交同步写入；后台标签页只消费 snapshot，不会成为第二个 writer。

绑定中会保存最近一次同步的原生 scene epoch 与 revisions。即使 Blender 材质或 topology 编辑没有
改变根对象 transform，它们也会推进普通 `DirectorProject` revision，避免 Agent guard、审片证据或
交付回执静默引用精修前状态。轮询 snapshot 本身不会额外制造 undo；Blender 原生编辑会进入与
Director 编辑相同的时间顺序，撤销时委托 Blender 原生事务。Director 投影到 Blender 的编辑会标记为
同一个意图，因此不会重复记账。

| 层                    | 所有权                                                                        |
| --------------------- | ----------------------------------------------------------------------------- |
| `DirectorProject`     | 制片身份、根对象投影、人物 Action/Pose/IK 语义、相机、时间线和镜头            |
| Blender 原生场景      | 子层级、mesh topology、Edit Mode、modifier、材质、UV、armature、action 与 NLA |
| Live runtime snapshot | scene epoch、revision、帧、选择、相机/灯光、rig 兼容性和原生状态证据          |

Director 中的变换、重命名、可见性、删除和模型放置会转换为一次带 revision 校验的原生事务；事务完成后，
Blender 快照会回读到同一个 Director 对象投影，轮询同步不会额外制造 undo。直接在 Blender 中编辑时，
transform、可见性、名称、求值 bounds 和原生 revisions 会回写到该投影；由 Director 发起的投影仍以
Director 为准。选择 Blender 子对象时会解析到对应 Director 根对象，而 Blender Mesh 与 Rig 检查器
仍然可以访问被选中的子数据。

`provisioned: false` 表示 Director 模型实例正在等待导入为原生根对象；`provisioned: true` 表示该
根对象已经存在于绑定的 Blender 场景。临时 runtime snapshot 由 Stage 和检查器共享，但绝不
持久化为另一套可编辑场景。

`DirectorAssetRef.localBoundsM` 保存可复用的目录测量值，`DirectorObject.localBoundsM` 保存由
Blender 或渲染器实测的对象覆盖值。两者都使用米制，并位于 Director transform 应用前的对象局部
空间。空间查询、放置、碰撞和审计只使用这一套 bounds。未知的导入几何保持“空间未知”；单一的
`realWorldSizeM` 不会再被伪造成一个立方体。在 Director 中加载模型或 provision 到 Blender 后，
系统测量真实几何并把 bounds 写回同一个对象投影。

对兼容的原生人物，adapter 会通过类型化操作把 canonical Director Action/Pose 状态投影到
Blender armature。每个人物的 Action 使用独立的 `Director Motion` NLA 轨道，全场只有一个
共享场景帧跟随 Director 播放头。armature 保存 Director 状态标记，避免轮询或预览导出后重复应用
同一语义状态。原生 mesh 与 rig 细节只是同一对象的能力，不会被提升成另一个资产超类或平行项目。
IK 继续以 `DirectorProject` 为事实来源，但在原生 solver adapter 可用前由 capability gate 阻止写入。

## StageScene 版本 5

`StageScene` 是紧凑的 Agent/旧版模型：

```ts
{
  v: 5,
  objects: Record<string, StageObject>,
  show: {
    name: string,
    tracks: StageTrack[]
  },
  recordAspect: "16:9" | "9:16" | "1:1" | "4:3" | "1.85:1" | "2.39:1"
}
```

它适合可移植的白模操作。`frontend/director/src/agent/directorStageAdapter.ts` 中的适配器会校验转换的两端。

## Creative workspace 版本 2

Canvas 与 Video Editor 使用按场景隔离的创意工作区：

```ts
interface DirectorCreativeWorkspace {
  boardNodes: DirectorBoardNode[];
  boardEdges: DirectorBoardEdge[];
  editTracks: DirectorEditTrack[];
  editSettings: DirectorEditSettings;
}
```

媒体字节单独存放在持久化媒体库中，并通过稳定 ID 引用。Agent 投影额外提供确定性的
`snapshot_fingerprint`、规范化字段名、精确计数、媒体就绪状态和安全限制。它是同一个实时浏览器
store 的并发视图，而不是第二套可编辑模型。

一次 `execute_batch` 会捕获意图执行前的历史快照。成功时只产生一个撤销单元；失败时恢复图、时间线、
设置和选择。快照指纹能防止基于旧观察生成的 mutation 覆盖人类或 Agent 的新修改。

## ProductionRecord

制作记录保存：

- 制作 ID 与修订号；
- 标题与当前场景；
- 带源修订号的命名场景引用；
- 链接或固定源行为的剪辑镜头；
- 更新操作者与时间戳。

制作 mutation 使用期望修订号，避免静默并发覆盖。

## Agent 计划

旧版助手规划会返回经过校验的工具操作列表，以及摘要、验证结果和建议的下一步。计划会过期，
并绑定到创建时观察到的场景签名。

新版 Agent workbench 使用持久化会话和直接的结构化工具执行。

## 图完整性

通过 schema 校验并不代表跨实体引用完整。Director 还会检查：

- 对象父子引用；
- 相机 rig 与目标引用；
- 资产绑定；
- 当前相机与全景 ID；
- 时间线目标 ID；
- 分镜相机 ID 与帧范围。

图不完整时，会在替换实时项目状态之前拒绝请求。

## 迁移

持久化项目数据会先解析，再执行迁移。向后兼容的可选字段会被规范化为当前
`DirectorProject` 表示，使用前还会再次校验。
