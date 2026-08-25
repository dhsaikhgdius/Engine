---
title: 开源资产与 Hugging Face
description: GitHub 只保存 Director 源码；通过不可变 Hugging Face revision 恢复许可明确的运行资产。
---

Director 把**源码仓库**与**资产供应链**明确分开：

- GitHub 保存代码、schema、catalog、测试、文档、生成器、checksum、license 和 notice；
- Hugging Face 只保存已经明确取得再分发权的二进制资产；
- 用户提供或来源许可未解决的第三方内容只留在用户机器上。把它放进 private/gated 仓库并不会自动获得分发权。

这同时是许可证边界、仓库体积边界和可复现边界。源码仓库里的 Git LFS 不能替代这一设计。

## 分发等级

| 等级                  | 当前 checkout 示例                                            | 分发规则                                                                                  |
| --------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 公开、可再分发        | 程序化生成的 open mannequin；带相邻 MIT notice 的原创低模道具 | 审核 notice、hash 和来源后，可以上传公开 HF dataset                                       |
| 用户提供 / local-only | 个人账号导出的 Mixamo 人物与动作                              | 只保留本地；manifest 记录期望 hash 与准备说明，但不能出现 repository 或 remote path       |
| 来源许可未解决        | 本地 Flick Stage 镜像及缩略图                                 | 每项资产取得明确再分发许可前必须留在本地；不能发布到 public、gated 或 private 共享 bundle |
| 审查证据              | clean-room 对比过程中保存的第三方截图                         | 链接公开页面；没有记录再分发权时不随源码发布截图                                          |

Adobe 的 [Mixamo FAQ](https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html) 允许在项目中广泛使用，
但不能把它表述成公开发布独立人物或动作资产库的许可。因此 Director 将现有 Mixamo package 标记为
`user-provided`。

## 仓库边界

根目录 `.gitignore` 默认排除模型、DCC 文件、权重、媒体、下载产物、生成物和可变运行状态，同时
有意保留以下轻量源码材料：

- `assets/library/**/catalog.json`：Agent/UI 发现资产所需的 metadata；
- `README`、`LICENSE`、`NOTICE` 和 `SHA256SUMS`；
- `assets/manifest.schema.json` 与资产 manifest lock metadata；
- `frontend/director/src/**/__fixtures__/` 中的文本交换 fixture；
- 在文档体积预算内、由 Director 自己生成的文档图片；
- `vendor/` 下许可证和固定来源都完整的合法 vendored source。

新增资产库还带有 Asset Catalog v2 manifest（`assets/library/<library>/catalog.v2.json`；zod 契约在
`packages/protocol/src/assetCatalogProtocol.ts`）。用开发者 ingest CLI 生成或更新：
`npx tsx tools/scripts/asset-ingest.ts <files...> --library <library>`，详见
[Agent 资产与人物](/zh/agents/assets/)。

本地研究 checkout 必须放在 `.external/`。官方推理运行时仍以 Git submodule 位于
`vendor/ltx-2`、
`vendor/hunyuan3d`、`vendor/trellis`、
`vendor/ardy`，不能复制到其他源码目录。

提交发布版前运行只读边界审计：

```bash
npm run repo:check
```

审计会检查已跟踪和未被 ignore 的文件，拒绝凭据、模型/权重/媒体 payload、数据库状态、超大源码，
也会防止必要 catalog 或 schema 被错误 ignore。

## Hugging Face 目录

为许可明确的资产创建独立 **dataset** 仓库。内部镜像本地运行路径，让 manifest 中的目标一目了然：

```text
director-open-assets/
  README.md
  LICENSES/
    director-open-mannequin.MIT.txt
    director-builtins.MIT.txt
  assets/
    runtime/
      models/
        storyai-open-mannequin.glb
      model-library/
        models/...
        thumbnails/...
  provenance/
    SHA256SUMS
    build-receipts.json
```

不要把整个 Director `assets/library/` 目录作为上传源。新建一个只含已清权文件的 staging 目录，并明确排除
`mixamo-*`、`flick-stage-props`、下载器产物、DCC jobs、preview 和第三方参考截图。

