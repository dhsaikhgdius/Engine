# 资产

> 语言：**中文** · [English](README.md)

## 概述

`assets/` 是 WorldEngine 的资产目录，包含**源资产清单（library）**与**运行时生成产物（generated）**两部分。资产通过 Hugging Face 数据集分发，并由 `manifest.lock.json`（版本锁定清单）描述完整的供应链（来源仓库、commit SHA、SHA256 校验、许可证引用）。开发时运行 `npm run assets:install` 即可从 Hugging Face 拉取所需资产。

| 目录 | 用途 |
|---|---|
| `library/` | 源资产目录，含模型、动画、道具、角色及其 catalog 元数据 |
| `generated/` | 运行时生成产物（DCC 导入中间件、原生模型构建输出） |
| `manifest.schema.json` | 资产清单 JSON Schema 规范（v1） |
| `manifest.example.json` | 示例清单，展示 Hugging Face 数据集、许可证、文件映射结构 |

---

## library/ — 源资产目录

### director-characters

| 文件 | 说明 |
|---|---|
| `catalog.json` | 角色目录 v1（Hero 角色，Mixamo 骨骼绑定，FBX 模型） |
| `catalog.v2.json` | 角色目录 v2（由 `tools/scripts/asset-ingest.ts` 生成，含 SHA256、空间包围盒） |
| `models/` | 角色 FBX 模型文件（Standing Idle、Running、Standard Walk） |
| `thumbnails/` | 角色缩略图（hero.svg） |

**关键文件：** `models/Standing Idle.fbx`、`models/Running.fbx`、`models/Standard Walk.fbx`

### flick-stage-props

| 文件 | 说明 |
|---|---|
| `catalog.json` | Flick 公共道具目录（约 8500 条，含源 URL 和缩略图路径） |
| `metadata.i18n.json` | 确定性中文翻译与标签叠加层（由 `generate-flick-metadata.mjs` 生成） |
| `sync-report.json` | 同步结果报告 |
| `texture-audit.json` | 纹理引用审计（记录每个 GLB 的纹理及其本地/来源状态） |
| `NOTICE.md` | 第三方资产镜像声明 |

**19 个分类子目录：** `animals`、`boats`、`buildings`、`cars`、`dungeon`、`furniture`、`guns`、`houses`、`medieval`、`medievalkit`、`nature`、`pirate`、`spaceships`、`tanks`、`trains`、`trees`、`vehicles`、`weapons`、`thumbnails`

每个分类目录包含 GLB 模型文件，`thumbnails/` 包含对应的 WebP 缩略图。

GLB 文件是本地的 Flick CDN 镜像，确保 Director 模型库不会在运行时请求外部资源。可通过 `npm run sync:flick-catalog` 重新同步。

### mixamo-characters

| 文件 | 说明 |
|---|---|
| `catalog.json` | Mixamo 角色目录（约 70+ 个角色，含骨骼绑定信息、65 骨骼 Mixamo 骨架） |
| `models/` | 角色 GLB 模型文件（如 `abe.glb`、`x-bot.glb`、`adam.glb` 等） |
| `thumbnails/` | 角色 WebP 缩略图 |

角色来源为 Adobe Mixamo，由用户本地提供。许可证要求：不得作为独立资产转储公开发布（`redistribution: local-only`）。

### mixamo-animations

| 文件 | 说明 |
|---|---|
| `catalog.json` | Mixamo 动画目录（由 `tools/scripts/package_mixamo_animations.py` 生成，含循环模式、根运动建议、时长、帧数、SHA256） |
| `clips/` | 动画 GLB 剪辑文件（如 `idle.glb`、`walk.glb`、`run.glb`、`jump.glb`、`clap.glb` 等） |

每个动画剪辑包含：标准循环模式（repeat/once）、推荐根运动类型（in-place/root-motion）、源 FPS、帧数、SHA256 校验和。来源为 Adobe Mixamo，用户本地提供。

### model-library

| 文件 | 说明 |
|---|---|
| `README.md` | 内置模型库说明与生成/校验命令 |
| `catalog.v2.json` | 模型目录 v2（由 `asset-ingest.ts` 生成，含中英文名称、分类、标签） |
| `LICENSE` | MIT 许可证 |
| `SHA256SUMS` | 所有 FBX 和 SVG 文件的 SHA256 校验和清单 |

**3 个分类子目录：**

| 分类 | 文件 | 显示名称 |
|---|---|---|
| `便利生活` | `ATM_low.fbx`、`缩略图/` | 自动取款机 |
| `工具配件` | `drill_press_low.fbx`、`wrench_low.fbx`、`缩略图/` | 台钻、扳手 |
| `户外出行` | `backpack_low.fbx`、`thermus_low.fbx`、`deer_skull_low.fbx`、`缩略图/` | 背包、保温瓶、鹿头骨 |

