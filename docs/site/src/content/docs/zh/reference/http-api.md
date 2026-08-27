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

| Method | Path                                | 结果                                |
| ------ | ----------------------------------- | ----------------------------------- |
| `GET`  | `/health`                           | 无需鉴权的进程状态与 browser 数     |
| `GET`  | `/api/control-plane/capabilities`   | 已脱敏的 Agent 与视频配置           |
| `GET`  | `/api/control-plane/tool-manifest`  | 机器可读的 Director tool catalog    |
| `GET`  | `/api/control-plane/a2a-agent-card` | 仅用于发现的 A2A 风格 agent card    |
| `GET`  | `/api/agent/providers`              | 本地/API session provider 可用性    |
| `GET`  | `/api/agent/profiles`               | Profile 公开元数据与模型 capability |
| `GET`  | `/api/video/providers`              | 视频 provider 的实时 capability     |
| `GET`  | `/api/dcc/status`                   | Blender/DCC bridge 状态             |
| `GET`  | `/api/stage`                        | 旧版 StageScene projection          |
| `GET`  | `/api/preview`                      | 最近一次 capture，读取需要鉴权      |

```bash
curl -fsS "$BASE/api/agent/profiles" \
  -H "X-Director-Browser-Token: $TOKEN" | jq '.profiles[]'
```

发现响应不会包含模型 API key、worker credential 或原始 credential 环境变量名。

`GET /api/control-plane/tool-manifest` 返回 `director-tool-manifest-v1` catalog：每个 Director
工具的 surface（`mcp`、`http` 或 `both`）、category、wire `op` 枚举，以及存在时的 HTTP 绑定。
类型化工具绑定到 `POST /api/tools/<name>`；`stage_*` 条目标记为 `legacy`（HTTP-only 兼容层，
MCP 不再对模型公布）；`director_film` 与 `director_production` 的 `http` 为 `null`，因为它们的
HTTP 面是各自的 domain 路由（`/api/film/runs`、`/api/production/*`），不是 `/api/tools/<name>`。
精确的逐操作 JSON Schema 请使用各工具的 `describe` 操作；manifest 有意保持为 catalog。

```bash
curl -fsS "$BASE/api/control-plane/tool-manifest" \
  -H "X-Director-Browser-Token: $TOKEN" | jq '.tools[] | {name, surface, legacy}'
```

`GET /api/control-plane/a2a-agent-card` 返回 [ADR 0004](/zh/engineering/adr/0004-a2a-gateway-spike/)
决定的 `director-a2a-agent-card-v1` 卡片。它**仅用于发现**：Director 不运行 A2A JSON-RPC
server（`a2a.jsonrpc_endpoint` 为 `null`；streaming 与 push notification 均为 `false`），`url`
是 loopback gateway origin 而非公网 A2A 服务，skills 镜像实时 tool manifest 中的
`director_workbench`、`director_creative`、`blender_native` 与 `stage_video`。执行请走 MCP 或
`POST /api/tools/{tool}`，而不是 A2A。

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
/api/tools/blender_native
/api/tools/director_dcc
/api/tools/director_game
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

上传、预览、应用返回的每个计划都会在类型化的 `result.plan.omitted[]`（与 `omittedCount` 配对）中
声明被放弃的内容：`unsupported_object`（extractor 跳过的数据块，附 Blender `kind`）、
`hierarchy_flattened`（场景合并为单一 Director 场景对象导入）、`animation_actions`（内嵌动作未映射
到时间线）与 `camera_roll_lens_shift`（逐台导入相机）。free-text `warnings` 仍面向人类；请读取
类型化记录而不是解析警告文本。

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

## 引擎交接（Unreal / Unity / Godot）

`director_dcc` 还会通过 `integrations/{unreal,unity,godot}` 中的 Director 官方连接器跑无头引擎往返。
先查就绪状态；`nativeReady` 要求连接器文件、带版本探测的可执行文件，以及连接器已安装到配置的引擎工程。
Godot 还额外要求 `project.godot` 中已启用该插件，以及有效的固定入口 `--mode health` JSON 输出
（仅限 Godot 4.x，连接器版本须与工作区一致）：

