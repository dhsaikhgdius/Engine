---
title: 第三方声明
description: Director 使用的第三方源码、资产、参考项目和许可证说明。
---

Director 的源码和资产来源必须分开审计。行为研究不等于源码复制；改名、翻译或结构重写
的代码仍然属于源码复用，必须登记来源、修订号、许可证和修改范围。

## DeepSeek Harness

Agent harness 是 git 子模块 `vendor/deepseek-harness`
（[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，
MIT，commit `47f943859bef60e4160492346772ded9b24f765a`）。导演台、画布、视频与
Blender 工具在 `@director/dsh-plugin-workbench`。树内对 DSH UI 与
workspace/web/subagent 工具的聚焦拷贝已于 2026-08-17 删除。不要再拷一份；使用子模块。

## Adobe Mixamo 本地角色与动画包

本地开发 checkout 可以由项目所有者在 `assets/library/mixamo-characters` 和
`assets/library/mixamo-animations` 中准备 Mixamo 角色与动作。Git 只跟踪生成 catalog，不跟踪
GLB、FBX 或缩略图 payload。每项内容都必须记录下载来源、文件哈希、处理步骤和再分发许可。

原始或转换后的 Mixamo 资产不能作为独立资产库发布，包括 public、gated 或共享 private
Hugging Face bundle。资产 manifest 必须把它们表示成没有远端仓库或下载路径的
`user-provided`；运行目录中存在文件不代表它们可以公开发布。

完整来源、revision、notice 和许可证状态见[参考复用台账](/zh/engineering/reference_reuse_ledger/)。

## Lightricks LTX-2 源码子模块

`vendor/ltx-2` 是 Lightricks 官方 LTX-2 仓库的 Git 子模块，固定在
revision `9377758131b1ffde4b7f766804590a6617bf2ab9`。它不适用 Director 根仓库的源码
许可证；源码、模型权重、衍生物及其使用均受独立的
[LTX-2 Community License](https://github.com/Lightricks/LTX-2/blob/9377758131b1ffde4b7f766804590a6617bf2ab9/LICENSE)
约束，其中包括可接受使用限制，以及协议所列收入门槛以上实体需要另行取得商业许可证的要求。

Director 源码仓库不镜像 LTX-2.3 checkpoint。用户必须自行审阅并接受上游条款、取得 gated
权重，并在 `npm run setup:ltx2` 前设置 `DIRECTOR_ACCEPT_LTX2_LICENSE=1`。固定的源码与模型
revision 记录在 `vendor/ltx-2.lock.json`。

## Tencent Hunyuan3D-2 源码子模块

`vendor/hunyuan3d` 是
[Tencent-Hunyuan/Hunyuan3D-2](https://github.com/Tencent-Hunyuan/Hunyuan3D-2) 的 Git 子模块，
固定在 `f8db63096c8282cb27354314d896feba5ba6ff8a`，受
[Tencent Hunyuan 3D 2.0 Community License](https://github.com/Tencent-Hunyuan/Hunyuan3D-2/blob/f8db63096c8282cb27354314d896feba5ba6ff8a/LICENSE)
约束（含地域排除与协议所列 MAU 商业门槛）。Director 不把 Hunyuan3D 源码或权重复制到其他目录。
运行 `npm run setup:hunyuan3d` 前须设置 `DIRECTOR_ACCEPT_HUNYUAN3D_LICENSE=1`。

## Microsoft TRELLIS 源码子模块

`vendor/trellis` 是
[microsoft/TRELLIS](https://github.com/microsoft/TRELLIS) 的 Git 子模块，固定在
`442aa1e1afb9014e80681d3bf604e8d728a86ee7`。锁定的 TRELLIS 源码为 MIT。嵌套 FlexiCubes
以及部分网格/渲染 pip 依赖另有许可证，商业部署前须另行审阅。运行 `npm run setup:trellis`。
锁定记录在 `vendor/trellis.lock.json`。

## NVIDIA ARDY 源码子模块

`vendor/ardy` 是
[nv-tlabs/ardy](https://github.com/nv-tlabs/ardy) 的 Git 子模块，固定在
`693f74d13b3d04a0a22ce127ee79c929dd89756b`（Apache-2.0）。模型 checkpoint 与数据集在
Hugging Face 上另行授权。Director 网关调用上游 `scripts/generate.py`，不重写模型。
运行 `npm run setup:ardy`。锁定记录在 `vendor/ardy.lock.json`。
