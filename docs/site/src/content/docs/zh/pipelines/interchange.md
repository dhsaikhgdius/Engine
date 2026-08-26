---
title: 交换格式与 DCC 交接
description: Director 在剪辑、剧本、3D、Blender 与可携带镜头包上的已测试子集。
---

Director 使用 manifest-first 的交换契约。每个边界都声明身份、米制单位、坐标轴、时间基准
以及降级警告。“支持”表示文档所列 Director 子集通过 fixture 往返测试，不代表外部标准的
每个特性都能无损往返。

## 能力矩阵

| 格式             | 方向      | 保留内容                                                                                                 | 明确边界                                                                                          |
| ---------------- | --------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Fountain         | 导入/导出 | 场景标题与 Director shot/storyboard 元数据                                                               | 不是完整 screenplay AST 或排版引擎                                                                |
| OTIO             | 导入/导出 | cuts、有理时间范围、稳定引用、轨道顺序                                                                   | transition 会警告并忽略；未知 schema 变成 gap                                                     |
| OTIOZ            | 导入/导出 | 受限 ZIP 中的 Director OTIO 子集                                                                         | 检查大小、CRC 和路径穿越；不覆盖所有外部媒体打包约定                                              |
| glTF/GLB         | 导入/导出 | 稳定 ID、变换、相机、资产引用、Director 元数据                                                           | 不保证所有 DCC 材质、约束与动画无损往返                                                           |
| USDA             | 导入/导出 | 米制、Y-up、右手系的 Director 场景桥                                                                     | ASCII 场景子集；二进制 USDC 需要宿主 OpenUSD bridge                                               |
| USDZ             | 导入/导出 | 包含 `scene.usda` 与 manifest 的对齐 archive                                                             | 当前不会嵌入全部贴图/模型 payload                                                                 |
| OBJ/MTL ZIP      | 导出      | 全部或选中的受支持 Stage 基础体、烘焙世界变换、标量材质、稳定 ID、米制/Y-up manifest 与 SHA-256 文件回执 | 仅静态基础体网格；关联模型字节、相机、灯光、动画、贴图与层级会省略并显示警告                      |
| ASCII STL ZIP    | 导出      | 全部或选中的受支持 Stage 基础体、烘焙世界变换、稳定 ID solid 名、米制/Y-up manifest 与 SHA-256 文件回执  | 不含材质、贴图、层级、相机、灯光、动画或内嵌单位声明；完整解释必须保留 sidecar                    |
| Blender `.blend` | 导入      | active scene 的 current-frame GLB 快照、选中静态透视相机、源时间审核元数据                               | 无深层可编辑层级、动画播放/时间线映射、实时同步或不可信文件安全处理；Blender 专属语义不支持或有损 |
| Blender 往返     | 导出/回传 | 经过验证的场景/相机/灯光交接、clay 预览、按稳定 ID 回传 mesh、变换、机位光学、`director_id` 灯光与可移植 pose control | 仅接受 DCC job 根下带 hash 的受限 package；新建对象只能通过 stamp `director_id` 加显式 `include_new_objects` 选择加入导入，骨骼编辑只在 stamp 的骨骼角色映射覆盖范围内 reconcile（其余 warn-and-omit） |
| 引擎交接（Unreal/Unity/Godot） | 发送/回传 | 无头连接器导入场景布局、相机与镜头范围并写入 `director:id`；以 canonical 空间回传变换。Unreal 额外将 Gateway 烘焙的变换/相机动画写入 Sequencer（有理帧率、SMPTE 起始时间码），把带蒙皮 GLB 以绑定姿态导入为骨骼网格，并将 Director PBR 参数应用为材质实例。Unity 额外把 Director 动画与语义姿势通道烘焙到 Timeline、从蒙皮 GLB 构建 Avatar，应用 PBR 材质回退与灯光，并提供仅出站的预览 live link。Godot 4 额外导入基于有理时基的 Gateway 烘焙 `AnimationPlayer` 动画、绑定姿态的蒙皮 GLB 骨架、带哈希外置纹理的 `StandardMaterial3D` 材质，以及 Omni/Spot/Directional 灯光 | 需要用户引擎工程中已安装 Director 官方连接器（`nativeReady`）；Unreal、Unity 与 Godot 预览 live link 均为 native（永不改写项目）；Unreal `clean_frame` 为尽力而为；Unreal 的 Control Rig 姿态、动作片段与贴图以警告省略处理；Godot 的绑定姿态通道与环境光/面光警告省略 |
| Unreal 场景      | 导入      | 关卡 GLB 包（几何、材质、骨骼网格）、类型化层级快照、Cine 相机光学、方向/点/聚光/矩形/天空光、稳定 actor ID | Sequencer 动画仅按名称清单化；裁剪面用 Director 默认值；回程 roundtrip 为 planned；每一项被放弃的内容同时以类型化计划 `omitted[]` 记录呈现 |
| Unity 场景       | 导入      | 场景 GLB 包（几何、材质、蒙皮网格）、类型化层级快照、物理相机光学、方向/点/聚光/矩形灯 + Flat 环境光、`GlobalObjectId` 稳定 ID | 圆盘灯与 skybox 环境光记录为 gap；动画剪辑仅带时长清单化；回程 roundtrip 为 planned；每一项被放弃的内容同时以类型化计划 `omitted[]` 记录呈现 |

