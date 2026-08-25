# Director Unity 连接器

仅源码分发的 UPM 编辑器包（`com.director.bridge`），带固定的 `-batchmode
-executeMethod` 入口，用于将本机已授权的 Unity 2022.3+ 与 Director 连接。场景数据
通过 GLB 加 Director manifest JSON 传递；Unity YAML 绝不作为交换格式，Director
Gateway 也绝不解析它。

## 功能

- **导入**（`Director.Bridge.Editor.DirectorBridgeCli.Import`）：读取
  `director-dcc-exchange-package-v1` 包目录（经 schema 与 SHA-256 校验），新建
  场景并保存到 `Assets/Director/Scenes/`。所有实体挂载 `DirectorId` 组件，并恢复
  父子层级。
  - **GLB 资产**以内容哈希命名复制到 `Assets/Director/Packages/<id>/`，再通过工程
    中已安装的 glTF `ScriptedImporter`（如 `com.unity.cloud.gltfast`）同步导入。
    连接器自身绝不解析 GLB 字节；缺少导入器时写入警告并保留空 GameObject。
  - **角色**通过 `assetRefId` 解析（绝不按数组下标）。带蒙皮的 GLB 在
    Mixamo 兼容必需骨骼齐全时（自动剥离骨骼前缀）获得带 Humanoid Avatar 的
    `Animator`，否则回退为 Generic Avatar。未传输的绑定状态（姿势值、动作块）
    写入警告，绝不静默拍平。
  - **材质**依据检测到的渲染管线，把 Director PBR manifest 映射到 URP/Lit 或
    Built-in Standard（HDRP 警告并使用最接近的回退）。绑定 glTF
    metallic-roughness 标量与内容哈希的相对路径贴图；不支持的材质图
    警告并省略。
  - **相机**成为 Unity 物理相机：焦距加 Director 传感器画幅裁切驱动
    `Camera.usePhysicalProperties`、传感器尺寸与 FOV；look-at 目标按场景实体
    解析；正交比例正确换算。变形宽银幕挤压（anamorphic squeeze）警告并省略。
  - **灯光**（点光 / 聚光 / 平行光 / 面光）成为带独立 `DirectorId` 的 Unity
    `Light` GameObject；环境光与半球光映射到 `RenderSettings` 并写入警告。灯光
    不参与往返（返回契约没有灯光实体类型）。
  - **Timeline**：在 `Assets/Director/Timelines/` 下生成一个 `TimelineAsset`，
    由单个 `PlayableDirector` 承载。分镜成为覆盖其相机的 `ActivationTrack`
    片段；Director 关键帧 / 轨迹动画通过 Director 缓动与轨迹求值器的 C# 移植
    烘焙为 `AnimationTrack` 上的 `AnimationClip`。不支持的通道警告并省略；
    `.unity` YAML 绝不成为交换格式。
  - 最后回写一个规范空间的返回包，并写出 `director-dcc-engine-report-v1`
    回执，其 `unity` 块报告渲染管线、glTF 导入器可用性，以及导入灯光数 /
    烘焙片段数 / Avatar 数 / 材质回退数等计数。
- **导出**（`...DirectorBridgeCli.Export`）：重新打开 Director 场景，在提供方边界
  把所有 `DirectorId` 实体的变换转换回 Director 规范空间，仅导出相对交换包基线
  发生变化的物体与相机，写出 `director-dcc-return-v1` 返回包。
- **健康检查**（`...DirectorBridgeCli.Health`）：输出 JSON 健康信息，包含主机与
  连接器版本、当前渲染管线以及 glTF 导入器可用性。

坐标转换（右手 Y-up ↔ 左手 Y-up，均为米制，`(x, y, z) -> (x, y, -z)`，四元数
`(x, y, z, w) -> (-x, -y, z, w)`，以及配套的 4×4 绑定矩阵共轭变换）实现在
`DirectorSpace.cs`。相机数学（传感器画幅、垂直 FOV、look-at 四元数）与动画求值
（三次贝塞尔缓动、关键帧变换、圆形/路径轨迹）均为 TypeScript 参考实现的 C# 移植。

## 测试

`Tests/Editor/` 内含 Unity EditMode（NUnit）测试，用黄金值锁定
`DirectorSpace`、`DirectorCameraMath` 与 `DirectorAnimationEvaluator`。同一组
黄金值在 Gateway CI 中无需主机即可校验
（`packages/dcc-protocol/tests/directorDccUnityConnectorGolden.test.ts`），因此
C# 移植与 TypeScript 参考实现一旦漂移，至少有一侧的测试会失败——CI 中始终无需
安装 Unity。

## 安装

1. 将 `com.director.bridge` 复制到 `<你的工程>/Packages/com.director.bridge`
   （或在 `Packages/manifest.json` 中作为本地包引用）。
2. 建议安装 `com.unity.cloud.gltfast`，GLB 资产可作为网格导入，而不是
   “警告并省略”的占位对象。
3. 配置 Director Gateway 环境变量：

```bash
export DIRECTOR_UNITY_BIN=/path/to/Unity/Editor/Unity
export DIRECTOR_UNITY_PROJECT=/path/to/YourProject
```

