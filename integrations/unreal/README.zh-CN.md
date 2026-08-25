# Director Unreal Engine 连接器

仅源码分发的编辑器插件与固定无头入口，用于将本机已授权的 Unreal Engine 5.3+
与 Director 连接。本目录不包含任何 Epic 发行内容；连接器完全运行在用户自己的
引擎与工程中，符合 Unreal Engine EULA。

## 功能

- **导入**（`--mode import`）：读取 `director-dcc-exchange-package-v1` 包目录，
  为每个 Director 物体生成一个 Actor（GLB 资产用 StaticMeshActor，带蒙皮的 GLB
  用 SkeletalMeshActor，否则生成空 Actor 并写入警告），为每个 Director 相机生成
  CineCameraActor，恢复父子层级，为所有 Actor 打上 `director_id:<id>` 标签，
  将 Director PBR 材质应用为材质实例（Material Instance），依据 Gateway 写出的
  哈希锁定动画烘焙为 LevelSequence 打关键帧，把分镜（storyboard）映射为相机
  切换轨道，将关卡保存到 `/Game/Director/Levels/`，并回写一个规范空间
  （canonical space）的返回包。
- **导出**（`--mode export`）：读取当前关卡中所有带 `director_id` 标签的 Actor，
  在提供方边界处把变换转换回 Director 规范空间，仅导出相对交换包基线发生变化
  的实体，写出 `director-dcc-return-v1` 返回包。相机基线使用与 glTF/OpenUSD
  导出一致的 look-at 旋转。
- **健康检查**（`--mode health`）：输出包含引擎版本、连接器版本与特性列表的 JSON。
- **实时预览**（`--mode live-preview`）：可选的、仅用于预览的回环相机通道，
  推送到编辑器视口。参见下文「实时预览」；它永远不是持久化场景通道。
- **干净帧渲染**（`--mode render`）：可选的尽力而为静帧渲染，通过带 Director
  标签的 CineCamera 渲染已导入关卡，不含任何 gizmo、标签或选中描边。总是写出
  `director-unreal-clean-frame-v1` 回执——成功时为 `rendered` 并附图像
  SHA-256，否则为 `skipped` 并附原因。参见下文「干净帧渲染回执」。

坐标转换（右手 Y-up 米制 ↔ 左手 Z-up 厘米制，
`(x, y, z) -> (-z*100, x*100, y*100)`）实现在 `director_space.py` 中，纯 Python、
不依赖 `unreal` 模块：可直接运行 `python3 director_space.py --self-test`。
Gateway 的 CI 测试会用 TypeScript 参考实现校验同一组黄金用例。

## 模块地图

| 模块                         | 可脱离 Unreal 运行  | 职责                                                                                     |
| ---------------------------- | ------------------- | ---------------------------------------------------------------------------------------- |
| `director_headless.py`       | 仅 health 模式      | 固定入口：导入 / 导出 / 健康检查 / 实时预览 / 渲染编排                                   |
| `director_package.py`        | 是                  | 交换包/返回包读写、报告回执                                                              |
| `director_space.py`          | 是（`--self-test`） | 规范空间 ↔ Unreal 基变换、相机 look-at 四元数                                            |
| `director_timebase.py`       | 是（`--self-test`） | 有理帧率、Sequencer tick 分辨率、SMPTE NDF/DF 时间码（23.976 / 24 / 25 / 29.97 DF / 30） |
| `director_bake.py`           | 是（`--self-test`） | 校验 Gateway 烘焙 sidecar 的哈希；将规范空间采样转换为 Unreal 关键帧并做旋转连续性展开   |
| `director_materials.py`      | 是（CLI）           | Director PBR 参数 → 材质实例覆盖、sRGB→线性、警告省略记录                                |
| `director_gltf.py`           | 是（CLI）           | GLB 容器检查（仅 JSON 块），将带蒙皮的资产路由到骨骼网格导入                             |
| `director_livelink.py`       | 是（CLI）           | 预览会话协议：令牌、序列号、乱序/重复丢弃、失联检测                                      |
| `director_sequencer.py`      | 否                  | LevelSequence 创作：显示帧率、tick 分辨率、起始时间码、相机切换、变换与焦距轨道          |
| `director_host_materials.py` | 否                  | 创建 `DirectorPbrOpaque` / `DirectorPbrTranslucent` 父材质及材质实例                     |