编辑器顶部 **Interchange** 菜单是人类入口。Stage OTIO 与 Video 工作区 OTIO 使用不同
adapter，因为二者保留的 source model 不同。导入必须先校验，再替换或合并状态。

## Blender 原生模式不是交换格式

`npm run blender` 会启动本机 Blender 4.2+（带 `worldengine_studio`）、同一个 Director 前端和 Gateway。
Director 用 `nativeScene.projectId` 绑定这份 live 场景，在 Stage 渲染带 revision 的预览，并把
原生根对象投影到现有 Director 场景树。这是正常的集成建模路径，不是两个项目之间反复导入导出。

| 工作流                  | 适用场景                             | 原生数据权威来源                      |
| ----------------------- | ------------------------------------ | ------------------------------------- |
| 集成 Blender       | 在当前制片中同时导演与建模           | 已绑定的 Blender 场景            |
| 原始 `.blend` 导入      | 从已有、可信的 Blender 文件开始      | 导入的 current-frame 场景快照         |
| Director ↔ Blender 往返 | 把有边界的快照交给另一个 Blender job | 仅合并已知 Director ID 的可审阅回传包 |

集成模式中，Director 负责面向制片的根对象投影：身份、名称、可见性、变换、相机/时间线引用和镜头
上下文；Blender 负责子层级、mesh topology、Edit Mode、modifier、材质、UV、armature、action
和 NLA。Director 根对象编辑会成为带 revision 校验的原生操作，结果快照再回读到同一个对象。
选择原生子对象时会解析到所属 Director 根对象，而 Mesh editor 与 Rig 继续提供子级编辑。

Live scene snapshot 是共享的临时证据，不是另一份持久化项目。外部 project ID 不会接到当前
Director 项目上，原生工具也只作用于 Director 当前选择的根对象。只有确实需要跨文件边界时才使用
Interchange 菜单。操作流程见[场景与资产](/zh/editor/scenes-and-assets/)，工程契约见
[Blender 原生后端](/zh/engineering/blender_bridge/)。

## 已有 `.blend` 场景

原始 `.blend` 导入与 Director 往返是两条独立流程。原始导入后台运行 Blender，生成
`director-blend-scene-v1`，然后展示由服务端保存的
`director-blend-scene-import-plan-v1`。计划可以包含场景包和任意透视相机子集。在 Apply
收到 `plan_id`、精确 `expected_revision` 和仅用于重试的 `idempotency_key` 之前，不会修改项目。

Apply 会复核源文件与 artifact hash，基于当前项目重建计划，把 GLB 复制到不可变内容寻址存储，
并执行一次原子 authoring mutation。Director 设置 `modelNormalization: "preserve"`，因此场景包
保留作者定义的米制比例、原点和世界布局。生成 GLB 通过
`/dcc-import/<hash-prefix>/<asset-id>.glb` 提供。

v1 只计算 Blender 的 active scene；它的 current frame 会成为 GLB 的可见快照，选中的透视
相机也只在该帧采样为静态 Director 相机。场景包在 Director 中仍是一个根场景对象。子层级、
skin、morph、材质与内嵌 GLB 动画 clip 可以留在资产内部，但 Director v1 既不会映射也不会
播放这些 clip；子节点和 action 不会转换为可编辑对象或时间线轨道。manifest 中的有理帧率、
帧范围和当前帧只用于审核与来源记录，不会改写 Director 的项目 timebase、IN/OUT、playhead
或时间线。不能无损表达的 Blender 语义不会被静默宣称支持：灯光、world/HDRI/compositor、
正交相机、constraint、自定义 shader 等价性、lens shift、精确 camera roll 与 Blender 专用
模拟必须成为 warning 或显式省略。这是批处理导入，不是 Blender 实时同步。

这是一条可信本地操作。`--disable-autoexec` 能防止自动执行内嵌 Python/driver，但不能为
Blender 原生文件解析器提供 OS/container sandbox。私有 job 路径、大小限制和进程超时只是
约束措施，不是 sandbox。不可信 `.blend` 应先在容器或虚拟机中处理，再交给 Director。

