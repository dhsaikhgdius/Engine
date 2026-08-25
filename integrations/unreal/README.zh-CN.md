# Director Unreal Engine 连接器

仅源码分发的编辑器插件与固定无头入口，用于将本机已授权的 Unreal Engine 5.3+
与 Director 连接。本目录不包含任何 Epic 发行内容；连接器完全运行在用户自己的
引擎与工程中，符合 Unreal Engine EULA。

## 功能

- **导入**（`--mode import`）：读取 `director-dcc-exchange-package-v1` 包目录，
  为每个 Director 物体生成一个 Actor（GLB 资产用 StaticMeshActor，否则生成空
  Actor 并写入警告），为每个 Director 相机生成 CineCameraActor，恢复父子层级，
  为所有 Actor 打上 `director_id:<id>` 标签，将分镜（storyboard）映射为
  LevelSequence 的相机切换轨道，把关卡保存到 `/Game/Director/Levels/`，并回写
  一个规范空间（canonical space）的返回包。
- **导出**（`--mode export`）：读取当前关卡中所有带 `director_id` 标签的 Actor，
  在提供方边界处把变换转换回 Director 规范空间，仅导出相对交换包基线发生变化
  的实体，写出 `director-dcc-return-v1` 返回包。
- **健康检查**（`--mode health`）：输出包含引擎与连接器版本的 JSON。

坐标转换（右手 Y-up 米制 ↔ 左手 Z-up 厘米制，
`(x, y, z) -> (-z*100, x*100, y*100)`）实现在 `director_space.py` 中，纯 Python、
不依赖 `unreal` 模块：可直接运行 `python3 director_space.py --self-test`。
Gateway 的 CI 测试会用 TypeScript 参考实现校验同一组黄金用例。

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
      --mode import --package <包目录> --report <job>/report.json --return-dir <job>/return" \
  -unattended -nopause -nosplash -nullrhi -stdout
```

入口脚本是固定的；Gateway 绝不执行请求方提供的 Python。每次运行都会写出
`director-dcc-engine-report-v1` 回执，Gateway 会做 schema 校验，并核对交换包 ID
与源修订号。

## 能力诚实性

已实现且有版本校验：无头导入/导出、稳定 `director_id` 往返、场景层级、变换、
相机、分镜 → Sequencer 相机切换。仍为规划中（宁可警告省略，绝不静默拍平）：
动画曲线、骨骼重定向、材质转换、实时链接（live link）。

---

## Unreal Engine 集成

> 语言：[English](README.md) · **中文**

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
