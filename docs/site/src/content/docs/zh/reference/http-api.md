---
title: HTTP API
description: 通过本地控制面 API bootstrap、鉴权、绑定目标、执行任务并恢复 Director。
---

TypeScript gateway 是浏览器编辑器、Agent harness、MCP、CLI 和 Python worker 共用的 loopback
控制面。默认地址是：

```text
http://127.0.0.1:8787
```

使用 `npm run dev` 启动完整开发栈，或使用 `npm run gateway` 只启动 gateway。下面示例使用
`jq` 在请求之间传递结构化 target。

## Bootstrap 与鉴权

只有 `GET /health` 和 `POST /te-man/director/agent/bootstrap` 不需要 gateway token。所有
`/api/*` 路由（包括 `GET /api/preview`）以及 Director `/te-man/*` 路由都需要鉴权。

```bash
BASE='http://127.0.0.1:8787'
BOOTSTRAP="$(curl -fsS -X POST "$BASE/te-man/director/agent/bootstrap" \
  -H 'Content-Type: application/json' \
  -d '{}')"
TOKEN="$(printf '%s' "$BOOTSTRAP" | jq -r '.browserToken')"

curl -fsS "$BASE/api/control-plane/capabilities" \
  -H "X-Director-Browser-Token: $TOKEN" | jq
```

把进程 token 放在 `X-Director-Browser-Token` header 中。为兼容旧客户端，gateway 也接受
query string 中的 `browser_token`，但 header 不会把凭据泄漏到 URL 与日志。浏览器 Origin 必须
在默认 loopback allowlist 或 `DIRECTOR_ALLOWED_ORIGINS` 中；原生客户端可以不发送 `Origin`。

默认 token 在每次 gateway 进程启动时随机生成。如果 MCP、CLI 或其他进程需要稳定共享 token，
请把 `DIRECTOR_GATEWAY_TOKEN` 设置为至少 24 个字符。Gateway 会把最终 token 写入自己的环境，
使内部 API harness 工具调用使用同一 secret。Gateway 拒绝非 loopback bind；需要远程访问时应使用
真正有鉴权的 reverse proxy，而不是直接暴露端口。

进程 token 只负责客户端到 gateway 的身份校验；它与 observe 返回的不透明 workspace
`target_token` 不是同一个概念。

## 发现接口

| Method | Path                              | 结果                                |
| ------ | --------------------------------- | ----------------------------------- |
| `GET`  | `/health`                         | 无需鉴权的进程状态与 browser 数     |
| `GET`  | `/api/control-plane/capabilities` | 已脱敏的 Agent 与视频配置           |
| `GET`  | `/api/control-plane/tool-manifest` | 由 Zod tool schema 生成的机器可读工具目录 |
| `GET`  | `/api/agent/providers`            | 本地/API session provider 可用性    |
| `GET`  | `/api/agent/profiles`             | Profile 公开元数据与模型 capability |
| `GET`  | `/api/video/providers`            | 视频 provider 的实时 capability     |
| `GET`  | `/api/dcc/status`                 | Blender/DCC bridge 状态             |
| `GET`  | `/api/stage`                      | 旧版 StageScene projection          |
| `GET`  | `/api/preview`                    | 最近一次 capture，读取需要鉴权      |

```bash
curl -fsS "$BASE/api/agent/profiles" \
  -H "X-Director-Browser-Token: $TOKEN" | jq '.profiles[]'
```

发现响应不会包含模型 API key、worker credential 或原始 credential 环境变量名。

Tool manifest 会列出每个 Director 工具的描述、JSON Schema 输入契约与操作名；冻结的
`stage_*` 兼容工具会标注 `legacy: true`。跨入口的统一 tool audit trail 将在路线图 M3
（统一治理）落地后收敛到 gateway；manifest 本身只做发现，不承担审计。

Capture 结果可能返回带有进程周期 `preview_token` 的 URL。它是仅允许读取 preview 路由的
capability，使浏览器与可读取图像的 Agent 无需获得 gateway 主 token 也能显示图像；gateway
重启后自动失效。操作方也可以用 `X-Director-Browser-Token` header 直接读取该路由。

## 获取精确浏览器 target

保持目标 Director tab 打开，并在所有 target-bound 操作前 observe：

```bash
curl -fsS -X POST "$BASE/api/tools/director_workbench" \
  -H "X-Director-Browser-Token: $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"op":"observe","fields":["counts","cameras","production"]}' \
  > /tmp/director-observe.json

TARGET="$(jq -c '.target' /tmp/director-observe.json)"
TARGET_TOKEN="$(jq -r '.target.token' /tmp/director-observe.json)"
REVISION="$(jq -r '.result.project_revision' /tmp/director-observe.json)"
```

Target 是 contract-v2 对象，包含 `token`、`client_id`、`instance_id`、`scene_id` 和
`creative_scope_id`。Session message 与 production run 携带完整对象；直接 tool call 携带
`target_token`。Gateway 会将其解析回同一个完整 target 并校验响应，绝不会把精确请求重定向到
其他 tab。

