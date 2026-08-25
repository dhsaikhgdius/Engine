---
title: Blender 原生后端与文件交换
description: 无头 Blender 建模后端，以及可选的文件交换流程。
---

实时建模内核是 `integrations/blender/live/addons/worldengine_studio/` 里的
`worldengine_studio` 插件。它运行在无头 Blender 4.2+ 中，持有唯一权威场景图，
负责 mesh/Edit Mode 操作、modifier、材质、骨骼、动画、相机、灯光、渲染与 undo。
文件交换脚本（可信 `.blend` 导入与 Director 往返）位于
`integrations/blender/interchange/`。Director 是面向人和 Agent 的导演前端，
而不是第二份几何数据库。长尾的 `invoke_operator` / `set_rna_property` / `execute_code`
与 live kernel 共用同一场景。策略是小拒绝列表（退出 Blender、console/help/preferences/screen/workspace），
而不是建模白名单。`execute_code` 对标 blender-mcp，可在场景中执行 Python。
typed 的 `polyhaven_search` / `polyhaven_import` 与 `sketchfab_search` / `sketchfab_import`
覆盖 Poly Haven 的 CC0 HDRI/贴图/模型，以及可下载的 Sketchfab glTF（Sketchfab 需要
`SKETCHFAB_API_TOKEN` 或 Studio 偏好设置）。

从 WorldEngine 项目根目录启动完整产品：

```bash
npm run blender
```

人可以继续使用 Blender 原生 UI 建模。Agent 使用同一份原生场景：搜索运行时
operator catalog、读取 operator 的 RNA 参数、提交一次结构化事务、检查编辑后的
对象，再用干净的 Blender 相机 capture 验收。常用白膜任务保留高层 recipe，
长尾能力由 Blender 动态目录提供，不需要在 TypeScript 中复制上千个 Blender 控件。

Director 同时渲染同一 Blender 场景按 revision 更新的 live GLB 视图。紧凑的
Native Mesh 面板通过与 Agent 相同的 scene-epoch/revision 事务契约写入
Edit Mode 操作、modifier、材质分配、Principled 参数、UV 投影与精选的
Material Nodes 节点图。因此 UI 和 Agent 编辑的是同一份 Blender 场景并收到
相同的聚焦回执，不会另外维护一份 mesh 或 shader graph。

「建模」页签会直接呈现 live 会话本身的状态。连接状态条显示 Blender 版本、
当前场景 revision，原生事务执行期间显示忙碌指示，并提供手动重新检测按钮。
面板的每次操作都以独立通知区分进行中、成功与失败，成功回执会自动消失。
会话离线时，工具区替换为 `npm run blender` 的启动引导，面板不再自行轮询；
场景所有者保留低频状态检查，重新启动的 Blender 会话无需刷新页面或启动第二套面板轮询
即可恢复建模工具。

## 单一操作契约

`packages/protocol/src/blenderOperationManifest.json` 是所有 Blender live 操作的唯一
权威目录。每个条目只声明公开面（`typed`、`longtail` 或 `internal`）和事务影响
（`read`、`selection`、`frame`、`transform`、`content`、`history` 或 `project`）。
TypeScript 协议会断言可执行 Zod union 与目录完全一致；Gateway 的回执分类和 Director 的刷新
策略也从同一组影响类型派生。Blender 读取生成副本，不再在 Python 中手写另一套操作集合。

这是一条 capability Definition/Provider/Consumer 边界：manifest 定义身份和影响，TypeScript 与
Blender 提供执行，Gateway/Director 消费回执。它不会创建第二套 Agent harness，也不会创建第二份
场景模型。修改目录后，用以下命令同步并校验 Blender 副本：

```bash
npm run sync:blender-operations
npm run sync:blender-operations -- --check
```

## Live 所有权与同步