可脱离主机运行的模块由 Gateway CI 测试
（`backend/gateway/tests/dcc/unrealConnectorModules.test.ts`）用 `python3`
直接验证；依赖编辑器的模块在该测试中做语法编译检查，并在编辑器内执行。

## 动画：Sequencer 烘焙 sidecar

Director 的动画求值器（缓动曲线、轨迹、相机路径与跟随行为）运行在 Gateway 中，
不在 Python 中复刻。每次 Unreal 交接时，Gateway 会将逐帧世界变换与相机焦距采样
写入私有任务目录内的 `director-unreal-sequencer-bake-v1` sidecar
（`animation.json`），并通过固定参数数组锁定其 SHA-256：

```text
--animation "<job>/animation.json" --animation-sha256 <hex>
```

连接器会拒绝哈希、包 ID 或源修订号不匹配的 sidecar，然后打关键帧：

- 每个烘焙实体一条变换轨道（位置为厘米，旋转为连续性展开后的 rotator 角度，
  缩放按 Unreal 轴序重排）；
- 每个带 fov 动画的相机一条焦距轨道，按该相机自己的 filmback 换算；
- LevelSequence 的显示帧率、tick 分辨率与起始时间码取自 Director 时间线
  timebase（有理帧率；drop-frame 仅在 NTSC 29.97/59.94 上生效）。

烘焙无法承载的通道——骨骼姿态关键帧（Control-Rig 类数值）、角色动作片段、
角色绑定状态——绝不静默拍平，而是以结构化数据出现两次：Gateway 直接从烘焙
计算出 `send_to_engine` 结果上的 `omittedAnimationChannels` 记录
（`directorId`、`entityType`、`channels`），连接器同时在报告中回显对应的
`omitted_animation_channels` 条目，并保留逐实体的警告省略（warn-and-omit）
文字。报告中还嵌入从已创作 LevelSequence 资产回读的 `sequencer` 回执
（显示帧率、tick 分辨率、起始时间码、播放范围、轨道与关键帧数量）。

## 骨骼与材质

- 带蒙皮的 GLB 资产（仅从 GLB JSON 块检测，绝不解析二进制缓冲）通过编辑器资产
  管线导入，并以绑定姿态生成带 `director_id` 标签的 `SkeletalMeshActor`。当导入
  管线未产出骨骼、或角色引用了无蒙皮 GLB 时，连接器写入警告并回退为静态网格。
- Director PBR 材质参数（baseColor、metalness、roughness、opacity、自发光、
  双面）转换为材质实例，父材质为 Director 创作的 `DirectorPbrOpaque` /
  `DirectorPbrTranslucent`。不支持的通道（transmission、IOR、clearcoat、
  未随包捆绑为相对哈希文件的贴图引用、仅背面渲染）以警告省略处理。

## 安装

1. 将 `plugins/DirectorBridge` 复制到 `<你的工程>/Plugins/DirectorBridge`。
2. 在 Edit → Plugins 中启用 **Director Bridge** 与 **Python Editor Script
   Plugin**，然后重启编辑器。
3. 配置 Director Gateway 环境变量：

```bash
export DIRECTOR_UNREAL_EDITOR_BIN=/path/to/Engine/Binaries/Linux/UnrealEditor-Cmd
export DIRECTOR_UNREAL_PROJECT=/path/to/YourProject/YourProject.uproject
```

未设置 `DIRECTOR_UNREAL_EDITOR_BIN` 时，Gateway 会在 `PATH` 中探测
`UnrealEditor-Cmd` / `UnrealEditor`（Windows 上还包括 `.exe` 名称），并检查
三个平台的默认安装根目录：Linux 二进制包 / 源码构建根目录
（`/opt/UnrealEngine`、`/opt/unreal-engine`、`/usr/local/UnrealEngine`）、
macOS Epic Games Launcher 安装（`/Users/Shared/Epic Games/UE_5.x`），以及
Windows Launcher 安装（`C:\Program Files\Epic Games\UE_5.x`）。引擎版本从
安装目录中的 `Build.version` 文件读取，无需启动编辑器。

只有当连接器源码、可执行文件、引擎版本探测、工程内已安装的插件全部通过检查时，
`director_dcc {"op":"status","provider":"unreal"}` 才会报告 `nativeReady: true`。
仅检测到可执行文件绝不代表原生就绪；便携 USDA/GLB 交换始终可用。

