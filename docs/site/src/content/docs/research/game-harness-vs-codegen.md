---
title: Harness Game vs Skill-based Codegen
description: An honest comparison of Director's typed director_game harness with GameFactory-3A's skill-routed code-generation pipelines.
---

[GameFactory-3A](https://github.com/OpenDCAI/GameFactory-3A) and Director's experimental
`director_game` both let a coding agent produce a playable game slice, but they disagree on
three questions: what the agent speaks, what counts as playability evidence, and what an
engine export is. GameFactory-3A routes a generic coding agent (Codex, Claude Code, Gemini
CLI) through the markdown entry point `agent_skills/setting_overview.md` into
`pipeline/assets_gen/*` and `pipeline/code_gen/*` scripts that generate assets and
engine-native gameplay/UI code for UE5, Unity, Blender, and three.js. Director's
`director_game` is a typed contract on the same Gateway as the film tools
(`backend/gateway/game/gameSliceStore.ts`), reachable with identical vocabulary over MCP,
HTTP, CLI, and DSH.

## Comparison

| Question              | Director `director_game` (Experimental)                                                                                                                                                | GameFactory-3A                                                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Agent interface       | One typed Zod contract; `{"op":"capabilities"}` / `{"op":"describe"}` are the canonical vocabulary, and malformed or out-of-order calls get typed rejections with a corrective call     | Prose skills: the agent reads `agent_skills/setting_overview.md` and follows pipeline instructions; the contract is markdown        |
| First runtime         | The live Director Stage player; the default playtest is the host-free kinematic tape runner, so no browser tab is required for a receipt                                                | The target engine; the game first exists when generated code runs in UE5, Unity, or three.js                                        |
| Playability evidence  | A scored playtest receipt (`director-game-evaluation-v1`): a scripted input tape plus a trace with per-check pass/fail. The `game_export_not_playable` rejection states it directly: "A compile is not evidence." | Generated code that compiles and runs, plus the agent's own judgment; there is no typed per-check playability receipt              |
| Gameplay and UI       | Typed `author_loop` / `author_hud` patches against the slice; engine source dumps are rejected on the agent wire                                                                        | Generated engine-native source (for example Unity C# or three.js JavaScript) from `gen_mechanic` and `gen_ui`                        |
| Engine export         | `export_slice` refuses code generation with `game_export_via_dcc` and routes the bound Stage scene through `director_dcc` `send_to_engine` — a receipted scene/animation handoff, never generated C#/GDScript | Code and assets are generated directly into the engine project; the generated source is the deliverable                             |
| Breadth               | One slice at a time, five genres, Stage runtime only; asset breadth comes from the existing catalog / Blender / generated-3D flows                                                      | Broad generation: T-pose images, 3D objects and scenes, motion, audio, CG video, and full game construction across several engines |

## Honest limits

GameFactory-3A is ahead wherever the deliverable is generated content: it produces a
runnable engine-native game and a wide range of generated assets today. `director_game` is
**Experimental** (see [Feature Status](/reference/feature-status/)), never generates gameplay
source, and its engine export hands off scene and animation data — gameplay still has to be
authored engine-side after `director_dcc` `send_to_engine`.

What skill-based codegen cannot offer is what the harness guarantees: a machine-checkable
vocabulary instead of prose, rejections that carry the corrective call, a playability receipt
scored per check against the same Stage scene the film tools observe, and an export gate that
refuses to substitute a compile for a playtest.

## Proof

Golden tasks `12`–`21` in `tools/evals/tasks/` — see the task inventory in
`tools/evals/README.md` — replay the claims above against an isolated gateway
(`npm run eval`). `tasks/16-game-harness-vs-codegen-honesty.json` asserts the two
load-bearing ones mechanically: `capabilities` reports `runtime.default = "stage"`, and
`export_slice` rejects with `game_export_not_playable` before a playable receipt exists and
with `game_export_via_dcc` (routing to `director_dcc`) after one does.