只有当连接器源码、可执行文件、版本探测、工程内已安装的包全部通过检查时，
`director_dcc {"op":"status","provider":"unity"}` 才会报告 `nativeReady: true`。
`installed` 本身绝不等于 `nativeReady`。便携 GLB/USDA 交换始终可用。

## 无头调用（Gateway 实际执行的命令）

```bash
"$DIRECTOR_UNITY_BIN" -batchmode -nographics -quit \
  -projectPath "$DIRECTOR_UNITY_PROJECT" \
  -executeMethod Director.Bridge.Editor.DirectorBridgeCli.Import \
  -logFile <job>/host.log \
  -directorPackage <包目录> -directorReport <job>/report.json \
  -directorReturnDir <job>/return
```

入口方法是固定的；Gateway 绝不执行请求方提供的 C#。每次运行都会写出
`director-dcc-engine-report-v1` 回执，Gateway 会做 schema 校验，并核对交换包 ID
与源修订号。

## 能力诚实性

已实现且有版本校验：无头导入/导出、稳定 `director_id` 往返、场景层级、变换、
物理相机、灯光、PBR 材质回退、蒙皮 GLB 的 Humanoid/Generic Avatar、分镜 →
Timeline 激活轨道，以及烘焙到 Timeline `AnimationClip` 的 Director 动画。仍为
规划中（宁可警告省略，绝不静默拍平）：实时链接 / 预览传输（需要只出站的认证
通道与断线安全测试），以及生产级 USD 往返（Unity 的 USD 包仍为预发布；USDA
保持次要、实验性地位）。

---

## Unity 场景导入（director-engine-scene-v1）

从 Unity 场景到 Director 的单向导入桥。Editor-only 导出器产出可移植的
`director-engine-scene-v1` 包，由 Director 网关校验、生成计划并应用——与受信
`.blend` 导入相同的 preview/apply 流程。

### 包结构

| 文件 | 用途 |
| --- | --- |
| `manifest.json` | 场景元数据、层级快照、相机、灯光、动画剪辑清单、警告、SHA-256 哈希。 |
| `assets/scene.glb` | 通过 **`com.unity.cloud.gltfast`**（Package Manager 安装）导出的可渲染场景几何。材质与蒙皮网格内嵌于 GLB。 |

manifest 中的每个变换都已从 Unity 的左手 Y-up 米约定转换为 Director 的
右手 Y-up 米约定（`(x,y,z)->(-x,y,z)`），manifest 记录该映射以供审计。

### 导出

Headless（当 `DIRECTOR_UNITY_BIN` 或常见安装路径可解析时，Director 网关会在
`director_dcc` `extract_engine_scene` 中自动执行；网关会先把
`interchange/DirectorSceneExport.cs` 复制到项目的
`Assets/Editor/DirectorInterchange/`）：

```bash
Unity -batchmode -nographics -quit -projectPath <project> \
    -executeMethod DirectorInterchange.DirectorSceneExport.ExportFromCommandLine \
    -directorOutputDir /abs/out [-directorScene Assets/Scenes/Main.unity] [-directorZip]
```

Headless 批处理模式需要本机已激活的 **Unity 许可证**。没有许可证时，可在
编辑器内交互式运行导出（同一方法可交互调用），再上传 `-directorZip` 写出的
`.zip`：

```bash
curl -X POST "http://127.0.0.1:8787/api/dcc/engine-scene/uploads?provider=unity" \
    -H "content-type: application/zip" \
    -H "x-director-filename: director-engine-scene.zip" \
    --data-binary @director-engine-scene.zip
```

### 导入 Director

1. `director_dcc {"op":"status","provider":"unity"}` —— 检查运行时与连接器就绪状态。
2. 获取包：`extract_engine_scene`（已装引擎且已激活许可证）或上述 `.zip` 上传。
3. 用返回的 `packageDir` 调 `preview_engine_scene_import` —— 审阅计划、警告与冲突。
4. 用 `plan_id`、`expected_revision` 和 `idempotency_key` 调 `apply_engine_scene_import`。

### 功能保留

| 功能 | 等级 | 说明 |
| --- | --- | --- |
| 几何 / 层级 | exchange | GLB 包 + 带 `GlobalObjectId` 稳定 ID 的类型化层级快照。 |
| 相机 | exchange | 物理相机启用时保留传感器、光圈、对焦距离；垂直 FOV 与裁剪面始终保留。 |
| 灯光 | exchange | 方向 / 点 / 聚光 / 矩形灯 + Flat 环境光；圆盘灯记录为缺口。 |
| 材质、蒙皮网格 | exchange | 由 gltfast 内嵌于 GLB。动画剪辑带时长清单化。 |
| 稳定 ID | director-manifest | 每个节点/相机/灯光记录 `GlobalObjectId`。 |
| 回程 roundtrip | planned | v1 仅导入。 |

### 阻塞项

Linux Editor 本体可自由下载（`tools/scripts/install-dcc-runtimes.sh` 会把
6000.0.82f1 LTS 装入 `/opt/director-dcc`），但 `-batchmode` 运行需要已激活的
许可证（免费 Personal 许可证即可）。没有许可证时请交互式导出并上传 `.zip`。
