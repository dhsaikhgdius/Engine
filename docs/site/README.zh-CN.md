# 文档站

> 语言：**中文** · [English](README.md)

Director 文档站基于 **Astro 7** 与 **Starlight** 构建，采用 **Nova 主题**，提供 **English · 简体中文** 双语内容。它是面向操作者与集成者的产品使用指南，不是营销镜像或路线图汇总。

---

## 配置文件

| 路径 | 中文用途 |
|---|---|
| `astro.config.mjs` | Astro/Starlight 主配置：站点元信息、中英双语 locale、侧边栏结构、Nova 主题与自定义 CSS 注册 |
| `package.json` | 依赖声明与脚本：`astro`、`@astrojs/starlight`、`starlight-theme-nova`、`sharp` |
| `postcss.config.mjs` | PostCSS 仅含空插件，保持文档站独立于 `tools/tailwind.config.js` |
| `src/content.config.ts` | Starlight 内容集合：`docsLoader` + `docsSchema` |
| `src/content/i18n/zh-CN.json` | Starlight 简体中文 UI 翻译词条 |

---

## `src/` 目录结构

| 路径 | 中文用途 |
|---|---|
| `src/assets/` | 首页用 Hero 图片（`director-hero-atmosphere.png` 等） |
| `src/components/` | 自定义 Astro 组件：`DirectorHome.astro`（首页布局）、`RepositoryStructure.astro`（仓库结构图）、TypeScript 辅助模块 |
| `src/pages/` | 自定义路由页面：`404.astro`（自定义 404 页） |
| `src/styles/` | 全局样式：`custom.css`（站点定制）、`splash.css`（启动屏）、`directorHome.css`（首页样式） |
| `src/content/docs/` | 所有 Markdown/MDX 文档页面，按语言与主题分目录 |
| `src/content/i18n/` | Starlight 内置 UI 翻译 |

---

## 文档内容目录

### 根级页面

| 路径 | 中文用途 |
|---|---|
| `index.mdx` | 文档站首页（简版 splash；完整营销首页在 `src/home-backup/`） |

### 快速开始

| 路径 | 中文用途 |
|---|---|
| `getting-started/index.md` | 入门概览 |
| `getting-started/install.md` | 安装与运行指南 |
| `getting-started/quick-start.md` | 快速上手指南 |

### 核心概念

| 路径 | 中文用途 |
|---|---|
| `concepts/agent-native-production.md` | Agent-native 制片概念说明 |
| `concepts/glossary.md` | 术语表 |

### 教程

| 路径 | 中文用途 |
|---|---|
| `tutorials/verified-shot.md` | 端到端可验证镜头教程 |

### 3D 编辑器

| 路径 | 中文用途 |
|---|---|
| `editor/index.md` | 编辑器总览 |
| `editor/scenes-and-assets.md` | 场景与资产管理 |
| `editor/characters.md` | 人物、动作与 IK |
| `editor/cameras.md` | 相机操作 |
| `editor/animation.md` | 动画与时间线 |
| `editor/storyboard-and-recording.md` | 分镜与录制 |
| `editor/reference-reconstruction.md` | 参考图重建 |
| `editor/procedural-modeling.md` | 程序化建模 |
| `editor/canvas-video.md` | 画布与视频编辑器 |
| `editor/gallery.md` | Gallery 媒体库 |
| `editor/ui-icons.md` | 界面图标对照表 |

### Agent 控制

| 路径 | 中文用途 |
|---|---|
| `agents/index.md` | Agent 控制总览 |
| `agents/workbench.md` | Agent 工作台 |
| `agents/assets.md` | 资产发现 |
| `agents/multi-agent.md` | 多 Agent 制片 |
| `agents/creative-workspaces.md` | 画布与视频 Agent |
| `agents/mcp.md` | MCP 协议集成 |
| `agents/control-surfaces.md` | HTTP、CLI 与浏览器控制面 |

### 生成管线

| 路径 | 中文用途 |
|---|---|
| `pipelines/index.md` | 管线总览 |
| `pipelines/system-design.md` | 管线与系统设计 |
| `pipelines/characters-and-motion.md` | 角色与动作生成 |
| `pipelines/video-generation.md` | 白模到视频生成 |
| `pipelines/interchange.md` | 交换格式与 DCC 交接 |

### 架构

| 路径 | 中文用途 |
|---|---|
| `architecture/index.md` | 架构总览 |
| `architecture/control-plane.md` | 控制面与 Python Worker |
| `architecture/data-models.md` | 数据模型 |
| `architecture/persistence.md` | 持久化与同步 |
| `architecture/server-import-boundaries.md` | Server 导入边界 |