## 游戏引擎场景（Unreal / Unity）

Unreal Engine 5 与 Unity 场景走与 `.blend` 相同的 preview/apply 纪律，但包格式不同：
引擎内导出器（`integrations/unreal/interchange/director_scene_export.py`、
`integrations/unity/interchange/DirectorSceneExport.cs`）自己负责坐标转换，写出
`director-engine-scene-v1` 包，其中所有变换已是 Director 的右手 Y-up 米制约定。
manifest 声明实际应用的线性映射（Unreal `(x,y,z)->(y,z,-x)*0.01`、Unity
`(x,y,z)->(-x,y,z)`）、层级快照、相机、灯光、动画剪辑清单、警告与每个文件的 SHA-256。

两条摄取路径产出同一种包。`director_dcc extract_engine_scene` 对本地工程 headless 运行
已安装的引擎（Unreal 走 `UnrealEditor-Cmd -run=pythonscript`，Unity 走
`-batchmode -executeMethod`；Unity 额外需要已激活的许可证）。把引擎内导出的 `.zip` 上传到
`POST /api/dcc/engine-scene/uploads?provider=unreal|unity` 则完全不依赖引擎安装，是云环境
可 headless 验证的路径。

`preview_engine_scene_import` 生成服务端持久化的 `director-engine-scene-import-plan-v1`；
`apply_engine_scene_import` 重新校验哈希、把 GLB 复制进内容寻址存储，并用 `plan_id`、
`expected_revision` 与仅限重试的 `idempotency_key` 执行一次原子 authoring 变更。几何保持
`modelNormalization: "preserve"`。可渲染几何依赖引擎侧 glTF 导出器（Unreal 的 glTF
Exporter 插件、Unity 的 `com.unity.cloud.gltfast`）；缺失时包仍可导入相机、灯光与层级，
并把几何缺口记录在案。回程 roundtrip 是声明为 `planned` 的能力，当前不可用。

上传、抽取、预览、应用返回的每个计划都会在类型化的 `result.plan.omitted[]`（与 `omittedCount`
配对，镜像 `.blend` 导入计划）中声明被放弃的内容：`unsupported_object`（导出器跳过的元素，附
引擎 `kind`）、`hierarchy_flattened`（场景合并为单一 Director 场景对象导入）、
`animation_clips`（内嵌剪辑未映射到时间线）、`skinned_mesh_rigs`（骨骼未重绑到 Director 的
角色绑定系统）与 `camera_roll`（逐台导入相机）。free-text `warnings` 仍面向人类；请读取
类型化记录而不是解析警告文本。

## 坐标系统

Director 与 glTF 的原生约定：

```text
线性单位：米
上轴：Y
手性：右手系
metersPerUnit：1
```

人物对象跨边界时必须携带具体资产绑定。如果接收端只能猜测人物可见模型，Director 会让
导出失败，而不是写出歧义文件。

## 有范围的静态网格导出

OBJ 与 STL 是只导出的兼容 artifact，以 ZIP 而不是裸文件交付。`director-obj.zip` 包含
`director-scene.obj`、`director-scene.mtl` 和 `director-export.json`；`director-stl.zip`
包含 `director-scene.stl` 和同一报告 sidecar。报告记录精确项目 revision 与请求范围、纳入和
省略的稳定 ID、三角形数、负缩放 winding 修正、米制/Y-up/右手坐标、警告、字节长度，以及每个
网格 payload 的 SHA-256。

Interchange 菜单可以导出整个 Stage 或当前选择；Agent 通过 `object_ids` 接受相同的精确对象
范围。两条路径都限制为 2,048 个范围内对象和一百万个三角形。隐藏对象和不支持的对象类型会
显式省略；没有受支持可见基础体时导出失败。当前基础体细分覆盖 box、sphere、cylinder、torus、
cone 与 pyramid。此浏览器导出器不会实体化关联的 GLB/GLTF/OBJ/FBX 字节；必须传递这些网格时，
请使用 glTF/USD 或 Blender bridge。

## 专业时间

规范剪辑契约保存有理帧率、整数帧、SMPTE 起始 timecode 与 drop-frame 模式，支持
`24000/1001`、`30000/1001`、`60000/1001` 等。部分兼容 UI 仍暴露数字 `fps` 或秒数，
adapter 会在交换前归一化。

必须区分：

- **project timebase**：Director 时间线的规范 rate 与起始 timecode；
- **source timebase**：媒体自身 rate 与 source range；
- **delivery timebase**：导出或生成要求的格式。

可用 `30000/1001` 时，不要用不精确的 `29.97` 小数往返。

## 媒体、代理与离线重连