## 无头调用（Gateway 实际执行的命令）

```bash
"$DIRECTOR_UNREAL_EDITOR_BIN" "$DIRECTOR_UNREAL_PROJECT" \
  -ExecutePythonScript="<工程>/Plugins/DirectorBridge/Content/Python/director_headless.py \
      --mode import --package <包目录> --report <job>/report.json --return-dir <job>/return \
      --animation <job>/animation.json --animation-sha256 <hex>" \
  -unattended -nopause -nosplash -nullrhi -stdout
```

入口脚本是固定的；Gateway 绝不执行请求方提供的 Python。每次运行都会写出
`director-dcc-engine-report-v1` 回执，Gateway 会做 schema 校验，并核对交换包 ID
与源修订号。缺少 `--animation` 参数表示静态导入；提供了 sidecar 但校验失败则
判定为硬失败。

## 实时预览（`live_link`，仅预览、绝非权威通道）

`--mode live-preview` 仅绑定 `127.0.0.1`，要求 `DIRECTOR_UNREAL_PREVIEW_TOKEN`
环境变量提供的共享令牌，并将带序列号的 `camera_frame` 消息应用到编辑器视口。
乱序或重复的帧会被丢弃；对端静默超时会断开会话。Gateway 侧实现在
`backend/gateway/dcc/unrealLivePreview.ts`（`director-unreal-live-preview-v1`
契约）：每个出站帧都经过校验，过期序列号被丢弃，入站字节只计数、绝不解析，
因此实时帧永远不可能变成工程变更。两端均有断连/乱序/重复测试
（传输侧为 `backend/gateway/tests/dcc/unrealLivePreview.test.ts`，无主机的
连接器会话侧为 `backend/gateway/tests/dcc/unrealConnectorModules.test.ts`），
因此 `live_link` 能力为 `native`——但仅作为预览通道。持久化场景通道始终是
经哈希校验的交换/返回包，Remote Control 绝不充当安全边界。

## 干净帧渲染回执

当 `send_to_engine` 带 `clean_frame: true` 且 Unreal 处于 `nativeReady` 时，
Gateway 会启动第二个短生命周期的编辑器进程，使用 `-RenderOffscreen`
（真实 RHI，不用 `-nullrhi`）加载已导入关卡、定位请求的带 Director 标签的
CineCamera、把 LevelSequence 定位到请求帧，并捕获一张不含 gizmo、标签或
选中描边的高分辨率截图。连接器总是写出
`director-unreal-clean-frame-v1` 回执：

- `status: "rendered"`：包含图像路径（相对 job 目录）、SHA-256、像素尺寸、
  相机 `director_id`、帧号与捕获方式（`offscreen_high_res_screenshot`）；或
- `status: "skipped"`：包含说明原因的 `skipReason`（没有带标签的相机、渲染
  进程失败、回执/哈希不匹配等）。

Gateway 会对照交换包 ID 与源修订号重新校验回执，并在附加到发送结果之前重新
计算图像哈希。渲染失败或跳过绝不会导致交接失败——回执会说明原因。回执
schema 不依赖主机；`runUnrealCleanFrame` 实现在
`backend/gateway/dcc/unrealCleanFrame.ts`，降级测试在
`backend/gateway/tests/dcc/unrealCleanFrame.test.ts`。

## 能力诚实性

已实现且有版本校验：无头导入/导出、稳定 `director_id` 往返、场景层级、变换、
相机、分镜 → Sequencer 相机切换、Gateway 烘焙的变换/相机动画写入 Sequencer
轨道（含有理帧率与起始时间码）、带蒙皮 GLB 的骨骼网格绑定姿态导入、
Director PBR 参数转材质实例、仅预览的 `live_link` 传输（绝非场景权威）、
以及尽力而为的干净帧渲染回执。以上每项转换均有无主机黄金测试覆盖；编辑器内
路径仅在配置了已授权 Unreal 安装时额外执行。

仍为规划中（以结构化 `omittedAnimationChannels` 记录警告省略，绝不静默
拍平）：骨骼姿态与动作片段传输（Control Rig）、骨骼动画重定向、以及贴图
文件转换。`.uasset` 文件绝不会在 Unreal 之外被解析或合成。
