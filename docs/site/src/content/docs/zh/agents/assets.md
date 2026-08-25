---
title: Agent 资产与人物
description: 发现准确的本地资产，并在不猜测标识符的前提下创建和验证 Mixamo 人物。
---

Agent 创建场景时必须把 Director 目录作为单一事实来源。不要根据显示名称猜测资产 ID、模型 URL、预览 URL 或人物动作 ID。

## 启动控制面

同时运行浏览器与 Gateway：

```bash
npm run dev
```

操作同一个浏览器目标期间，使用稳定的 CLI session：

```bash
export STAGE_AGENT_SESSION=asset-authoring
```

CLI 会为该 session 保存准确的已观察目标。tab、scene 或 creative scope 改变后会失败关闭，绝不会把待处理写入重定向到另一个 Director tab。

## 先发现，再创作

Workbench 提供四个目录：

| 目录                | 内容                           |
| ------------------- | ------------------------------ |
| `assets`            | Agent 可寻址的所有本地资产     |
| `character_assets`  | 已打包的 Mixamo 人物模型       |
| `character_motions` | 已打包的 Mixamo 骨骼动作       |
| `project_assets`    | 当前项目已上传与 AI 生成的模型 |

已跟踪 metadata 快照见[功能状态](/zh/reference/feature-status/#目录数量)（最近核验为 108 个
Mixamo 人物和 1,426 个本地镜像 Stage 道具）。二进制 payload 不进入 Git，因此本机可能尚未具备。
资产准备后，应以实时目录响应和本地 availability 为准，不能只依赖这些数量。详见
[开源资产与 Hugging Face](/zh/development/open-source-assets/)。

```bash
npm run stage -- director_workbench '{"op":"catalog","catalog":"assets","query":"chair","limit":25}'
npm run stage -- director_workbench '{"op":"catalog","catalog":"assets","query":"木椅","limit":25}'
npm run stage -- director_workbench '{"op":"catalog","catalog":"character_assets","asset_id":"mixamo:x-bot","limit":1}'
npm run stage -- director_workbench '{"op":"catalog","catalog":"character_motions","limit":25}'
```

资产目录支持 `query`、`asset_id`、`category`、`kind`、`preview_status`、`offset` 和 `limit`（1–100）。动作目录支持文本搜索和分页，不接受仅用于资产的筛选项。支持中文搜索：`name_zh`、中文 alias 和 `tags` 均已建立索引。

每个资产结果都包含预览元数据、准确 asset record 和准备好的 authoring actions。优先使用返回的 actions。Agent 若要 upsert 打包资产，必须原样复制目录中的 `asset` 对象；Director 会拒绝身份与目录不一致的打包路径。

每个条目还会返回 `name_zh`（可为 null）、`tags`，以及以米为单位、可为 null 的 `spatial` 信息：`bounds_m: [x, y, z]`、`footprint_m: [x, z]`、`height_m`、`ground_offset_y` 和 `front_axis`。在 `compose_blocking` 或 `place_relative` 之前，先读取 `spatial` 校验尺寸与占地。

## 复用项目内资产

`project_assets` 列出当前项目的运行时资产——用户上传和 AI 生成的模型——而不是打包资产库：

```bash
npm run stage -- director_workbench '{"op":"catalog","catalog":"project_assets","query":"robot","asset_source":"generated","limit":25}'
```

支持 `query`、`kind`、`asset_source`、`offset` 和 `limit`。每个条目返回 `id`、`name`、`kind`、`file_name`、`url`、`thumbnail_url`、`asset_source`，以及一个准备好的 `add_object` authoring action。资产已存在于项目中，无需 upsert；原样提交返回的 action。

## 让资产保持真实尺寸

模型 asset record 可以携带 `realWorldSizeM`（以米为单位、按包围盒最大边测量的真实尺寸）和 `sizeSource`（`catalog`、`user` 或 `estimated`）。Director 会把模型的最大边缩放到该尺寸，让道具与人物处于同一套米制尺度。打包道具会按类别取默认尺寸，Asset Catalog v2 条目优先使用自带的 `bounds_m`/`height_m`；原样复制返回的 `asset`，尺寸也会一并带上。

没有 `realWorldSizeM` 的资产会回退到旧的显示归一化，把最大边缩放到 2 m——放在 1.78 m 的人物旁边通常明显不对。`audit` 会给出 `asset_missing_real_world_size` 告警，列出该资产及绑定它的可见对象；目录已知尺寸时还附带 `upsert_asset` 修复。目录不了解用户导入的模型，因此需要自行在 `upsert_asset` 中提交实测尺寸：`realWorldSizeM` 以米为单位，并设 `sizeSource: "user"`。缺少 `realWorldSizeM` 时 `sizeSource` 会被拒绝。与 `url`、`fileName`、`sourceType` 不同，尺寸并未锁定到目录记录，因此可以用修正后的尺寸 upsert 打包资产。

标记 `modelNormalization: "preserve"` 的资产——晋升后的生成 3D 模型和导入的场景包——保留作者的米制尺度，不会被告警。Agent 的空间代理体也使用声明的尺寸，因此审计净距与放置结果同视口渲染一致。

## 观察准确目标

只观察当前操作所需切片，并保留返回的 `project_revision`：

```bash
npm run stage -- director_workbench '{"op":"observe","fields":["assets","characters","timeline","graph_issues"]}'
```

CLI 会自动执行预检观察，并为缺少 revision 的受保护操作注入 guard。MCP 和 HTTP caller 应显式发送最新 `expected_revision`。所有 mutation 还需要稳定的 `idempotency_key`。

## 添加真实 X Bot

以下命令可直接在尚不存在 `actor-xbot` 的场景中执行：

```bash
npm run stage -- director_workbench '{"op":"author","idempotency_key":"asset-guide-xbot-v1","actions":[{"action":"add_object","id":"actor-xbot","name":"X Bot","kind":"character","asset_id":"mixamo:x-bot","transform":{"position":[0,0,0],"rotation":[0,0,0],"scale":[1,1,1]}}]}'
```

对于目录人物，`add_object` 可以自动登记打包资产。持久化对象必须包含 `characterSource: "asset"`、`assetRefId: "mixamo:x-bot"` 和 Mixamo rig。Director 不允许清除已有角色的资产绑定。

如果只提供名称而省略 `asset_id`，Director 只接受无歧义的精确 alias，否则使用默认 X Bot。为了让 Agent 计划可重复，建议显式使用目录 ID。

## 应用本地动作

先发现 clip，再分配其目录 ID：

```bash
npm run stage -- director_workbench '{"op":"author","idempotency_key":"asset-guide-xbot-walk-v1","actions":[{"action":"set_character_motion","object_id":"actor-xbot","clip_id":"walk","enabled":true,"loop":"repeat","speed":1,"weight":1,"root_motion":"in-place"}]}'
```

有效本地 ID 为 `idle`、`walk`、`walk-back`、`walk-left`、`walk-right`、`run`、`run-back`、`run-left`、`run-right`、`wave`、`clap`、`sit-idle`、`jump` 和 `talk`。目录拥有默认循环和推荐 root-motion 模式。可覆盖参数包括：

- `loop`：`once`、`repeat` 或 `ping-pong`；
- `speed`：0.1–4；
- `weight`：0–1；
- `start_frame`：整数时间线帧；
- `blend_in_s` 与 `blend_out_s`：0–10 秒；
- `root_motion`：`in-place` 或 `authored`。

## 微调姿势与 IK

显式姿势控制会应用在采样动作之后。`merge` 从当前已解析姿势开始，`replace` 从中性 controls 开始。

```bash
npm run stage -- director_workbench '{"op":"author","idempotency_key":"asset-guide-xbot-pose-v1","actions":[{"action":"set_character_pose_controls","object_id":"actor-xbot","mode":"merge","controls":[{"control":"head.yaw","value":15},{"control":"rightElbow.bend","value":35}]}]}'
```

IK 是最后一层 rig。target 和 pole 都是人物局部坐标，单位为米：

```bash
npm run stage -- director_workbench '{"op":"author","idempotency_key":"asset-guide-xbot-ik-v1","actions":[{"action":"set_character_ik","object_id":"actor-xbot","effector":"rightHand","target":[0.45,1.25,0.2],"pole":[0.2,1.1,-0.35],"weight":1,"reach_clamp":0.95}]}'
```

有效末端只有 `leftHand`、`rightHand`、`leftFoot` 和 `rightFoot`。two-bone solver 不会拉伸肢体。锁定人物会拒绝动作、姿势和 IK 修改；只有用户明确授权后才可覆盖。

## 验证结果

先使用结构化状态检查：

```bash
npm run stage -- director_workbench '{"op":"observe","fields":["characters","timeline","graph_issues"]}'
npm run stage -- director_workbench '{"op":"inspect","entity":"object","id":"actor-xbot"}'
npm run stage -- director_workbench '{"op":"audit","subject_id":"actor-xbot","include_spatial":true}'
npm run stage -- director_workbench '{"op":"capture","camera_id":"cam_1","frame":0,"render_pass":"clean","clean_plate":true}'
```

CLI 返回持久 capture receipt，但不会打印图像字节。具备 MCP 视觉能力的 Agent 或操作员必须检查返回的 clean pixels，之后才能验收落地、轮廓、遮挡、姿势或构图。

## 验收标准

- 目录发现得到一个准确资产和 ready 预览。
- 创建的人物保留预期真实 `assetRefId`。
- observe 在 `character_rig` 下报告预期 motion、controls 和 IK。
- walk/run 循环保留骨盆垂直运动，且骨骼没有意外平面漂移。
- 求值帧中双脚落地，IK 保持在可达范围。
- 最终 clean frame 不含网格、gizmo、标签、视锥或选择辅助元素。
- 不能只凭 `audit.ready` 声称最终交付；还需使用最新 revision、已验证 capture 和像素视觉检查。

## 恢复规则

- revision 过期时重新 observe，只提交剩余意图并使用新 key。
- 遇到 `outcome_unknown` 时先 inspect。只有确认效果不存在且请求保持字节等价时，才能复用原 key 重试。
- 遇到 `target_unavailable` 时重新连接目标 tab 并观察，绝不回退到其他目标。
- 不要把 `force:true` 当作方便开关；它必须得到操作员明确授权。

## 库维护者：接入新资产

打包资产库在磁盘上由 Asset Catalog v2 manifest 描述，位于
`assets/library/<library>/catalog.v2.json`；zod 契约在
`packages/protocol/src/assetCatalogProtocol.ts`。用开发者 ingest CLI 登记新文件：

```bash
npx tsx tools/scripts/asset-ingest.ts <files...> --library <library> [--kind --category --name-zh --tags ...]
```

CLI 会规范化 GLB/GLTF（bounds、SHA-256）、登记 FBX/OBJ 文件，并把结果合并进
`catalog.v2.json`。这是面向开发者的加库流程，不是 Agent 运行时工具。分发与许可规则见
[开源资产与 Hugging Face](/zh/development/open-source-assets/)。
