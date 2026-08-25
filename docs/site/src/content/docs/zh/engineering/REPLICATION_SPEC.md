---
title: Agent-native 3D Stage 复刻规范
description: Director Stage 的 clean-room 边界、场景模型、控制面和视觉一致性契约。
---

## Clean-room 边界

本规范只描述可独立实现的行为、schema 和可观察结果，不复制外部项目的受保护源码、
命名或实现结构。参考截图是视觉验收材料，不是源码或资产许可。

## 参考画面

视觉比较基于公开的
[Flick 3D Stage](https://flick.art/canvas/dc024bd1-d1bb-43ee-b131-74d811fa10ca?view=stage)。
本地审查使用的第三方截图属于证据，不属于可再分发的 Director 资产，因此不会进入源码仓库。
验收仍以当前 Director 的结构数据、测试和精确 capture 为准。

## 场景模型

StageScene v5 以 JSON 表达 scene、object、asset、transform、camera、timeline、show、
character、animation 和 metadata。对象 ID 稳定，transform 使用 metre、明确 up axis 和
handedness；asset URL、thumbnail、hash、来源和 floor offset 不能靠 UI 推断。

## 运行时架构

浏览器拥有 WebGL scene、相机、capture、helper layer 和可见状态；gateway 负责认证、
revision、命令校验、MCP/HTTP/CLI adapter 和持久化；Agent 只通过语义 operation 访问
准确 target。clean capture 必须隐藏 grid、gizmo、label、path、camera helper 和骨骼。

## Agent 协议

### `stage_read`

用于 capabilities、observe、inspect、diff、audit 和 revision。读取结果应返回准确 target、
project revision、对象/相机/时间状态和 evidence fingerprint。

### `director_workbench`

用于完整 DirectorProject 的语义 authoring、catalog、角色、相机、timeline、coverage、
audit、preview 和 delivery。写入必须带 revision guard 和 idempotency key。

### `director_creative`

用于 Canvas/Video workspace 的 observe、execute_batch、audit、preview、媒体和 editorial
操作。它绑定的是 scene snapshot fingerprint，不是 Stage revision。

### `stage_object`

提供白模对象的创建、更新、删除、变换、材质和组操作。对象必须经过 schema 和空间审计，
不能用未验证的任意 JSON 覆盖 scene。

### `stage_camera`

提供 camera 创建、目标、镜头、sensor、aspect、focus、DOF、路径、coverage 和 clean capture。
capture 绑定 exact frame、camera ID、revision 和 helper policy。

### `stage_show`

负责时间线、播放、IN/OUT、shot、take 和录制/导出。实时 MediaRecorder 是预览证据，不能
声称是确定性渲染；确定性 package 必须保存每帧 hash 和时间基准。

## Provider-neutral 控制面

MCP、HTTP、CLI、browser API 和 coding-agent plugin 都应投影到同一 semantic operation。
任何 adapter 必须保持 target guard、幂等性、错误码、receipt 和 audit 语义一致。

## Fidelity lock

视觉一致性要求：

- 视口、相机和 helper layer 使用同一 scene state；
- 角色、道具和相机的落地/目标/景别由可重复的空间规则计算；
- capture、preview、audit 和 Agent observe 使用同一帧求值器；
- UI 可以展示结果，但不能成为唯一的 source of truth。

## 视觉台账

每次参考比较记录窗口尺寸、DPR、浏览器、项目 revision、相机、frame、资产 hash、
capture path、差异和结论。只记录“看起来相同”不足以证明复刻完成；必须同时保存结构、
行为和视觉证据。
