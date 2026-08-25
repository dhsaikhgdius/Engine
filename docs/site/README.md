# Documentation Site

> Languages: **English** · [中文](README.zh-CN.md)

The Director documentation site is built with **Astro 7** + **Starlight** and the **Nova theme**, delivering bilingual content in **English · 简体中文**. It is the operator and integrator guide for the product—not a marketing mirror or a roadmap dump.

---

## Configuration Files

| Path | Purpose |
|---|---|
| `astro.config.mjs` | Astro/Starlight config: site metadata, en/zh-CN locales, sidebar structure, Nova theme & custom CSS |
| `package.json` | Dependencies & scripts: astro, starlight, nova theme, sharp |
| `postcss.config.mjs` | PostCSS with empty plugins; keeps the doc site isolated from `tools/tailwind.config.js` |
| `src/content.config.ts` | Starlight content collection: docsLoader + docsSchema |
| `src/content/i18n/zh-CN.json` | Starlight Simplified Chinese UI translation strings |

---

## `src/` Directory Layout

| Path | Purpose |
|---|---|
| `src/assets/` | Hero images for the home page |
| `src/components/` | Custom Astro components: DirectorHome.astro (home layout), RepositoryStructure.astro (repo map), TS helpers |
| `src/pages/` | Custom route pages: 404.astro (custom 404 page) |
| `src/styles/` | Global styles: custom.css (site overrides), splash.css (splash screen), directorHome.css (home page) |
| `src/content/docs/` | All Markdown/MDX doc pages, organized by language & topic |
| `src/content/i18n/` | Starlight built-in UI translations |

---

## Documentation Content Directories

### Root-level Pages

| Path | Purpose |
|---|---|
| `index.mdx` | Documentation home page (simple splash; full marketing homepage is in `src/home-backup/`) |

### Getting Started

| Path | Purpose |
|---|---|
| `getting-started/index.md` | Getting started overview |
| `getting-started/install.md` | Install & run guide |
| `getting-started/quick-start.md` | Quick start walkthrough |

### Concepts

| Path | Purpose |
|---|---|
| `concepts/agent-native-production.md` | Agent-native production concept |
| `concepts/glossary.md` | Glossary of terms |

### Tutorials

| Path | Purpose |
|---|---|
| `tutorials/verified-shot.md` | End-to-end verified shot tutorial |

### 3D Editor

| Path | Purpose |
|---|---|
| `editor/index.md` | Editor overview |
| `editor/scenes-and-assets.md` | Scenes & assets |
| `editor/characters.md` | Characters, motion & IK |
| `editor/cameras.md` | Cameras |
| `editor/animation.md` | Animation & timeline |
| `editor/storyboard-and-recording.md` | Storyboard & recording |
| `editor/reference-reconstruction.md` | Reference reconstruction |
| `editor/procedural-modeling.md` | Procedural modeling |
| `editor/canvas-video.md` | Canvas & video editor |
| `editor/gallery.md` | Gallery media library |
| `editor/ui-icons.md` | UI icon reference |

### Agent Control

| Path | Purpose |
|---|---|
| `agents/index.md` | Agent control overview |
| `agents/workbench.md` | Agent workbench |
| `agents/assets.md` | Asset discovery |
| `agents/multi-agent.md` | Multi-agent production |
| `agents/creative-workspaces.md` | Canvas & video agents |
| `agents/mcp.md` | MCP integration |
| `agents/control-surfaces.md` | HTTP, CLI & browser control surfaces |

### Pipelines

| Path | Purpose |
|---|---|
| `pipelines/index.md` | Pipelines overview |
| `pipelines/system-design.md` | Pipeline & system design |
| `pipelines/characters-and-motion.md` | Characters & motion |
| `pipelines/video-generation.md` | White-box to video |
| `pipelines/interchange.md` | Interchange & DCC handoff |

### Architecture

| Path | Purpose |
|---|---|
| `architecture/index.md` | Architecture overview |
| `architecture/control-plane.md` | Control plane & Python workers |
| `architecture/data-models.md` | Data models |
| `architecture/persistence.md` | Persistence & sync |
| `architecture/server-import-boundaries.md` | Server import boundaries |

### Reference

