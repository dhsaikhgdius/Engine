# Director Agent Harness 设计评审

> 语言:**中文**。评审对象:DSH 循环 + Director Cordis 插件 + Gateway 工具面 + MCP 面。
> Last verified: **2026-08-25**(以下所有判断均以当日代码为证据,证据路径随条目给出)。

本文从第一性原理评审 Director 的 agent harness 设计:边界与抽象是否匹配「人在浏览器里导戏 + agent 通过 typed tools 改同一项目」,合约与拒绝路径是否自洽,以及当前设计是在放大还是在绑死模型能力。这不是格式扫查;每条判断都回答「为什么是这样、对 agent 意味着什么、更好的设计是什么」。

## 一、结论

### 1.1 合理(边界、抽象、信息流)

**判断:整体合理。所有权切分是本仓库最正确的一个架构决定。**

- **循环归 DSH,领域归插件。** Director 不自研 tool loop:循环、会话、todo、子代理、workspace/web/job 工具、提示词组装全部来自 `vendor/deepseek-harness`;Director 侧只有一个 Cordis 插件(`packages/dsh-plugin-workbench/src/register.ts`、`cordis.ts`),注册 5 个领域工具并把每次调用 POST 到 Gateway `/api/tools/:name`(`src/gatewayClient.ts`)。插件的执行函数只做三件事:Zod 校验、HTTP 分发、结果整形(`register.ts` 的 `execute` + `prepareDirectorResult`)。这意味着 DSH 上游的每次改进(更好的循环、更好的子代理、更好的上下文管理)Director 免费继承,而 Director 的全部工程投入落在领域合约上——对 3D 导戏 agent 是净放大。
- **单一执行面。** DSH 插件、MCP(`backend/gateway/mcp-server.ts`)、CLI(`tools/scripts/stage-cli.mjs`)、浏览器全部汇聚到同一个 `handleStageRoute`(`backend/gateway/routes/stageRoutes.ts`),同一套严格 Zod 校验、同一个调度器(`backend/gateway/agents/agentToolScheduler.ts`)、同一份角色策略(`agents/filmRoleToolPolicy.ts`)。编码 agent(Cursor/Claude MCP)与 DSH 创作 agent 面对同一心智模型,不存在两套业务逻辑。
- **信息流方向正确。** 人改浏览器 store,agent 改同一 store(经 revision 守卫);agent 的每次成功修改返回新 `project_revision`,人做的修改让 agent 的下一次 `expected_revision` 失配并携带当前 revision 拒绝(`backend/gateway/agentNaiveBoundary.ts`)。人与 agent 的并发通过一条 revision 链而不是锁 UI 解决,匹配「同一项目、双主体」的产品形态。

### 1.2 正确(合约、拒绝路径、revision/session、视觉验收、Blender 投影)

**判断:合约层自洽;但在本次评审前,文档面存在系统性失实——教 agent 相信一个已被删除的架构,并承诺一个从未接线的能力。均已在本 PR 修复。**

自洽的部分(保持):