```bash
curl -fsS -X POST "$BASE/api/tools/director_dcc" \
  -H "X-Director-Browser-Token: $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"input":{"op":"status","provider":"godot"}}' | jq
```

把当前项目送入引擎。Gateway 把交换包导出到私有作业目录，调用固定连接器入口（绝不用请求提供的脚本），
并返回经 schema 校验的主机报告。对 Godot，Gateway 还会把时间线动画烘焙成哈希固定的
`animation.json` 边车文件，由连接器写入 `AnimationPlayer`/`AnimationLibrary` 关键帧；报告中携带
从已保存场景读回的 Godot 专属回执（轨道/关键帧/灯光/骨架/材质/纹理计数）：

```bash
curl -sS -X POST "$BASE/api/tools/director_dcc" \
  -H "X-Director-Browser-Token: $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"input":{"op":"send_to_engine","provider":"godot","formats":["glb"]}}' | jq
```

连接器未就绪时，路由返回 `409 engine_not_ready` 以及结构化 `diagnostics`（`provider`、`mode`、
`ready`、`warnings`、`recovery`），而不是裸失败。按 recovery 步骤设置 `DIRECTOR_GODOT_BIN` /
`DIRECTOR_GODOT_PROJECT` 并安装插件，或回退到 `export_exchange_package`。

当 `provider: "unreal"` 时，Gateway 还会把项目动画逐帧采样为私有作业目录内哈希锁定的
`director-unreal-sequencer-bake-v1` sidecar。连接器据此为 LevelSequence 打关键帧，返回的报告可携带
Unreal 专有字段：`sequencer` 回执（从已创作资产回读的显示帧率、tick 分辨率、起始时间码、播放范围、
轨道与关键帧数量）以及 `importedSkeletalMeshCount` 与 `appliedMaterialCount`。烘焙失败会降级为带警告
的静态导入；sidecar 被篡改则任务失败。

把引擎侧编辑带回来时，使用与 Blender 回传相同的预览再 Apply 协议。引擎回传包携带 canonical
Director 空间变换，因此必须显式传入产生该包的提供商：

```bash
PREVIEW="$(curl -sS -X POST "$BASE/api/tools/director_dcc" \
  -H "X-Director-Browser-Token: $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"input":{"op":"receive_from_engine","provider":"godot","package_dir":"JOB_ID/return-package"}}')"

curl -fsS -X POST "$BASE/api/tools/director_dcc" \
  -H "X-Director-Browser-Token: $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "$(printf '%s' "$PREVIEW" | jq '{input:{
    op:"apply_import_plan",
    provider:"godot",
    plan:.result.plan,
    expected_revision:.result.plan.targetRevision,
    idempotency_key:("godot-return-" + .result.plan.packageId)
  }}')" | jq
```

`receive_from_engine` 接受与 `import_return_package` 相同的可选 `skip_director_ids` 列表和
`include_new_objects` 选择加入；未选择加入时，引擎 `object_addition` 条目保持为可审阅的 skip。Apply
受 revision 保护且幂等；冲突返回 `409` 以及只读计划。

### 引擎场景导入（Unreal / Unity / Godot）

把已有引擎场景作为 `director-engine-scene-v1` 包带进 Director。可以对本地工程无头运行已安装的
引擎，也可以把引擎内导出器写出的 `.zip` 上传到
`POST /api/dcc/engine-scene/uploads?provider=unreal|unity|godot&filename=scene.zip`
（`Content-Type: application/zip`，完全不依赖引擎安装）：

```bash
curl -sS -X POST "$BASE/api/tools/director_dcc" \
  -H "X-Director-Browser-Token: $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"input":{"op":"extract_engine_scene","provider":"godot","project_dir":"GodotProject","scene":"res://scenes/main.tscn"}}' | jq
```

两条路径都返回已校验的包和初始计划。预览与应用走同一套 revision 保护纪律
（`preview_engine_scene_import` 可带 `selection`，随后 `apply_engine_scene_import` 带
`plan_id`、`expected_revision` 与 `idempotency_key`）。

### Unreal 实时预览（网关 → 编辑器回环）

