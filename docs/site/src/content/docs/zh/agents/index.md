---
title: Agent 控制
description: 将 Agent 接入 Director,通过经过校验且与 provider 无关的接口控制制片状态。
---

Director 面向 Agent 原生设计:同一份制片状态可以通过 UI、MCP 工具、HTTP、CLI 或浏览器 API
控制——每个接口上的守卫和证据规则完全一致。本页中的陌生术语见[术语表](/zh/concepts/glossary/)。

## 三步接入

1. **启动 Director**:运行 `npm run dev`,并保持一个浏览器标签页停留在目标工作区。只有当
   Director 浏览器连接到网关时,可写的 Agent 目标才存在。
2. **接入客户端**:让任意 MCP 客户端指向仓库中的 `.mcp.json`,或使用内置工作台面板,
   也可以直接从 CLI 开始:

   ```bash
   npm run stage -- director_workbench '{"op":"capabilities"}'
   ```

3. **先观察再写入**:第一次 observe 会把会话绑定到精确目标,并返回后续每个 mutation 都必须
   作为守卫携带的 `project_revision`:

   ```bash
   npm run stage -- director_workbench '{"op":"observe","fields":["scene","objects","cameras"]}'
   ```

## 选择接口

| 工具                 | 负责范围                           | 适用场景                                             |
| -------------------- | ---------------------------------- | ---------------------------------------------------- |
| `director_workbench` | 完整 DirectorProject 与 Stage 证据 | 场景、对象、角色、相机、时间线、coverage、审计、交付 |
| `director_creative`  | 画布与视频工作区                   | 节点、连线、媒体剪辑、轨道、预览、撤销/重做          |
| `stage_video`        | 生成任务                           | 准备、提交/渲染、轮询、取消                          |
| `director_dcc`       | DCC 交接                           | 能力发现、Blender 导出/状态                          |

`stage_*` 工具仍作为紧凑兼容接口,服务白模场景协议和现有 Stage v5 客户端。新的自动化
应优先使用 `director_workbench`。

## 支持的 provider harness

内置 Agent 工作台可以连接:

- **Codex**:通过 `codex app-server`;
- **Claude Code**:通过流式 JSON CLI 与项目 MCP 配置。

制片协议不绑定这些 provider,任何 MCP 客户端都可以使用同一套工具。

## 已验证的创作循环

```text
发现能力/目录
  → 观察精确目标与并发守卫
  → 原子地修改一个意图
  → 观察并检查效果
  → 审计制片质量
  → 预览或交付并检查像素
```

每一步都封堵一种特定的失败模式:

- `observe` 防止 Agent 虚构 ID 或依据过期假设操作;
- `author` 把一个意图组合成一个经过校验且可撤销的 mutation,幂等键让完全相同的网络重试安全;
- `audit` 检查引用、落地、重叠、时间线范围和相机空间构图;
- `correct` 只应用绑定到返回审计 token 的已验证建议;
- `deliver` 用无辅助元素的干净画面、Shot IR 和带哈希的多通道包证明当前修订号。

对于 3D 片场,并发守卫是 `project_revision`,`deliver` 是最终证据边界。如果交付被阻塞,
执行 `audit → correct(audit_token) → audit`,然后重试交付。只有当结果没有视觉成分时,
才使用更短的 `observe → author → audit` 循环。

画布与视频使用独立的并发 token,因为它们是按场景隔离的浏览器 store:

```text
capabilities → observe(target + snapshot_fingerprint) → execute_batch → observe → audit → preview
```

`preview` 返回指纹绑定、无辅助元素的 PNG,覆盖完整画布板或视频时间线上的精确时刻,且不会
移动播放头。别名、原子回滚、预览和幂等重试详见
[画布与视频 Agent](/zh/agents/creative-workspaces/)。

## 守卫、重试与恢复

observe 会把 provider 会话绑定到精确的浏览器标签页、项目实例、场景和创意作用域。目标的
任一部分发生变化时,Director 返回 `target_unavailable`,而不是把写操作重定向到别处;
此时应重新观察,而不是复用其他标签页的 lease。

`idempotency_key` 只能用于字节完全相同的重试。如果 mutation 返回 `outcome_unknown`,先停下
来观察精确目标再决定:效果已存在就不要重试;效果不存在且原有前置条件仍成立,才用同一个键
重发完全相同的载荷。修改过的意图或变化了的守卫必须使用新键。

完整的逐错误码恢复契约——`stale_project_revision`、`idempotency_key_conflict`、
`idempotency_replay_stale`、`outcome_unknown`、`command_timeout` 和 `target_unavailable`——
见 [Agent 工作台的恢复表](/zh/agents/workbench/#冲突与不确定结果);
[故障排查](/zh/troubleshooting/)则按症状对应到同一组错误码。

## 人类锁定内容

`locked: true` 表示内容由用户拥有。除非请求明确授权解锁或强制覆盖,否则 Agent 不得更新或
删除锁定对象。
