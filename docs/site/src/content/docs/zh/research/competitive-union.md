---
title: 竞品能力并集
description: Director 3D 制作架构的来源核验能力并集与交付关卡。
---

Director 的目标是七个制作工具经过测试的能力并集，而不是把它们的控件做成视觉集合。详细的、锁定修订号的审计维护在 `docs/site/src/content/docs/engineering/COMPETITIVE_UNION_ARCHITECTURE.md`。

## 锁定的参考项目

| 项目                                                                | 已验证优势                                          | 复用边界                              |
| ------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------- |
| [Blockout](https://github.com/wassermanproductions/blockout)        | coverage/take、真实 sensor gate、精确帧和控制包导出 | Apache-2.0 与 NOTICE；FFmpeg 另行审计 |
| [3D Director Desk](https://github.com/xiaozangao/3d-director-desk)  | 相机掌镜、目标感知路径、clean capture               | MIT 代码；资产有独立许可证            |
| [Nomi](https://github.com/aqm857886159/Nomi)                        | 非破坏 take、无限画布生成流程、固定时间参考捕获     | Apache-2.0；资产另行审计              |
| [CineForge Previz](https://github.com/Work-Fisher/cineforge-previz) | 联动相机/对象路径点和隔离 MP4 导出                  | CC BY-NC-SA；只采用 clean-room 行为   |
| [Storyboarder](https://github.com/wonderunit/storyboarder)          | IK、姿势库、骨骼感知取景、Shot Explorer             | 限制性 EULA；只采用 clean-room 行为   |
| [Framepilot](https://github.com/rahmanef63/framepilot)              | 单渲染器四视图和 provider 中立 prompt IR            | MIT                                   |
| [Infinite Canvas](https://github.com/tigerowo/infinite-canvas)      | 类型化媒体 DAG 与 capture-to-node 流程              | AGPL-3.0；clean-room 行为或独立许可   |

完整审计会记录修订、源码路径、实现限制和资产许可证警告。没有可访问源码路径的 README 声称不算已实现能力。

对于 clean-room 项目，Director 使用独立记录的行为要求，不使用改名或改写语法的受保护源码。MIT 和 Apache-2.0 实现可以复用，但必须保留 NOTICE 和修改义务；代码与模型资产始终分开审计。

`docs/site/src/content/docs/engineering/REFERENCE_REUSE_LEDGER.md` 是维护中的来源台账：它区分只研究行为和实际源码复制，分开追踪代码与资产，并要求记录准确的上游/本地路径后，才可合并聚焦的 MIT 或 Apache-2.0 适配。目前审计日期内没有登记这七个仓库的源码复制；改名、翻译或结构重写的片段仍属于源码复用，应登记。

## 统一架构

Director 把并集收敛为一个制作真相：

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

同一个纯帧求值器必须驱动视口、多视图、捕获、渲染 pass、prompt 编译、质量审计和 Agent 观察。Provider prompt 与渲染适配器只是这个状态的投影，不能成为第二套场景模型。

## 必要能力关卡

### 制作与相机

- 跨多个独立相机 coverage 复用同一个演员表演；
- 使用真实 sensor gate 和 crop-to-aspect FOV，并支持 aperture、focus、shutter、ISO、近/远裁剪和可选 anamorphic 光学；
- 生成可编辑、理解主体的景别与相机运动，而不是只有 prompt 描述；
- 在同一精确帧求值演员、道具、相机、镜头、对焦、灯光和剪辑切换。

### 角色与空间控制

- 提供末端 IK、pole target、姿势镜像/搜索/保存、retarget、root motion、foot lock 和可靠落地；
- 提供带 seed 的群组编队、canon、镜像、双人反应和共享路径；
- 编辑器、相机和演员路径使用 swept/capsule 碰撞，需要路线时使用导航数据。

### 视口与输出

- 持久化 quad inspection layout 使用一个 WebGL renderer 和一个场景状态渲染 perspective、top、front、right 四个 pane；当前 pane 有意只读，可配置 Camera/Side/custom pane 与逐 pane 导航仍是交付关卡；
- 将标签、路径、gizmo、网格和相机辅助线放在显式 helper layer；
- 时间线可以确定性导出含 IN/OUT 两端的 PNG ZIP，写入微秒时间、每帧 SHA-256、package fingerprint、进度和取消；配置真实 WebCodecs encoder 与 container muxer 前，同一路径不能产出可播放 MP4/WebM，更不能把 ZIP 改名成视频；
- 独立浏览器 `MediaRecorder` 是实时预览录制，不是确定性渲染；
- 用 hash 打包精确视频、静帧、camera plot、marks、元数据、来源、ShotIR、prompt adapter 和 workflow 文件。

### 生成、剪辑与 Agent 控制

- 把一个 provider 中立的 ShotIR 编译为生成器适配器；
- 用类型化、可撤销的 artifact graph 表示镜头、take、capture、参考、生成媒体和剪辑结果；
- 通过 revision/fingerprint 前置条件拒绝过期 Agent mutation，并让长时间导出成为可重试 job；
- UI 与 Agent 使用相同操作、校验、图规则和证据。

## 交付顺序

当前已落地的基础包括物理 filmback/crop 数学、物理 anamorphic 投影、带颜色与硬件 depth 的 DOF、持久化单渲染器只读 quad 视图、schema 支持的 Performance Take/Coverage Shot、纯制作求值器、浏览器/HTTP/MCP 的制作感知 ShotIR、确定性项目修订与过期写保护，以及确定性 PNG frame-package 导出。下面仍是交付关卡，不代表控件或文档已经等于完整 renderer。

1. **P0：制作真相**——sensor gate、PerformanceTake/CoverageShot 迁移、纯帧求值器、ShotIR 和过期写保护；
2. **P0：确定性 package**——固定帧离屏渲染、clean/depth/normal/ID pass、确定性 PNG ZIP 已落地；生产级容器编码与完整 hash shot package 仍待完成；
3. **P1：角色与构图**——IK、retarget、骨骼感知取景、Shot Explorer、动作/编舞库和联合路径点；
4. **P1：多视图与碰撞**——scissored view、helper layer、swept collision 和可选导航；
5. **P2：artifact graph 与剪辑**——非破坏 take、生成节点、多镜头音频/字幕/转场与 reconform。

## 完成定义

能力只有同时具备以下内容才算完成：

1. schema 持有的持久表示或有文档的派生 artifact；
2. 使用同一状态的真实 UI 路径和 Agent 路径；
3. 确定性校验以及撤销/重试行为；
4. 领域单元测试和主流程浏览器 E2E；
5. 能证明影响最终 artifact 的导出证据；
6. 每个依赖和资产都有来源与许可证决定。

禁用控件、只有文档的功能，以及被展示成已执行 3D 变更的 prompt fallback，都不算完成。