Director 可通过 OPFS 或 IndexedDB（并有 memory fallback）持久化本地媒体元数据/字节，
为浏览器可解码音频生成波形，关联代理，选择播放源，标记离线，并给用户选择的重连文件
评分。当前主要是本地浏览器工作流；后台服务端转码、远程对象存储和跨机器自动重连还不是
生产服务。

导出引用稳定媒体身份与来源，不能把离线引用静默伪装成在线资产。

## 镜头与 AI 控制包

生成或合成流程应使用 Stage delivery，而不是抓取编辑器 viewport。`.director-control.zip`
可以包含：

- manifest 与 Shot IR；
- 使用有理 timebase 的逐帧相机轨迹；
- `ai/control.json`；
- 无辅助元素的 `clean`、PBR `albedo`/`roughness`/`metalness`/`emissive`/`ao`/`shadow`、
  packed `depth`、view-space `normal`、稳定 `object-id` 与二值 `mask` PNG；
- 可选米制浮点深度 EXR，并明确记录相机空间深度语义；
- 每个 artifact 的 SHA-256 和 package fingerprint。

capture、Shot IR 与 trajectory 使用同一精确相机/帧 evaluator。当前 LTX-2.3 adapter 只消费
clean frame；额外 pass 可供其他或未来 conditioning adapter 使用，不能写成现有 LTX 多控制输入。

时间轴多模态逐帧包还可以为每帧写出实例标注 JSON。它复用 object-ID 像素，记录稳定对象 ID、
RGB、可见像素数、画面占比与以左上角为原点的像素边界；单视图数据不会被误写为遮挡率。

## Agent 边界

`director_creative interchange` 为有界 OTIO/OTIOZ、Fountain、glTF/GLB、USD/USDZ、OBJ
和 STL 传输提供 `capabilities`、`plan-export`、`export`、`plan-import` 与 `import`。每个计划
绑定精确 Stage revision 或 creative-workspace fingerprint。导出返回 UTF-8 或 base64 payload、
archive SHA-256、字节数、兼容性警告和稳定回执；inline 传输上限是 8 MiB。OBJ/STL 计划可携带
精确 `object_ids`，并把它写入计划身份和 ZIP manifest。

导入沿用同一套 plan/receipt 纪律，分两个 JSON 步骤完成。`plan-import` 校验一个 source —
有界 `inline` payload、已存在的 Gallery `media_id`，或可读的 `workspace_path` — 并返回绑定
当前 guard fingerprint 的计划；`import` 随后精确应用该 `plan_id`，携带
`expected_guard_fingerprint` 与 `confirm:true`，fingerprint 过期时必须重新生成计划。OBJ/STL
仍是只导出格式；文档所列 **Limited** 格式子集边界不变。浏览器
文件选择器仍作为便捷入口保留（针对人类本地已打开的文件），但不再是唯一导入路径。没有已
校验的计划和回执时，不得宣称完成导入。

Stage 验收与 provider-neutral 证据使用 `director_workbench` 的 `shot_ir`、`shot_package` 或
`deliver`。Blender 与引擎连接器先发现并调用 `director_dcc`：`discover`/`status` 如实报告就绪状态，
`export_exchange_package` 为任意提供商准备可携带包，`send_to_engine` / `receive_from_engine` /
`apply_import_plan` 在 Director 官方连接器 `nativeReady` 时跑 Unreal/Unity/Godot 无头往返。就绪门槛
与未就绪结构化诊断见[多 DCC 集成](/engineering/multi_dcc_integration/)。

编辑器侧，同一组操作汇聚在交换菜单的「DCC / 引擎交接」工作台（Blender / Unreal /
Unity / Godot 四个标签页）：来自实时提供方目录的诚实能力芯片、带恢复步骤的连接器健康、
无头发送与各引擎回执（Unreal Sequencer 时基与 `clean_frame` rendered/skipped、Unity
Timeline/Avatar 烘焙、Godot AnimationPlayer/镜头切换计数与 WorldEnvironment 环境光）、
结构化省略通道列表、需显式审阅确认的回传干跑预览，以及绝不宣称写入工程的仅预览
实时链路状态。Blender 标签页挂载既有实时面板；`.blend` 导入与 `include_new_objects`
回传选项仍在菜单原有区块中。

## 往返检查表

1. 记录源项目 revision/fingerprint。
2. 确认比例、坐标轴、相机前向与 timebase。
3. 校验所有人物资产绑定和媒体引用。
4. 导出并保留 manifest/receipt 与 warnings。
5. 导入到一次性 scope。
6. 比较稳定 ID、变换、相机、cuts 与时间范围。
7. 检查 clean camera frame；schema 相等不代表视觉相等。

当前成熟度见[功能状态](/zh/reference/feature-status/)，更大的生产模型见
[管线与系统设计](/zh/pipelines/system-design/)。