所有模型由 Blender 程序化生成，无第三方网格、纹理、缩略图或权重。使用 Blender 相同主版本可生成字节级一致的文件。

重新生成：
```bash
blender --background --factory-startup \
  --python frontend/director/src/comprehensive/editor/modelLibrary/scripts/generate_builtin_models.py
```

校验：
```bash
blender --background --factory-startup \
  --python frontend/director/src/comprehensive/editor/modelLibrary/scripts/generate_builtin_models.py -- --check
```

### models

| 文件 | 说明 |
|---|---|
| `storyai-open-mannequin.glb` | StoryAI 开放人偶模型（GLB，程序化生成，MIT 许可证） |
| `storyai-open-mannequin.LICENSE.md` | 资产特定 MIT 许可证文件 |

模型由 `tools/scripts/generate_open_mannequin.py` 在 Blender 中程序化生成，不依赖任何第三方几何体或纹理。

---

## generated/ — 运行时生成产物

### dcc-import/

DCC（数字内容创作工具）导入中间件，存储从 Blender 等 DCC 工具导入的中间处理结果。每个子目录以确定性哈希命名。

### native-models/

原生建筑模型构建输出，每个子目录以 `asset-<base64>` 格式命名，对应 `native:<building>:<version>` 资产 ID。

| 子目录 | 对应资产 | 建筑 |
|---|---|---|
| `asset-bmF0aXZlOmJhb2hlZGlhbjp2MQ` | `native:baohedian:v1` | 保和殿 |
| `asset-bmF0aXZlOmppYW90YWlkaWFuOnYx` | `native:jiaotaidian:v1` | 交泰殿 |
| `asset-bmF0aXZlOmppYW9sb3U6djE` | `native:jiaolou:v1` | 角楼 |
| `asset-bmF0aXZlOmt1bm5pbmdnb25nOnYx` | `native:kunninggong:v1` | 坤宁宫 |
| `asset-bmF0aXZlOnd1bWVubG91OnYx` | `native:wumenlou:v1` | 午门楼 |
| `asset-bmF0aXZlOnFpYW5xaW5nZ29uZzp2MQ` | `native:qianqinggong:v1` | 乾清宫 |
| `asset-bmF0aXZlOnNoZW53dW1lbjp2MQ` | `native:shenwumen:v1` | 神武门 |
| `asset-bmF0aXZlOnpob25naGVkaWFuOnYx` | `native:zhonghedian:v1` | 中和殿 |
| `asset-bmF0aXZlOnRhaWhlbWVuOnYx` | `native:taihemen:v1` | 太和门 |
| `asset-bmF0aXZlOnRhaWhlZGlhbjp2MQ` | `native:taihedian:v1` | 太和殿 v1 |
| `asset-bmF0aXZlOnRhaWhlZGlhbjp2Mg` | `native:taihedian:v2` | 太和殿 v2 |
| `asset-bmF0aXZlOnRpcmVuZ2U6djE` | `native:tirenge:v1` | 体仁阁 |

还包括 Mixamo 角色和通用资产的构建输出（`asset-bWl4YW1v:*`、`asset-YXNzZXRf*`）。

---

## Manifest 清单契约

`manifest.schema.json` 定义了资产清单的 JSON Schema（v1），包含：

- **repositories**：Hugging Face 数据集仓库（`repoId`、`revision` 为不可变 commit SHA）
- **licenses**：许可证声明（`id`、`name`、`spdx`、`redistribution` 级别）
- **files**：文件映射（`huggingface` 或 `user-provided` 来源、`localPath`、`sha256`、`size`、`mediaType`、`licenseRef`）

`manifest.example.json` 是完整的示例清单，展示了：
- 公开的 Hugging Face 数据集资产（如 StoryAI Open Mannequin）
- 用户本地提供的 Mixamo 资产（角色、动画）
- 两种来源类型（`huggingface` 与 `user-provided`）的完整字段

---

## 常用命令

| 命令 | 说明 |
|---|---|
| `npm run assets:status` | 检查资产状态（哪些已安装、哪些缺失） |
| `npm run assets:install` | 从 Hugging Face 安装所需资产 |
| `npm run assets:verify` | 校验已安装资产的 SHA256 |
| `npm run assets:release-check` | 发布前检查资产完整性 |
| `npm run test:assets` | 运行资产相关测试（`run-local-asset-tests.mjs`） |
| `npm run sync:flick-catalog` | 同步 Flick 道具目录到本地镜像 |