---
title: 命令地图
description: Director Workbench 与 Stage 操作的紧凑参考。
---

## 仓库启动命令

| 命令                        | 用途                                                   |
| --------------------------- | ------------------------------------------------------ |
| `npm run dev`               | 以 watch 模式运行 Director UI 与 Gateway               |
| `npm run blender`      | 运行 Director 与绑定的原生 Blender 场景           |
| `npm run blender:test` | 用解析到的可执行文件运行 Blender 原生冒烟测试套件 |

只做浏览器布景时使用 `npm run dev`；需要在绑定场景中 provision 或编辑原生模型、mesh、材质、UV、
modifier、armature、action 或 NLA 时使用 `npm run blender`。它们是同一产品的两种启动模式，
不是两种项目格式。

## director_workbench 操作

| 操作              | 用途                                 |
| ----------------- | ------------------------------------ |
| `capabilities`    | 列出支持的操作和创作词汇             |
| `production`      | 观察或修改多场景 production manifest |
| `observe`         | 读取选定的紧凑项目切片               |
| `snapshot`        | 必要时读取完整项目                   |
| `inspect`         | 读取单个实体的精确字段               |
| `author`          | 执行一批原子语义动作                 |
| `audit`           | 运行结构、空间、时间和相机空间检查   |
| `correct`         | 应用针对审计 token 的校验修复        |
| `diff`            | 比较本轮项目变更                     |
| `trace`           | 检查操作耗时、状态与质量关卡结果     |
| `capture`         | 请求干净视口或相机帧                 |
| `shot_ir`         | 求值可移植的精确帧场景/相机契约      |
| `shot_package`    | 捕获带 hash 的多通道精确帧证据包     |
| `deliver`         | 审计并完成用于验收的干净视觉证据     |
| `select`          | 改变 Workbench 选择                  |
| `viewport`        | 改变支持的视口 UI 状态               |
| `playback`        | 控制时间线传输                       |
| `patch`           | 未覆盖字段的 JSON Patch escape hatch |
| `replace_project` | 替换完整的已校验项目                 |
| `undo`            | 撤销最近一次被跟踪的项目 mutation    |

### 多场景 production 契约

修改 production 前先调用 `{"op":"production","command":{"action":"observe"}}`。
响应会给出服务端权威的整数 `production_revision`；mutation 需要把它作为
`expected_revision` 回传，并且只为完全相同的重试复用同一个稳定 `idempotency_key`。

支持 `rename_production`、`create_scene`、`duplicate_scene`、`rename_scene`、
`activate_scene` 和 `delete_scene`。`duplicate_scene` 要求源场景正加载于绑定浏览器中，
并为目标场景写入一份独立的 scoped `DirectorProject`。删除最后一个场景时必须显式提供
`replacement`。切换完成后应重新 observe，因为浏览器 target lease 与项目 revision 已属于目标场景。

`author.start_scene` 只重置或替换当前已加载场景内的内容，不会新建 production 场景。

## 语义 author 动作

| 动作                                              | 用途                                         |
| ------------------------------------------------- | -------------------------------------------- |
| `start_scene`                                     | 开始新场景或替换场景                         |
| `set_scene`                                       | 修改全局场景设置                             |
| `upsert_asset` / `remove_assets`                  | 管理项目资产                                 |
| `add_object` / `update_object` / `delete_objects` | 管理对象和角色                               |
| `compose_blocking`                                | 编译多角色语义布局并适配相机取景             |
| `place_relative` / `orient_toward`                | 用世界、目标局部或相机语义放置和朝向已有对象 |
| `arrange_group` / `arrange_facing_pair`           | 创建确定性编队和双人相向关系                 |
| `add_camera` / `update_camera` / `delete_cameras` | 管理相机                                     |
| `set_animation`                                   | 替换完整的 v1 动画                           |
| `set_storyboard`                                  | 替换或移除分镜数据                           |
| `set_active_camera`                               | 改变当前镜头相机                             |

`set_scene` 要求非空 `patch`，不会创建新场景。

## Stage 工具族

