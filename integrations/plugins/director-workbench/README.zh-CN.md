# Director Workbench — 可移植 Agent/MCP 插件

> 语言：**中文** · [English](README.md)

`integrations/plugins/director-workbench/` 是可移植的 Agent/MCP 插件，基于与
Director 工作台相同的合约构建。它为 coding agent 提供结构化的 3D Stage、Canvas
生产 DAG、Video Editor 时间线控制能力。

## 文件级清单

| 路径 | 中文用途 |
| --- | --- |
| `.codex-plugin/plugin.json` | Codex CLI 插件清单：名称 `director-workbench` v0.1.0，声明能力（Interactive、Write），默认提示词，指向 skills 目录与 MCP 服务器配置。 |
| `.mcp.json` | MCP 服务器配置：定义 `director-workbench` 服务器，通过 `node ./mcp/server.mjs` 启动，环境变量 `STAGE_GATEWAY_URL=http://127.0.0.1:8787`。 |
| `mcp/server.mjs` | **生成文件**（~97k 行），构建产物：单文件 bundle 的 MCP 服务器，内含完整依赖（ajv 等）。`npm run build:mcp-plugin` 构建。**勿手改。** |
| `skills/director-workbench/SKILL.md` | 技能主指令（138 行）：默认工作循环（discover → observe → atomic mutate → observe → audit → preview/deliver）、3D Stage 操作规范（author/execute/execute_batch）、大场景处理、并发限制、幂等恢复规则。 |
| `skills/director-workbench/agents/openai.yaml` | OpenAI Agent 配置：声明 MCP 工具依赖 `director-workbench`（stdio transport），允许隐式调用。 |
| `skills/director-workbench/references/operations.md` | 操作示例参考（652 行）：observe、describe、catalog、author、capture、audit、execute_batch、deliver、shot_package 等每种操作的最短可用请求形状与说明。 |

## 技能结构

```
skills/director-workbench/
├── SKILL.md                  # 主指令
├── agents/
│   └── openai.yaml           # OpenAI Agent 集成配置
└── references/
    └── operations.md          # 操作参考
```

技能规范源位于 `.claude/skills/director-workbench/`。此目录下的副本由
`npm run sync:skills` 同步生成。**请编辑规范源，而非此处的副本。**

## MCP 服务器

`mcp/server.mjs` 是构建产物：`npm run build:mcp-plugin` 将 MCP 服务器及其所有依赖
打包为单个自包含文件。该文件**不应手动编辑**——所有更改应在源码中进行并重新构建。

MCP 服务器启动时连接 `STAGE_GATEWAY_URL`（默认 `http://127.0.0.1:8787`），暴露三个工具集：

- `director_workbench` — Stage、生成、作业
- `director_creative` — Canvas、Video、Gallery、交换、协作
- `director_dcc` — Blender/DCC 交接

## 运行

```bash
npm run build:mcp-plugin      # 构建可移植 MCP 插件
npm run sync:skills           # 从规范源同步技能
npm run validate:agent-plugin # 校验 Agent 插件集成
```