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

坐标转换（右手 Y-up 米制 ↔ 左手 Z-up 厘米制，
`(x, y, z) -> (-z*100, x*100, y*100)`）实现在 `director_space.py` 中，纯 Python、
不依赖 `unreal` 模块：可直接运行 `python3 director_space.py --self-test`。
Gateway 的 CI 测试会用 TypeScript 参考实现校验同一组黄金用例。

## 模块地图

| 模块 | 可脱离 Unreal 运行 | 职责 |
| ------------------------- | ------------------ | ---------------------------------------------------------------------------------- |
| `director_headless.py` | 仅 health 模式 | 固定入口：导入 / 导出 / 健康检查 / 实时预览编排 |
| `director_package.py` | 是 | 交换包/返回包读写、报告回执 |
| `director_space.py` | 是（`--self-test`） | 规范空间 ↔ Unreal 基变换、相机 look-at 四元数 |
| `director_timebase.py` | 是（`--self-test`） | 有理帧率、Sequencer tick 分辨率、SMPTE NDF/DF 时间码（23.976 / 24 / 25 / 29.97 DF / 30） |
| `director_bake.py` | 是（`--self-test`） | 校验 Gateway 烘焙 sidecar 的哈希；将规范空间采样转换为 Unreal 关键帧并做旋转连续性展开 |
| `director_materials.py` | 是（CLI） | Director PBR 参数 → 材质实例覆盖、sRGB→线性、警告省略记录 |
| `director_gltf.py` | 是（CLI） | GLB 容器检查（仅 JSON 块），将带蒙皮的资产路由到骨骼网格导入 |
| `director_livelink.py` | 是（CLI） | 预览会话协议：令牌、序列号、乱序/重复丢弃、失联检测 |
| `director_sequencer.py` | 否 | LevelSequence 创作：显示帧率、tick 分辨率、起始时间码、相机切换、变换与焦距轨道 |
| `director_host_materials.py` | 否 | 创建 `DirectorPbrOpaque` / `DirectorPbrTranslucent` 父材质及材质实例 |

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
角色绑定状态——会作为警告省略（warn-and-omit）记录在报告中，绝不静默拍平。
报告中嵌入从已创作 LevelSequence 资产回读的 `sequencer` 回执（显示帧率、
tick 分辨率、起始时间码、播放范围、轨道与关键帧数量）。

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

## 实时预览（仅预览，能力仍为 `planned`）

`--mode live-preview` 仅绑定 `127.0.0.1`，要求 `DIRECTOR_UNREAL_PREVIEW_TOKEN`
环境变量提供的共享令牌，并将带序列号的 `camera_frame` 消息应用到编辑器视口。
乱序或重复的帧会被丢弃；对端静默超时会断开会话。协议语义由
`backend/gateway/tests/dcc/unrealConnectorModules.test.ts` 做无主机验证。
Gateway 侧传输尚未发布，因此 `live_link` 能力保持 `planned`；持久化场景通道
始终是经哈希校验的交换/返回包。

## 能力诚实性

已实现且有版本校验：无头导入/导出、稳定 `director_id` 往返、场景层级、变换、
相机、分镜 → Sequencer 相机切换、Gateway 烘焙的变换/相机动画写入 Sequencer
轨道（含有理帧率与起始时间码）、带蒙皮 GLB 的骨骼网格绑定姿态导入、以及
Director PBR 参数转材质实例。以上每项转换均有无主机黄金测试覆盖；编辑器内
路径仅在配置了已授权 Unreal 安装时额外执行。

仍为规划中（宁可警告省略，绝不静默拍平）：骨骼姿态与动作片段传输
（Control Rig）、骨骼动画重定向、贴图文件转换、Gateway 实时链接传输、以及
干净帧渲染回执。`.uasset` 文件绝不会在 Unreal 之外被解析或合成。

---

## Unreal Engine 场景导入（director-engine-scene-v1）

从 Unreal Engine 5 关卡到 Director 的单向导入桥。导出器在 Unreal 编辑器内运行
（交互式或 headless），产出可移植的 `director-engine-scene-v1` 包，由 Director
网关校验、生成计划并应用——与受信 `.blend` 导入相同的 preview/apply 流程。

### 包结构

| 文件 | 用途 |
| --- | --- |
| `manifest.json` | 场景元数据、层级快照、相机、灯光、动画剪辑清单、警告、SHA-256 哈希。 |
| `assets/scene.glb` | 通过内置 **glTF Exporter** 插件导出的可渲染关卡几何（在 Edit → Plugins 中启用）。材质、骨骼网格与动画数据内嵌于 GLB。 |

manifest 中的每个变换都已从 Unreal 的左手 Z-up 厘米约定转换为 Director 的
右手 Y-up 米约定（`(x,y,z)->(y,z,-x)*0.01`），manifest 记录该映射以供审计。

### 导出

Headless（当 `DIRECTOR_UNREAL_EDITOR_BIN` 或常见安装路径可解析时，Director
网关会在 `director_dcc` `extract_engine_scene` 中自动执行）：

```bash
UnrealEditor-Cmd <project.uproject> -run=pythonscript \
    -script="integrations/unreal/interchange/director_scene_export.py --output-dir /abs/out [--scene /Game/Maps/Set] [--zip]" \
    -unattended -nosplash -nullrhi -stdout
```

也可在编辑器 Python 控制台运行同一脚本。`--zip` 会在输出目录旁写出
`director-engine-scene.zip`，可直接上传：

```bash
curl -X POST "http://127.0.0.1:8787/api/dcc/engine-scene/uploads?provider=unreal" \
    -H "content-type: application/zip" \
    -H "x-director-filename: director-engine-scene.zip" \
    --data-binary @director-engine-scene.zip
```

### 导入 Director

1. `director_dcc {"op":"status","provider":"unreal"}` —— 检查运行时与连接器就绪状态。
2. 获取包：`extract_engine_scene`（已装引擎）或上述 `.zip` 上传。
3. 用返回的 `packageDir` 调 `preview_engine_scene_import` —— 审阅计划、警告与冲突。
4. 用 `plan_id`、`expected_revision` 和 `idempotency_key` 调 `apply_engine_scene_import`。

### 功能保留

| 功能 | 等级 | 说明 |
| --- | --- | --- |
| 几何 / 层级 | exchange | GLB 包 + 带稳定 actor 路径 ID 的类型化层级快照。 |
| 相机 | exchange | Cine 相机 filmback、焦距、光圈、对焦距离；裁剪面回退到 Director 默认值。 |
| 灯光 | exchange | 方向 / 点 / 聚光 / 矩形 / 天空光，附亮度启发式（lux 与 lumens → Director 无单位刻度）。 |
| 材质、骨骼网格、动画数据 | exchange | 由 glTF Exporter 插件内嵌于 GLB。Level Sequence 仅按名称清单化。 |
| 稳定 ID | director-manifest | 每个节点/相机/灯光记录 actor 路径名。 |
| 回程 roundtrip | planned | v1 仅导入。 |

### 阻塞项

Epic 对二进制与源码分发均要求 Epic Games 账户（EULA），云环境无法匿名获取
UE5。请手动安装并设置 `DIRECTOR_UNREAL_EDITOR_BIN`，或在编辑器内导出后上传
`.zip`。
