---
title: 开发指南
description: 配置 Director 开发环境、遵守运行时边界、选择测试并准备可审查的变更。
---

## 支持的工具链

- **Node.js 22** 是仓库和 CI 的统一基线。
- **npm 10+** 用于安装和运行 TypeScript/React workspace。
- 交互式 Stage 验证需要支持 WebGL 2 的浏览器。
- Python、CUDA、模型权重和 Blender 都是隔离集成中的可选依赖。

使用 lockfile 进行可复现安装：

```bash
npm ci
npm --prefix docs/site ci
```

## 日常命令

| 命令                   | 用途                                                     |
| ---------------------- | -------------------------------------------------------- |
| `npm run dev`          | 启动 Vite UI 与 TypeScript Gateway。                     |
| `npm run dev:ui`       | 只启动浏览器 UI。                                        |
| `npm run dev:gateway`  | 只以 watch 模式启动 Gateway。                            |
| `npm run docs:dev`     | 启动 Starlight 文档站。                                  |
| `npm run lint`         | 运行 ESLint 与 server import-boundary 审计。             |
| `npm run format:check` | 检查格式，不重写文件。                                   |
| `npm run build`        | 类型检查、构建 UI、检查 chunk budget 并打包 MCP server。 |
| `npm test`             | 运行完整 Vitest 测试。                                   |
| `npm run docs:build`   | 构建中英文文档并验证 route 与 Markdown/MDX。             |

`.github/workflows/ci.yml` 使用 Node 22 执行 `npm ci --ignore-scripts`，随后运行 lint、格式检查、
构建和完整测试。每次文档变更都应在本地执行 `npm run docs:build`；如果文档要成为强制合并关卡，
还应将该命令加入 CI。

## 运行时边界

Director 包含三个运行平面：

```text
浏览器执行面（React/R3F、编辑器状态、WebGL capture）
  → TypeScript 控制面（Gateway、Agent session、job、DCC 编排）
  → Python 推理 Worker（模型常驻与 GPU 执行）
```

`tools/scripts/checkServerImportBoundaries.ts` 强制执行以下规则：

- `backend/gateway/**` 不得导入 React、React Three Fiber、Zustand、Xterm、编辑器 runtime 模块或浏览器全局变量。
- 共享 wire contract 放在 `packages/protocol/src/**`；纯 Stage/Agent contract 和 editor schema 只能通过审计后的 allowlist 导入。
- Python Worker 不直接修改浏览器或 Gateway 状态，只接收经过校验的 job 并返回不可变 result descriptor。
- 审计目前恰好有 **4 个临时迁移例外**。不要扩大或复制这些例外；修改相关路径时应尽量收窄或删除，
  并同步更新原因和测试。

## 如何选择测试

先运行能够证明行为的最小测试，再根据变更跨越的边界扩大范围。

Vite、Vitest、ESLint、TypeScript 与 PostCSS 配置在 `tools/`。优先使用 `npm run …` 脚本；它们会显式传入 `--config`。

```bash
# 迭代时运行单个文件
npx vitest run --config tools/vitest.config.ts path/to/file.test.ts

# Agent 与紧凑 Stage contract
npm run test:agent

# 完整编辑器、workspace、runtime 与媒体
npm run test:comprehensive

# 交付前运行全仓库
npm test
```

如果变更跨越浏览器/Gateway、MCP/HTTP、持久化、archive、interchange、DCC 或 provider 边界，
必须使用 integration test。视觉或 R3F 行为还需要渲染或浏览器检查；只验证状态的 unit test 不能证明像素正确。

可选 LTX-2.3 的 spawn 测试在 TypeScript 套件里。默认 Node 测试不能下载权重或要求 GPU。

## 文档契约

- 英文页和中文页必须在同一个 PR 中修改。
- 标题、表格、状态、命令、版本、数量和支持边界必须保持一致。
- 使用[功能状态](/zh/reference/feature-status/)作为唯一状态词汇；指南和工程记录不能引入第五种状态或自行提升功能状态。
- 操作步骤放在 `getting-started`、`editor`、`agents` 或 `pipelines`；schema、ADR、provenance 与实现理由放在 `engineering`。
- 对修改的 Markdown 运行 Prettier，并以 `npm run docs:build` 完成验证。

## Pull request checklist

- [ ] 明确变更范围及受影响的运行平面。
- [ ] 不包含无关用户修改或生成文件。
- [ ] 运行时校验和类型仍来自同一个 contract。
- [ ] 新的外部输入具有边界校验与失败测试。
- [ ] 在适用时覆盖持久化、Undo、revision/fingerprint 和 idempotency。
- [ ] Agent 可以发现并验证新增行为，不依赖 DOM 坐标。
- [ ] 聚焦测试通过，必要的跨边界 integration test 已添加。
- [ ] `npm run lint`、`npm run format:check`、`npm run build` 与 `npm test` 通过。
- [ ] 中英文文档已同步，且 `npm run docs:build` 通过。
- [ ] 能力或来源发生变化时，已更新[功能状态](/zh/reference/feature-status/)与第三方声明。
