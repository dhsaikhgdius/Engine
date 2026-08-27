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

有真实 Godot 4 编辑器时，单独运行引擎结果门槛：

```sh
npm run eval:godot-result
```

该评测在 Godot 中启动一个可运行的 3D 房间、抓取引擎视口，并把降采样图像与
`fixtures/godot-room-reference.ppm` 对比；运行标记必须齐全，视觉得分不得低于 82。
临时工程会删除，截图与 JSON 报告保留在 `.runtime/evals/godot-result/` 供审阅。
Godot 不在标准位置时设置 `DIRECTOR_GODOT_BIN`。

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
   （`success`、`code`、`error_includes`、`result_paths`、`result_equals`）。
8. 汇总通过/失败计数,退出码反映结果。

## 任务格式

每个 `tasks/*.json` 文件为一个任务,使用自己的 `session_id`
（`eval-<name>-<timestamp>`）按顺序运行。步骤按顺序执行,遇到第一个失败即停止。

每个步骤都通过 `tool` 指定一个公开工具:`director_workbench`、`director_creative`、
`stage_video`、`blender_native`、`director_dcc` 或 `director_game`。在启动隔离浏览器前,任务 schema 测试会先用
对应工具的严格合同校验所有预期成功的输入。游戏切片任务（`12`–`18`）覆盖规划/绑定/试玩、
导出到 `director_dcc` 的路由、未绑定拒绝、无内联 `trace` 的 host-free playtest、实时 Stage
试玩路径（见"实时（live）与 host-free 试玩"）、harness 与代码生成的诚实契约（Stage 是默认运行时;`export_slice` 拒绝生成引擎代码），以及从 `packages/protocol/src/gameDemoRecipes.ts` 逐字回放的 fps/racing/rpg 题材演示配方。这些诚实
断言背后的对比记录在 `docs/site/src/content/docs/zh/research/game-harness-vs-codegen.md`。

`result_paths` 是针对整个 JSON 响应体解析的点号路径（数组按数字索引,如
`result.issues.0`）;当解析到的值既不是 `undefined` 也不是 `null` 时路径通过。
`result_equals` 把相同的点号路径映射到精确的预期 JSON 值（深度相等）,用于"存在还不够"的断言
——例如 `runtime.default` 必须等于 `"stage"` 而非仅存在,试玩 trace 的 source 必须等于
`"live_stage"`,因为 host-free 回退同样会让路径存在。
`expect.success: false` 的步骤在校验边界按预期报错时通过,与 HTTP 状态码无关。
运行器是通用的——只需将新 JSON 文件放入 `tasks/` 即可添加任务。

步骤可通过 `session_id` 冒充特定 Agent 会话（例如角色绑定的占有会话）以验证
possession 范围;标记 `gateway_fills_target: true` 的步骤故意省略角色目标,
由网关 possession 预检在校验前补全,任务 schema 测试会断言该输入确实不完整。

等待异步就绪的步骤可声明 `retry: { attempts, delay_ms }`（延迟默认 2000 ms）:该步骤会
重跑,直到全部预期通过或次数用尽。任务 `18` 的实时试玩步骤使用它,因为无头标签页的
Player Mode 在 `player enter` 之后需要片刻才能就绪。

## 实时（live）与 host-free 试玩

不带内联 `trace` 的 `director_game {op:"playtest"}` 优先走实时 Stage 路径:网关把输入带
派发给已连接的工作台标签页,实时 PlayerController 逐帧回放,回执带
`trace.source: "live_stage"`（并持久化为 `evaluation.trace_source`）。当没有标签页应答——
或标签页无法运行该带,例如绑定的玩家 `object_id` 在 Stage 工程中不存在——网关回退到
运动学运行器,回执如实标注 `"host_free"`。内联 trace 一律按 `"inline"` 评估;机器会重新
盖章,公开边界无法伪造实时来源。

在本评测中,无头工作台标签页始终已连接,任务走哪条路径由绑定决定:

- 任务 `12`–`17` 绑定的 object id 只存在于切片文档,实时标签页会拒绝该带,网关回退——
  它们是 host-free 黄金任务（任务 `12` 与 `13` 另外提供内联 trace,按 `"inline"` 评估）。
- 任务 `18` 先在 Stage 上创建真实对象再绑定,输入带必须在实时玩家会话上回放。其
  `result_equals` 断言要求 `"live_stage"` 来源与可玩回执:若被强制回退到 host-free
  （包括实时派发超时——回退回执会如实标注 `"host_free"`）,该任务失败。它先用公开的
  `player {"action":"enter"}` 预热会话,避免 Player Mode 冷启动吃掉实时派发预算,
  结束后退出 Player Mode。

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
| `tasks/09-dcc-discover-and-handoff.json`         | 验证 DCC Provider 目录、Blender 交接就绪状态与未知 Provider 失败分类      |
| `tasks/10-transcription-contract.json`           | 验证转写 capabilities/list 以及未知输入下 get/read 的失败分类             |
| `tasks/11-workbench-observe-author-smoke.json`   | 冒烟核心循环:capabilities、有界观察、添加机位、inspect 与撤销             |
| `tasks/12-game-slice-plan-and-playtest.json`     | 规划类型化游戏切片,绑定 Stage 对象并用脚本输入带回放试玩                  |
| `tasks/13-game-slice-export-routes-dcc.json`     | 通过 DCC discover/status/send_to_engine 导出可玩切片                     |
| `tasks/13-whitebox-blockout-workflow.json`       | 白盒 blockout 工作流黄金任务                                             |
| `tasks/14-game-slice-unbound-playtest-rejects.json` | 验证未绑定玩家角色时 playtest 被拒绝                                   |
| `tasks/14-world-systems-observation.json`        | 设置 Living World 天气/风并添加一个效果,验证 `world` 观察投影            |
| `tasks/15-game-slice-hostfree-playtest-no-trace.json` | 无显式 trace 的 host-free playtest 评分                            |
| `tasks/16-game-demo-fps-recipe-hostfree.json`    | 回放 fps 题材演示配方:capabilities/describe 发现、plan、按提示绑定、免宿主试玩至可玩 |
| `tasks/16-game-harness-vs-codegen-honesty.json`  | harness vs 代码生成诚实性:capabilities 报告 `runtime.default = "stage"`,`export_slice` 在可玩回执之前（`game_export_not_playable`）与之后（`game_export_via_dcc`）都拒绝代码生成 |
| `tasks/16-game-slice-racing-full-loop.json`      | 无内联 trace 的完整竞速闭环,强制载具顺序,导出路由到 `director_dcc`       |
| `tasks/17-game-demo-racing-recipe-hostfree.json` | 回放 racing 题材演示配方,含 enter/exit vehicle 动词,回执字面可玩          |
| `tasks/17-game-slice-fps-full-loop.json`         | 无内联 trace 的完整 FPS 闭环,覆盖 fire/reload 动词,导出路由到 `director_dcc` |
| `tasks/18-game-demo-rpg-recipe-hostfree.json`    | 回放 rpg 题材演示配方,含 interact 与 attack 动词,回执字面可玩             |
| `tasks/18-game-slice-live-stage-playtest.json`   | 实时 Stage 试玩:创建真实对象、绑定并在已连接标签页上回放,要求 `live_stage` 来源 |
