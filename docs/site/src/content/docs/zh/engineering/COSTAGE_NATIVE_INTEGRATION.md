---
title: CoStage 功能审计与原生集成
description: 对 cs68614-hash/costage 的逐项能力审计、许可证边界和 Director 原生集成决策。
---

审计日期：2026-08-02  
上游仓库：<https://github.com/cs68614-hash/costage>  
锁定修订：`fa1b7fa0b40d6f71c2700ed503613dea088b6f70`  
修订说明：`Add action-stage timeline synchronization`

## 结论

CoStage 是一个约束清晰的小型 Codex MCP App：它把 Three.js 导演台内嵌为原生 Widget，
并通过语义化 MCP 操作和电影知识 Skill 让 Agent 实际修改场景。Director 已经覆盖并超过其
大部分 3D、相机、角色、时间线和 Agent 能力；本轮真正需要吸收的是可组合的空间关系语义，
而不是再复制一个 Widget、场景模型或静态快照时间线。

Director 现在原生提供：

- `place_relative`：世界、目标局部或相机屏幕坐标中的相对放置；
- `arrange_group`：line、grid、circle、arc 编队及确定性朝向；
- `arrange_facing_pair`：两人间距、位置和互相朝向的一次性原子编辑；
- `orient_toward`：面向真实对象或世界坐标目标；
- 默认相对距离与编队间距来自共享的旋转 bounds；`clearance_m` 可表达可见边缘净距；
- 同一套 Zod 契约、项目模型、锁定保护、revision guard、idempotency、Undo、audit 和
  `deliver` 交付闭环。

## 许可证与复用边界

锁定修订根目录没有 `LICENSE` 文件，`package.json` 也没有许可证声明。因此本次只做
行为级研究与独立实现，不复制、翻译或改写 CoStage 源码、Skill 章节、模型或其他资产。
这一决策记录在 Director 的 reference reuse ledger 中。

## 完整功能范围

| CoStage 能力                              | 上游证据                                                   | Director 状态                                                            | 原生决策                                                                |
| ----------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Codex 原生全屏/inline Widget              | `mcp/server.mjs`, `mcp/lib/widget-resource.mjs`            | Director 使用完整浏览器应用 + 可移植 MCP 插件                            | 不复制第二套 UI；保持浏览器为唯一可视真相，MCP 绑定精确目标             |
| Widget 静态构建内联与 CSP 处理            | `mcp/lib/static-widget.mjs`                                | Vite 应用与 bundled MCP 分离构建                                         | 不引入；避免将大型编辑器内联进每个工具结果                              |
| thread/project 两级 `stageDir` 存储       | `mcp/lib/stage-storage.mjs`                                | 项目场景、production manifest、浏览器持久化、Agent session 持久化        | 语义已覆盖；不增加第三套存储协议                                        |
| revision 读取与 stale whole-document save | `get_director_stage_revision`, `save_director_stage_state` | SHA-256 项目 revision、精确浏览器 lease、idempotency 和未知结果恢复      | Director 更强，保留现有协议                                             |
| SSE 场景/选择同步                         | `mcp/lib/stage-events.mjs`                                 | 网关 WebSocket、页面状态桥、Yjs collaboration                            | 已覆盖并超过                                                            |
| 多场景新建、切换、重命名、复制、删除      | `applyStageOperations` 的 scene actions                    | production manifest、ProductionPanel、host scene switch、Workbench Agent | 已原生集成；统一 revision/idempotency 契约，复制会写入独立项目作用域    |
| 角色、道具、相机、环境结构树              | `frontend/director/src/App.tsx`                            | 分组对象树、资产、角色、组合对象、相机和场景面板                         | 已覆盖并超过                                                            |
| 8 个内置 GLB 角色与 IndexedDB 缓存        | `public/assets/3d-characters`, `directorStageClient.ts`    | Mixamo/XBot 资产目录、rig/geometry hash、预览、动作目录和本地资产缓存    | 已覆盖并超过；不得复制上游 GLB                                          |
| 自适应插入当前镜头附近                    | `adaptiveScenePlacement`                                   | catalog authoring payload、grounding、共享 bounds 和相机 framing         | 空间净距已原生化；后续仅继续增强 frustum 与详细 mesh 验收               |
| 移动/旋转/缩放 Gizmo 与可视中心           | `EditableObject`, `TransformControls`                      | Director Gizmo、中心点、组合父级、lasso、四视图                          | 已覆盖并超过                                                            |
| 锁定、复制、删除、选择                    | Scene tree handlers + selection MCP                        | UI/MCP author、锁定所有权、强制覆盖显式化、Undo                          | 已覆盖并超过                                                            |
| 25 字段静态姿势与关节标记                 | `Pose`, `applyCharacterPose`, `PoseSkeletonOverlay`        | Mixamo 骨骼动作、语义 pose controls、手脚 IK、retarget、root motion      | 已超过；不降级到静态 25 字段副本                                        |
| 姿势预设                                  | `characterAssets` / pose UI                                | pose presets、语义控制、动作 catalog                                     | 已覆盖并超过                                                            |
| 多相机 position/target/FOV/aspect         | `CameraPlan`, `CameraPanel`                                | 焦距、sensor gate、光圈、焦点、快门、ISO、裁切、变形宽银幕、shake        | 已超过；保留物理相机模型                                                |
| 相机 PIP、纯相机视图、截图                | `CameraMarker`, `CameraFrame3D`, clean render              | 可移动 PIP、clean capture、revision-bound render passes 和 Shot Package  | 已超过                                                                  |
| 2:1 全景上传、校验、哈希存储              | panorama tools + `panorama-assets.mjs`                     | equirectangular/backdrop 导入、接缝/极点处理、资产模型                   | 已覆盖；服务端 content-addressed 二进制存储仍可继续增强                 |
| 全景旋转、地平线、光照强度                | `EnvironmentState`                                         | yaw/radius、背景与地面显示                                               | 部分覆盖；pitch/基于全景的照明属于独立渲染改进，不应绑到空间语义补丁    |
| 时间轴镜头静态 scene snapshot             | `TimelineShot.sceneSnapshot`                               | frame-native transform/pose/camera animation、storyboard、takes/coverage | Director 已超过；不引入第二条快照时间线                                 |
| action stage 与多机位同步刷新             | `createTimelineShot`, `refreshTimelineShot`                | PerformanceTake + CoverageSequence/Shot 复用同一表演                     | Director 的非破坏 take/coverage 模型更强，保持为唯一生产真相            |
| 镜头排序、改名、时长、删除、播放          | `updateTimeline`, `TimelinePanel`                          | Stage timeline、storyboard、coverage 和 Video Editor                     | 已覆盖并超过                                                            |
| 场景 CRUD 语义操作                        | `apply_director_stage_operations`                          | `director_workbench` 的 `production` 操作                                | 已原生集成；服务端原子校验、冲突码、幂等回放与浏览器确认切换            |
| 相对放置                                  | `place_relative`                                           | `place_relative` + directional OBB support                               | 已原生集成                                                              |
| line/grid/circle/arc 编队                 | `arrange_group`                                            | `arrange_group` + bounds-aware default spacing                           | 已原生集成                                                              |
| 两人相向                                  | `arrange_facing_pair`                                      | `arrange_facing_pair` + bounds-aware clearance                           | 已原生集成                                                              |
| 朝向对象/坐标                             | `orient_toward`                                            | 本轮加入 `orient_toward`                                                 | 已原生集成                                                              |
| 全状态替换、局部操作、选择 MCP            | `mcp/server.mjs`                                           | `director_workbench` observe/inspect/author/select/patch/replace         | 已覆盖并超过                                                            |
| 电影镜头基础与实战 Skills                 | `skills/shot-design-*`                                     | 单一 workbench skill + operations/reference/docs                         | 能力已在控制闭环中；应独立编写可验证的镜头 recipe，不能复制无许可证章节 |
| 角色动作设计 Skill                        | `skills/character-action-design`                           | motion/pose/IK catalog + workbench skill                                 | 技术能力已超过；继续补独立动作验收 recipe                               |
| Agent 修改后回读验收                      | 所有 CoStage Skills 的 Execution Contract                  | observe → author → audit/correct → deliver → inspect pixels              | Director 更严格，保留现有闭环                                           |

