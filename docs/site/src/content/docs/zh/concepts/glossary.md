---
title: 术语表
description: 用一句话解释 Director 文档中反复出现的每个术语。
---

Director 文档使用一套小而精确的词汇。本页对每个术语只定义一次;其他页面直接链接到这里,
不再重复解释。阅读时遇到陌生词汇,先来这里查。

## 产品与服务

- **WorldEngine** — 仓库根目录的制片平台,Director 是它的浏览器端产品。
- **Director** — 浏览器中的制片台:3D 布景、相机、角色、动画、分镜、画布、视频编辑器和
  Gallery,默认地址 `http://127.0.0.1:5175`。
- **Gateway(网关)** — 位于 `http://127.0.0.1:8787` 的 TypeScript 控制面,负责 Agent 会话、
  HTTP/MCP/CLI 接入、持久化任务、媒体与协作。见[控制面](/zh/architecture/control-plane/)。
- **工作区(Workspace)** — 四个顶层界面之一:**画布**(镜头意图与媒体溯源)、**3D 片场**
  (blocking、相机、动画)、**视频编辑器**(画面/音频轨道)、**Agent**(持久 coding-agent 会话)。
  通过 `/?workspace=stage` 之类的 URL 选择。项目媒体仍在这些制片工作区里的 Gallery 中。
- **Blender** — 集成的原生建模后端:本地 headless Blender 4.2+ 进程运行
  `worldengine_studio`,用 `npm run blender` 启动。绑定的 Blender 场景对原生几何拥有
  权威;Director 保留制片语义。
- **白模(white-box)** — 由基本体和人台搭建、无贴图但度量正确的 blocking 场景。它在任何
  生成式渲染之前先锁定布局、比例、镜头和相机运动,让构图问题在最便宜的阶段暴露。

## 项目与数据

- **地面枢轴（floor pivot）** — 基本体的 `position` 是底部中心，不是几何中心。3 米高的墙立在地面上应写 `position.y = 0` 且 `scale.y = 3`。写成半高（`y = 1.5`）会把墙抬离地面；天花板写成 `3 + 厚度/2` 会跑到房间上方。
- **DirectorProject** — 完整的 v1 编辑器文档:场景设置、资产、对象、角色、相机、动画、
  分镜和制片覆盖。见[数据模型](/zh/architecture/data-models/)。
- **StageScene** — 可移植 `stage_*` 工具和旧客户端使用的紧凑 v5 投影。它是同一项目的兼容
  视图,不是第二份文档。紧凑协议的基本体用 `kind:"cube"`;完整编辑器仍可存储
  `kind:"prop"` 加 `geometry_type:"box"`。公开的 `director_workbench` `author` 调用会拒绝
  这些简单几何体,改为实例化 catalog、Blender 或生成网格。
- **创意工作区(Creative workspace)** — 以场景为作用域的画布/视频模型:画布节点与连线、
  剪辑轨道和剪辑设置。媒体字节存放在媒体库中,按 ID 引用。
- **Take(表演条)** — 可复用的表演:独立于任何相机求值的实体动画轨道。
- **Coverage shot(覆盖镜头)** — 引用某个 take 的相机设定(光学参数、构图、帧范围)。
  多个覆盖镜头可以拍摄同一个 take。
- **Revision(修订号,`project_revision`)** — 当前项目状态的指纹。每次 observe 都会返回它,
  每个受保护的 mutation 都要把它作为 `expected_revision` 传回。
- **Snapshot fingerprint(快照指纹)** — 画布/视频侧的修订号等价物,在创意 mutation 上作为
  `expected_snapshot_fingerprint` 传递。

旁边还会出现另外几个“指纹”名字,它们不能互换:

| 名称 | 字段 | 作用域 |
| ---- | ---- | ------ |
| 项目修订号 | `project_revision` / `expected_revision` | 整份 `DirectorProject` |
| 快照指纹 | `snapshot_fingerprint` / `expected_snapshot_fingerprint` | 一个画布/视频创意工作区 |
| Shot IR 修订指纹 | `revisionFingerprint` | 单次相机/帧求值;记录生成该 Shot IR 时的项目修订号 |
| Shot Package 指纹 | package fingerprint | 单个精确帧的多通道哈希包 |

## 控制面

- **控制面(Control surface)** — 指向同一份制片状态的任意类型化接口:MCP 工具、Gateway
  HTTP API、Stage CLI 或浏览器 API。见 [HTTP、CLI 与浏览器](/zh/agents/control-surfaces/)。
- **`director_workbench`** — 面向 3D 片场的主 Agent 工具:observe、author、audit、correct、
  capture、Shot IR、shot package 和 deliver。见 [Agent 工作台](/zh/agents/workbench/)。
- **`director_creative`** — 面向画布与视频编辑器的 Agent 工具:observe、execute_batch、
  audit 和指纹绑定的 preview。见[画布与视频 Agent](/zh/agents/creative-workspaces/)。
- **`stage_*`** — 紧凑的兼容工具集,包括负责生成任务的 `stage_video`。新集成优先使用
  `director_workbench`。
- **`director_dcc`** — DCC 交接工具:能力发现与 Blender 导出/状态。见
  [交换格式与 DCC 交接](/zh/pipelines/interchange/)。
- **Stage CLI** — 网关命令行:`npm run stage -- <工具> '<json>'`。优先 `director_workbench`。`npm run stage -- --help` 列出工具；`stage_read` 等紧凑 `stage_*` 名称仅作 HTTP 兼容。

## Agent 循环

