---
title: Canvas、Video 与 Gallery Agent
description: 通过目标绑定、原子批次、幂等性和制作审计安全地控制 Canvas 生产 DAG、Video Editor 与 Gallery。
---

`director_creative` 是 Canvas、多模态生产 DAG、Video Editor 与 Gallery 的 Agent 原生控制面。它操作真实的、按场景隔离的浏览器工作区，
而不是 gateway 侧的仿真副本。MCP、HTTP、浏览器 bridge，以及内置的 Codex 和 Claude Code planner
共享同一个契约。

## 闭环

```text
capabilities
  → observe（保留 target、snapshot_fingerprint 与精确 ID）
  → execute_batch 或 execute
  → 再次 observe
  → audit(scope="all", quality_profile="production")
  → preview（最新 snapshot_fingerprint）
  → 检查 Canvas 布局 / 代表性的 Video 帧
```

`audit` 只证明结构是否就绪，会刻意返回 `visual_verification_required:true`；没有真实预览检查时，它不会声称构图、
可读性或剪辑节奏已经视觉正确。

## 发现契约

```json
{ "op": "capabilities" }
```

响应会列出请求操作、内容操作、限制、批次排除项、并发保护条件和质量配置。然后读取实时工作区：

```json
{ "op": "observe" }
```

保留返回的 `snapshot_fingerprint`，只使用观察到的节点、边、媒体、轨道、片段和 Gallery ID。源媒体字节仍由浏览器拥有；
观察返回元数据，专用的 `preview` 操作返回干净 PNG 证据。

## 一个意图对应一个原子批次

```json
{
  "op": "execute_batch",
  "idempotency_key": "canvas-shot-chain-v1",
  "expected_snapshot_fingerprint": "<来自 observe 的 sha256 指纹>",
  "steps": [
    {
      "step_id": "intent",
      "save_as": "intent",
      "operation": {
        "op": "canvas.node.add",
        "kind": "note",
        "title": "镜头意图",
        "body": "人物保持在右侧三分线",
        "x": 80,
        "y": 80
      }
    },
    {
      "step_id": "shot",
      "save_as": "shot",
      "operation": {
        "op": "canvas.node.add",
        "kind": "shot",
        "title": "Shot 01",
        "body": "50mm 中景，缓慢推进",
        "x": 440,
        "y": 80
      }
    },
    {
      "step_id": "connect",
      "operation": {
        "op": "canvas.edge.add",
        "source_node_id": "@intent",
        "target_node_id": "@shot"
      }
    }
  ]
}
```

创建步骤可以通过 `save_as` 暴露生成的 ID，后续 ID 字段使用 `@alias`。一个批次包含 1–32 个持久化 mutation，
并成为一个撤销单元。`edit.seek`、`workspace.switch`、undo 和 redo 被有意排除，因为它们是临时 UI 命令，而非持久内容。

如果后续步骤失败，响应会指出 `failed_step_id`，返回 `rolled_back:true` 和恢复后的快照。针对新的观察重试完整的、修正后的意图。

## 单次编辑

对于恰好一个操作使用 `execute`：

```json
{
  "op": "execute",
  "idempotency_key": "move-shot-card-v2",
  "expected_snapshot_fingerprint": "<来自 observe 的 sha256 指纹>",
  "operation": {
    "op": "canvas.node.update",
    "node_id": "board-shot-01",
    "patch": { "x": 620, "y": 160 }
  }
}
```

两个 mutation envelope 都要求指纹和幂等 key。字节完全相同的重试会返回原成功结果并标记 `replayed:true`，不会复制 mutation；
同一个 key 搭配不同输入会产生冲突。

## 操作族