相机推送通道，把 Director 相机帧送进 Unreal 编辑器视口。先在引擎环境启动连接器监听
（`director_headless.py --mode live-preview`，读取 `DIRECTOR_UNREAL_PREVIEW_TOKEN`），在网关
设置同一令牌，然后对其打印的回环端口开启会话。相机帧仍只用于预览；网关只读取与自己已发送命令
匹配且通过 schema 校验的回执。把引擎权威快照投影到 Director 仍是另一条带 revision 保护的操作。

```bash
SESSION="$(curl -fsS -X POST "$BASE/api/dcc/unreal/live-preview/sessions" \
  -H "X-Director-Browser-Token: $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"port":42813}' | jq -r '.result.session.sessionId')"

curl -fsS -X POST "$BASE/api/dcc/unreal/live-preview/sessions/$SESSION/frames" \
  -H "X-Director-Browser-Token: $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"seq":1,"transform":{"location":[0,1.7,5],"rotationQuaternion":[0,0,0,1],"scale":[1,1,1]},"focalLengthMm":35}' | jq

curl -fsS -X DELETE "$BASE/api/dcc/unreal/live-preview/sessions/$SESSION" \
  -H "X-Director-Browser-Token: $TOKEN" | jq
```

`GET /api/dcc/unreal/live-preview/sessions` 列出会话；重复或乱序的序号作为结构化
`sent: false` 结果丢弃，不是 HTTP 错误。工作台「DCC / 引擎交接」坞的 Unreal 页提供同样的
推送控制。

### 独立引擎截图

`render_engine_frame` 是三引擎共同的视觉验收原语，不需要再次 `send_to_engine`。Unreal 选择先前的
send job，Unity/Godot 渲染配置工程中的场景：

```bash
curl -fsS -X POST "$BASE/api/tools/director_dcc" \
  -H "X-Director-Browser-Token: $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"input":{"op":"render_engine_frame","provider":"godot","scene":"res://scenes/main.tscn","width":1280,"height":720}}' | jq
```

### 引擎编辑器启动与项目运行

与社区 godot-mcp / unity-mcp 工具同精神的本地可信引擎进程操作，收进 `director_dcc`：
网关只会用固定参数向量、对配置好的 `DIRECTOR_*_PROJECT` 启动已发现的引擎可执行文件——
这些进程操作绝不执行请求提供的脚本，运行输出也是有界尾部。显式授权的编辑器代码属于下文独立的
引擎会话命令。

```bash
curl -fsS -X POST "$BASE/api/tools/director_dcc" \
  -H "X-Director-Browser-Token: $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"input":{"op":"launch_engine_editor","provider":"godot"}}' | jq

curl -fsS -X POST "$BASE/api/tools/director_dcc" \
  -H "X-Director-Browser-Token: $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"input":{"op":"run_engine_project","provider":"godot","scene":"res://scenes/main.tscn","headless":true}}' | jq

curl -fsS -X POST "$BASE/api/tools/director_dcc" \
  -H "X-Director-Browser-Token: $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"input":{"op":"engine_run_status","provider":"godot"}}' | jq '.result.state, .result.output'

curl -fsS -X POST "$BASE/api/tools/director_dcc" \
  -H "X-Director-Browser-Token: $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"input":{"op":"stop_engine_project","provider":"godot"}}' | jq
```

`launch_engine_editor` 三引擎可用（Unreal 的控制台二进制会映射到其 GUI 兄弟）。项目运行
目前仅 Godot：Unity 播放模式与 Unreal `-game` 运行需要 Director 尚未声明的引擎侧支持，
因此返回 `501 engine_run_unsupported` 及 recovery 步骤。运行已存在时返回
`409 engine_run_active`；停止时 SIGTERM 两秒后升级为 SIGKILL。

### Opt-in 引擎常驻工作台

`start_engine_session` 接入已经打开的 Unity 或 Godot 编辑器：Unity 使用 **Director / Live Link
Preview** 返回的 grant，Godot 接入当前活跃的出站 live-preview 会话。Unreal 接入令牌保护的监听器，
因此还必须传入其打印的 `port`。`allow_code` 与引擎权威都默认关闭，必须显式开启：

