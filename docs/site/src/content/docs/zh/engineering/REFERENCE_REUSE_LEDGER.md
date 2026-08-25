---
title: 参考复用与来源台账
description: Director 的外部项目研究、源码复用、资产来源、许可证和维护门槛。
---

## 规则

1. 行为研究和源码复制分开记录；
2. 代码、模型、纹理、字体、图像和网站内容分别审计；
3. MIT/Apache 代码必须保留 license、NOTICE 和修改说明；
4. 不明确或限制性许可只允许 clean-room 行为研究；
5. 每条实际复用必须记录上游仓库、revision、上游路径、本地路径、修改范围和测试；
6. 没有可定位来源的 README 断言不算能力证据。

## 八个仓库的研究边界

| 项目             | 研究重点                                     | 当前边界                          |
| ---------------- | -------------------------------------------- | --------------------------------- |
| Blockout         | coverage、take、真实 film gate、Shot Package | Apache-2.0 与 NOTICE，FFmpeg 另审 |
| 3D Director Desk | 相机掌镜、路径和 clean capture               | MIT 代码，资产另审                |
| Nomi             | 非破坏 take、无限画布、固定帧参考            | Apache-2.0，资产另审              |
| CineForge Previz | 相机/对象 waypoint 与 MP4 导出               | CC BY-NC-SA，只做 clean-room      |
| Storyboarder     | IK、姿势库、骨骼取景和 Shot Explorer         | 限制性 EULA，只做 clean-room      |
| Framepilot       | quad view 与 provider-neutral prompt IR      | MIT，仍需逐项确认                 |
| Infinite Canvas  | typed media DAG 与 capture-to-node           | AGPL-3.0，clean-room 或独立许可   |
| 虚拟制片研究 #8  | 角色跟随与独立角色资产                       | PolyForm 非商业，只做独立实现     |

## 活跃源码复用登记

DeepSeek Harness 以 git 子模块 `vendor/deepseek-harness` 使用。导演台 / 画布 / 视频 /
Blender 工具在 `@director/dsh-plugin-workbench`。树内对 DSH UI 与 workspace/web/subagent
工具的聚焦拷贝已于 2026-08-17 删除。不要再拷一份。
任何新的复制都必须先增加本表和受影响文件的 provenance。

## 不要混淆的其他来源

Three.js、Blender、Mixamo、LTX 和公共模型目录各自拥有独立的 license、notice、
版本和资产规则。使用某个项目的行为参考，不代表可以复制它的源码或再分发它的资产。

Hunyuan3D-2、TRELLIS 与 ARDY 以 Git 子模块锁定在 `vendor/` 下，不拷贝进其他目录。
许可、commit 与义务见英文[参考复用台账](/engineering/reference_reuse_ledger/)与
[第三方声明](/zh/engineering/third_party_notices/)。

## 维护门槛

每次 release 前检查来源 revision、license、notice、hash、打包范围和 clean-room 边界。
无法确认许可的文件从发布 artifact 中排除，并在 receipt 中记录原因。