## 不应照搬的设计

### 单体 `App.tsx`

CoStage 的主要 UI、类型、默认数据、3D runtime、姿势、树、Inspector 和时间轴集中在一个
约 4,600 行文件。Director 已按 schema、runtime、canvas、timeline、panels、agent 和 server
拆层，不应为了 Widget 形态回退为单体应用。

### 第二套场景真相

CoStage 的 `DirectorStageDocument`、每镜 `sceneSnapshot` 和 MCP storage 是一套自洽的小型模型。
把它直接放进 Director 会与 `DirectorProject`、Production Take/Coverage、Canvas/Video artifact
graph 和协作 revision 产生竞争真相。新能力必须编译到现有 `DirectorProject`。

### 静态姿势与离散运镜

上游明确不支持连续骨骼动画、手脚 IK、接触约束或平滑相机轨迹；运动通过多张静态快照表达。
Director 已有 frame-native animation、Mixamo clips、IK、camera action 和 deterministic capture，
不应为兼容上游表现形式而降级。

### 弱结构补丁

CoStage 操作 schema 的 `patch`/`value` 使用开放 record，完整文档保存使用 `z.any()`；同时
`stage-storage.mjs` 仍保留手写字段检查。Director 保持单一 Zod 契约和严格 action schemas，
空间语义只编译成已有的 `update_object`。

## 本轮实现的执行语义

### 坐标参考

- `world`：世界 `+Z` 为前、`+X` 为右；
- `target`：使用 anchor 当前 Y 轴旋转的局部前/右；
- `camera`：使用真实相机 position → target 的水平投影；屏幕前景向相机，背景向镜头深处；
- `offset_m` 固定解释为 `[right, up, forward]`，避免 Agent 猜测 XYZ。

### 安全与验收

- 引用不存在、重复 ID、零长度 axis、自朝向或无相机时原子拒绝；
- 锁定对象仍由已有 `update_object` 保护，只有显式 `force:true` 才能覆盖；
- `look_target_object_id` 只在真实对象目标存在时持久化；
- 所有坐标和 yaw 确定性舍入，重试不会产生漂移；
- mutation 成功不是完成证明；仍需最新 revision 上的 `audit`/`deliver` 和 clean frame 检查。

## 后续优先级

1. 基于 Director 自己的物理相机、Shot IR 和 audit 写独立镜头设计 recipes；不复制 CoStage
   无许可证 Skill 文本。
2. 为全景增加 pitch 与环境照明时，必须由同一 frame evaluator 驱动 viewport、capture、
   Shot Package 和 video-gen 输出，不能只做面板控件。

## 完成标准

CoStage 某项能力只有同时满足以下条件才算被 Director 吸收：

1. 使用现有 schema-owned production truth；
2. UI 与 Agent 操作同一数据和验证；
3. mutation 有 revision、idempotency、Undo 与原子回滚；
4. 有单元测试和失败路径；
5. 视觉能力能通过 revision-bound capture/deliver 证明；
6. 许可证与资产来源在 ledger 中有明确决定。