| Path | Purpose |
|---|---|
| `reference/feature-status.md` | Feature status matrix (operator-facing source of truth) |
| `reference/reference-integration-matrix.md` | Reference integration matrix |
| `reference/configuration.md` | Configuration reference |
| `reference/http-api.md` | Gateway HTTP API reference |
| `reference/commands.md` | Command map |
| `reference/repository-structure.mdx` | Repository structure |

### Common Issues

| Path | Purpose |
|---|---|
| `troubleshooting/index.md` | Troubleshooting |

### Development

| Path | Purpose |
|---|---|
| `development/index.md` | Contributing & verification |
| `development/open-source-assets.md` | Open-source assets |

### Engineering Records

| Path | Purpose |
|---|---|
| `engineering/index.md` | Engineering records overview |
| `engineering/AGENT_NATIVE_OPERATOR_GUIDE.md` | Agent-native operator guide |
| `engineering/AGENT_NATIVE_ROADMAP.md` | Agent-native roadmap |
| `engineering/BLENDER_BRIDGE.md` | Blender bridge integration |
| `engineering/CHARACTER_ASSET_MOTION_PIPELINE.md` | Character assets & motion pipeline |
| `engineering/COMPETITIVE_UNION_ARCHITECTURE.md` | Competitive union architecture |
| `engineering/COSTAGE_NATIVE_INTEGRATION.md` | CoStage native integration |
| `engineering/creative-production-parity.md` | Creative production parity |
| `engineering/MULTI_DCC_INTEGRATION.md` | Multi-DCC integration |
| `engineering/PIPELINE_IMPLEMENTATION_ROADMAP.md` | Pipeline implementation roadmap |
| `engineering/PIPELINE_SYSTEM_DESIGN.md` | Pipeline system design |
| `engineering/REFERENCE_REUSE_LEDGER.md` | Reference reuse ledger |
| `engineering/REPLICATION_SPEC.md` | Replication spec |
| `engineering/RESEARCH_PORTAL.md` | Research portal |
| `engineering/THIRD_PARTY_NOTICES.md` | Third-party notices |
| `engineering/VIDEO_GEN_PIPELINE.md` | White-box to video pipeline |
| `engineering/architecture/control-plane.md` | Engineering-level control plane architecture |
| `engineering/architecture/server-import-boundaries.md` | Engineering-level server import boundaries |
| `engineering/adr/index.md` | ADR overview |
| `engineering/adr/0001-production-graph.md` | ADR 1: ProductionGraph |
| `engineering/adr/0002-durable-production-jobs.md` | ADR 2: Durable production jobs |
| `engineering/adr/0003-import-export-receipts.md` | ADR 3: Import, export & receipts |

### Research

| Path | Purpose |
|---|---|
| `research/index.md` | Evaluation protocol |
| `research/competitive-union.md` | Competitive union |
| `research/agent-native-architecture-assessment.md` | Agent-native architecture assessment |

### Simplified Chinese Translations (`zh/`)

The `zh/` directory mirrors the English directory structure exactly, containing Simplified Chinese translations for every page above. Every English page has a corresponding `zh/` translation; both must be updated together.

---

## Local Development

From the repository root:

```bash
npm --prefix docs/site install
npm run docs:dev        # 启动开发服务器 → http://127.0.0.1:4321
npm run docs:build      # 构建生产版本
npm run docs:preview    # 预览构建产物（端口 4321）
```

Inside the `docs/site/` directory you can also run directly:

```bash
npm run dev             # astro dev --host 127.0.0.1 --port 4321
npm run build           # astro build
npm run preview         # astro preview --host 127.0.0.1 --port 4321
```

`docs:dev` is a live preview: site search is disabled until `docs:build` / `docs:preview`, and
Astro's development toolbar can appear in fetched page text. Production builds do not include
that toolbar.

Set `DIRECTOR_DOCS_SITE_URL` to the actual HTTPS origin before deploying.

## Authoring Rules

1. Update the English page and its `zh/` counterpart in one change.
2. Verify commands and payloads against runtime schemas; never copy a stale example forward.
3. Use only `Implemented`, `Experimental`, `Limited`, or `Planned` for feature maturity.
4. State format/provider subsets explicitly. "Supported" must not imply a lossless universal round trip.
5. Link operator pages to engineering contracts instead of duplicating long implementation sections.
6. Run Prettier on changed Markdown/MDX and finish with `npm run docs:build`.