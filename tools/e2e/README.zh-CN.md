# 端到端测试

> 语言：**中文** · [English](README.md)

基于 Playwright 的端到端测试套件，覆盖 Director 视频编辑器与 3D 舞台的关键用户流程。
测试在无头 Chromium 中运行，通过 Vite 开发服务器提供纯前端应用（无需网关/后端）。
使用 `prefers-reduced-motion: reduce` 减少动画抖动。

## 运行

```sh
npm run test:e2e
```

该命令运行 `playwright test --config tools/e2e/playwright.config.ts`。Playwright 不会从仓库根自动发现该文件。

要求：安装仓库依赖，并下载 Playwright Chromium（`npx playwright install chromium`）。

## 测试用例

| 文件 | 中文用途 |
|------|----------|
| `enter-video-editor.spec.ts` | 从首页通过"视频编辑器"标签进入，验证空时间线出现 |
| `media-import.spec.ts` | 导入 PNG 素材，通过 "+" 按钮添加到时间线，验证预览画面渲染 |
| `clip-context-menu.spec.ts` | 右键点击时间线剪辑，打开菜单并执行删除操作 |
| `timeline-editing.spec.ts` | 拖动剪辑、刮擦播放头定位、S 键分割、撤销操作 |
| `media-drag-drop.spec.ts` | 真实浏览器拖放：将素材卡拖到时间线轨道上落轨（Drag and Drop） |
| `export-dialog.spec.ts` | 打开导出对话框，查看输出摘要信息，Escape 关闭 |
| `render-golden.spec.ts` | 3D 舞台像素级回归快照：导入固定项目，采样多种监视器模式与视口像素 |

## 辅助模块

`helpers.ts` 提供共享的 Playwright 工具函数：

- `FIXTURE_PNG_PATH` / `FIXTURE_PNG_NAME` — 由 `fixtures/generate-fixtures.mjs` 生成的纯红色 48×27 PNG。
- `prepareCleanStorage(page)` — 清除 localStorage，标记欢迎引导已看过，确保测试从干净状态开始。
- `openVideoEditor(page)` — 导航到 `/`，切换到视频编辑器标签页，等待时间线区域可见。
- `importFixtureImage(page)` — 通过隐藏文件输入导入测试 PNG，等待素材卡片出现。
- `addCardToTimeline(page, card)` — 悬停素材卡片，点击 "+ 添加" 按钮。
- `scrubRulerAt(page, offsetX)` — 在时间线标尺上模拟指针刮擦。
- `playhead` / `timelineClips` / `timelineRegion` / `videoTrackRow` / `timelineRuler` — 预构建的定位器。

## 固件

`fixtures/` 目录包含测试所需的二进制与数据固件：

| 文件 | 中文用途 |
|------|----------|
| `generate-fixtures.mjs` | 纯 Node.js 生成用于导入测试的纯净红色 PNG（无需外部图片工具） |
| `director-e2e-red.png` | 由 `generate-fixtures.mjs` 生成的 48×27 纯红色 PNG 测试素材 |
| `render-golden-project.json` | 3D 舞台像素快照的固定项目文件（通过 interchange 菜单导出） |

## Vite 配置

| 文件 | 中文用途 |
|------|----------|
| `vite.config.e2e.ts` | 合并 `tools/vite.config.ts`，使用独立依赖缓存目录 `node_modules/.vite/director-e2e`，避免与开发者 `npm run dev` 产生跨实例重新优化竞争 |
| `vite.config.golden.ts` | 冻结服务器：禁用文件监听与 HMR，独立缓存目录，确保像素比较期间仓库编辑不会触发页面重载 |

## 快照目录

`render-golden.spec.ts-snapshots/` 存放 3D 舞台的像素级回归基准快照：

- `monitor-*-chromium-golden-darwin.png` — 7 种监视器模式（depth、mask、normal、objectid、previz、rgb、wireframe）的固定帧。
- `stage-viewport-chromium-golden-darwin.png` — 全视口快照，阈值 `maxDiffPixelRatio: 0.01`。

快照在无头 Chromium 下通过 SwiftShader 渲染，像素在同一机器类别的固定 Playwright 版本下具有确定性。

当渲染变更有意为之，使用以下命令刷新快照：

```sh
npx playwright test --config tools/e2e/playwright.config.ts tools/e2e/render-golden.spec.ts --update-snapshots
```

## 播放配置

`tools/e2e/playwright.config.ts` 配置：

- 测试目录：`tools/e2e/`
- 两个项目：`chromium`（视频编辑器测试，端口 5178）与 `chromium-golden`（像素快照，端口 5179，冻结服务器）。
- 两个 webServer：一个使用 `vite.config.e2e.ts` 的实时热更新服务器，一个使用 `vite.config.golden.ts` 的冻结服务器。
- `fullyParallel: true`，CI 下 `retries: 2`，`workers: 1`。
- 视口 1440×900，超时 90 秒，`reducedMotion: "reduce"`。