| 族             | 操作                                                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Canvas 节点    | `canvas.node.add`、`canvas.node.update`、`canvas.node.remove`、`canvas.node.bring_to_front`、`canvas.node.assign_section` |
| Canvas 分区    | `canvas.section.add`、`canvas.section.update`、`canvas.section.remove`                                                      |
| Canvas 边      | `canvas.edge.add`、`canvas.edge.remove`                                                                                     |
| Canvas DAG     | `canvas.dag.layout`、`canvas.production.configure`；顶层 `pipeline` start/status/cancel                                     |
| Video 片段     | `edit.clip.add`、`edit.clip.update`、`edit.clip.move`、`edit.clip.split`、`edit.clip.remove`                                |
| Video 轨道     | `edit.track.add`、`edit.track.update`、`edit.track.remove`                                                                  |
| Gallery 媒体   | `gallery.media.update`、`gallery.media.move`、`gallery.media.rename_many`、`gallery.media.trash`、`gallery.media.restore`   |
| Gallery 文件夹 | `gallery.folder.add`、`gallery.folder.rename`、`gallery.folder.move`、`gallery.folder.remove`、`gallery.preferences.update` |
| UI 与历史      | `edit.seek`、`workspace.switch`、`workspace.undo`、`workspace.redo`                                                         |

读取 `capabilities`，不要把限制硬编码在 Agent 中。当前安全上限为 240 个画布节点、2,000 条边、12 条轨道、每轨道 400 个片段、
5,000 条 Gallery 记录、200 个 Gallery 文件夹，以及每批 32 个步骤。

Gallery 属于同一快照指纹和撤销历史。文件夹创建支持 `save_as`，因此原子批次可以先创建文件夹，再把媒体移动到
`@folder`。永久删除会移除浏览器拥有的持久字节，不属于 Agent 操作；Agent 使用可逆的回收站与恢复操作。

## 运行 Canvas 生产 DAG

Canvas 边不仅是视觉连线，也是可执行依赖。先用 `execute` 或 `execute_batch` 为每个生成图片、视频或音频节点
配置已观察到的工作流和节点池；不要编造 ID：

```json
{
  "op": "execute",
  "idempotency_key": "configure-board-shot-01-v1",
  "expected_snapshot_fingerprint": "<最新 snapshot_fingerprint>",
  "operation": {
    "op": "canvas.production.configure",
    "node_id": "board-shot-01",
    "patch": {
      "workflow_id": "comfy-workflow-image-main",
      "node_ids": ["gpu-a", "gpu-b"],
      "negative_prompt": "blur, duplicate subject",
      "seed": 17,
      "parameters": { "12.cfg": 6.5 }
    }
  }
}
```

再次观察并保留新指纹。`target_node_ids` 留空会运行整个 graph；提供目标则运行这些目标及全部祖先：

```json
{
  "op": "pipeline",
  "request": {
    "action": "start",
    "target_node_ids": ["board-shot-01"],
    "force_node_ids": [],
    "max_parallel": 4,
    "await_completion": false,
    "expected_snapshot_fingerprint": "<配置后的 snapshot_fingerprint>",
    "idempotency_key": "run-board-shot-01-v1"
  }
}
```

`force_node_ids` 只强制重生成当前执行范围内的显式节点，其他未变节点可使用已验证缓存；布局变化不会让生产缓存失效。
直接上游的持久图片会绑定为工作流参考输入，note/frame 节点无需 provider 任务即可透传。同一拓扑层的独立节点按有界并行运行，
失败分支只阻塞其后代。

后台运行时保留返回的精确 `run.id`，随后轮询或取消：

```json
{ "op": "pipeline", "request": { "action": "status", "run_id": "canvas-run-01" } }
```

```json
{ "op": "pipeline", "request": { "action": "cancel", "run_id": "canvas-run-01" } }
```

运行回执会持久化逐节点状态、请求指纹、任务、产物、媒体、时间和错误。Director 会在晋升 Gallery 前校验输出字节数与 SHA-256，
并保留有界节点输出和 graph 运行历史。`stale` 表示节点运行期间输入发生变化，必须从新观察有意重新启动。进程刷新后可核对持久生成任务，
但不能假装仍持有已经丢失的浏览器内取消 controller。

## 审计

```json
{ "op": "audit", "scope": "all", "quality_profile": "production" }
```

scope 可以是 `canvas`、`video` 或 `all`。profile 可以是 `draft` 或 `production`；production 会把断开的节点、严重重叠、
未解析镜头、空时间线、片段重叠和媒体未就绪等重要警告视为阻塞项。

