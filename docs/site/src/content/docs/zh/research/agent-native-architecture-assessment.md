---
title: Agent-Native 架构符合性评估
description: 对照 Builder.io Agent-Native 架构框架，评估 Director 在五大原则与软件栈各维度上的符合程度。
---

本文档对照 [Builder.io：Agent-Native — The Next Architecture for Software](https://www.builder.io/blog/agent-native-architecture#where-agent-native-fits-in-the-software-stack) 的框架，评估 Director 是否符合 **agent-native**（而非 bolt-on AI）产品架构。

Last verified: **2026-08-25**。与 [Feature Status](/zh/reference/feature-status/) 对齐。

相关文档：

- [Agent-native Production](/zh/concepts/agent-native-production/) — Director 自身的 agent-native 控制循环与契约
- [Control surfaces](/zh/agents/control-surfaces/) — MCP、HTTP、CLI、Browser API 汇聚层
- [Feature Status](/zh/reference/feature-status/) — 各能力证据链与边界

## 总体结论

Director **整体方向符合 agent-native 定义**。在核心控制面、协议暴露和证据闭环上，明显强于「侧边栏聊天 + 部分 API」类产品；但 **尚未完全达到文章描述的理想态**，主要差距在 UI/Agent 能力对等、统一 action registry，以及团队治理层。

**综合评分：约 4/5** — 在 agent-native 产品里属于设计先行、实现较完整的一档。

---

## 产品阶段定位

| 阶段             | 文章测试                            | Director 现状                               |
| ---------------- | ----------------------------------- | ------------------------------------------- |
| **AI-enabled**   | 去掉 AI，产品仍基本可用             | ✅ 3D / Canvas / Video 编辑器可独立使用     |
| **AI-native**    | 去掉 AI，产品价值崩塌               | ⚠️ 否 — AI 是增强层，不是唯一入口           |
| **Agent-native** | UI 与 Agent 能否操作同一套 workflow | ✅ **是（核心生产路径）**，边缘能力仍有缺口 |

Director 文档明确自定位为 **Agent-native，而非「可被 Agent 控制」**：

> Director is **Agent-native**, not merely "controllable by an Agent." The distinction is the contract around every action: an Agent can discover vocabulary, address an exact project, make a bounded change, verify state and pixels, and recover from conflicts without clicking coordinates.

结论：Director **属于 agent-native 产品架构，不是 bolt-on AI**；更接近文章 **Video 实践案例** 那一类 — 完整编辑器 + Agent 操作同一 composition model。

---

## 五大架构原则对照

### 1. Agent UI Parity — 部分符合 ⚠️

**符合：**

- 场景编排、相机、角色、时间线、Canvas/Video、interchange 导出与导入（`plan-import` / `import`，来源支持 inline / media_id / workspace_path）、collaboration 读写（评论 resolve/reopen、版本 create/restore/delete）、audit/deliver 等核心能力可通过 MCP / HTTP / CLI 完成
- 禁止 DOM 坐标点击作为 authoring 契约（见 [Feature Status](/zh/reference/feature-status/)）
- Agent 操作结果可在 UI 中 inspect（revision、diff、capture、receipts）

**缺口：**

- UI 大量操作仍 **直连 Zustand store**（`frontend/director/src/comprehensive/editor/store/directorStore.ts`），Agent 走 `directorWorkbenchExecutor` → `applyDirectorAuthoringActions`，**调用路径分叉**
- 视口拖拽、pilot 等交互式操控缺少完整 semantic 等价物

**评级：3.5/5**

### 2. One Shared Action Model — 较强 ✅（Agent 侧），UI 侧未完全统一 ⚠️

**符合：**

| 层                  | 共享模型                                                          | 路径                                                                                                           |
| ------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Workbench authoring | `directorAuthoringActionSchema` + `applyDirectorAuthoringActions` | `packages/agent-engine/src/directorAuthoring.ts`, `frontend/director/src/agent/directorWorkbenchExecutor.ts` |
| Workbench 契约      | `directorWorkbenchOperationSchema`（Zod discriminated union）     | `packages/agent-engine/src/directorWorkbenchContract.ts`                                                     |
| Creative 契约       | `creativeWorkspaceAgentRequestSchema`（transport-only）           | `packages/protocol/src/creativeWorkspaceProtocol.ts`                                                           |
| Stage 白盒          | `stageCommandSchema` → `executeStageTool`                         | `packages/agent-engine/src/commandEngine.ts`, `packages/agent-engine/src/stageCommandSchema.ts`            |

所有控制面汇聚同一 gateway 执行与校验层（见 [Control surfaces](/zh/agents/control-surfaces/)）。Audit 修复建议直接引用 `DirectorAuthoringAction[]`，同一 vocabulary 贯穿 observe → author → audit → deliver。

**共享 action 示例：**

```json
{
  "op": "author",
  "expected_revision": "director-project-revision:v1:sha256:...",
  "idempotency_key": "shot-017-medium-framing-v1",
  "actions": [
    {
      "action": "update_camera",
      "camera_id": "cam-main",
      "patch": { "focal_length_mm": 50, "target_object_id": "hero" }
    }
  ]
}
```

**缺口：**

- UI 按钮/拖拽未统一经 `directorAuthoring` registry
- `stage_*` 兼容层与 `director_workbench` 完整模型仍并存

**评级：4/5**

### 3. Shared State, Data, and Context — 强 ✅

**符合：**

| 状态                   | 所有者                     | 路径                                                                                                       |
| ---------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 实时 `DirectorProject` | 浏览器 store               | `frontend/director/src/comprehensive/editor/store/directorStore.ts`                                        |
| Agent observe/author   | 同一 store（browser 执行） | `frontend/director/src/agent/directorWorkbenchExecutor.ts`, `frontend/director/src/agent/gatewayClient.ts` |
| Wire 契约              | 共享 Zod schema            | `packages/protocol/src/agentGatewayProtocol.ts`                                                            |
| Agent sessions/events  | SQLite WAL                 | `backend/gateway/agentSessionStore.ts`                                                                     |

- `observe {"fields":[...]}` 选择性切片，避免 stale 全量快照
- `expected_revision` / `snapshot_fingerprint` 并发守卫
- Exact target lease（token + client + instance + scene + scope），fail-closed，不静默切换 tab/scene

**评级：4.5/5**

### 4. Protocol-Ready by Design — MCP 强 ✅，A2A 弱 ⚠️

**符合：**

| 协议           | 实现                            | 路径                                                                               |
| -------------- | ------------------------------- | ---------------------------------------------------------------------------------- |
| **MCP**        | stdio server，structured output | `backend/gateway/mcp-server.ts`, `integrations/plugins/director-workbench/`        |
| **HTTP**       | `POST /api/tools/{tool-name}`   | `backend/gateway/routes/stageRoutes.ts`                                            |
| **Tool manifest** | `GET /api/control-plane/tool-manifest`（从 Zod schema 生成） | `backend/gateway/controlPlane/toolManifest.ts` |
| **WebSocket**  | 浏览器 target 绑定与命令响应    | `frontend/director/src/agent/gatewayClient.ts`, `backend/gateway/agent-gateway.ts` |
| **CLI**        | `npm run stage --`              | [Control surfaces](/zh/agents/control-surfaces/)                                   |

MCP 工具全部转发 gateway，无重复业务逻辑。可分发插件含 `.mcp.json`、Skill、Codex plugin manifest。

**缺口：**

- 无标准 **A2A（Agent-to-Agent）** 协议
- Multi-agent 为固定串行 DAG，状态 **Experimental**

**评级：4/5**

### 5. Governed Execution — 审计强 ✅，原始 HTTP/UI 仍未设闸 ⚠️

**符合：**

- Production audit（spatial、grounding、graph issues）— `packages/agent-engine/src/directorAudit.ts`
- `deliver` 机器验收边界
- Revision / idempotency / exact target fail-closed（428 / 409）
- Agent event store、structured MCP receipts、credential redaction
- 共享的电影角色工具策略（如 visual-critic 只读）— `backend/gateway/agents/filmRoleToolPolicy.ts`，由 MCP（`DIRECTOR_FILM_ROLE`）、本地 Agent harness 与托管 API adapter 共用

**缺口：**

- 原始 HTTP `POST /api/tools/{tool-name}` 以及走该路径的 CLI **不应用** `filmRoleToolPolicy`
- Human UI 操作无等价 permission gate
- 工具调用尚未形成按 `source: ui | mcp | http | cli` 标记的 **统一审计轨迹**
- Collaboration 生产房间鉴权、公网部署加固仍 **Limited**

**评级：4/5**

---

## 软件栈维度对照

对照文章 [Where agent-native fits in the software stack](https://www.builder.io/blog/agent-native-architecture#where-agent-native-fits-in-the-software-stack) 表格：

| 维度              | 传统 SaaS            | Raw Agent      | Agent-Native 目标              | Director                                                                                        | 评分  |
| ----------------- | -------------------- | -------------- | ------------------------------ | ----------------------------------------------------------------------------------------------- | ----- |
| **控制权**        | 厂商                 | 用户 prompt    | 开发者/团队拥有 app            | 开源、本地 gateway、可改代码                                                                    | 5/5   |
| **Human UI 质量** | 强                   | 弱/无          | 完整产品 UI                    | Canvas / 3D / Video 完整编辑器                                                                  | 4.5/5 |
| **Agent 访问**    | 部分 bolt-on         | 广但无结构     | 通过 app actions 全访问        | 核心路径强；interchange 导出/导入与 collaboration 读写均为 JSON 操作；OBJ/STL 仍只导出，格式子集为 Limited | 4.5/5 |
| **可定制性**      | 设置/插件            | prompt 一次性  | 代码/workflow 可 clone         | Profiles、Skills、MCP plugin                                                                    | 4/5   |
| **数据所有权**    | 厂商 DB              | 依赖外部工具   | 自有 DB/schema                 | 本地 SQLite / JSON / 浏览器 media                                                               | 4.5/5 |
| **Runtime 定制**  | 厂商 roadmap         | 一次性 chat    | SQL workspace、runtime tools   | 有 Skills/Profiles；无 SQL-backed workspace                                                     | 3/5   |
| **上下文感知**    | UI 状态对 agent 隐藏 | 靠手动 prompt  | 当前 view/selection/navigation | observe、capabilities、catalog、target lease                                                    | 4.5/5 |
| **团队就绪**      | 成熟 admin           | 难治理         | org/roles/audit                | Yjs 协作 Limited；internet deployment 未完成                                                    | 3/5   |
| **可观测性**      | 产品分析             | chat 历史      | traces/evals/audit/cost        | AgentEvent、trace、deliver receipts；缺 cost/latency 面板                                       | 4/5   |
| **成本模式**      | 按 seat + AI 附加    | LLM + 工具订阅 | 一把 key 驱动多个自有 app      | 自托管 + 自带 LLM key                                                                           | —     |
| **Cloneability**  | 低                   | N/A            | 可 clone、own、reshape         | 开源 repo、plugin 验证脚本、双语文档                                                            | 4/5   |

---

## 成熟度层（as they grow）

| 能力                            | 文章期望                           | Director                                                                         |
| ------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------- |
| **Workspace 定制**              | SQL 中的 AGENTS.md、skills、memory | 有 `.claude/skills/`、Profiles JSON；**不在产品内 SQL-backed workspace**         |
| **Runtime tools / Automations** | Agent 创建小工具、定时 workflow    | 固定 serial production graph（Experimental）；无动态 DAG / scheduled automations |
| **Progress & Observability**    | 长任务进度、traces、evals、cost    | Agent workbench 流式输出、session events；缺统一 cost/latency 面板               |
| **Team readiness**              | users/orgs/roles/audit             | Collaboration Limited；multi-agent Experimental                                  |

---

## 与文章实践案例的类比

文章以 **Video** 为例：timeline + preview + export，Agent 直接操作 composition model。

Director 高度吻合：

- 人类使用 timeline、viewport、Canvas node graph
- Agent 使用 `director_workbench` / `director_creative` 语义操作同一 `DirectorProject`
- 有 `audit` → `deliver` 像素级验收闭环

这比「AI 生成一段视频文案」更接近 agent-native video 模板。

---

## 关键组件地图

```text
Browser (gatewayClient.ts, directorStore)
    │ WebSocket + exact target
    ▼
agent-gateway.ts (composition root)
    ├─ stageRoutes.ts → commandEngine / browser workbench executor
    ├─ mcp-server.ts (stdio；filmRoleToolPolicy via DIRECTOR_FILM_ROLE)
    ├─ AgentHarness + agentAdapters (Codex/Claude；同一策略)
    ├─ openAiCompatibleAdapter (同一 filmRoleToolPolicy)
    ├─ ProductionRunOrchestrator (multi-agent)
    └─ controlPlaneRoutes / video / dcc
```

---

## 已对齐的部分

1. **单一 gateway 执行层** — MCP / HTTP / CLI / Browser 不重复实现业务逻辑
2. **契约优先** — Zod schema 贯穿 MCP input、HTTP、executor、audit
3. **证据驱动闭环** — observe → author → audit → deliver，revision-bound capture
4. **Fail-closed targeting** — 不静默切换 tab/scene
5. **可分发 agent 资产** — plugin + skills + 多 provider workbench
6. **Cloneability** — 开源、本地数据、可验证 plugin（`npm run validate:agent-plugin`）

## 主要差距

1. **UI parity 进行中** — interchange 导入、collaboration 写操作（resolve/reopen、version create/restore/delete）、Gallery purge / media.relink、Player/Pilot 会话 op 已进 Agent JSON；Stage 删除与单次变换开始经 `dispatchDirectorAuthoringActions` 与 Agent 共用 authoring。其余 store mutator（相机面板、姿态/IK、时间线、世界、Canvas/Video）仍在分批收敛
2. **Governance 入口未完全统一** — MCP、本地 harness 与托管 adapter 已共享 `filmRoleToolPolicy`；原始 HTTP 与人类 UI 仍绕过 film role，审计也未跨入口统一
3. **Protocol breadth** — MCP 强，tool manifest 已交付；无标准 A2A（spike 结论：no-go / 暂缓，见路线图 M7）；multi-agent 为自定义串行 graph
4. **Dual surface 遗留** — `stage_*` 兼容层 vs `director_workbench` 完整模型仍并存
5. **Runtime workspace** — 无文章描述的 SQL-backed AGENTS.md / LEARNINGS.md 等产品内 workspace

---

## 优先改进建议

按 ROI 排序（详细里程碑见 [Agent-Native 优化路线图](/zh/engineering/agent_native_roadmap/)）：

1. **继续把 UI mutator 收敛到 shared authoring dispatch** — 相机 / 姿态 / 时间线 / Canvas·Video 仍有双写
2. **把共享角色策略接到原始 HTTP 与 UI，并统一审计轨迹** — MCP / 本地 / 托管已共用 `filmRoleToolPolicy.ts`
3. **补 team/observability 层** — collaboration auth、agent trace/cost dashboard
4. **Cross-app 编排** — tool manifest 已交付（`GET /api/control-plane/tool-manifest`）；A2A 评估结论为 no-go / 暂缓（见[路线图 M7](/zh/engineering/agent_native_roadmap/)），剩余为 cross-app receipt handoff recipe

---

## 参考文献

- [Agent-Native: The Next Architecture for Software](https://www.builder.io/blog/agent-native-architecture) — Builder.io, Vishwas Gopinath, May 2026
- Director 内部：[Agent-native Production](/zh/concepts/agent-native-production/)
- Director 内部：[Feature Status](/zh/reference/feature-status/)