`DirectorProject.nativeScene.projectId` 是会话绑定。Stage 只会绑定一次未归属的原生 runtime，
拒绝其他项目的 snapshot，并由 `BlenderSceneLayer` 作为唯一场景 poller。该层把临时快照发布
到 `blenderRuntimeStore`；Modeling、相机、碰撞和右侧栏路由共享这份快照，不会各自
启动刷新循环。Modeling 与 Rig 检查器可以执行带 revision 约束的对象检查，但不会再次读取完整
场景。每次写入都携带 intent ID、预期 scene epoch 与预期 revision；只有回执的前后 revision 能与
当前 snapshot 精确衔接时，Director 才会把其中的聚焦证据投影回共享 store，更新选择、帧、变换、
删除结果和已检查实体。纯变换、选择与帧事务因此不需要第二次读取场景；内容/历史变化、无法核验的
回执和 revision 冲突才会向共享 poller 请求一次立即刷新。隐藏原生预览后会停止 GLB 下载与解析，
同时保留低频结构化场景同步。只有可见且当前获得焦点的 Director 页面可以自动绑定 runtime 或
提交同步写入；后台标签页保持只读，避免两个打开的项目反复重绑或覆盖同一份 Blender 场景。

每个顶层 Blender 对象映射到一个 `DirectorObject.nativeSource`。Director 持久化相机、时间线、
镜头、Agent 检查和常规场景树编辑所需的制片投影；Blender 持久化该根对象下的原生层级与内容。
因此同步是按字段明确划分的，不是再加一个通用资产抽象：

- Blender → Director 创建/移除原生根对象投影，并更新根名称、可见性和变换；轮询更新不会进入
  Director undo stack；
- Director → Blender provision 模型资产，并在一次带 revision 校验的事务中提交根变换、重命名、
  可见性和删除；
- Stage 点击原生子对象时解析到根投影，Director 选择则会设置对应的原生根选择；
- 兼容的 Character 根对象把 Action 与 Pose 统一保存在 `DirectorProject.characterRig`；场景层把
  每个人物的 Action 映射到独立的 `Director Motion` NLA 轨道，并通过类型明确且幂等的操作把 Pose
  映射到检测到的骨骼。全场只提交一次跟随 Director 播放头的场景帧更新，人物不会争抢 Blender
  全局帧；
- Properties 只路由到一个 Character 或 Prop 检查器，原生 mesh 编辑固定放在顶层 Modeling 页签。
  兼容的 Director Character 不再叠加第二套 Mesh 或 Rig 面板。

事务冲突或 preview 加载失败时保留最后一份一致预览，并把状态标记为 stale；不会替换 Director 项目，
也不会清空无关选择。只有接受了新的原生场景版本才重新加载 GLB，选择证据可以更新而不启动第二个
场景 loader。原生 preview 导出会烘焙当前形变，但不会导出 skin 状态，因此生成预览不会重置 live
armature 的 pose 或 Director state token。

### 仅预览的 live link

live kernel 还会发布一条有界、仅用于预览的增量流。每次被接受的场景快照都会 diff 成一个
live-link 帧，帧带按 scene epoch 单调递增的序列号：`transform` 帧携带对象/相机/灯光的变换、
镜头与能量预览；`structure` 帧不携带实体数据，只表示发生了更大的变化（datablock 创建/删除、
mesh 或材质编辑、重命名、或超大增量），消费者必须重新读取权威快照而不是打补丁。内核保留固定
容量的最近帧环（默认 128），并在 `/health` 中以 `liveLink { seq, bufferedFrames, capacity }`
上报状态；「建模」连接状态条显示同一序列号。

客户端通过只读的 `blender_native` 操作
`{ "op": "live_link", "cursor": { "sceneEpoch": "…", "seq": N } }` 轮询。响应要么返回 cursor
之后的连续帧，要么返回 `resync` 标记（`initial`、`epoch_changed` 或 `history_evicted`）。
`packages/protocol/src/blenderLiveLinkProtocol.ts` 中的共享重放防护会丢弃重复/重放帧，并在任何
序列缺口或 epoch 变化时强制快照重同步，因此消费者不可能悄悄失去同步。

