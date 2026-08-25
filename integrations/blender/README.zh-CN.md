# Director 与 Blender 集成

> 语言：**中文** · [English](README.md)

`integrations/blender/` 是 Blender 连接器根目录（DCC 目录的 `connectorDirectory`）。
Python 代码分布于两个同级子树：

| 目录 | 中文用途 |
| --- | --- |
| `live/` | 无头实时建模。`BLENDER_USER_SCRIPTS` 指向此处。包含 `worldengine_backend.py` 与 `addons/worldengine_studio/`。 |
| `interchange/` | 文件工作流：导入可信 `.blend`，或导出/返回 Director 场景。 |

安装 Blender 4.2+（或设置 `BLENDER_BIN`）以使用实时建模。Director 不捆绑 Blender 的 C 源码。

## 文件级清单

### `live/`

| 路径 | 中文用途 |
| --- | --- |
| `worldengine_backend.py` | 无头 Blender 后端入口：加载 addon、配置项目为米制 24fps 1080p、在 `127.0.0.1:8791` 启动 loopback HTTP 会话、运行事件循环直到 SIGTERM。 |
| `addons/worldengine_studio/` | Blender 4.2+ addon（WorldEngine Studio v0.1.0，GPL-2.0），17 个模块 + 测试套件。详见 `live/README.md`。 |

### `interchange/`

| 路径 | 中文用途 |
| --- | --- |
| `director_bridge.py` | 将经验证的 Director DCC 场景包导入 Blender：写入 `director_id` 自定义属性、网格签名、源变换与角色 pose-bone 基线，显式不接受数据之外的任何内容。 |
| `director_scene_export.py` | 从已打开的 `.blend` 提取场景：导出 `director-blend-scene-v1` 包（manifest.json + scene.glb + 相机参数 + 哈希收据）。网关以 `--factory-startup --disable-autoexec` 启动 Blender 后运行此脚本。 |
| `director_return_export.py` | 从精修后的 `.blend` 导出 `director-dcc-return-v1` 返回包：仅导出携带 `director_id` 的对象，生成 GLB + SHA-256 收据；stamp 了全新 `director_id` 的新建根对象成为带 hash 的 `object_addition` 条目；已映射 pose bone 的旋转编辑 reconcile 为 `director_pose.*` control 增量；无 `director_id` 的顶层对象仅作警告。 |
| `director_signature.py` | 共享的网格内容指纹模块：`director_bridge.py` 在导出时写入签名，`director_return_export.py` 在返回时重新计算；两端必须传入字节级一致的数据。 |
| `director_properties.py` | 往返共享的自定义属性名（基线、指纹、骨骼映射）。 |
| `director_pose_bones.py` | 桥接与回传导出器共用的免主机 pose bone ↔ 可移植 control 映射模块。 |
| `director_scene_export.test.ts` | 场景导出脚本的 vitest 单元测试。 |
| `director_return_export.test.ts` | 返回导出脚本的 vitest 单元测试。 |
| `director_pose_bones.test.ts` | pose-bone 映射与别名表同步的免主机 vitest 测试。 |

## 实时建模内核

无头 Blender + `worldengine_studio` addon，位于
`integrations/blender/live/addons/worldengine_studio/`。Stage 与 Agent 通过
`worldengine-blender-live-v1` 协议编辑同一原生场景。`npm run blender` 启动。

启动器将 `BLENDER_USER_SCRIPTS` 设为 `integrations/blender/live`，使 Blender 找到
`addons/worldengine_studio/`。后端入口为 `integrations/blender/live/worldengine_backend.py`。

Loopback 会话默认无认证。如需 bearer 认证，请为网关和 Blender 进程导出相同的
`DIRECTOR_BLENDER_TOKEN`（Blender 继承 shell 环境变量；`WORLDENGINE_SESSION_TOKEN`
仅对 Blender 覆盖）。每个会话请求须携带 `Authorization: Bearer <token>`；无 token 请求返回 401。

## 文件交换

Director 有两套独立的文件工作流。它们共享本地网关和哈希校验，但合并语义不同：