### 参考

| 路径 | 中文用途 |
|---|---|
| `reference/feature-status.md` | 功能状态矩阵（操作者面向的权威来源） |
| `reference/reference-integration-matrix.md` | 参考项目集成矩阵 |
| `reference/configuration.md` | 配置参考 |
| `reference/http-api.md` | Gateway HTTP API 参考 |
| `reference/commands.md` | 命令地图 |
| `reference/repository-structure.mdx` | 仓库结构说明 |

### 常见问题

| 路径 | 中文用途 |
|---|---|
| `troubleshooting/index.md` | 故障排查 |

### 开发

| 路径 | 中文用途 |
|---|---|
| `development/index.md` | 贡献与验证指南 |
| `development/open-source-assets.md` | 开源资产管理 |

### 工程记录

| 路径 | 中文用途 |
|---|---|
| `engineering/index.md` | 工程记录总览 |
| `engineering/AGENT_NATIVE_OPERATOR_GUIDE.md` | Agent-native 操作指南 |
| `engineering/AGENT_NATIVE_ROADMAP.md` | Agent-native 优化路线图 |
| `engineering/BLENDER_BRIDGE.md` | Blender Bridge 集成 |
| `engineering/CHARACTER_ASSET_MOTION_PIPELINE.md` | 角色资产与动作管线 |
| `engineering/COMPETITIVE_UNION_ARCHITECTURE.md` | 竞品能力并集架构 |
| `engineering/COSTAGE_NATIVE_INTEGRATION.md` | CoStage 原生集成 |
| `engineering/creative-production-parity.md` | 创作生产对齐 |
| `engineering/MULTI_DCC_INTEGRATION.md` | 多 DCC 集成 |
| `engineering/PIPELINE_IMPLEMENTATION_ROADMAP.md` | 管线实施路线图 |
| `engineering/PIPELINE_SYSTEM_DESIGN.md` | 管线系统设计 |
| `engineering/REFERENCE_REUSE_LEDGER.md` | 参考复用台账 |
| `engineering/REPLICATION_SPEC.md` | 复刻规范 |
| `engineering/THIRD_PARTY_NOTICES.md` | 第三方声明 |
| `engineering/VIDEO_GEN_PIPELINE.md` | 白模到视频管线 |
| `engineering/architecture/control-plane.md` | 工程级控制面架构 |
| `engineering/architecture/server-import-boundaries.md` | 工程级 Server 导入边界 |
| `engineering/adr/index.md` | 架构决策记录总览 |
| `engineering/adr/0001-production-graph.md` | ADR 1: ProductionGraph |
| `engineering/adr/0002-durable-production-jobs.md` | ADR 2: 持久化 ProductionJob |
| `engineering/adr/0003-import-export-receipts.md` | ADR 3: 导入、导出与回执 |

### 研究

| 路径 | 中文用途 |
|---|---|
| `research/index.md` | 评测协议 |
| `research/competitive-union.md` | 竞品能力并集 |
| `research/agent-native-architecture-assessment.md` | Agent-native 架构符合性评估 |

### 简体中文翻译（`zh/`）

`zh/` 目录结构与英文目录完全镜像，包含上述所有页面的简体中文翻译。每个英文页面都有对应的 `zh/` 翻译，两者需同步更新。

---

## 本地运行

从仓库根目录执行：

```bash
npm --prefix docs/site install
npm run docs:dev        # 启动开发服务器 → http://127.0.0.1:4321
npm run docs:build      # 构建生产版本
npm run docs:preview    # 预览构建产物（端口 4321）
```

在 `docs/site/` 目录内也可直接使用：

```bash
npm run dev             # astro dev --host 127.0.0.1 --port 4321
npm run build           # astro build
npm run preview         # astro preview --host 127.0.0.1 --port 4321
```

`docs:dev` 是实时预览：全站搜索要到 `docs:build` / `docs:preview` 才可用，抓取页面时也可能
混入 Astro 开发工具栏文案。生产构建不包含该工具栏。

部署时设置 `DIRECTOR_DOCS_SITE_URL` 为实际 HTTPS 地址。

## 撰写规则

1. 英文页面与对应 `zh/` 翻译需在同一变更中更新。
2. 命令与载荷需对照运行时 schema 验证，不得沿用过期示例。
3. 功能成熟度仅使用 `Implemented`、`Experimental`、`Limited`、`Planned` 四级。
4. 明确声明格式/供应商子集。"Supported" 不得暗示无损全格式往返。
5. 操作者页面链接到工程契约，避免重复长段实现细节。
6. 修改后运行 Prettier 并执行 `npm run docs:build` 验证。