live-link 帧永远不是权威数据。已提交的 Director 状态只会通过带 revision 保护的 live 命令批次
或经过审阅的回传导入改变；断开链路、缓冲历史被淘汰或重启 Blender，都不会影响最后一次提交的
Director revision。

下文的文件导入与往返仍然保留，用于确实需要和另一个 Blender 安装交换快照的项目。

除原生后端外，Director 还提供两条刻意分开的 Blender 文件路径：

- **原始场景导入**：读取操作者信任的本地 `.blend`，提取 active scene 在 current frame 的
  一个 GLB 视觉快照和可选静态透视相机，预览计划后创建新的 Director 实体。
- **Director 往返**：对校验过的 `DirectorProject` 做快照，生成携带稳定 `director_id`
  属性的 `.blend`，审阅后只回传受限的稳定 ID mesh/transform 修改。

原始导入不会用于合并 Director 导出后的修改；往返也不是任意 `.blend` 合并器。两套契约
分开，才能避免把 Blender 游离对象误判为 Director 项目的编辑。

## 导入原始 `.blend` 场景

Interchange 菜单把原始文件上传到
`POST /api/dcc/blender-scene/uploads?filename=...`。Gateway 写入私有 job 后，使用
`--factory-startup` 与 `--disable-autoexec` 后台启动 Blender。提取器输出
`director-blend-scene-v1`：

- 源文件名、字节数、SHA-256、Blender 版本和明确的兼容性警告；
- 作为审核元数据的精确有理帧率、源帧范围和当前帧；
- 米制、Y-up 的 `assets/scene.glb`，其可见状态取自 active scene 的 current frame，并保留
  GLB 内的世界布局与层级；
- 支持的透视相机物理参数和 current-frame 变换。

GLB 可以保留 Blender glTF exporter 支持的材质、skin、morph 与内嵌动画。Director 会把它
作为一个 scene asset 和一个根对象导入，并设置 `modelNormalization: "preserve"`，不会自动
居中、fit-to-box 或缩放作者搭建的场景。

上传会返回默认 `director-blend-scene-import-plan-v1`。若只需要场景、部分相机或仅相机，
通过 selection 重新预览：

```json
{
  "op": "preview_blend_scene_import",
  "package_dir": "blend-JOB_ID/package",
  "selection": {
    "includeScene": true,
    "cameraSourceIds": ["Camera"]
  }
}
```

预览不修改项目。存在冲突时返回 HTTP `409` 和 `ready:false`，不能 Apply。可用计划由服务端
保存，应用时只传计划标识，不接受客户端任意改写的完整计划：

```json
{
  "op": "apply_blend_scene_import",
  "plan_id": "blend-JOB_ID/plans/SELECTION_HASH.json",
  "expected_revision": "<plan.targetRevision>",
  "idempotency_key": "blender-scene-import-<intent>"
}
```

Apply 会重新加载并按 schema 校验计划，复核每个 package hash，核对当前 revision，重建并
逐字节比较计划，再把 GLB 复制到不可变、按内容寻址的存储中，最后只提交一次有保护的 authoring
mutation。同一个 idempotency key 只用于字节完全相同且结果不确定的重试；新意图必须使用新 key。
生成模型位于 `assets/generated/dcc-import/`，浏览器通过
`/dcc-import/<hash-prefix>/<asset-id>.glb` 读取。

### 原始导入边界

