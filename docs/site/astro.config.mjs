import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightThemeNova from "starlight-theme-nova";

const page = (label, slug, zhLabel) => ({
  label,
  slug,
  translations: { "zh-CN": zhLabel },
});

const group = (label, zhLabel, items, options = {}) => ({
  label,
  translations: { "zh-CN": zhLabel },
  items,
  ...options,
});

export default defineConfig({
  // Astro needs an absolute origin for canonical URLs and sitemap output. Deployments can
  // override this without changing the checked-in local documentation workflow.
  site: process.env.DIRECTOR_DOCS_SITE_URL ?? "http://127.0.0.1:4321",
  integrations: [
    starlight({
      title: "Director Docs",
      description:
        "Documentation for Director, an agent-native 3D production desk for staging, cameras, animation, and verified AI-agent authoring.",
      favicon: "/favicon.svg",
      defaultLocale: "root",
      locales: {
        root: { label: "English", lang: "en" },
        zh: { label: "简体中文", lang: "zh-CN" },
      },
      customCss: ["./src/styles/custom.css", "./src/styles/splash.css"],
      disable404Route: true,
      plugins: [starlightThemeNova()],
      sidebar: [
        group("Home", "首页", [page("Director", "index", "Director")]),
        group("Getting Started", "快速开始", [
          page("Overview", "getting-started", "概览"),
          page("Install & Run", "getting-started/install", "安装与运行"),
          page("Quick Start", "getting-started/quick-start", "快速上手"),
        ]),
        group("Concepts", "核心概念", [
          page("Agent-native Production", "concepts/agent-native-production", "Agent-native 制片"),
          page("Glossary", "concepts/glossary", "术语表"),
        ]),
        group("Tutorials", "教程", [page("End-to-end Verified Shot", "tutorials/verified-shot", "端到端可验证镜头")]),
        group("3D Editor", "3D 编辑器", [
          page("Overview", "editor", "概览"),
          page("Scenes & Assets", "editor/scenes-and-assets", "场景与资产"),
          page("Characters, Motion & IK", "editor/characters", "人物、动作与 IK"),
          page("Cameras", "editor/cameras", "相机"),
          page("Animation & Timeline", "editor/animation", "动画与时间线"),
          page("Storyboard & Recording", "editor/storyboard-and-recording", "分镜与录制"),
          page("Reference Reconstruction", "editor/reference-reconstruction", "参考图重建"),
          page("Procedural Modeling", "editor/procedural-modeling", "程序化建模"),
          page("Canvas & Video Editor", "editor/canvas-video", "画布与视频编辑器"),
          page("Gallery", "editor/gallery", "Gallery 媒体库"),
          page("UI Icon Reference", "editor/ui-icons", "界面图标对照表"),
        ]),
        group("Agent Control", "Agent 控制", [
          page("Overview", "agents", "概览"),
          page("Agent Workbench", "agents/workbench", "Agent 工作台"),
          page("Asset Discovery", "agents/assets", "资产发现"),
          page("Multi-Agent Production", "agents/multi-agent", "多 Agent 制片"),
          page("Canvas & Video Agents", "agents/creative-workspaces", "画布与视频 Agent"),
          page("MCP", "agents/mcp", "MCP"),
          page("HTTP, CLI & Browser", "agents/control-surfaces", "HTTP、CLI 与浏览器"),
        ]),
        group("Pipelines", "生成管线", [
          page("Overview", "pipelines", "概览"),
          page("Pipeline & System Design", "pipelines/system-design", "管线与系统设计"),
          page("Characters & Motion", "pipelines/characters-and-motion", "角色与动作"),
          page("White-box to Video", "pipelines/video-generation", "白模到视频"),
          page("Interchange & DCC Handoff", "pipelines/interchange", "交换格式与 DCC 交接"),
        ]),
        group("Architecture", "架构", [
          page("Overview", "architecture", "概览"),
          page("Control Plane and Python Workers", "architecture/control-plane", "控制面与 Python Worker"),
          page("Data Models", "architecture/data-models", "数据模型"),
          page("Persistence & Sync", "architecture/persistence", "持久化与同步"),
          page("Server Import Boundaries", "architecture/server-import-boundaries", "Server 导入边界"),
        ]),
        group("Reference", "参考", [
          page("Feature Status", "reference/feature-status", "功能状态"),
          page("Reference Integration Matrix", "reference/reference-integration-matrix", "参考项目集成矩阵"),
          page("Configuration", "reference/configuration", "配置"),
          page("Production Deployment Checklist", "reference/production-deployment", "生产部署清单"),
          page("Gateway HTTP API", "reference/http-api", "Gateway HTTP API"),
          page("Command Map", "reference/commands", "命令地图"),
          page("Repository Structure", "reference/repository-structure", "仓库结构"),
        ]),
        group("Common Issues", "常见问题", [page("Troubleshooting", "troubleshooting", "故障排查")]),
        group("Development", "开发", [
          page("Contributing & Verification", "development", "贡献与验证"),
          page("Open-source Assets", "development/open-source-assets", "开源资产"),
        ]),
        group(
          "Engineering Records (contributors)",
          "工程记录（贡献者）",
          [
            page("Overview", "engineering", "总览"),
            group("Architecture", "架构", [
              page("Control Plane", "engineering/architecture/control-plane", "控制面"),
              page("Server Import Boundaries", "engineering/architecture/server-import-boundaries", "Server 导入边界"),
            ]),
            group("Architecture Decisions", "架构决策", [
              page("Overview", "engineering/adr", "总览"),
              page("ProductionGraph", "engineering/adr/0001-production-graph", "ProductionGraph"),
              page("Durable Production Jobs", "engineering/adr/0002-durable-production-jobs", "持久化 ProductionJob"),
              page("Import, Export & Receipts", "engineering/adr/0003-import-export-receipts", "导入、导出与回执"),
              page("A2A Gateway Spike", "engineering/adr/0004-a2a-gateway-spike", "A2A gateway spike"),
            ]),
            page("Agent-native Operator Guide", "engineering/agent_native_operator_guide", "Agent-native 操作指南"),
            page("Agent-Native Roadmap", "engineering/agent_native_roadmap", "Agent-Native 优化路线图"),
            page("Blender Bridge", "engineering/blender_bridge", "Blender Bridge"),
            page("Character Assets & Motion", "engineering/character_asset_motion_pipeline", "角色资产与动作"),
            page("Competitive Union Architecture", "engineering/competitive_union_architecture", "竞品能力并集架构"),
            page("Creative Production Parity", "engineering/creative-production-parity", "创作生产对齐"),
            page("CoStage Native Integration", "engineering/costage_native_integration", "CoStage 原生集成"),
            page("Multi-DCC Integration", "engineering/multi_dcc_integration", "多 DCC 集成"),
            page("Pipeline Implementation Roadmap", "engineering/pipeline_implementation_roadmap", "管线实施路线图"),
            page("Pipeline System Design", "engineering/pipeline_system_design", "管线系统设计"),
            page("Reference Reuse Ledger", "engineering/reference_reuse_ledger", "参考复用台账"),
            page("Replication Spec", "engineering/replication_spec", "复刻规范"),
            page("Third-party Notices", "engineering/third_party_notices", "第三方声明"),
            page("UI/Agent Parity Inventory", "engineering/ui-agent-parity-inventory", "UI/Agent 对等清单"),
            page("White-box to Video", "engineering/video_gen_pipeline", "白模到视频"),
          ],
          { collapsed: true },
        ),
        group(
          "Research (contributors)",
          "研究（贡献者）",
          [
            page("Evaluation Protocol", "research", "评测协议"),
            page("Competitive Union", "research/competitive-union", "竞品能力并集"),
            page(
              "Harness Game vs Skill-based Codegen",
              "research/game-harness-vs-codegen",
              "Harness 游戏 vs 技能式代码生成",
            ),
            page(
              "Agent-Native Architecture Assessment",
              "research/agent-native-architecture-assessment",
              "Agent-Native 架构符合性评估",
            ),
          ],
          { collapsed: true },
        ),
      ],
      tableOfContents: {
        minHeadingLevel: 2,
        maxHeadingLevel: 3,
      },
    }),
  ],
});