- **拒绝路径带出路。** stale revision 拒绝携带当前 revision;公开 `author` 缺 revision 时由 `agentNaiveBoundary.ts` 观察注入并在 `agent_boundary` 返回生成的重试键;`geometry_type` 拒绝(产品护栏)在拒绝消息中直接给出 `create_blockout` 的纠正调用(PR #1 加强)。拒绝不是死胡同,是教学时刻。
- **幂等与断开重放。** 修改携带 `idempotency_key`,重放由 `agents/agentToolMemory.ts` 应答而非重复执行;`outcome_unknown` 的 Blender 事务只允许原样重放 `retry_ticket.input`;脚本化批次的 probe id 约定(SKILL「designate one new object id per batch as a probe」)让 agent 在丢失结果时可自证批次是否落地。
- **视觉验收诚实。** capture 走附件通道成为真正的 image block;无视觉模型时返回 `image_attached:false` + 原因(`register.ts` 的 `prepareDirectorResult` → `routeAcceptsImages`),`audit.ready` 被四个通道一致声明为「仅结构校验,不是视觉验收」。没有教 agent 假装看见。
- **Blender 投影单向自动。** 原生编辑成功后自动投影回 Director 项目(稳定 id、变换、实测 bounds、revision);「禁止 GLB 导出再 interchange 导入来'归还'Blender 工作」在 guidance、SKILL、工具描述三处一致。

评审发现并已修复的不正确(证据在本 PR 的 diff):

1. **结果投影是死代码,文档却承诺它存在。** `backend/gateway/agents/agentToolResultProjection.ts` 有完整实现与测试,但两个模型面(DSH 插件的 `prepareDirectorResult`、MCP 的 `createMcpToolResponse`)都没有调用它;SKILL.md 却声称「Model-facing MCP and hosted-harness surfaces summarize oversized results」。后果:全量 `observe` 或重型 catalog 页直接冲进模型上下文,agent 越是遵守「先 observe」的教学,越快耗尽自己。修复:规范实现移入 `packages/dsh-plugin-workbench/src/toolResultProjection.ts`,接入两个模型面;`blender_native` MCP 响应中 base64 截图在 text 块、structuredContent、image 块三重复制的问题一并剥离(`backend/gateway/mcp-server.ts`、`mcpToolResponse.ts`)。
2. **文档教一个已删除的自研内核。** `backend/gateway/README.md`(中英)与 `docs/site/.../architecture/agent-runtime-kernel.md`(中英)列出 `agentSessionStore` / `agentHarness` / `agentToolPipeline` / `agentSpillStore` / `agentAdapters` 等十余个不存在的模块;SKILL.md 声称「Hosted and Codex adapters in the Gateway process call the Stage route directly」——该进程内路径已随自研 harness 一起删除,现在所有 agent 面都走 `POST /api/tools/:name`。对以文档为地图的编码 agent,这是主动误导。已全部改写为 DSH 架构的真实描述。

### 1.3 发挥 agent 最大能力

**判断:合约层在放大模型;上下文层在本次修复前是最大短板;可发现性策略治标多于治本;双内核缝隙与自我批判原语是下一批上限。**

- **mega-op + 紧凑信封是正确的取舍。** `director_workbench` 单工具 33 个 op(`packages/agent-engine/src/directorWorkbenchContract.ts`),若展开为 33 个细粒度工具或一个全字段 JSON Schema,每轮工具目录的 token 税不可接受。`catalog.ts` 的 `compactWireSchema` 只在线材上放 `op` 枚举 + 少量常用字段,精确字段经 `describe`/`capabilities` 渐进披露,Gateway 仍按完整严格 schema 校验(`dshToolParameters` 把 Zod 投影到 DSH 的 JSON Schema 子集)。代价是 schema 跟随依赖模型主动 `describe`;从 PR #1 的历史看,模型猜错字段后的补救是把常错字段提升到信封上(`catalog`、`actions`、`spatial` 等已提升)——这个「按失败提升」的维护循环是健康的,但应以评测驱动而非事故驱动(见 §3)。
- **上下文纪律工具齐全,兜底缺失(已补)。** `query_objects`(name/kind/spatial/frustum)、`observe.fields`、`object_mode:"hierarchy"`、`since_revision`、`max_results` 组成完整的有界读取词汇;但在投影接线前,不守纪律的那一次全量 observe 没有任何兜底。现在超大结果被就地摘要为 counts + 有界 id 样本 + 指向有界重查的提示(`toolResultProjection.ts`),纪律与兜底同时存在,agent 才真正「看得见」大场景。
- **并行与一致性是正确的护栏,不是摩擦。** 只读窗口有界并发、结果按原调用顺序返回;同精确目标的修改跨会话跨 provider 独占(`agentToolScheduler.ts`);`author` 一批最多 128 个 action、Blender `apply` 是单事务——批量原语足够强。全局写独占对 3D 场景是必要的:两个 agent 并发改同一面墙没有合理语义。
- **多模态闭环真实可跑。** capture → DSH 附件存储 → image block;`author.evidence` 允许在提交的精确 revision 上原子取证。缺的是比较原语:`reconstruction.compare` 能对重建场景做渲染 vs 关键帧的网格化评分,但一般场景的「两次 capture 差异评分」没有对应物,自我批判只能靠模型裸看图(见 §3)。

## 二、正确的护栏 vs 应去掉的摩擦

| 类别       | 条目                                                   | 判断依据                                                                                             |
| ---------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| 护栏(保持) | `geometry_type` 公开拒绝                               | 白膜是 clay look 的质量底线;拒绝消息携带 `create_blockout` 出路,不是无出路禁令                       |
| 护栏(保持) | 修改独占 + revision fail-closed                        | 双主体同项目的唯一一致性来源;拒绝携带当前 revision,恢复成本一次 observe                              |
| 护栏(保持) | 禁止 GLB 往返「归还」Blender 工作                      | 自动投影已存在;往返路径会制造第二份真相                                                              |
| 护栏(保持) | `image_attached:false` + 「audit.ready 非视觉验收」    | 防幻觉视觉断言;诚实信号比假成功便宜                                                                  |
| 护栏(保持) | 「typed 回执才算修改证据」「禁止猜 provider/model id」 | `register.ts` guidance;针对 LLM 真实失败模式的低成本规则                                             |
| 摩擦(已除) | 模型面全量结果无摘要兜底                               | 本 PR 接线投影;SKILL 的承诺从失实变为事实                                                            |
| 摩擦(已除) | 文档描述已删除的自研内核                               | 本 PR 改写 gateway README(中英)、agent-runtime-kernel(中英)、SKILL 两处                              |
| 摩擦(已除) | MCP `blender_native` 截图 base64 三重复制              | 本 PR 剥离;图片只经 image block 传输一次                                                             |
| 摩擦(存留) | `director_creative` observe 不接受 `fields`            | 与 workbench observe 不一致,大 Canvas 只能靠摘要兜底;需产品决策(§3)                                  |
| 摩擦(存留) | 四通道教学重复                                         | 同一课(blockout、禁 geometry_type、audit≠视觉)在 guidance/SKILL/描述/拒绝消息各讲一遍;见下文治本判断 |

**关于 PR #1(blockout 可发现性)是否治标:部分治标,但重复本身不全是病。** 四个通道服务不同的 agent 群体:MCP 编码 agent 看不到 DSH 的 `DIRECTOR_AGENT_GUIDANCE`(4.4 KB,只注入 DSH 系统提示);DSH 创作 agent 不一定读 SKILL.md(29 KB,按需加载);工具描述(约 1 KB/工具)是唯一保证每轮都在场的通道;拒绝消息是唯一保证在失败时刻在场的通道。所以跨通道重复是覆盖,不是冗余。真正的病是**无排序的重复**:四通道没有声明谁是规范来源,漂移时(如本次 SKILL 的失实承诺)没有机械手段发现。治本是:(a) `describe`/`capabilities` 作为唯一规范词汇表,其余通道只教原则和指针;(b) 拒绝消息永远携带纠正调用(已基本做到);(c) 用 golden eval(`tools/evals/tasks/`,现 8 个任务)锁住每条关键教学的行为效果,让「教了但模型不做」显形——eval 08 已为 blockout 建立此闭环,应成为每次教学变更的标配。

## 三、发挥能力的瓶颈 Top 5(按杠杆排序)

1. **[已修复] 超大工具结果直通模型上下文。** 杠杆最高:它惩罚遵守教学的 agent,且随场景规模恶化。修复见 §1.2。后续应在 `tools/evals/` 增加一个大场景摘要任务,防止回归(现有任务 05 只测有界读取纪律,不测兜底)。
2. **教学通道无规范来源声明,漂移不可检测。** 本次发现的两处失实(摘要承诺、进程内 adapter)都存活了整个架构迁移期。立刻可做:`repo:check` 类比 `agent-integrations.mjs`,增加「文档引用的 `backend/gateway/**` 路径必须存在」的机械校验。
3. **双内核缝隙的所有权不可机械发现。** catalog Stage 实例不是 Blender datablock(Blender 里删不掉它们);provisioned 原生对象的材质归 Blender 所有(`update_object.material` 被有意拒绝)。这些规则目前只存在于文字教学;agent 面对一个具体 object id 时,没有一个字段直接回答「哪个内核拥有它、哪些操作会被拒绝」。建议在 `inspect` 结果上暴露 `kernel_ownership`(或等价字段)——需产品决策,但杠杆高:缝隙处的每次拒绝-重试循环都在烧上下文。
4. **缺少通用视觉比较原语,自我批判靠裸看图。** `reconstruction.compare` 证明了网格化评分的可行性;把它推广为「对同一命名相机的两次 capture(或 capture vs 参考图)返回复合评分与最差网格」会让强模型的迭代式白膜/构图工作流从「看图-感觉-重拍」升级为「量化-定位-修局部」。需产品决策。
5. **创作会话无持久记忆面。** 项目数据本身是记忆,但「这个项目的相机语言、已确认的尺度决定、用户否掉的方案」没有落点;每个新会话从零重建判断。DSH 的 workspace 文件工具是现成载体,缺的是约定(如项目内 `DIRECTIONS.md`)与 guidance 一句话。低成本,需产品决策确认形态。

## 四、建议改动

**立刻可做(本 PR 已完成):**

- 结果投影移入插件并接线两个模型面;MCP `blender_native` 剥离 base64 复制(`packages/dsh-plugin-workbench/src/toolResultProjection.ts`、`register.ts`、`backend/gateway/mcpToolResponse.ts`、`mcp-server.ts`,含测试)。
- 改写失实文档:`backend/gateway/README.md`(中英)`agents/` 清单、`docs/site/.../agent-runtime-kernel.md`(中英)整体重写为 DSH 架构、SKILL.md 两处过时表述 + `sync:skills`。

**立刻可做(后续小改动):**

- `repo:check` 增加文档路径存在性校验(瓶颈 2)。
- `tools/evals/` 增加大场景摘要兜底任务(瓶颈 1 的回归锁)。

**需产品决策:**

- `director_creative` observe 支持 `fields`/有界查询(与 workbench 对齐)。
- `inspect` 暴露内核所有权字段(瓶颈 3)。
- 通用 capture 比较评分 op(瓶颈 4)。
- 项目内创作记忆约定(瓶颈 5)。
- 统一检查点绑定 Director 项目 revision 与 Blender 场景 revision(已在 agent-runtime-kernel「尚未统一的边界」登记)。

**禁止:**

- Fork `vendor/deepseek-harness` 或在仓内另起 tool loop / 会话存储——所有权切分是当前设计最大的放大器,任何「Director 特殊需求」都应表达为插件工具或 Gateway 合约。
- 为「可发现性」继续增加第五个教学通道;先建立规范来源排序与 eval 闭环。
- 放松 `geometry_type` 拒绝(如加旁路 flag);它是白膜质量的地板,且出路(`create_blockout`)已足够便宜。