```bash
curl -fsS -X POST "$BASE/api/tools/director_dcc" \
  -H "X-Director-Browser-Token: $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"input":{"op":"start_engine_session","provider":"unity","label":"Gameplay lookdev","allow_code":true,"authority":"engine"}}' | jq

curl -fsS -X POST "$BASE/api/tools/director_dcc" \
  -H "X-Director-Browser-Token: $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"input":{"op":"engine_session_command","provider":"unity","session_id":"SESSION_ID","command":"execute_code","code":"var room = new GameObject(\"GameplayRoom\"); return room.name;"}}' | jq

curl -fsS -X POST "$BASE/api/tools/director_dcc" \
  -H "X-Director-Browser-Token: $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"input":{"op":"engine_session_command_status","provider":"unity","session_id":"SESSION_ID","command_id":"COMMAND_ID"}}' | jq
```

Unity 与 Godot 还支持热 `capture_frame`；Unreal 的干净像素走 `render_engine_frame`。三引擎在
`authority:"engine"` 会话中都支持 `sync_scene`；状态完成后，再用 command id、当前
`expected_revision` 与 `idempotency_key` 调用 `sync_engine_session_to_director`。只有匹配稳定 ID 的
变换与相机审阅数据进入 Director；脚本、Prefab/场景结构、碰撞、导航、灯光烘焙与 UI 仍由引擎工程
权威保存。`stop_engine_session` 关闭作用域 grant。

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

| Domain            | 路由                                                                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Assistant planner | `POST /api/assistant/plan`、`POST /api/assistant/apply`                                                                                       |
| Production job    | `POST /api/canvas-jobs`、`GET /api/canvas-jobs/{id}`、`GET .../{id}/artifact`                                                                 |
| Production state  | `/te-man/director/productions/{id}` 及其 `/scenes`；`/scenes/{id}/project`                                                                    |
| Film 管线         | `GET/POST /api/film/runs`、`GET /api/film/runs/{id}`、`GET .../{id}/receipt`、`POST .../{id}/resume\|cancel\|approve`                         |
| DCC               | `GET /api/dcc/status`，以及 bridge 文档中记录的版本化 DCC job 操作                                                                            |
| 参考图重建        | `POST /api/reconstruction/reference-scene/analyze`                                                                                            |
| 可观测性          | `GET /api/agent/traces`、`GET /api/agent/traces/summary`、`GET /api/agent/traces/sessions`、`GET /api/agent/usage`、`GET /api/agent/progress` |
| 存储运维          | `GET /api/storage/health`、试运行 `POST /api/storage/gc/plan`、需确认的 `POST /api/storage/gc/sweep`                                          |
| 旧版 Stage        | `GET /api/stage`、`PUT /api/stage`                                                                                                            |

Film 路由在列表响应上显式上报管线配置状态（`pipeline: {configured, reason, capabilities}`，其中
`capabilities` 以各自的 `{configured, reason}` 上报可选的对白 TTS 与 Stage 锚点捕捉就绪状态），
失败响应携带冻结的
public code（`film_pipeline_unconfigured`、`invalid_request`、`invalid_run_id`、`run_not_found`），
并在 status、receipt 与动作响应上附带归一化的 `director-film-run-receipt-v1`（阶段收据、稳定错误
码、产物路径及读取时实测的按产物 `storagePresence`——`present`/`absent`，未声明路径为 null，另对
每个声明了已渲染场景视频的场景附带一条 `sceneVideos[]` 实测结论）。resume 在重新渲染/拼装前清除字节缺失的场景/成片/时间线声明，使控制路径与同一探测一致。
receipt 的 `artifacts.timelineExport` 携带与 `timelinePath` 一同落盘的类型化 OTIO 导出收据：
计划/导出镜头计数与逐镜头 `omittedShots[]`（代码 `clip_missing`），部分交接是类型化事实而非静默
跳过；早于类型化导出收据的 run 保持 null。receipt 的 `capabilityOmissions[]` 记录 run 请求了但
被跳过的可选能力，携带稳定代码（`tts_unconfigured`、`anchor_hook_unavailable`，以及精确到场景的
`anchor_resolution_failed`），因此没有配音或白盒锚定就渲染完成的 run 是类型化事实而非自由文本
事件。provider 未配置时 cancel 仍然可用。

