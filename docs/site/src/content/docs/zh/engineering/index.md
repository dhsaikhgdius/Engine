---
title: Director 工程文档地图
description: Director 的工程契约、架构决策、管线设计与研究记录。
---

这一整块面向贡献者和维护者：ADR、路线图、复用台账和实现契约。新用户请从
[快速开始](/zh/getting-started/)进入。页面保持公开，是为了让 schema 与许可证决策可检查，
而不是作为操作入门路径。

这里汇总 Director 的工程与产品契约。它与操作指南位于同一个文档站中，是修改
schema、管线和外部契约时应维护的规范记录。

## 状态词汇

- **已实现**：代码存在、测试覆盖，并且可通过用户或 Agent 控制面使用；
- **部分实现**：核心契约存在，但仍有重要的生产或恢复路径未完成；
- **提案**：设计目标，不代表当前运行时已经提供。

不要因为存在文件格式或 UI 控件，就把提案描述成已发布功能。

## 从这里开始

| 文档                                                                   | 用途                                                                 |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [管线与系统设计](/zh/engineering/pipeline_system_design/)              | 端到端制作管线、边界、不变量、关卡与演进计划。                       |
| [实施路线图](/zh/engineering/pipeline_implementation_roadmap/)         | 里程碑、模块边界、迁移、验收和 PR 顺序。                             |
| [架构决策记录](/zh/engineering/adr/)                                   | ProductionGraph、持久化任务和互操作回执的决策。                      |
| [Agent 运行时内核](/zh/engineering/architecture/agent-runtime-kernel/) | 所有 Agent Provider 共享的事件、Inbox、Turn 所有权与工具执行内核。   |
| [创作生产对齐](/zh/engineering/creative-production-parity/)            | 产品完成关卡和恢复旅程。                                             |
| [Agent-native 操作指南](/zh/engineering/agent_native_operator_guide/)  | Provider 无关的 Agent 操作、并发保护、重试和证据要求。               |
| [Agent-Native 优化路线图](/zh/engineering/agent_native_roadmap/)       | UI/Agent 对等、统一治理、workspace、可观测性与团队就绪的分阶段计划。 |
| [复刻规范](/zh/engineering/replication_spec/)                          | 紧凑 Stage 协议与运行时行为契约。                                    |
| [竞品能力并集架构](/zh/engineering/competitive_union_architecture/)    | 从相关 previs 和 filmmaking 系统研究出的能力并集。                   |

## 管线与资产

| 文档                                                                    | 范围                                                                                             |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [角色资产与动作](/zh/engineering/character_asset_motion_pipeline/)      | 角色来源、规范化、rig、retarget、动作层和许可。                                                  |
| [白模到视频](/zh/engineering/video_gen_pipeline/)                       | 当前白模到视频任务契约与 ComfyUI 适配器。                                                        |
| [Blender 原生后端与文件交换](/zh/engineering/blender_bridge/) | Live 场景所有权、Director 根对象同步、原生 Mesh/Rig 编辑，以及可选 `.blend` 导入与稳定 ID 回传。 |
| [Multi-DCC 集成（英文）](/engineering/multi_dcc_integration/)            | 规范 IR、提供方能力声明、可移植交换包、Unreal / Unity / Godot 原生适配器成熟度与推进顺序。       |
| [参考复用台账](/zh/engineering/reference_reuse_ledger/)                 | 来源复用、许可、修订和 clean-room 决策。                                                         |

## 研究与发布证据

| 文档                                               | 范围                           |
| -------------------------------------------------- | ------------------------------ |
| [第三方声明](/zh/engineering/third_party_notices/) | 第三方源码、资产和许可证说明。 |

## 文档规则

1. 先说明 source of truth，再说明 UI；
2. 写出跨边界传递的 schema 或契约版本；
3. 明确单位、坐标系、时间基准、身份和二进制所有权；
4. 分开结构校验、语义校验、视觉审查和交付；
5. 同时记录失败与恢复路径，而不只是 happy path；
6. 工程断言优先链接测试和源码模块，而不是截图；
7. 契约变化时，在同一变更中更新规范记录和对应操作页面。

英文原始记录仍可从对应中文页面的顶部导航切换查看。
