---
title: 生产部署清单
description: 从本地 Director gateway 到小团队部署的最短受支持配置路径。
---

本页是把 Director 从单人本地操作扩展为小团队部署的最小清单。这里只列出当前已实现并有测试的
内容；边界以[功能状态](/zh/reference/feature-status/)页为准，每个变量的细节见
[配置](/zh/reference/configuration/)参考。

:::caution
Director 面向公网的加固仍为 **Limited**。gateway 只绑定 loopback；生产部署必须放在你自己的
TLS 终结反向代理之后，网络访问控制由你负责。不要直接暴露 gateway 端口。
:::

## 1. 固定 gateway 身份

| 步骤                                                         | 设置                                                    |
| ------------------------------------------------------------ | ------------------------------------------------------- |
| 固定 gateway token（≥ 24 字符），使 Agent 与浏览器跨重启存活 | `DIRECTOR_GATEWAY_TOKEN`                                |
| 为部署后的 UI URL 配置可信浏览器 origin                      | `DIRECTOR_ALLOWED_ORIGINS=https://director.example.com` |
| 把可变数据根目录放在持久存储上（run、任务、媒体、快照）      | `DIRECTOR_DATA_DIRECTORY=/srv/director/data`            |

## 2. 启用协作房间鉴权

本地信任模式（默认）会让每个已通过升级鉴权的 socket 以 editor 身份加入——单机正确，团队错误。

| 步骤                                                     | 设置                                         |
| -------------------------------------------------------- | -------------------------------------------- |
| 每次加入房间都要求签名邀请 token                         | `DIRECTOR_COLLAB_ROOM_AUTH=required`         |
| 稳定的邀请签名 secret（否则邀请随每次重启失效）          | `DIRECTOR_COLLAB_INVITE_SECRET`              |
| 持久化 Yjs 房间快照（压缩 + 损坏更新隔离）与邀请吊销列表 | `DIRECTOR_COLLAB_PERSISTENCE=1`              |
| 可选：为快速重连保留空房间的内存文档                     | `DIRECTOR_COLLAB_EMPTY_ROOM_TTL_SECONDS=300` |

用 master gateway token 铸造邀请：

```bash
curl -X POST "$GATEWAY_URL/api/collab/invites" \
  -H "X-Director-Browser-Token: $DIRECTOR_GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"room":"project-a/*","role":"editor","ttl_seconds":86400}'
```

`role` 为 `editor`（读写）或 `viewer`（只接收 + awareness）。`room` 接受精确房间 id 或
`prefix/*` 前缀 capability。把返回的 token 通过 `VITE_DIRECTOR_COLLAB_INVITE_TOKEN` 或你自己的
邀请流程交给浏览器。

泄露的邀请用同一 master token 吊销：`POST /api/collab/invites/revoke` 携带 `{"token":"…"}`
按 `jti` 吊销单个邀请，携带 `{"room":"project-a/*"}` 则设置截止点，拒绝该范围内不晚于吊销时刻
铸造的所有邀请。日常运维方面：`GET /api/collab/rooms` 报告成员计数、快照年龄、隔离区计数与鉴权模式；
`GET /api/collab/rooms/quarantine?room=…` 列出某房间被隔离的损坏更新；
`POST /api/collab/rooms/close`（可选 `"archive": true`）会用 `room_closed` 错误踢出所有成员，
并刷入——或归档——持久历史。本地信任模式下，被关闭的房间可以被任何本地客户端重新创建；
需要真正终止访问时，请把关闭与邀请吊销组合使用。

## 3. 配置托管 multi-agent run（可选）

托管 production run 用服务端持有的模型 Profile 执行 observe-only 影片角色。

| 步骤                     | 设置                                                                       |
| ------------------------ | -------------------------------------------------------------------------- |
| 服务端持有的托管 Profile | `DIRECTOR_AGENT_PROFILES_JSON`（+ `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`） |
| 可选的按角色路由         | `DIRECTOR_AGENT_ROLE_PROFILES_JSON`                                        |

run 接受串行 `roles` 列表，或由节点和 `dependsOn` 边组成的显式 `graph`；独立分支按并行波次
执行，`POST /api/agent/runs/:id/resume` 携带 `{"from_node_id":"…"}` 可从持久 checkpoint 节点
重跑。

## 4. 按需配置媒体与生成 provider

每个 provider 都是可选的，未配置时上报显式状态而不是崩溃：媒体转码用
`DIRECTOR_FFMPEG_PATH`/`DIRECTOR_FFPROBE_PATH`，film 管线用 `DIRECTOR_FILM_LLM_*` /
`DIRECTOR_FILM_IMAGE_*` / `DIRECTOR_FILM_VIDEO_*`，生成 provider 见[配置](/zh/reference/configuration/)参考。

## 5. 邀请团队前先验证

```bash
npm run build            # typecheck + chunk 预算 + 便携 MCP 插件
npm test                 # 完整 vitest 套件
curl "$GATEWAY_URL/health"
# → {"ok":true,...,"collaboration":{"mode":"invite-required","persistence":true,...}}
curl -H "X-Director-Browser-Token: $DIRECTOR_GATEWAY_TOKEN" "$GATEWAY_URL/api/collab/auth"
# → {"mode":"invite-required"}
```

此时未认证的 `collab.join` 必须收到 code 为 `unauthorized` 的 `collab.error`。
启用团队鉴权时确认 `/health` 上 `collaboration.mode === "invite-required"`；邀请 capability
token 与自声明的 awareness 身份不是按用户账号体系。

## 明确不在范围内

- 没有你自己的反向代理、TLS 与网络策略就直接暴露公网。
- 多节点 gateway 集群与可插拔对象存储。
- 按用户账号体系：邀请是 capability token，不是身份系统。
