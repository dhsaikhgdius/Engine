# 工具配置

> 语言：**中文** · [English](README.md)

Vite、Vitest、ESLint、TypeScript 与 PostCSS/Tailwind 配置放在这里，仓库根目录只保留 npm
workspace 必需的 `package.json` 和 `package-lock.json`。这两份必须留在根目录：npm workspaces
从那里解析依赖与工作区。

`npm run …` 脚本会显式传入 `--config` / `-p`。在仓库根直接跑 `npx vite`、`npx vitest`、
`npx eslint` 或 `npx playwright test` 不会自动发现这些文件。

## 配置文件

| 路径 | 用途 | 由谁调用 |
| --- | --- | --- |
| `vite.config.ts` | Director UI 开发服务器与生产打包。`root` 为 `frontend/director/`；产物在仓库根 `dist/`。`css.postcss` 指向本目录。 | `npm run dev:ui`、`npm run build`、`npm run preview` |
| `vitest.config.ts` | jsdom Vitest 运行器。`root` 为仓库根，以便同时收集前端、网关与 packages 测试。排除 `tools/e2e/`、`.external/`、`.runtime/` 与 `vendor/`。 | `npm test`、`npm run test:core`、`npm run test:agent`、`npm run test:comprehensive` |
| `vitest.setup.ts` | jest-dom matcher，以及内存版 `localStorage`（Node 25 自带 shim 不完整）。 | 由 `vitest.config.ts` 加载 |
| `eslint.config.js` | 带类型的 ESLint，以及前端 / 网关 / protocol 的 import 边界。`basePath` 为仓库根。 | `npm run lint` |
| `tsconfig.json` | 规范的 `tsc --noEmit` 工程。源码树各留一行 `extends`，IDE 从源文件向上查找时能落到这里：`frontend/director/tsconfig.json`、`backend/gateway/tsconfig.json`、`packages/tsconfig.json`。 | `npm run build` |
| `postcss.config.js` | Director UI 的 Tailwind + Autoprefixer。 | Vite（`css.postcss` → 本目录） |
| `tailwind.config.js` | 扫描 `frontend/director/` 的 Tailwind content。由 `postcss.config.js` 显式引用，不会从仓库根自动发现。 | PostCSS |

文档站有自己的空 `docs/site/postcss.config.mjs`，不会继承这套 Tailwind 管线。

## 相邻目录

| 路径 | 用途 |
| --- | --- |
| [`scripts/`](./scripts/README.md) | 仓库自动化、本地启动器、检查与可复现工具 |
| [`e2e/`](./e2e/README.md) | Playwright 端到端测试（`npm run test:e2e`；配置为 `e2e/playwright.config.ts`） |
| [`evals/`](./evals/README.md) | Agent 黄金任务评测（`npm run eval`） |

## 指定配置的命令

优先使用 `npm run …` 脚本。需要在仓库根临时跑一次时：

```bash
npx vite --config tools/vite.config.ts
npx vitest run --config tools/vitest.config.ts <path>
npx eslint --config tools/eslint.config.js <path>
npx tsc --noEmit -p tools/tsconfig.json
npx playwright test --config tools/e2e/playwright.config.ts
```
