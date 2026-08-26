# Director 工作台 DeepSeek Harness 插件

> 语言：**中文** · [English](README.md)

Director 不再自研 Agent harness。循环、会话、工作区/网页/任务工具和提示词组装来自
git 子模块 `[vendor/deepseek-harness](../../vendor/deepseek-harness)`
（[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)）。

本包是 Director 专用 Cordis 插件：3D 导演台（`director_workbench`）、画布 / 视频编辑
（`director_creative`）、视频生成（`stage_video`）、原生 Blender
（`blender_native`）、游戏切片（`director_game`），以及 DCC / 引擎交接
（`director_dcc`：Blender 文件、Unreal、Unity、Godot）。每个工具都 POST 到
正在运行的 Gateway `/api/tools/:name`。

插件还提供由 DSH 实时 LLM 注册表直接驱动的 `director_model_routes`。子代理与 workflow
默认继承当前路由；确实需要其他能力时，Agent 必须读取该目录，而不是猜测 provider 或
model id。只有 Director 截图真正作为图片块进入会话后，视觉质检才算完成。

```bash
npm run dsh
```

启动器会在需要时初始化 vendored 子模块，在 `vendor/deepseek-harness/.director/` 写入薄
overlay，并在 `http://127.0.0.1:3080` 启动固定版本的官方 DSH
（`@deepseek-ai/dsh@0.1.0-rc.6`）。DSH 以仓库根目录为工作目录运行，会自行发现
`.dsh/skills/director-workbench` 技能——会话内用 DSH 原生 `skill` 工具加载。Gateway 需要
先启动（`npm run dev:gateway`），插件才能操作实时导演台、画布和视频编辑器。只有需要
生成 overlay 而不启动 Web profile 时才使用 `npm run dsh:prepare`。

启动器会在设置了 `STAGE_GATEWAY_URL`、`DIRECTOR_GATEWAY_TOKEN`、`DIRECTOR_TARGET_TOKEN`
时把它们透传给 DSH；无头 / 云端运行设置 `DIRECTOR_DSH_NO_OPEN=1`（或 `CI=1`），DSH Web
会以 `--no-open` 启动。

通用编码、网页、todo、子代理、job、skill、goal 和 plan 工具留在 DeepSeek Harness，不要写进这个插件。
Agent 应先用 DSH 的 `skill` 工具加载 `.dsh/skills/director-workbench`，再把这些 Harness
工具和 Director 领域工具一起用。