可观测性路由返回经 redaction 的执行回执、模型用量聚合，以及生产任务、multi-agent run 与 film run
共用的统一 progress；`/traces/sessions` 列出紧凑的逐 session 聚合，`/progress` 附带按 state/kind
零填充的计数。工具调用可通过 `x-director-trace-source: ui|mcp|http|cli` 头自报入口来源；
未知或缺失的值记录为 `http`。轨迹回执从不包含提示词、工具载荷或密钥——错误文本与 capture 引用
都在落盘前 redaction。

存储健康执行两项实时检查而非默认后端健康：`capacity` 容量测量（文件系统后端经 `statfs` 实测；
不可测时为 typed `capacity_unsupported`/`capacity_probe_failed` 省略）与 put→get→delete
`writeProbe`——探针会把对象字节读回并做内容比对（不只看 `head` 大小），成功时盖章
`bytesProbed`，失败时报告确切步骤（`put_failed` / `verify_failed` / `delete_failed`）。
get 路径损坏或回读内容不一致的后端会在 verify 失败，而不会被误报为可写。清扫是破坏性操作：`POST /api/storage/gc/sweep` 必须以 `confirm`
回显所审阅的计划 id，且重放幂等。由于审阅窗口内系统仍在变化，清扫在删除前会对照最新 job 记录与
对象新鲜度重新校验计划：计划内又被 job 引用的 key（例如重新暂存的内容寻址输入）或计划之后被改写
的对象会被跳过而非删除。每个被跳过的 key 都带 typed code——`became-reachable`、
`modified-since-plan`、`already-absent` 或携带后端原因的 `delete-failed`——清扫结果、持久化审计
日志与健康报告的 `recentSweeps` 均上报 `skippedByReason` 计数。

优先使用结构化工具而不是直接 `PUT /api/stage`：Workbench 操作会参与 revision、idempotency、精确
target、quality、asset、audit 和 evidence contract。

## 护栏与恢复

| HTTP/code                         | 恢复方式                                                                                                                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `401 gateway_unauthorized`        | 重新 bootstrap，并使用新的 process token 重试一次。                                                                                                                                                                 |
| `403 origin_denied`               | 使用已配置的 loopback origin，或加入精确可信 origin；不要关闭 origin 检查。                                                                                                                                         |
| `428 target_required`             | Observe 目标 workspace，并携带其 `target_token`。                                                                                                                                                                   |
| `409 target_unavailable`          | 重新连接同一个 tab/scope 并 observe；不要重定向写入。                                                                                                                                                               |
| `409 target_mismatch`             | 丢弃响应并获取新的 target lease。                                                                                                                                                                                   |
| `409 stale_project_revision`      | Observe、合并当前状态，使用最新 revision 与新 idempotency key 创建新意图。                                                                                                                                          |
| `409 stale_production_revision`   | 重新 observe production、合并 manifest，再用新 key 提交新意图。                                                                                                                                                     |
| `409 idempotency_key_conflict`    | 保留旧回执；不同输入使用新 key。                                                                                                                                                                                    |
| `409 idempotency_replay_stale`    | 旧 mutation 已成功但项目继续前进；observe 后只把剩余工作表达为新意图。                                                                                                                                              |
| `409 outcome_unknown`             | 先 observe/diff；效果不存在时，只能用 `agent_boundary` 中的注入 revision 与 key 重试。                                                                                                                              |
| `403 possession_scope_violation`  | 该 session 处于人物占有（possess）中，只能改写被占有人物；`replace_project`、`reconstruction.apply` 等全场写入会被拒绝。读取类型化 `possession` 块（被占有 id、违规 operation、reason）后重新定位目标，或解除绑定。 |
| `400 possession_target_ambiguous` | 该 session 占有多个人物，省略的人物目标无法自动填充。读取 `possession.omitted_targets`，显式指定一个被占有 id。                                                                                                     |
| `504 command_timeout`             | 不要声称成功；保持 target 可见，必要时 observe，再重试读取/证据操作。                                                                                                                                               |
| `profile_unavailable`             | 选择可用且 provider 匹配的 Profile，并检查 credential。                                                                                                                                                             |
| `profile_capability_mismatch`     | 选择具有 tools 的 Profile；Visual Critic 还必须具有 vision。                                                                                                                                                        |

不要仅为绕过冲突而使用 `unconditional:true`。HTTP 成功状态也不能证明视觉质量；必须检查无辅助线的
clean frame 与 audit/delivery 回执。