`director_workbench` 的 `capabilities`、`catalog`、`observe` 不需要 target；检查 catalog asset
也不需要 target。其他 Workbench 操作必须携带 `target_token`。`director_creative` 只有
`capabilities` 与 `observe` 不需要 target。

## 调用结构化工具

公开 tool path 为：

```text
/api/tools/stage_read
/api/tools/stage_scene
/api/tools/stage_object
/api/tools/stage_camera
/api/tools/stage_show
/api/tools/director_workbench
/api/tools/director_creative
/api/tools/stage_video
```

Body 可以直接包含 operation。`session_id` 与 `target_token` 是 envelope 字段，其余字段由对应
工具的严格运行时 schema 解析。

下面执行一次有保护的原子 Workbench mutation：

```bash
curl -fsS -X POST "$BASE/api/tools/director_workbench" \
  -H "X-Director-Browser-Token: $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n \
    --arg target "$TARGET_TOKEN" \
    --arg revision "$REVISION" \
    '{
      session_id:"http-guide",
      target_token:$target,
      op:"author",
      expected_revision:$revision,
      idempotency_key:"http-guide-background-v1",
      quality_gate:"strict",
      actions:[{action:"set_scene",patch:{backgroundColor:"#222222"}}]
    }')" | jq
```

始终保留最新 observe 返回的 `project_revision`，并在 mutation 与证据捕获中作为
`expected_revision` 发送。同一个稳定 `idempotency_key` 只用于字节完全一致、结果不确定的重试。
HTTP 边界可以为 naive client 通过同 target preflight 补齐缺失 mutation guard；省略 key 时，
边界会为这次意图生成唯一 key 并在 `agent_boundary` 返回，只有原请求结果不确定时才复用它。
显式值能让意图和恢复过程更加清楚。

## Agent session

Agent 会话在 DeepSeek Harness（`vendor/deepseek-harness`）里。Director 不再提供
`/api/agent/sessions` 或 `/api/agent/runs`。先启动 Gateway，再运行 `npm run dsh` 生成 Director
overlay 并启动 DSH Web。
导演台 / 画布 / 视频 / Blender 工具 POST 到 `/api/tools/:name`。`GET /api/agent/profiles`
仍列出重建与影片规划用的 profile。

## 导入 Blender 场景

原始 `.blend` 导入使用上传 → 预览 → 应用三步协议。它与 Director 自己的
`export_blend` / `import_return_package` 往返完全分开。

直接上传文件字节，不要 JSON 编码，也不要包装成 multipart：

```bash
UPLOAD="$(curl -fsS -X POST \
  "$BASE/api/dcc/blender-scene/uploads?filename=$(printf '%s' 'set.blend' | jq -sRr @uri)" \
  -H "X-Director-Browser-Token: $TOKEN" \
  -H 'Content-Type: application/x-blender' \
  --data-binary @set.blend)"

PACKAGE_DIR="$(printf '%s' "$UPLOAD" | jq -r '.result.packagePath')"
PLAN_ID="$(printf '%s' "$UPLOAD" | jq -r '.result.plan.planId')"
REVISION="$(printf '%s' "$UPLOAD" | jq -r '.result.plan.targetRevision')"
```

也接受 `application/octet-stream`。filename query 必须以 `.blend` 结尾，上传上限为 512 MiB。
上传成功后，服务会后台运行 Blender，并返回已校验的 `director-blend-scene-v1` manifest 和
默认计划；默认选择场景包及所有支持的透视相机。

v1 只检查 Blender 的 active scene，并采样其 current frame。GLB 可以携带内嵌动画 clip，但
Director 不会映射或播放它们；导入的透视相机是该帧的静态相机。manifest 中的 timebase/帧范围
只用于审核，不会改写 Director 时间线。该 API 是批量上传、预览、应用，不是 Blender 实时同步。

若要改变选择，预览一个新的服务端持久计划：

```bash
PREVIEW="$(curl -sS -X POST "$BASE/api/tools/director_dcc" \
  -H "X-Director-Browser-Token: $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg package "$PACKAGE_DIR" '{input:{
    op:"preview_blend_scene_import",
    package_dir:$package,
    selection:{includeScene:true,cameraSourceIds:[]}
  }}')")"

PLAN_ID="$(printf '%s' "$PREVIEW" | jq -r '.result.plan.planId')"
REVISION="$(printf '%s' "$PREVIEW" | jq -r '.result.plan.targetRevision')"
```

Preview 永远不修改项目。选择或 ID 冲突会有意返回 HTTP `409`，但响应仍包含可读取的
`result.plan`、`ready:false`、warnings 和 conflicts。解决后重新 preview。

只应用服务端保存的原样 ready plan：

