# Unity 集成

> 语言：[English](README.md) · **中文**

从 Unity 场景到 Director 的单向导入桥。Editor-only 导出器产出可移植的
`director-engine-scene-v1` 包，由 Director 网关校验、生成计划并应用——与受信
`.blend` 导入相同的 preview/apply 流程。

## 包结构

| 文件 | 用途 |
| --- | --- |
| `manifest.json` | 场景元数据、层级快照、相机、灯光、动画剪辑清单、警告、SHA-256 哈希。 |
| `assets/scene.glb` | 通过 **`com.unity.cloud.gltfast`**（Package Manager 安装）导出的可渲染场景几何。材质与蒙皮网格内嵌于 GLB。 |

manifest 中的每个变换都已从 Unity 的左手 Y-up 米约定转换为 Director 的
右手 Y-up 米约定（`(x,y,z)->(-x,y,z)`），manifest 记录该映射以供审计。

## 导出

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

## 导入 Director

1. `director_dcc {"op":"status","provider":"unity"}` —— 检查运行时与连接器就绪状态。
2. 获取包：`extract_engine_scene`（已装引擎且已激活许可证）或上述 `.zip` 上传。
3. 用返回的 `packageDir` 调 `preview_engine_scene_import` —— 审阅计划、警告与冲突。
4. 用 `plan_id`、`expected_revision` 和 `idempotency_key` 调 `apply_engine_scene_import`。

## 功能保留

| 功能 | 等级 | 说明 |
| --- | --- | --- |
| 几何 / 层级 | exchange | GLB 包 + 带 `GlobalObjectId` 稳定 ID 的类型化层级快照。 |
| 相机 | exchange | 物理相机启用时保留传感器、光圈、对焦距离；垂直 FOV 与裁剪面始终保留。 |
| 灯光 | exchange | 方向 / 点 / 聚光 / 矩形灯 + Flat 环境光；圆盘灯记录为缺口。 |
| 材质、蒙皮网格 | exchange | 由 gltfast 内嵌于 GLB。动画剪辑带时长清单化。 |
| 稳定 ID | director-manifest | 每个节点/相机/灯光记录 `GlobalObjectId`。 |
| 回程 roundtrip | planned | v1 仅导入。 |

## 阻塞项

Linux Editor 本体可自由下载（`tools/scripts/install-dcc-runtimes.sh` 会把
6000.0.82f1 LTS 装入 `/opt/director-dcc`），但 `-batchmode` 运行需要已激活的
许可证（免费 Personal 许可证即可）。没有许可证时请交互式导出并上传 `.zip`。