## 预览

审计是结构性的。在声称视觉完成前，应从同一个 mutation 后指纹请求像素：

```json
{
  "op": "preview",
  "workspace": "canvas",
  "expected_snapshot_fingerprint": "<mutation 后 observe 的指纹>"
}
```

`workspace` 支持 `auto`、`canvas` 和 `video`。Canvas 预览会适配完整画布，渲染节点、边和可用媒体缩略图，不显示选择辅助线。
Video 预览使用与时间线渲染器相同的片段时间和合成规则：

```json
{
  "op": "preview",
  "workspace": "video",
  "time_sec": 2.5,
  "expected_snapshot_fingerprint": "<mutation 后 observe 的指纹>"
}
```

预览返回无辅助 UI 的 `image/png`、渲染画布或当前片段的元数据，以及拥有证据的指纹；不会移动播放头。Director 会在渲染前后检查指纹，
并发编辑会返回 `stale_snapshot`，而不是生成标签错误的像素。时间、转场或 coverage 发生变化时，应检查多个代表性时刻。

## 精确浏览器目标

第一次 `observe` 响应会包含 gateway `target` 描述和一个不透明 token，描述精确的浏览器客户端、项目实例、场景、creative scope 和契约版本。
把完整描述作为一份 lease。MCP 会自动保留 token，内置持久 Agent 会固定完整描述；HTTP 调用方必须在后续 mutation、audit 和 preview 顶层传入 `target_token`。

Director 永远不会回退到最近可见的另一个 tab。缺少 token 返回 `target_required`；关闭或改变目标返回 `target_unavailable`。重新观察，并依据新的目标和快照重建请求。

## 恢复表

| 代码                         | 含义                                      | 正确恢复方式                                                                                    |
| ---------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `target_required`            | 没有提供已观察的浏览器目标                | 观察目标工作区，保留精确目标并重建请求。                                                        |
| `target_unavailable`         | 绑定 tab、项目、场景或 scope 已改变或断开 | 重新连接并观察，不要重定向旧写入。                                                              |
| `conflict`                   | 指纹变化，或错误复用了 key                | 查看 `result.code`；观察并针对新快照重建，只有新意图才使用新 key。                              |
| `stale_snapshot`             | 预览开始或结束时指纹不同                  | 重新观察并从当前指纹请求预览，不要接受旧图像。                                                  |
| `idempotency_key_conflict`   | 一个 key 被绑定到不同输入                 | 保留旧收据，为新意图使用新 key。                                                                |
| `idempotency_replay_stale`   | 原 mutation 成功后 scope 又发生变化       | 观察并核对，把剩余工作表达为新的意图和新 key。                                                  |
| `outcome_unknown`            | mutation 超时，可能已提交                 | 停止并观察精确目标；若效果存在则不重试，否则在前置条件仍成立时用同一 key 重试完全相同 payload。 |
| `command_timeout`            | observe/audit/preview 超时并取消          | 保持工作区可见，必要时重新观察保护条件，再重试证据请求。                                        |
| start 返回 `stale_guard`     | pipeline 接受前 graph 已变化              | 观察精确画布、核对配置和 ID，再用当前指纹和新 key 启动新意图。                                  |
| active start 返回 `conflict` | 当前浏览器已持有活动 Canvas pipeline      | 查询或取消精确活动 run；不要在同一 workspace 启动竞争 controller。                              |
| `not_found`                  | ID 或 alias 不存在                        | 检查观察到的 ID 并修正请求。                                                                    |
| `locked`                     | 轨道或实体拒绝 mutation                   | 请求用户解锁或明确授权范围受限的 override。                                                     |
| `capacity`                   | 达到安全上限                              | 有意删除内容或使用另一个场景 scope，不要隐式驱逐旧工作。                                        |
| `render_failed` / `aborted`  | 预览媒体无法渲染或请求被取消              | 检查媒体可用性、浏览器解码/CORS 支持和 canvas 可见性；仍需证据时再重试。                        |

不要仅凭命令状态报告成功。必须由新观察证明效果、制作审计就绪，并在实际工作区检查视觉结果后才结束。