```bash
curl -fsS -X POST "$BASE/api/tools/director_dcc" \
  -H "X-Director-Browser-Token: $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg plan "$PLAN_ID" --arg revision "$REVISION" '{input:{
    op:"apply_blend_scene_import",
    plan_id:$plan,
    expected_revision:$revision,
    idempotency_key:("blender-scene-import-" + ($plan | gsub("[^A-Za-z0-9._-]";"-")))
  }}')" | jq
```

Apply 会重新校验 package/hash receipt 与当前 revision，重建计划，然后执行一次原子 authoring
mutation。idempotency key 只能用于同一意图结果不确定时的重试。成功后，
`result.copiedAssets[]` 返回每个 asset ID、SHA-256 与不可变 URL。场景 GLB 通过
`GET`/`HEAD /dcc-import/<hash-prefix>/<asset-id>.glb` 读取；路径穿越、symlink escape、非 GLB
路径及超过 512 MiB 的文件都会被拒绝。

原始 `.blend` 属于可信本地输入。Blender 启动时会禁用脚本/driver 自动执行，但这不是针对
Blender 原生解析器的 OS 或 container sandbox；私有 job 路径、限制和超时也不能让不可信文件
变得安全。不可信文件必须先在容器或虚拟机中处理。支持与降级边界见
[交换格式与 DCC 交接](/zh/pipelines/interchange/)。

## 分析参考图片

`POST /api/reconstruction/reference-scene/analyze` 接收版本化
`referenceSceneAnalysisRequestSchema`：当前工程 revision、追加/替换意图、`auto`/`vision`/`local`
模式、可选托管 Profile ID、有界物体数、规范化图片 base64、SHA-256、MIME 类型、文件名和本地图片
测量值。它只返回一份严格草稿计划，不会修改片场；浏览器必须在相同工程 revision 上应用该计划。

路由会在 provider 调用前拒绝哈希或 MIME 不一致。强制视觉模式会返回
`profile_unavailable`、`vision_profile_required` 或 `vision_failed`；自动模式可以返回
analysis status 为 `degraded`、mode 为 `local` 的计划。完整信任边界见
[参考图重建](/zh/editor/reference-reconstruction/)。

## 其他 HTTP domain

| Domain            | 路由                                                                          |
| ----------------- | ----------------------------------------------------------------------------- |
| Assistant planner | `POST /api/assistant/plan`、`POST /api/assistant/apply`                       |
| Production job    | `POST /api/canvas-jobs`、`GET /api/canvas-jobs/{id}`、`GET .../{id}/artifact` |
| Production state  | `/te-man/director/productions/{id}` 及其 `/scenes`；`/scenes/{id}/project`    |
| DCC               | `GET /api/dcc/status`，以及 bridge 文档中记录的版本化 DCC job 操作            |
| 参考图重建        | `POST /api/reconstruction/reference-scene/analyze`                            |
| 旧版 Stage        | `GET /api/stage`、`PUT /api/stage`                                            |

优先使用结构化工具而不是直接 `PUT /api/stage`：Workbench 操作会参与 revision、idempotency、精确
target、quality、asset、audit 和 evidence contract。

## 护栏与恢复

| HTTP/code                       | 恢复方式                                                                               |
| ------------------------------- | -------------------------------------------------------------------------------------- |
| `401 gateway_unauthorized`      | 重新 bootstrap，并使用新的 process token 重试一次。                                    |
| `403 origin_denied`             | 使用已配置的 loopback origin，或加入精确可信 origin；不要关闭 origin 检查。            |
| `428 target_required`           | Observe 目标 workspace，并携带其 `target_token`。                                      |
| `409 target_unavailable`        | 重新连接同一个 tab/scope 并 observe；不要重定向写入。                                  |
| `409 target_mismatch`           | 丢弃响应并获取新的 target lease。                                                      |
| `409 stale_project_revision`    | Observe、合并当前状态，使用最新 revision 与新 idempotency key 创建新意图。             |
| `409 stale_production_revision` | 重新 observe production、合并 manifest，再用新 key 提交新意图。                        |
| `409 idempotency_key_conflict`  | 保留旧回执；不同输入使用新 key。                                                       |
| `409 idempotency_replay_stale`  | 旧 mutation 已成功但项目继续前进；observe 后只把剩余工作表达为新意图。                 |
| `409 outcome_unknown`           | 先 observe/diff；效果不存在时，只能用 `agent_boundary` 中的注入 revision 与 key 重试。 |
| `504 command_timeout`           | 不要声称成功；保持 target 可见，必要时 observe，再重试读取/证据操作。                  |
| `profile_unavailable`           | 选择可用且 provider 匹配的 Profile，并检查 credential。                                |
| `profile_capability_mismatch`   | 选择具有 tools 的 Profile；Visual Critic 还必须具有 vision。                           |

不要仅为绕过冲突而使用 `unconditional:true`。HTTP 成功状态也不能证明视觉质量；必须检查无辅助线的
clean frame 与 audit/delivery 回执。
