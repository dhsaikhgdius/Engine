# Blender 文件交换

> 语言：**中文** · [English](README.md)

`integrations/blender/interchange/` 包含 Director 与 Blender 之间的文件级交换脚本。
四个 Python 模块 + 两个 vitest 测试文件，用于导入 `.blend` 场景和实现 Director 往返工作流。

## 文件级清单

| 路径 | 中文用途 |
| --- | --- |
| `director_bridge.py` | 将经验证的 Director DCC 场景包导入 Blender：解析 `director-dcc-scene-v1` manifest，创建/更新携带 `director_id` 自定义属性的对象，写入 `director_source_transform` 与 `director_source_mesh_signature` 属性，显式仅接受数据、不执行任何包内代码。 |
| `director_scene_export.py` | 从已打开的 `.blend` 提取场景为 Director 导入包：导出 `director-blend-scene-v1` 包，包含 `manifest.json`（源/产物 SHA-256 收据、警告、不支持特性）、`assets/scene.glb`（米制 Y-up、保留层级/材质/蒙皮/形态键/动画）、相机参数、帧范围/帧率元数据。网关以 `--factory-startup --disable-autoexec` 启动 Blender 后运行此脚本。 |
| `director_return_export.py` | 从精修后的 `.blend` 导出 `director-dcc-return-v1` 返回包：仅导出携带 `director_id` 自定义属性的对象；生成 `meshes/*.glb`（保留 `extras.director.stableId`）；未修改的 `.blend` 返回空变更集；网格指纹排除 Director 包装变换；每个输出文件附带 SHA-256 收据；无 `director_id` 的顶层对象仅作警告。 |
| `director_signature.py` | 共享的网格内容指纹模块（SHA-256）：`director_bridge.py` 在导出时写入签名，`director_return_export.py` 在返回时重新计算。两端必须传入字节级一致的数据——更改任何哈希字节会使所有先前标记的场景失效。 |
| `director_scene_export.test.ts` | 场景导出脚本的 vitest 单元测试（TypeScript，通过 vitest/jsdom 运行）。 |
| `director_return_export.test.ts` | 返回导出脚本的 vitest 单元测试（TypeScript，通过 vitest/jsdom 运行）。 |

## 两个工作流

### 1. 导入现有 `.blend` 场景

```
操作者上传 .blend → 网关保存到私有作业目录 → Blender 以 --factory-startup --disable-autoexec 启动
       → director_scene_export.py 导出 director-blend-scene-v1 包
       → 编辑器预览 director-blend-scene-import-plan-v1 → 应用（原子项目替换）
```

### 2. Director 场景往返

```
Director 导出 director-dcc-scene-v1 → director_bridge.py 构建 .blend（带 director_id）
       → 在 Blender 中精修 → director_return_export.py 导出 director-dcc-return-v1
       → 网关预览合并（dry_run） → 应用（仅更新匹配对象/相机变换，不替换完整项目）
```

## 安全

所有脚本显式仅接受数据：不执行包内代码、不跟踪远程 URL、仅写入可信本地网关进程提供的路径。
原始 `.blend` 导入应视为**可信的本地桌面操作**——禁用自动 Python/驱动执行可减少攻击面，
但不对 Blender 原生文件解析器进行沙箱化。

## 运行

```bash
# 导入场景
blender --background --factory-startup --disable-autoexec scene.blend \
  --python integrations/blender/interchange/director_scene_export.py -- \
  --output-dir /path/to/output

# 返回精修场景
blender --background scene.blend \
  --python integrations/blender/interchange/director_return_export.py -- \
  --source-manifest data/dcc-jobs/blender/JOB_ID/scene.director-dcc.json \
  --output-dir data/dcc-jobs/blender/JOB_ID/return-package \
  --report data/dcc-jobs/blender/JOB_ID/return-package/return-report.json
```