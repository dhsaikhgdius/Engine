---
title: 人物
description: 添加本地 Mixamo 人物，设置动作，微调姿势并安全使用 IK 目标。
---

Director 的人物是本地、有骨骼的资产。人物对象会保留真实资产绑定、变换，以及包含可选动作片段、语义姿势控制和 IK 目标的 Mixamo rig 状态。

## 添加人物

1. 打开**资产**面板并选择人物分类。
2. 搜索人物，添加前先检查缩略图。
3. 将卡片拖入 Stage，或使用卡片上的添加控件。
4. 确认双脚落地，并且出现的是预期模型。
5. 在人物属性面板中设置动作、姿势控制和 IK。

打包的 **X Bot** 是默认的中性制片人物：

| 属性     | 值                                         |
| -------- | ------------------------------------------ |
| 资产 ID  | `mixamo:x-bot`                             |
| 模型     | `/mixamo-characters/models/x-bot.glb`      |
| 预览     | `/mixamo-characters/thumbnails/x-bot.webp` |
| 目标身高 | 1.78 m                                     |
| Rig      | Mixamo，65 根骨骼                          |

不要只用显示名称识别人物。项目会把真实绑定保存在 `assetRefId` 中；X Bot 的值必须是 `mixamo:x-bot`。

## 人物检查器

人物检查器在切换工具时会持续显示当前选择。顶部摘要展示人物或群组名称、选择类型和显示颜色；
四个紧凑页签各自负责明确的编辑层：

| 页签     | 用途                                                                |
| -------- | ------------------------------------------------------------------- |
| **属性** | 名称、XYZ 变换、**Down 2 Earth**、统一缩放和显示颜色                |
| **动作** | 本地骨骼片段、循环、速度、权重、开始帧、淡入淡出与 root-motion 模式 |
| **姿势** | 命名语义姿势预设和有边界的身体控制                                  |
| **IK**   | 局部手脚目标、pole、权重与 reach 限制                               |

变换标签既是数值输入，也可以左右拖动调整。选择人物群组时仍使用同一个面板，但名称、变换、缩放、
颜色、姿势和受支持 rig 操作会作用于群组，而不是单个成员。身份摘要在每个页签都保持可见，因此即使
Pose 或 IK 内容很长，也不会丢失当前编辑目标。

### Blender 原生人物

集成模式只保留一个人物对象和一套 Character 检查器，不会再把第二套 Mesh editor 或原始 Rig
检查器堆叠在人物属性下方。需要编辑 topology、modifier、材质或 UV 时，打开顶层 **Modeling**
页签；原始 Rig 检查器只用于不属于 Director 人物的 Blender armature。

`DirectorProject.characterRig` 是人物语义状态的唯一事实来源。Blender 完成资产 provision 后，
Director 会按原生 revision 检查 armature，并验证 Mixamo 骨骼角色。兼容人物会收到带 revision 校验
的原生操作：

- **Action** 导入或复用本地 Mixamo action，并通过每个 armature 独立的 `Director Motion` NLA
  轨道采样确定性的 Director 时间线帧；不同人物可以使用不同片段、循环、速度和起始帧，不会互相
  争抢全局场景帧；
- **Pose** 把同一组有限制的语义 controls 映射为骨骼 quaternion offset；
- 原生状态标记保证未变化的 Action/Pose 幂等，轮询与预览导出不会反复保存场景。

共享的 Blender 场景帧只跟随一次 Director 播放头，不属于任何单独人物。原生 Action 当前使用完整
权重；单次/重复、速度、开始帧和 in-place motion 已接入。往返循环、混合权重和淡入淡出仍只属于
浏览器 runtime，因此原生人物不会显示这些无效控件。原生 IK 适配尚未交付，所以 IK 页签会明确
显示边界，不会写入一个“看似成功”的结果。Mesh 预览会导出当前变形，但不会改变权威 armature 姿势。

## 本地动作片段