这些是遗留的紧凑 `StageScene` 接口：仅 HTTP 兼容路由（`POST /api/tools/stage_*`），MCP 不再
对模型公布。具体的每工具 schema 请使用工具帮助。工具族包括：

- `stage_read`：观察、检查、批评、状态和渲染审阅；
- `stage_scene`：重置、配置、校验和制作级场景动作；
- `stage_object`：创建、变换、放置、分组、动画和移除；
- `stage_camera`：创建、配置、瞄准、取景和移动；
- `stage_show`：轨道、动作、时间线、播放、排练和录制；
- `stage_video`：准备、渲染/提交和状态。

## 创作不变量

- 为新实体指定明确稳定 ID；
- 一个用户意图使用一个 `author` 批次；
- 支持的多角色布局优先使用 `compose_blocking`；
- 已有对象的细化使用 `place_relative`、`arrange_group`、`arrange_facing_pair` 和 `orient_toward`，不要猜测世界坐标；
- 省略中心距离/间距即可使用确定性的 bounds-aware 默认值；需要边缘净距时使用 `clearance_m`，不要与 `distance_m`/`spacing_m` 同时传入；
- 把基本体缩放视为度量尺寸，把基本体位置视为地面枢轴（底部中心，不是几何中心）。3 米高的墙立在地面上应写 `position.y = 0` 且 `scale.y = 3`；写成 `position.y = 1.5` 会浮空。天花板底面在 3 米处应写 `position.y = 3`，而不是 `3 + 厚度/2`；
- 为模型资产提供以米为单位的真实尺寸（`realWorldSizeM`，取包围盒最大边）；缺失时资产会回退到旧的 2 m 显示归一化，audit 也会报告 `asset_missing_real_world_size`；
- 保留锁定对象；
- 使用 `deliver` 并检查 clean frame 后再报告视觉完成。

## 语义空间放置

Agent 创作放置是语义化的，而不是 blanket Y 坐标豁免：

| 意图        | 使用场景                                             |
| ----------- | ---------------------------------------------------- |
| `grounded`  | 地面接触                                             |
| `supported` | 物理桌面、架子或平台接触                             |
| `attached`  | 墙面、车辆、rig 侧面或表面挂载；需要锚定 `parent_id` |
| `suspended` | 悬挂物体；需要空间上位于上方的锚定 `parent_id`       |
| `floating`  | 仅当请求的视觉确实需要无支撑空中放置时使用           |

`parent_id` 不能证明 `supported` 对象的支撑关系。不要仅为消除审计告警而改标签。实时的 `capabilities.spatial_contract` 暴露此决策树。以 revision 绑定的 `deliver` 为验收边界，而非 mutation 成功或独立 audit。对 elevated 的 `auto`/意图未知对象，必须用语义 `author` 动作检查并分类，因为 `unsupported_object` 故意没有自动 lowering 修复；当 audit 其余部分包含安全确定性修复时，可对 `correct.audit_issues` 使用窄子集。

## director_creative 请求

| 请求            | 用途                                                 |
| --------------- | ---------------------------------------------------- |
| `capabilities`  | 发现操作、限制、保护条件和质量配置                   |
| `observe`       | 读取精确 Canvas/Video ID、媒体元数据和 fingerprint   |
| `execute`       | 执行一个受 fingerprint 保护且幂等的操作              |
| `execute_batch` | 以一个原子撤销单元执行 1–32 个持久操作               |
| `audit`         | 检查 Canvas 图、媒体、源范围、重叠和 coverage        |
| `preview`       | 渲染绑定 fingerprint 的干净 Canvas board 或 Video 帧 |

内容操作覆盖 Canvas 节点/边、Video 片段/轨道、seek、工作区切换以及工作区 undo/redo。
`execute_batch` 只接受持久内容 mutation；创建的 ID 可以通过 `save_as` 保存，并在后续步骤中用 `@alias` 引用。
`preview` 接受 `workspace:"auto"|"canvas"|"video"`、可选的 Video `time_sec` 以及最新的 `expected_snapshot_fingerprint`，
会在不移动播放头的情况下返回 PNG 证据。