场景包是可靠的运行时快照，不是 Blender 到 Director 的完整深层可编辑转换。v1 只计算
Blender 的 active scene；它的 current frame 会成为 GLB 的可见快照。透视相机也只在同一帧
采样为静态 Director 相机，相机动画会被展平。Blender 子层级仍存在于 Blender/GLB 中，但
不会拆成独立 Director 对象。GLB 动画 clip 可以保存在文件内，但 Director v1 既不会把它们
映射成时间线轨道，也不会播放它们。manifest 中的有理帧率、帧范围和当前帧只用于审核与来源
记录；导入不会改写 Director 的项目 timebase、IN/OUT、playhead 或时间线轨道。灯光、
world/HDRI、compositor、正交相机、constraint、自定义 shader 等价性、lens shift、精确
camera roll 和 Blender 专用模拟不支持或有损，必须显示为 warning。相机光学参数会映射到
最接近的 Director sensor/aspect，并在超出 Director 范围时显式 clamp。上传、预览、应用是
显式批处理交换，不是与 Blender 的实时同步。

原始 `.blend` 上传属于**可信本地桌面边界**。`--disable-autoexec` 能阻止自动执行内嵌
Python/driver，但它不是 Blender 原生文件解析器或依赖的 OS sandbox。不要直接导入不可信
`.blend`；应先放入容器、虚拟机或其他宿主级 sandbox。私有 job 路径、大小限制和进程超时
只能降低暴露面，不能把 Blender 变成 sandbox。

## Director 往返

本地 Gateway 对当前校验过的 `DirectorProject` 做快照，写出带版本的场景 package，
后台模式调用 Blender，并返回生成的 `.blend`、报告和可选的相机预览路径。回传导出器输出
`director-dcc-return-v1` package，可包含稳定 ID 的 mesh replacement、transform update、
相机更新（变换加焦距、光圈、对焦距离与裁剪平面）、携带 `director_id` 的灯光更新，以及
可移植的人物 pose control 更新（含可选 root motion）。Director 验证全部 hash，构建可审阅的
`director-dcc-import-plan-v1`，再通过 Agent 和 UI 共用的 revision 保护 authoring 引擎
应用这份精确计划。

### Agent 操作

同一份 Zod 契约驱动 HTTP 与 `director_dcc` MCP 工具：

```json
{ "op": "status" }
```

```json
{
  "op": "export_blend",
  "render_preview": true,
  "camera_id": "optional-camera-id",
  "frame": 48
}
```

在 Blender 中细化生成的 `.blend` 后，携带原始 `scene.director-dcc.json` 运行
`integrations/blender/interchange/director_return_export.py`，再预览并应用回传：

```json
{
  "op": "import_return_package",
  "package_dir": "JOB_ID/return-package",
  "dry_run": true
}
```

```json
{
  "op": "apply_import_plan",
  "plan": "<原样返回的计划对象>",
  "expected_revision": "<plan.targetRevision>",
  "idempotency_key": "blender-return-<packageId>-<manifest hash 前缀>"
}
```

`import_return_package` 永不修改 live 项目。Apply 会重新读取 package、验证每个
SHA-256、核对 source 与 live revision、重建计划比较，最后只提交一个 authoring batch
（`upsert_asset`、`update_object`、`update_camera`、`update_light` 与人物 pose control
更新）。Take、Coverage、Storyboard 和 Shot IR 身份不会被替换。

HTTP 等价接口是 `GET /api/dcc/status` 与 `POST /api/tools/director_dcc`。原始 HTTP
客户端必须先 bootstrap 本地 gateway，并在 `X-Director-Browser-Token` 中携带令牌；
自带的 MCP 与 CLI 客户端会自动完成这一步。只有当 Blender 不在 macOS 标准应用路径
且不在 `PATH` 上时才需要设置 `DIRECTOR_BLENDER_BIN`。

### 往返数据契约

- 契约：`director-dcc-scene-v1`
- 来源：校验过的 `DirectorProject` v1
- 单位：米
- Director：右手系、Y-up、相机朝向 `-Z`
- Blender：右手系、Z-up、相机朝向 `-Z`
- 点映射：`(x, y, z) -> (x, -z, y)`
- 旋转：基变换后的归一化四元数，绝不使用猜测的 Euler 分量交换
- 时间线：对象与相机共享同一 FPS 和帧范围
- 相机：焦距（含镜头动画关键帧）、裁剪后的 sensor gate、光圈、对焦距离、快门角度、
  ISO、裁剪平面、变形宽银幕 squeeze 元数据、画幅比与目标点
