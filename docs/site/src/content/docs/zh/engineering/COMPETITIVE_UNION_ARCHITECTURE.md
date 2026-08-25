---
title: Director 竞品能力并集架构
description: 由来源核验的能力并集、架构目标和交付顺序。
---

Director 的目标是七类制作工具经过测试的能力并集，而不是把别人的控件拼成视觉集合。
研究记录只提取可独立实现的行为要求，源码、模型、资产和许可证仍按[参考复用台账](/zh/engineering/reference_reuse_ledger/)分别审计。

## 研究基线与复用边界

| 项目             | 已验证能力                                 | Director 的边界                  |
| ---------------- | ------------------------------------------ | -------------------------------- |
| Blockout         | coverage/take、film gate、精确帧、控制包   | 记录行为；Apache notice 另行保留 |
| 3D Director Desk | 相机掌镜、目标感知路径、clean capture      | MIT 代码与资产分开审计           |
| Nomi             | 非破坏 take、无限画布、固定帧参考          | 只复用已确认的许可内容           |
| CineForge Previz | 相机/对象 waypoint、隔离 MP4               | CC BY-NC-SA，只做 clean-room     |
| Storyboarder     | IK、姿势库、骨骼取景、Shot Explorer        | 限制性 EULA，只研究行为          |
| Framepilot       | 单 renderer quad view、provider-neutral IR | MIT 仍需逐文件确认               |
| Infinite Canvas  | typed media DAG、capture-to-node           | AGPL，只做 clean-room 或独立许可 |

## 审计结论

没有可访问的源码路径、锁定 revision 和实现限制，README 中的能力断言不算已实现。
Director 必须把“参考项目有这个控件”转化为自己的 schema、测试、证据和 failure policy。

## Director 当前位置

已有基础包括物理 filmback/crop、anamorphic projection、DOF、只读 quad inspection、
Performance Take、Coverage Shot、纯 production evaluator、ShotIR、revision guard 和
确定性 PNG frame package。仍缺少完整 production container、双向 DCC、全面 artifact graph、
IK/retarget 和完整多视图空间安全。

## 能力并集缺口

### 制作与相机

- 一个演员表演可被多个独立 camera coverage 复用；
- 真实 sensor gate、crop-to-aspect FOV、aperture、focus、shutter、ISO 和 anamorphic；
- 可编辑、理解主体的景别与运动，不是 prompt-only 描述；
- 同一精确帧同时求值演员、道具、相机、灯光、对焦和剪辑。

### 角色与空间

- end-effector IK、pole target、pose mirror/search/save、retarget、root motion 和 foot lock；
- seeded crowd formation、canon、mirror、pair reaction 和 shared path；
- 编辑器、相机和演员路径的 swept/capsule collision，以及需要时的导航数据。

### 视口与输出

- 单 renderer、单 scene state 的 perspective/top/front/right quad view；
- 显式 helper layer，clean/depth/normal/ID/mask pass；
- 确定性 IN/OUT PNG ZIP、微秒时间、每帧 SHA-256、package fingerprint、进度和取消；
- 真正的 WebCodecs/container muxer 完成前，不能把 PNG ZIP 改名为 MP4/WebM；
- 精确视频、静帧、camera plot、marks、元数据、provenance、ShotIR 和 workflow 的 hash package。

### 生成、剪辑与 Agent

- 一个 provider-neutral ShotIR 投影到各生成器；
- typed、可撤销 artifact graph 表示 shot、take、capture、reference、media 和 editorial；
- revision/fingerprint 前置条件拒绝过期 mutation；长任务是可重试 job；
- UI、Agent、审计和导出使用相同操作、校验、图规则和证据。

## 目标模型：一个制作真相、多个投影

```text
DirectorProduction
  SceneBlocking
    Cast / Props / Environment / Lights
    PerformanceTake[]
      EntityTrack[] / PoseTrack[] / EventTrack[]
  CoverageSequence[]
    CoverageShot[]
      takeId / frame range / camera / optics
  ArtifactGraph
    ShotIR / passes / generated media / editorial nodes
```

一个纯帧求值器驱动 viewport、multi-view、capture、render pass、prompt compiler、quality
audit 和 Agent observation。Provider prompt 与 render adapter 只能是 projection，不能成为
第二套 scene model。

### `ShotIR`

ShotIR 固定 shot identity、frame range、camera、lens、actor、动作、灯光、reference、
prompt、provider capability、来源 revision 和 degradation report。适配器必须声明支持、
近似、忽略和拒绝的字段。

### Render-pass graph

clean、depth、normal、object-ID、mask、camera plot 和 metadata 都绑定同一个 exact frame
与 project fingerprint。任何 helper visibility 变化都会使证据失效。

### Agent 契约

Agent 使用 `observe → author → audit → preview/deliver`，通过 semantic ID、guard、
idempotency key 和 receipt 操作。成功响应必须告诉 Agent 它实际改变了什么。

## 交付顺序

1. **P0：production truth**——ProductionGraph、PerformanceTake/CoverageShot、纯帧 evaluator、ShotIR 和 stale-write protection；
2. **P0：deterministic package**——固定帧离屏渲染、各类 pass、PNG ZIP、容器编码和完整 hash package；
3. **P1：角色与构图**——IK、retarget、骨骼取景、Shot Explorer、动作库和 waypoint；
4. **P1：多视图与空间安全**——scissored view、helper layer、swept collision 和导航；
5. **P2：artifact graph 与剪辑**——非破坏 take、生成节点、多镜头音频/字幕/转场和 reconform。

## “包含并超过能力并集”的定义

一项能力只有同时具备以下内容才算完成：

1. schema 持有的持久表示或有文档的派生 artifact；
2. 使用同一状态的真实 UI 和 Agent 路径；
3. 确定性校验以及撤销/重试行为；
4. 领域单元测试与主流程浏览器 E2E；
5. 能证明最终 artifact 受影响的导出证据；
6. 每个依赖和资产都有 provenance 与许可证决定。

只有 prompt fallback、禁用控件或“看起来完成”的截图，都不算完成。
