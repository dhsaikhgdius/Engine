---
title: Harness 游戏 vs 技能式代码生成
description: Director 类型化 director_game harness 与 GameFactory-3A 技能路由代码生成管线的诚实对比。
---

[GameFactory-3A](https://github.com/OpenDCAI/GameFactory-3A) 与 Director 实验性的
`director_game` 都让 coding agent 产出一个可玩的游戏切片，但在三个问题上给出了不同答案：
agent 说什么语言、什么算可玩性证据、引擎导出意味着什么。GameFactory-3A 让通用 coding
agent（Codex、Claude Code、Gemini CLI）从 markdown 入口 `agent_skills/setting_overview.md`
进入 `pipeline/assets_gen/*` 和 `pipeline/code_gen/*` 脚本，为 UE5、Unity、Blender 和
three.js 生成资产与引擎原生的玩法/UI 代码。Director 的 `director_game` 是与电影工具同一
Gateway 上的类型化契约（`backend/gateway/game/gameSliceStore.ts`），在 MCP、HTTP、CLI 和
DSH 上使用完全相同的词汇。

## 对比

| 问题       | Director `director_game`（实验性）                                                                                                                                          | GameFactory-3A                                                                                  |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Agent 接口 | 一个类型化 Zod 契约；`{"op":"capabilities"}` / `{"op":"describe"}` 是权威词汇，格式错误或顺序错误的调用会得到带纠正调用的类型化拒绝                                         | 散文式 skill：agent 阅读 `agent_skills/setting_overview.md` 并跟随管线说明；契约本体是 markdown |
| 首个运行时 | 实时 Director Stage 播放器；默认 playtest 使用 host-free 运动学 tape runner，无需浏览器标签页即可拿到回执                                                                   | 目标引擎；生成代码在 UE5、Unity 或 three.js 里跑起来，游戏才第一次存在                          |
| 可玩性证据 | 有评分的 playtest 回执（`director-game-evaluation-v1`）：脚本化输入 tape 加逐项检查通过/失败的 trace。`game_export_not_playable` 拒绝直接写明："A compile is not evidence." | 生成代码能编译能运行，加上 agent 自己的判断；没有类型化的逐项可玩性回执                         |
| 玩法与 UI  | 针对切片的类型化 `author_loop` / `author_hud` patch；agent 线路拒绝引擎源码 dump                                                                                            | 由 `gen_mechanic` 和 `gen_ui` 生成引擎原生源码（例如 Unity C# 或 three.js JavaScript）          |
| 引擎导出   | `export_slice` 用 `game_export_via_dcc` 拒绝代码生成，把已绑定的 Stage 场景经 `director_dcc` `send_to_engine` 交接——带回执的场景/动画交付，绝不生成 C#/GDScript             | 代码和资产直接生成进引擎项目；生成的源码就是交付物                                              |
| 广度       | 一次一个切片、五种类型、目前仅 Stage 运行时；资产广度来自既有的 catalog / Blender / 生成式 3D 流程                                                                          | 广泛生成：T-pose 图像、3D 对象与场景、动作、音频、CG 视频，并跨多个引擎构建完整游戏             |

## 诚实的边界

只要交付物是生成内容，GameFactory-3A 就领先：它今天就能产出可运行的引擎原生游戏和大量生成
资产。`director_game` 是**实验性**功能（见[功能状态](/zh/reference/feature-status/)），从不
生成玩法源码，引擎导出交付的是场景与动画数据——`director_dcc` `send_to_engine` 之后，玩法
仍需在引擎侧编写。

技能式代码生成给不了的，正是 harness 的保证：机器可校验的词汇而非散文、携带纠正调用的拒
绝、针对电影工具观察的同一 Stage 场景逐项评分的可玩性回执，以及拒绝用编译顶替 playtest 的
导出关卡。

## 证明

`tools/evals/tasks/` 中的黄金任务 `12`–`24`（任务清单见 `tools/evals/README.zh-CN.md`）在
隔离 gateway 上重放上述主张（`npm run eval`）。`tasks/16-game-harness-vs-codegen-honesty.json`
机械化断言其中两条关键主张：`capabilities` 报告 `runtime.default = "stage"`；在可玩回执存在
之前 `export_slice` 以 `game_export_not_playable` 拒绝，存在之后以 `game_export_via_dcc`
拒绝并路由到 `director_dcc`。