- 灯光：带 `director_id` 的 directional/point/spot/rect-area 灯光，携带 Director
  颜色/强度以及导入时使用的精确瓦数换算系数，回传时强度编辑可无损逆算
- 人物姿态：可移植的 `director_pose.*` 自定义属性（每个 control 一条），并同时
  stamp JSON 基线与导入时的 armature pose-bone 指纹

每个 job 位于 `data/dcc-jobs/blender/<uuid>/` 下，包含：

- `scene.director-dcc.json` — 校验过的交接包与来源 revision
- `assets/*.glb` — 本地 Blender 兼容的 GLB 副本
- `scene.blend` — 生成的 Blender 场景
- `report.json` — 数量统计、Blender 版本、警告与输出路径
- `preview.png` — 可选的活动相机 clay 渲染

细化后的 job 还可能包含 `return-package/manifest.json`、
`return-package/meshes/*.glb` 与 `return-package/return-report.json`。导入的 GLB
会复制到 `assets/generated/dcc-import/` 下按 hash 派生的不可变路径；原目录资产保持
可用，对象指针指向新的资产版本。

预览通过 Blender 渲染而不是编辑器截屏，因此网格线、坐标轴、标签、相机视锥、路径、
选择框、gizmo 和套索 UI 不会出现在结果中。临时 clay 材质覆盖产出中性的白模帧；
保存的 `.blend` 保留原始导入材质。

### 往返资产管线与安全

GLB/glTF 2.0 仍是运行时交换契约。进入 Blender 之前，桥接层使用固定版本的
`@gltf-transform/core` 及扩展解码器解析并重新序列化模型，去除 Blender importer
无法解码的几何压缩，而不改动原始 Web 资产。只接受解析结果位于仓库 `assets/library/`
目录内的本地模型路径。remote、`data:`、`blob:`、路径穿越、symlink 逃逸、非模型和
非 GLB/glTF 来源会被拒绝或报告为 unresolved。Blender 通过参数数组调用而不是 shell
命令串，也无法经由该 API 写出 Gateway 创建的 job 目录之外的内容。

### 当前往返边界

本节描述的是离线 Director 往返，不是 live 原生桥接。live 桥接已经把兼容 Character 的 Action 与
Pose 语义化应用到原生 armature；原生 IK 与动作混合渐变按能力门控，而不是显示无效控件。

对象与相机变换共享 Director 时间线，Mixamo/GLB 角色几何可以导入。细化后的对象 mesh、
对象/相机变换、相机光学（焦距、光圈、对焦距离、裁剪平面）、带 `director_id` 的灯光
（位置、目标、颜色、强度）以及可移植人物 pose control（含 root motion）都可按稳定 ID
回传，并在应用前提供预览与冲突报告。超出 Director 创作范围的值会烘焙到最近的限值并
显式 warning，绝不静默丢弃。sensor 尺寸编辑执行 warn-and-omit：Blender 的 sensor
尺寸不会覆盖 Director 的 sensor format。直接编辑 armature pose-bone 会被 stamp 的姿态
指纹检测到并产生 warning，但不做 reconcile——只有可移植的 `director_pose.*` control
值会往返。Blender 新建对象与没有 `director_id` 的灯光只产生 warning，v1.5 不自动创建。
材质随细化后的 GLB 一起返回；灯光创建、交互式 add-on 同步、最终动画渲染、
shader/constraint/模拟传输和 Unreal Interchange 仍不在此往返契约内。任意 `.blend`
使用上文独立的场景导入契约，不会自动获得稳定 ID 往返语义。