1. **导入现有 `.blend` 场景** — 将操作者信任的本地文件的活动场景快照为单个 GLB 场景包，
   并可选择创建其透视相机。
2. **Director 往返** — 导出 Director 拥有的场景，仅在 Blender 中精修其稳定 ID 实体，
   然后审查并返回这些更改。

第一个流程创建新的 Director 实体。第二个流程更新已知的 Director 实体，且从不将无关的
Blender 对象视为隐式编辑。

### 导入现有 Blender 场景

在编辑器中使用 **交换 → 导入 Blender 场景**，或将原始文件上传到本地网关。网关将上传文件
保存在私有作业目录中，并以 `--factory-startup` 和 `--disable-autoexec` 启动 Blender。
`integrations/blender/interchange/director_scene_export.py` 写入经验证的
`director-blend-scene-v1` 包，包含：

- `manifest.json`、源与产物 SHA-256 收据、警告、显式不支持特性记录；
- `assets/scene.glb`，单个米制、Y-up 场景包，保留 Blender 世界布局、GLB 内层级、材质、
  蒙皮、形态键、嵌入的 GLB 动画；
- 支持的透视相机的物理参数与当前帧变换；
- 源帧范围、当前帧、精确有理帧率作为审查/溯源元数据。

编辑器在任何变更前预览 `director-blend-scene-import-plan-v1`。编辑器默认导入场景包，
并允许操作者选择相机；API 客户端也可构建仅相机的计划。冲突禁用应用。应用仅接受服务器
存储的 `plan_id`、精确的实时 `expected_revision` 和一个 `idempotency_key`；它会重新验证
源包和哈希，重新构建计划，并提交一次原子项目替换。

复制的 GLB 是不可变的，内容寻址存储在 `assets/generated/dcc-import/` 下。浏览器通过
`/dcc-import/<hash-prefix>/<asset-id>.glb` 读取。Director 设置
`modelNormalization: "preserve"`，因此不会重新居中或自动缩放创作的 Blender 场景。

这是场景快照，而非深度可编辑转换。v1 仅评估 Blender 的活动场景。应将原始 `.blend` 导入
视为**可信的本地桌面操作**——禁用自动 Python/驱动执行可减少攻击面，但不对 Blender 原生
文件解析器进行沙箱化。请勿上传不受信任的 `.blend`。

### 导出 Director 场景以精修

Director 导出经验证的 `director-dcc-scene-v1` 包，并构建带有稳定 `director_id` 属性的
`.blend`。在 Blender 中精修该场景；请勿重命名或删除这些自定义 ID。

### 返回精修后的场景

在 Blender 内运行返回导出器。报告必须保持在输出目录内：

```bash
blender --background scene.blend \
  --python integrations/blender/interchange/director_return_export.py -- \
  --source-manifest data/dcc-jobs/blender/JOB_ID/scene.director-dcc.json \
  --output-dir data/dcc-jobs/blender/JOB_ID/return-package \
  --report data/dcc-jobs/blender/JOB_ID/return-package/return-report.json
```

输出为 manifest-first：`manifest.json` 使用 `director-dcc-return-v1`；`meshes/*.glb` 保留
`extras.director.stableId`；未修改的 `.blend` 返回空变更集；网格指纹排除 Director 包装变换；
每个输出文件均有 SHA-256 收据；无 `director_id` 的顶层对象为警告，绝不静默导入。若要提交
新建对象供审阅，请在其根对象上 stamp 一个全新的 `director_id` 自定义属性：它将以带 hash 的
`object_addition` 回传，且只有在预览时显式 `include_new_objects` 选择加入才作为 prop 导入。

应用前预览合并：

```bash
curl -sS http://127.0.0.1:8787/api/tools/director_dcc \
  -H 'content-type: application/json' \
  -d '{"input":{"op":"import_return_package","package_dir":"JOB_ID/return-package","dry_run":true}}'
```

使用精确的 `targetRevision`、稳定的仅重试幂等键和 `op: "apply_import_plan"` 应用返回的计划。
Director 注册不可变的 GLB 资产，仅更新匹配的对象/相机变换，从不替换完整项目。