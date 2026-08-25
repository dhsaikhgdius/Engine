# ARDY 文本生成动作桥接

> 语言：**中文** · [English](README.md)

Director 通过网关桥接 [NVIDIA ARDY](https://github.com/nv-tlabs/ardy)（Apache-2.0，SIGGRAPH 2026）
实现「文字 → 全身骨骼动作」。桥接直接调用上游仓库自带的 `scripts/generate.py`
命令行（本地或经 SSH 的远程 GPU 主机），不重新实现模型；生成的 `.npz`
（`local_rot_mats` / `root_positions` / `posed_joints` / `fps`）由网关缓存并流式提供给
工作台，前端将 cskel27 全局旋转以位置蒙皮方式重定向到 Mixamo 骨骼实时预览。

## 文件级清单

| 路径 | 中文用途 |
| --- | --- |
| `README.md` | 本文件：安装、配置、使用说明与许可信息。 |

> ARDY 桥接代码位于网关内部（`backend/gateway/`），不在 `integrations/ardy/` 目录中。
> 此目录仅包含集成文档。桥接通过网关的 motion API 端点暴露。

## 1. 准备 ARDY 检出

在将要跑推理的机器上（本机或远程 GPU 主机），优先使用锁定的子模块，或自行检出并设置
`DIRECTOR_ARDY_REPO`：

```sh
npm run setup:ardy
cd vendor/ardy
python3 -m venv .venv && source .venv/bin/activate
pip install -e .
```

锁定文件为 `vendor/ardy.lock.json`。

模型权重默认在首次运行时从 Hugging Face 下载；若离线部署，将官方发布的模型目录放入
`checkpoints/` 并导出 `CHECKPOINTS_DIR=~/ardy/checkpoints`。

先手动验证一次生成（这一步与网关将来执行的命令完全相同）：

```sh
python scripts/generate.py "A person walks in a circle." --model core8 --duration 4 --output /tmp/probe
python - <<'PY'
import numpy as np
data = np.load("/tmp/probe.npz")
print(sorted(data.keys()), data["posed_joints"].shape)  # 应包含 27 关节
PY
```

Director 仅支持 core 系列模型（cskel27，27 关节）。`soma` / `g1` 输出骨架不同，
面板会在解码时拒绝并给出明确报错。

## 2. 配置 Director 网关

| 环境变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `DIRECTOR_ARDY_REPO` | 否 | 本地子模块存在时 | ARDY 检出的绝对路径（远程模式下为远端路径）。`npm run setup:ardy` 后默认为 `vendor/ardy`。 |
| `DIRECTOR_ARDY_PYTHON` | 否 | `python3` | 用于运行 `scripts/generate.py` 的 Python（建议指向 venv，如 `~/ardy/.venv/bin/python`） |
| `DIRECTOR_ARDY_SSH_HOST` | 否 | — | 设置后经 `ssh`/`scp`（BatchMode）在远程主机生成并取回 npz |
| `DIRECTOR_ARDY_MODEL` | 否 | `core8` | 默认模型别名 |
| `DIRECTOR_ARDY_TIMEOUT_MS` | 否 | `600000` | 单次生成的硬超时（30s–1h） |

本机 GPU 示例：

```sh
DIRECTOR_ARDY_PYTHON=$PWD/vendor/ardy/.venv/bin/python \
npm run gateway
```

远程 GPU 主机示例（需已配置免密 SSH；网关使用 `BatchMode=yes`，绝不弹密码提示）：

```sh
DIRECTOR_ARDY_REPO=/home/gpu/ardy \
DIRECTOR_ARDY_PYTHON=/home/gpu/ardy/.venv/bin/python \
DIRECTOR_ARDY_SSH_HOST=gpu@ardy-box \
npm run gateway
```

## 3. 使用

1. 在工作台选中一个 Mixamo 骨骼角色（导入的 Mixamo GLB 或内置主角资产）。
2. 右侧「角色 → 动作」页签底部的「AI 生成动作」区域输入动作描述，选择时长后点击生成。
3. 生成过程中的 GPU 日志逐行回流到面板；完成后动作自动在视口预览，可随时停止或重播。

对应的 HTTP 接口（均要求网关本地客户端凭证）：

- `GET /api/motion/ardy/status` — 桥接配置状态
- `POST /api/motion/ardy/generate` — NDJSON 流（`status` → `done`/`error`）
- `GET /api/motion/ardy/motions/:jobId` — 取回生成的 npz（仅限本进程生成并校验过的白名单条目）

## 许可

NVIDIA ARDY 及其 cskel27 骨架定义（关节顺序、父子关系、中性姿势）以 Apache-2.0 发布；
Director 侧的桥接、解码与重定向代码为本仓库自有实现。参考实现
[CozyClay](https://github.com/HaD0Yun/CozyClay)（GPL-3.0）仅作为集成形态的调研对象，
本仓库未复制其代码。