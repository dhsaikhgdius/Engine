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
    `Animator`，否则回退为 Generic Avatar。
  - **姿势通道**：Director 语义姿势控制（`poseValues`）通过 Director 姿势数学
    的 C# 移植（`DirectorPoseMath.cs` / `DirectorPoseImport.cs`）应用到
    Mixamo 兼容骨骼——静态姿势直接钉入静置姿态，带关键帧的姿势通道则烘焙为
    该实体 `AnimationClip` 上的逐骨骼旋转曲线。非 Mixamo 骨骼上的姿势通道与
    动作块通道仍然绝不静默拍平：每个被跳过的通道都会以结构化条目写入引擎
    回执，而不是一行自由文本日志。
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
    回执，其 `unity` 块报告渲染管线、glTF 导入器可用性、导入灯光数 /
    烘焙片段数 / Avatar 数 / 材质回退数 / 已应用姿势角色数等计数，以及
    结构化的 `omittedChannels` 列表（通道 ID、实体、原因），涵盖所有连接器
    无法烘焙的通道。
- **导出**（`...DirectorBridgeCli.Export`）：重新打开 Director 场景，在提供方边界
  把所有 `DirectorId` 实体的变换转换回 Director 规范空间，仅导出相对交换包基线
  发生变化的物体与相机，写出 `director-dcc-return-v1` 返回包。
- **健康检查**（`...DirectorBridgeCli.Health`）：输出 JSON 健康信息，包含主机与
  连接器版本、当前渲染管线以及 glTF 导入器可用性。

坐标转换（右手 Y-up ↔ 左手 Y-up，均为米制，`(x, y, z) -> (x, y, -z)`，四元数
`(x, y, z, w) -> (-x, -y, z, w)`，以及配套的 4×4 绑定矩阵共轭变换）实现在
`DirectorSpace.cs`。相机数学（传感器画幅、垂直 FOV、look-at 四元数）、动画求值
（三次贝塞尔缓动、关键帧变换、圆形/路径轨迹）与姿势数学（控制值钳制、Mixamo
骨骼角色映射、语义姿势旋转）均为 TypeScript 参考实现的 C# 移植。

## 实时预览链接

`Director → Live Link Preview`（`DirectorLiveLink.cs`）打开一个编辑器窗口，
使用每会话独立的 Bearer 令牌长轮询 Gateway 的 Unity live-link 中枢
（`/api/dcc/unity/live-link/sessions/<id>/events`）。该传输被刻意收窄：

- **仅出站**：Unity 只发起 GET 轮询，绝不回写状态；Gateway 也不暴露任何形式
  的 C# 执行端点。
- **序列号保序**：每个事件携带单调递增的 `seq`；客户端以 `?after=<seq>` 续传，
  中枢从环形缓冲区重放，若请求的尾部已被淘汰则重发最新完整快照。
- **断线安全**：套接字关闭、会话闲置过期（TTL）、Director 侧关闭会话都会得到
  干净的终止响应；客户端退避并重新同步，而不是拆毁场景。这些行为由
  `backend/gateway/tests/dcc/unityLiveLink.test.ts` 锁定。
- **绝不作为权威**：live-link 事件只预览无头导入已经打上 `DirectorId` 的对象
  的变换。持久通道始终是交换包 / 返回包往返。

## 测试

`Tests/Editor/` 内含 Unity EditMode（NUnit）测试，用黄金值锁定
`DirectorSpace`、`DirectorCameraMath`、`DirectorAnimationEvaluator` 与
`DirectorPoseMath`。同一组黄金值在 Gateway CI 中无需主机即可校验
（`packages/dcc-protocol/tests/directorDccUnityConnectorGolden.test.ts` 及前端
Mixamo 黄金测试），因此 C# 移植与 TypeScript 参考实现一旦漂移，至少有一侧的
测试会失败——CI 中始终无需安装 Unity。

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

未设置 `DIRECTOR_UNITY_BIN` 时，Gateway 会探测 Unity Hub 的按版本安装目录：
macOS（`/Applications/Unity/Hub/Editor`）、Linux（`~/Unity/Hub/Editor`）与
Windows（`%PROGRAMFILES%\Unity\Hub\Editor`），优先选择最新的稳定版本，随后
回退到旧式 / 容器化编辑器布局，最后回退到 `PATH`。若 Hub 编辑器根目录被
迁移，可通过 `DIRECTOR_UNITY_HUB_EDITORS` 指定。

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
Timeline 激活轨道、烘焙到 Timeline `AnimationClip` 的 Director 动画与语义
姿势通道，以及上文所述的仅出站预览实时链接（令牌认证、序列号保序、断线
安全——仅用于预览，绝不作为场景权威）。连接器无法烘焙的通道（动作块、非
Mixamo 骨骼上的姿势通道）以结构化 `omittedChannels` 上报，绝不静默拍平。
仍为规划中：生产级 USD 往返——Unity 的 USD 包仍为预发布，USDA 保持次要、
实验性地位，GLB 仍是首选交换载荷。
