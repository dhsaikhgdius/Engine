---
title: HTTP、CLI 与浏览器
description: 不依赖 MCP host 使用 Director。
---

所有控制面最终都汇聚到同一套 gateway 执行与校验层。

## CLI

CLI 将一个工具名和一段 JSON 对象（`{"op":"..."}`）转发到本地 gateway。
`npm run stage -- --help` 会打印工具列表。优先使用 MCP 对外暴露的同名工具：

```bash
npm run stage -- director_workbench '{"op":"observe"}'
npm run stage -- director_workbench '{"op":"describe","target":"author.add_object"}'
npm run stage -- director_creative '{"op":"observe"}'
npm run stage -- director_dcc '{"op":"status"}'
```

`stage_read`、`stage_scene`、`stage_object`、`stage_camera`、`stage_show` 是遗留的紧凑
`StageScene` 接口。它们仍可通过 HTTP 使用，但 MCP 不再向模型暴露。
`kind:"cube"` 属于紧凑协议。公开的 `director_workbench` `author` 调用应实例化 catalog
网格，并会拒绝 Stage `geometry_type` 简单几何体。

配置：

```bash
export STAGE_GATEWAY_URL=http://127.0.0.1:8787
export STAGE_AGENT_SESSION=cli-default
export DIRECTOR_TARGET_TOKEN=<可选的已观察 target.token>
```

对 `director_workbench` 和 `director_creative`，一条带目标的 CLI 命令即可：未绑定 target 时，CLI 会在同一进程执行只读 `observe`，锁定返回的精确浏览器 target，在操作接受 guard 时注入观察到的 revision 或 fingerprint，然后执行请求。租约按 `STAGE_AGENT_SESSION` 在后续调用间保留。`DIRECTOR_TARGET_TOKEN` 显式固定已观察 target，优先级始终高于本地 session 缓存。CLI 输出保留 `code`、`feedback`、`suggested_next`/`recovery` 与 target 元数据，省略冗余的完整场景与二进制图像载荷。

## HTTP

工具路由使用：

```text
POST /api/tools/{tool-name}
```

原始 HTTP 客户端需要先 bootstrap loopback gateway token。内置 CLI、MCP server 和浏览器客户端会自动完成：

```bash
DIRECTOR_TOKEN="$(curl -fsS -X POST http://127.0.0.1:8787/te-man/director/agent/bootstrap \
  -H 'content-type: application/json' \
  -d '{}' | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).browserToken')"
```

示例：

```bash
curl -sS http://127.0.0.1:8787/api/tools/stage_object \
  -H 'content-type: application/json' \
  -H "x-director-browser-token: $DIRECTOR_TOKEN" \
  -d '{
    "session_id": "my-agent",
    "input": {
      "op": "create",
      "ref": "hero",
      "kind": "humanoid"
    }
  }'
```

需要跨请求保留 ref 别名时，显式设置 `session_id`。

Workbench 与 Creative HTTP 调用会绑定到精确的浏览器目标。先无 token 观察，并从响应中复制 `target.token`：

```bash
curl -sS http://127.0.0.1:8787/api/tools/director_creative \
  -H 'content-type: application/json' \
  -H "x-director-browser-token: $DIRECTOR_TOKEN" \
  -d '{"input":{"op":"observe"}}'
```

后续调用把 token 放在顶层：

```bash
curl -sS http://127.0.0.1:8787/api/tools/director_creative \
  -H 'content-type: application/json' \
  -H "x-director-browser-token: $DIRECTOR_TOKEN" \
  -d '{
    "target_token": "<target.token>",
    "input": {"op":"audit","scope":"all","quality_profile":"production"}
  }'
```

缺少 token 时 HTTP 返回 `428 target_required`；绑定的 tab、场景或 scope 不再存在时返回 `409 target_unavailable`。
请重新观察，不要对其他 tab 重试。浏览器认证 token 与精确目标 token 用途不同：前者通过 header 授权访问本地
gateway，后者把操作固定到观察到的 Director 工作区。gateway 重启后默认 browser token 会轮换，收到 `401` 后重新 bootstrap。

## 浏览器 API

编辑器通过 `window.stageAgent` 暴露同页集成接口：

```js
await window.stageAgent.scene({ op: "validate" });
await window.stageAgent.object({ op: "create", kind: "sphere", position: [1, 0, 0] });
await window.stageAgent.camera({ op: "frame", shot: "medium" });
await window.stageAgent.show({ op: "play" });
```

管线调用也在同一对象上：

```js
await window.stageAgent.video({
  op: "prepare",
  prompt: "Preserve the exact blocking and camera composition",
});

const creative = await window.stageAgent.creative({ op: "observe" });
console.log(creative.result);
```

## 选择控制面

| 需求                          | 推荐控制面                   |
| ----------------------------- | ---------------------------- |
| 完整 Agent 原生制作流程       | MCP `director_workbench`     |
| Canvas 与 Video Editor 自动化 | MCP/HTTP `director_creative` |
| Shell 脚本或 CI 冒烟测试      | CLI                          |
| 服务集成                      | HTTP                         |
| 同页自动化或宿主嵌入          | Browser API                  |
| 人类搭景与视觉审阅            | Director UI                  |

同一操作存在语义工具时，不要使用坐标点击。
