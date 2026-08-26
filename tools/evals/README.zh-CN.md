# Agent 评测

> 语言:**中文** · [English](README.md)

Director 公开 Agent HTTP 边界的黄金任务回归测试。当 Agent 契约
（`packages/agent-engine/` 和 `packages/protocol/`）、网关边界
（`backend/gateway/`）或技能文档变更时,这些任务验证 Agent 驱动是否仍能端到端完成
代表性工作流——包括失败分类（stale revision guard、严格字段校验等）。

Vite 配置为 `tools/vite.config.ts`（见 [`tools/README.md`](../README.md)）。评测启动 UI 时会传入 `--config`。

## 运行

```sh
npm run eval
```

生产级标杆案例复用已经运行的 Director、DSH 与 Blender，不会再启动浏览器或服务：

```sh
npm run eval:reference
```

它向 DSH 发送一条自然语言搭景任务，验证 Director 搭建与 Blender 精修共享 Stable ID 和 revision，
随后验证 clean、clay（白模）、mask、depth 与浮点深度交付。运行器会创建隔离的制作场景，结束后恢复
原活动场景并删除临时 Director 场景。

要求:本地安装仓库依赖,并下载 Playwright Chromium（`npx playwright install chromium`,若缺失）。
无需额外 npm 包。

## 隔离保证

评测工具从不与开发者正在运行的栈通信。每次运行:

- 在端口 **8899** 上启动自己的网关,使用 `DIRECTOR_DATA_DIRECTORY=.runtime/evals/data`
  （运行开始时清空;`.runtime/` 已 gitignore）,
- 在端口 **5199** 上启动自己的 Vite UI,通过 `VITE_STAGE_GATEWAY_URL` 指向该网关,
- 打开一个无头 Chromium 标签页加载该 UI,使工作台操作有实时执行器,
- 如果任一端口已被占用则快速失败,并
- 退出时拆除整个栈（包括进程组）。

## run.mjs

评测入口脚本（`run.mjs`）的逻辑:

1. 检查端口 8899 和 5199 是否空闲（`assertPortFree`）。
2. 清空并创建 `.runtime/evals/data`。
3. 启动网关子进程（`npm start` + env,等待就绪）。
4. 启动 Vite UI 子进程（`npx vite --config tools/vite.config.ts`，等待就绪）。
5. 启动无头 Chromium 并导航到 `http://127.0.0.1:5199`。
6. 按文件名顺序读取 `tasks/*.json`,逐个执行步骤。
7. 每个步骤向 `POST /api/tools/<step.tool>` 发送 JSON,验证响应是否匹配预期
   （`success`、`code`、`error_includes`、`result_paths`）。
8. 汇总通过/失败计数,退出码反映结果。

## 任务格式

每个 `tasks/*.json` 文件为一个任务,使用自己的 `session_id`
（`eval-<name>-<timestamp>`）按顺序运行。步骤按顺序执行,遇到第一个失败即停止。

每个步骤都通过 `tool` 指定一个公开工具:`director_workbench`、`director_creative`、
`stage_video`、`blender_native` 或 `director_dcc`。在启动隔离浏览器前,任务 schema 测试会先用
对应工具的严格合同校验所有预期成功的输入。

`result_paths` 是针对整个 JSON 响应体解析的点号路径（数组按数字索引,如
`result.issues.0`）;当解析到的值既不是 `undefined` 也不是 `null` 时路径通过。
`expect.success: false` 的步骤在校验边界按预期报错时通过,与 HTTP 状态码无关。
运行器是通用的——只需将新 JSON 文件放入 `tasks/` 即可添加任务。

步骤可通过 `session_id` 冒充特定 Agent 会话（例如角色绑定的占有会话）以验证
possession 范围;标记 `gateway_fills_target: true` 的步骤故意省略角色目标,
由网关 possession 预检在校验前补全,任务 schema 测试会断言该输入确实不完整。

## 任务清单

| 路径                                             | 中文用途                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| `tasks/01-blocking-and-revision-chain.json`      | 放置两个基础体素（box）,相对定位,检查 revision 链递增                    |
| `tasks/02-catalog-and-camera.json`               | 通过 `describe` 获取 schema 片段,搜索资产目录,添加活动摄像机并捕获干净帧 |
| `tasks/03-guard-and-error-taxonomy.json`         | 验证失败语义:stale revision 拒绝、严格字段校验拒绝、恢复后正常操作       |
| `tasks/04-character-animation-and-ik.json`       | 创建贴地角色,在一个原子事务中设置 Pose、动作与 IK                        |
| `tasks/05-bounded-large-scene-observation.json`  | 添加多对象街区并验证有界空间查询与层级观察                               |
| `tasks/06-creative-workspaces-atomic-batch.json` | 在一个可撤销批次中覆盖 Canvas、Video Editor 与 Gallery                   |
| `tasks/07-video-and-native-capabilities.json`    | 通过公开工具验证视频 Provider 发现与 Blender 原生内核状态                |
| `tasks/08-character-agent-possession.json`       | 绑定 Agent 并以占有会话驱动角色（含目标补全）,校验越权 author/player/pilot 均被拒绝后解绑 |
| `tasks/08-whitebox-blockout-workflow.json`       | 白盒 blockout 工作流黄金任务                                             |
| `tasks/08-world-systems-observation.json`        | 设置 Living World 天气/风并添加一个效果,验证 `world` 观察投影            |
| `tasks/09-dcc-discover-and-handoff.json`         | 验证 DCC Provider 目录、Blender 交接就绪状态与未知 Provider 失败分类      |
| `tasks/10-transcription-contract.json`           | 验证转写 capabilities/list 以及未知输入下 get/read 的失败分类             |
| `tasks/11-workbench-observe-author-smoke.json`   | 冒烟核心循环:capabilities、有界观察、添加机位、inspect 与撤销             |