- **Agent-native** — 让 Agent 通过可发现、有保护、可验证的契约工作,而不是点击屏幕坐标。
  见 [Agent-native 制片](/zh/concepts/agent-native-production/)。
- **`capabilities`** — 发现操作,返回某个接口真正支持的词汇,防止 Agent 编造操作。
- **`catalog`** — 针对真实资产、角色与动作 ID 的发现操作,防止 Agent 编造资产引用。
- **`observe`** — 读取操作,返回所选的当前状态切片以及当前修订号和目标。observe 是 ID 和
  修订号唯一诚实的来源。
- **`inspect`** — 当摘要不够用时,读取单个精确实体的操作。
- **精确目标(Exact target / target lease)** — 把会话绑定到唯一浏览器标签页、项目实例、
  场景和创意作用域的元组。Director 绝不把写操作重定向到其他目标。
- **守卫(Guard)** — mutation 的并发前置条件:片场用 `expected_revision`,画布/视频用
  `expected_snapshot_fingerprint`。不匹配时拒绝写入,而不是覆盖别人更新的工作。
- **`author` / 原子意图** — 把一个用户意图表达为一个经过校验的语义动作批次。要么整批提交
  并生成一个撤销单元,要么什么都不改。
- **`compose_blocking`** — 按语义角色编译多人物布局和适配相机,而不是猜测世界坐标。
- **`place_relative`** — 相对另一个对象、世界或相机放置已有对象。
- **`orient_toward`** — 让已有对象朝向目标、相机或世界方向。
- **`arrange_group`** — 用已有对象生成确定性队形(线、网格、簇)。
- **`arrange_facing_pair`** — 让两个已有对象按测量间距面对面。
- **幂等键(Idempotency key)** — 调用方选定的请求标识。用同一个键重试字节相同的载荷会
  返回原始结果,而不是把 mutation 应用两次。
- **质量门(`quality_gate`)** — authoring 选项:当批次会产生确定性质量违规时直接拒绝,
  而不是先提交再修复。
- **Naive caller(朴素调用方)** — 省略了目标、守卫或幂等键的公共 HTTP/MCP/CLI 调用方。
  边界会观察唯一精确目标、注入缺失值,并在 `agent_boundary` 回执中报告;浏览器内的执行
  始终保持严格。
- **锁定内容(Locked content)** — 标记 `locked: true` 的对象归用户所有。除非请求中明确
  授权解锁或覆盖,Agent 不得修改或删除它们。

## 失败词汇

mutation 不会静默出错,而是返回下列结构化错误码。权威的恢复步骤见
[Agent 工作台的恢复表](/zh/agents/workbench/#冲突与不确定结果)和
[故障排查](/zh/troubleshooting/)。

- **`stale_project_revision`** / **`stale_snapshot`** — 目标在产生守卫的那次 observe 之后
  被改动了。重新 observe 并重新规划;不要强行写入。
- **`idempotency_key_conflict`** — 同一个键被用于不同输入。为新意图换一个新键。
- **`idempotency_replay_stale`** — 原始 mutation 已经成功且项目已继续演进。把剩余工作
  表达为一个新意图。
- **`outcome_unknown`** — mutation 可能在确认丢失之前已经提交。先 observe 和 diff 再决定
  是否重试;绝不盲目重发。
- **`command_timeout`** — 某个读取或取证请求被取消。重试即可;不要声称其结果已存在。
- **`target_required`** / **`target_unavailable`** — 尚未绑定可写的精确目标,或已绑定的
  目标消失了。重新打开目标工作区并再次 observe。

## 证据与交付

- **编辑器辅助元素(Editor helpers)** — 网格、标签、gizmo、相机视锥、轨迹辅助线和选择
  轮廓。它们只服务于编辑,并被排除在捕获之外。
- **干净捕获(Clean capture)** — 移除全部辅助元素的相机或视口渲染,绑定到精确的相机、
  帧和修订号。这是视觉证据的标准格式。
- **渲染通道(Render passes)** — 逐帧的确定性输出:`clean`、`depth`、`normal`、
  `object-id` 和 `mask`,离屏渲染,供下游条件控制与合成使用。
- **`audit`(审计)** — 确定性质量检查:引用、落地、重叠、时间线范围和相机空间构图。
  审计通过只证明约束成立,不证明像素质量。
- **审计 token(Audit token)** — 审计失败时返回的标识。`correct` 只应用绑定在该 token 上
  的已验证修复建议。
- **`correct`(修复)** — 针对确定性审计问题的修复操作,由审计 token 和最新修订号共同
  保护。
- **预览(Preview)** — 指纹绑定、无辅助元素的 PNG:完整画布板或视频时间线上的精确时刻。
  它从不移动播放头。
- **Shot IR** — 单个相机/帧求值的中立中间表示:可见对象、传感器画幅与裁切、镜头、
  曝光/对焦元数据、运动意图,以及稳定的 `revisionFingerprint`。
- **Shot Package(镜头包)** — 单个精确帧的多通道哈希包:Shot IR 清单加上每个真实产物的
  SHA-256 哈希和稳定的包指纹。
- **`deliver`(交付)** — 验收边界:审计 + 干净捕获 + Shot IR + 包哈希,全部绑定到同一个
  期望修订号。只凭交付回执接受镜头,并且必须亲自检查干净图像。
- **回执(Receipt)** — 任何已提交操作或任务的结构化结果。Agent 汇报的依据是回执,
  而不是乐观的状态消息。
- **证据链(Evidence chain)** — 循环积累的完整集合:精确目标、修订号、幂等键、审计
  token、干净捕获和包指纹。缺少任何一环,工作就不算已验证。
