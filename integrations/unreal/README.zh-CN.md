# Unreal Engine 集成

> 语言：[English](README.md) · **中文**

从 Unreal Engine 5 关卡到 Director 的单向导入桥。导出器在 Unreal 编辑器内运行
（交互式或 headless），产出可移植的 `director-engine-scene-v1` 包，由 Director
网关校验、生成计划并应用——与受信 `.blend` 导入相同的 preview/apply 流程。

## 包结构

| 文件 | 用途 |
| --- | --- |
| `manifest.json` | 场景元数据、层级快照、相机、灯光、动画剪辑清单、警告、SHA-256 哈希。 |
| `assets/scene.glb` | 通过内置 **glTF Exporter** 插件导出的可渲染关卡几何（在 Edit → Plugins 中启用）。材质、骨骼网格与动画数据内嵌于 GLB。 |

manifest 中的每个变换都已从 Unreal 的左手 Z-up 厘米约定转换为 Director 的
右手 Y-up 米约定（`(x,y,z)->(y,z,-x)*0.01`），manifest 记录该映射以供审计。

## 导出

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

## 导入 Director

1. `director_dcc {"op":"status","provider":"unreal"}` —— 检查运行时与连接器就绪状态。
2. 获取包：`extract_engine_scene`（已装引擎）或上述 `.zip` 上传。
3. 用返回的 `packageDir` 调 `preview_engine_scene_import` —— 审阅计划、警告与冲突。
4. 用 `plan_id`、`expected_revision` 和 `idempotency_key` 调 `apply_engine_scene_import`。

## 功能保留

| 功能 | 等级 | 说明 |
| --- | --- | --- |
| 几何 / 层级 | exchange | GLB 包 + 带稳定 actor 路径 ID 的类型化层级快照。 |
| 相机 | exchange | Cine 相机 filmback、焦距、光圈、对焦距离；裁剪面回退到 Director 默认值。 |
| 灯光 | exchange | 方向 / 点 / 聚光 / 矩形 / 天空光，附亮度启发式（lux 与 lumens → Director 无单位刻度）。 |
| 材质、骨骼网格、动画数据 | exchange | 由 glTF Exporter 插件内嵌于 GLB。Level Sequence 仅按名称清单化。 |
| 稳定 ID | director-manifest | 每个节点/相机/灯光记录 actor 路径名。 |
| 回程 roundtrip | planned | v1 仅导入。 |

## 阻塞项

Epic 对二进制与源码分发均要求 Epic Games 账户（EULA），云环境无法匿名获取
UE5。请手动安装并设置 `DIRECTOR_UNREAL_EDITOR_BIN`，或在编辑器内导出后上传
`.zip`。