Hugging Face 当前官方 CLI 使用 `hf upload` 上传目录并可在中断后恢复，详见
[官方上传文档](https://huggingface.co/docs/huggingface_hub/en/guides/upload)：

```bash
python -m pip install --upgrade huggingface_hub
hf auth login
hf repo create YOUR_HF_ORG/director-open-assets --repo-type dataset
hf upload YOUR_HF_ORG/director-open-assets /absolute/path/to/cleared-staging . \
  --repo-type dataset \
  --commit-message "Director open assets 0.1.0"
```

上传后获取并记录**完整 commit SHA**，不能使用 `main`、会移动的 tag 或缩写 SHA：

```bash
git ls-remote https://huggingface.co/datasets/YOUR_HF_ORG/director-open-assets.git refs/heads/main
```

Hugging Face 的[下载文档](https://huggingface.co/docs/huggingface_hub/en/guides/download#from-specific-version)
同样把完整 commit hash 作为可复现 revision。

## Manifest v1

契约是 `assets/manifest.schema.json`；`assets/manifest.example.json` 同时展示两种 source。dataset
真正存在后才创建 `assets/manifest.lock.json`，并把该 lock 随代码提交。

每个可下载文件都记录：

- 稳定 `id` 与逻辑 `bundle`；
- 包含 repository ID 和 remote path 的 `huggingface` source；
- 精确本地运行路径；
- byte length 与小写 SHA-256；
- MIME type、license reference、required/optional 状态。

local-only 文件改用带明确获取/打包说明的 `user-provided` source，不包含 HF repository ID 或 remote
path。安装器只验证已经存在的本地文件，不会尝试获取或重新分发。

Repository revision 必须是不可变的 40 字符 commit SHA。示例中的全零 revision 和
`YOUR_HF_ORG` 会被 `release-check` 明确拒绝。

## 恢复与校验

安装器只允许 repository-relative 目标目录，拒绝 path traversal 与 symlink escape；下载先写临时文件，
校验 byte length 和 SHA-256 后再原子 rename。

```bash
# 只读查看本地资产状态。
npm run assets:status

# 只下载 manifest 中许可可再分发的 Hugging Face source。
# 必需的 user-provided 文件缺失时会给出准备说明。
npm run assets:install

# 不访问网络，校验必需本地文件。
npm run assets:verify

# 发布前拒绝 placeholder，并校验所有必需文件。
npm run assets:release-check
```

npm 命令后可使用 `-- --manifest path/to/manifest.json`、`-- --bundle open-models` 或
`-- --required-only`。`--force` 只会在新下载文件通过完整性验证后替换错误的可下载文件，绝不会让
user-provided 文件变成可下载文件。

## CI 与测试分层

公开 fresh clone 在没有 GLB、FBX、缩略图或本地数据库时也必须完成 build 和 core tests。解析真实打包资产
的测试属于显式本地资产层：

```bash
npm test             # assetless core suite 的别名
npm run test:core    # 无二进制资产的源码/契约/UI suite
npm run test:assets  # 需要本地准备 catalog 与 payload
npm run test:all     # 发布工作站运行 core + 本地资产验收
```

资产 runner 内部自己管理 opt-in 环境变量；使用以上 npm scripts，不要直接设置内部 flag。

公开 CI 不能依赖某个账号的 Mixamo export 或许可未解决的 Flick mirror。Release job 只能针对已经提交、
非 placeholder 且只包含清权文件的 manifest 执行 `assets:install`。

## 发布清单

1. 审核每个候选资产的作者、来源、license、修改权和再分发权；
2. 只把清权文件放入全新 staging 目录，生成 hash 与 provenance receipt；
3. 上传公开 HF dataset；
4. 在 `assets/manifest.lock.json` 固定完整 commit SHA；
5. 在 clean clone 中恢复并运行 `assets:release-check`；
6. 在拥有合法本地输入的发布工作站运行 `repo:check`、`test:all`、lint、build 和 docs build；
7. 检查 `git status --ignored`，只 stage metadata 与源码，绝不 stage 被 ignore 的 payload；
8. 只有 GitHub 源码与 HF revision 能复现相同且校验通过的运行目录时才 push。

如果二进制曾被提交，仅新增 `.gitignore` 不够：下次 commit 前要把它从 index 移除。如果已经进入公开历史，
应协调 history rewrite 与缓存/凭据失效流程，不能静默 force-push 覆盖其他协作者。