当前本地动作目录包含[功能状态](/zh/reference/feature-status/#目录数量)记录的 14 个已验证
Mixamo 片段：

| Clip ID      | 名称         |        时长 | 帧数 | 默认循环 |
| ------------ | ------------ | ----------: | ---: | -------- |
| `idle`       | 标准待机     |     3.000 s |   91 | 重复     |
| `walk`       | 向前行走     |  1.366667 s |   42 | 重复     |
| `walk-back`  | 向后行走     |     1.300 s |   40 | 重复     |
| `walk-left`  | 向左行走     |     1.200 s |   37 | 重复     |
| `walk-right` | 向右行走     |     1.200 s |   37 | 重复     |
| `run`        | 无武装向前跑 |     0.800 s |   25 | 重复     |
| `run-back`   | 无武装向后跑 |  0.766667 s |   24 | 重复     |
| `run-left`   | 向左跑       |  0.766667 s |   24 | 重复     |
| `run-right`  | 向右跑       |  0.766667 s |   24 | 重复     |
| `wave`       | 挥手         |  0.533333 s |   17 | 单次     |
| `clap`       | 站立鼓掌     |  4.766667 s |  144 | 单次     |
| `sit-idle`   | 坐姿待机     | 10.866667 s |  327 | 重复     |
| `jump`       | 原地跳跃     |  2.433333 s |   74 | 单次     |
| `talk`       | 站立说话     |  5.166667 s |  156 | 重复     |

这 14 个片段目前都推荐使用 **in-place** root motion。in-place 只驱动骨骼，不会让人物对象在 Stage 中平移。需要位移时应使用对象动画、路径或运行时移动。只有片段本身应携带平面位移时才选择 authored root motion。

浏览器 runtime 的动作参数包括循环模式、速度、权重、开始帧、淡入、淡出和 root-motion 模式；
Blender 原生人物使用上文列出的原生子集。排查走路或跑步问题时不要一次更改多个参数；先以
速度 `1`、权重 `1` 验证未经修改的目录片段。

## Rig 层序

Director 按以下顺序计算人物变形：

```text
本地骨骼动作
  → 语义姿势控制
  → IK 末端
```

这个顺序允许姿势控制继续微调采样后的动作，再由 IK 把手或脚固定到局部目标。清除动作不会清除姿势控制或 IK。设置动作会清除命名姿势预设，但保留显式 controls 和 IK。

## 姿势预设与控制

可用预设包括：

`stand`、`t-pose`、`walk`、`run`、`sit`、`crouch`、`kneel-one`、`kneel-two`、
`hands-on-hips`、`lean`、`bow`、`think`、`fight`、`kick`、`throw`、`push`、`wave`、
`reach`、`cross-arms`、`phone`、`punch` 和 `block`。

姿势控制使用 `head.yaw`、`torso.pitch`、`leftShoulder.pitch`、`rightKnee.bend` 等可移植名称。`body.offsetY` 的单位是米，其他控制的单位是度。

关节限制因控制项而异：

- `body.offsetY`：-1 到 1 m；
- 手肘和膝盖弯曲：0 到 150 度；
- 肩部和髋部 pitch：-120 到 120 度；
- 其他角度控制：-90 到 90 度。

儿童和 chibi 体型使用更窄的角度范围。应让属性面板执行限制，不要强制写入极端关节值。

## IK 目标

支持的末端只有 `leftHand`、`rightHand`、`leftFoot` 和 `rightFoot`。target 与 pole 都使用**人物局部坐标，单位为米**，不是世界坐标。weight 范围为 0–1，reach clamp 范围为 0.05–1。求解器是不可拉伸的 two-bone solver；目标不可达时，肢体会停在允许范围内，不会被拉长。

在基础动作和姿势正确后再添加 IK。固定脚部或让手接触道具时：

1. 先放置人物与道具。
2. 设置基础动作或姿势。
3. 先添加一个末端，并使用保守的 reach clamp。
4. 检查 pole 控制的手肘或膝盖朝向。
5. 再逐个添加其他末端。

该 solver 当前驱动浏览器渲染人物。已经 provision 的 Blender 人物仍在项目中保存同一份 IK
数据，但在原生 two-bone adapter 完成前不会把它应用到原生 armature。

## 接上 Agent

每个人物都可以接上一个 Agent；接上后该 Agent 以 possess 模式驱动这个人物的走路、动作、
姿势和位移。

1. 选中单个人物并打开**属性**页签。
2. 在**绑定 Agent** 区块选择一个 Agent Profile，或填写驱动该人物的 Agent Session ID
   （例如 `dsh-abc123`）。
3. 点击**绑定**。摘要处会出现 **Agent 接管中** 徽章，表示此人物已被 Agent 接管。
4. 需要收回控制时点击**解除绑定**。群组选择暂不支持绑定，请选择单个角色。

绑定状态在 Stage 视口中同样可见：被接管人物的名字标签旁会出现一个 **Agent 接管** 徽章。
徽章与名字共用同一个屏幕空间标签，不响应指针事件，因此不会挡住选择或变换 gizmo；
解除绑定后徽章立即消失，未绑定人物的标签保持不变。

绑定保存在项目 JSON 的 `agentBinding` 字段中（只有人物对象可以携带），与其他人物写操作走同一
revision 守卫；锁定的人物需要 `force` 才能绑定或解除。多个人物可以接同一个 Agent，但一个人物
同一时刻最多一个绑定，重新绑定直接覆盖。

Agent 侧使用 `director_workbench` 的语义 author action：

```bash
npm run stage -- director_workbench '{"op":"author","idempotency_key":"bind-actor-v1","actions":[{"action":"bind_character_agent","object_id":"actor-xbot","session_id":"dsh-abc123"}]}'
npm run stage -- director_workbench '{"op":"author","idempotency_key":"unbind-actor-v1","actions":[{"action":"unbind_character_agent","object_id":"actor-xbot"}]}'
```

接上后，该 session 继续用现有 action 驱动人物：`set_character_motion`、
`set_character_pose_controls`、`set_character_ik`、`update_object` 变换和 `set_animation`。
observe 的人物摘要会回显 `agent_binding`。

possess 模式同时限制该 session 的写入范围：绑定了人物的 session 只能修改自己接管的人物；
删除其他对象、修改别人的人物、`start_scene`、`replace_project` 等全局写入会被网关以可读错误
拒绝（HTTP 403，代码 `possession_scope_violation`）。未绑定任何人物的普通导演 session 行为
不变。所有人物 action 仍需显式 `object_id`。

「放置人物 → 绑定 Agent → 用 motion/pose 驱动 → 校验回显的 `agent_binding` → 解绑」这条完整
链路由黄金评测任务 `tools/evals/tasks/08-character-agent-possession.json` 回归覆盖，通过
`npm run eval` 运行（见仓库中的 `tools/evals/README.zh-CN.md`）。

## CLI 快速检查

通过 `npm run dev` 运行 Director 后，以下命令会检查目录并添加真实 X Bot。CLI 会在受保护写入前观察并绑定准确的浏览器目标。

```bash
export STAGE_AGENT_SESSION=character-guide
npm run stage -- director_workbench '{"op":"catalog","catalog":"character_assets","asset_id":"mixamo:x-bot","limit":1}'
npm run stage -- director_workbench '{"op":"catalog","catalog":"character_motions","query":"walk","limit":10}'
npm run stage -- director_workbench '{"op":"observe","fields":["assets","characters","timeline"]}'
npm run stage -- director_workbench '{"op":"author","idempotency_key":"character-guide-xbot-v1","actions":[{"action":"add_object","id":"actor-xbot","name":"X Bot","kind":"character","asset_id":"mixamo:x-bot","transform":{"position":[0,0,0],"rotation":[0,0,0],"scale":[1,1,1]}}]}'
```

如果 `actor-xbot` 已存在，应检查现有对象，不要改变 payload 后复用创建请求。只有确实要创建新人物时，才使用新的对象 ID 和 idempotency key。

## 验收清单

- 预期本地模型和缩略图正常加载，没有 fallback 占位图。
- 人物对象报告 `character_source: "asset"` 和预期 `asset_id`。
- 采样帧中双脚落地；walk/run 循环时骨盆没有跳变。
- 动作速度和方向与对象轨迹或运行时移动一致。
- 姿势控制按预期微调动作，没有意外替换采样片段。
- 原生 Action/Pose 修改只让 Blender 前进一次 revision，空闲后保持稳定。
- IK 肢体不会拉伸、翻转，也没有误用世界坐标目标。
- 无辅助线的 clean camera frame 中，人物、落地、轮廓和遮挡与预期一致。
