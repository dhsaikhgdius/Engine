# 运行时数据

> 语言：[English](README.md) · **中文**

本目录是 Director 会话、任务、预览、DCC 交换与可变生产状态的默认本地持久化根目录。**Git 只跟踪 JSON Schema 与本 README**；其余运行时产物均由 `.gitignore` 排除。

### `.runtime/` 与 `data/` 的区别

- **`.runtime/`**：生成的场景快照、构建树与本地检查点——完全被 Git 忽略。
- **`data/`**：用户可见的持久化运行时状态（生产数据、会话、任务结果、DCC 交换）；Schema 由 Git 跟踪。

---

## 文件与目录清单

### 顶层文件

| 路径 | 用途 |
|---|---|
| `director-agent-plan.schema.json` | Agent 执行计划 JSON Schema：约束 `summary` 与 `operations` 数组（含 `tool`、`input_json`、`summary` 字段） |
| `director-agent-sessions.sqlite` | Agent 会话持久化 SQLite 数据库，存储对话历史、工具调用记录与上下文 |
| `director-agent-sessions.sqlite-shm` | SQLite 共享内存文件（WAL 模式运行时自动生成） |
| `director-agent-sessions.sqlite-wal` | SQLite 预写日志文件（WAL 模式运行时自动生成） |
| `director-production.json` | 生产项目元数据：productionId、revision、场景列表与剪辑时间线 |
| `director-production-state.json` | 完整生产状态快照（全部场景细节、高修订计数），大文件 |
| `director-workbench.json` | Director 工作台全局状态（UI 布局、面板配置、用户偏好） |
| `stage-scene.json` | 当前 Stage 3D 场景完整数据（模型、相机、灯光、动画等） |
| `stage-scene.json.*.tmp` | Stage 场景写入过程中的临时文件（原子写入中间产物；进程退出后可安全清理） |
| `latest-preview.png` | 最新 Stage 场景渲染预览截图 |

### 子目录

| 路径 | 用途 |
|---|---|
| `comfy-workflows/` | ComfyUI 工作流 JSON 定义存储（当前为空） |
| `dcc-jobs/` | DCC 任务目录（见下） |
| `dcc-ledgers/` | DCC 操作台账目录（见下） |
| `film-runs/` | Film 渲染运行结果存储（当前为空） |
| `game-slices/` | 持久化的 `director_game` 切片文档（`<id>.json`）：类型化的游戏切片 IR，含 brief、角色、核心循环、HUD、验收检查与最近一次试玩评估 |
| `blender/` | Blender 原生 `.blend` 文件存储（`director-native.blend` 等），含去重备份 |

### `dcc-jobs/` 子目录

| 路径 | 用途 |
|---|---|
| `dcc-jobs/blender/` | Blender 导出任务：每个任务目录含 `scene.blend`、`scene.director-dcc.json`、`report.json`，以及可选的 `assets/` 与 `preview.png` |
| `dcc-jobs/blender-import/` | Blender 导入任务：含 `source.blend`、`report.json`、`package/`（打包产物）与 `plans/`（AI 导入计划） |
| `dcc-jobs/exchange/` | DCC 交换任务（如 Blender 双向交换） |

### `dcc-ledgers/` 子目录

| 路径 | 用途 |
|---|---|
| `dcc-ledgers/blender-scene-import/` | Blender 场景导入操作台账；以内容哈希命名的 JSON 文件记录每次导入的元数据与回执 |

---

## Git 跟踪规则

```
data/**                # 全部忽略
!data/                 # 保留目录本身
!data/*.schema.json    # 只跟踪 JSON Schema
!data/README.md        # 跟踪英文 README
!data/README.zh-CN.md  # 跟踪本文件
!data/.gitkeep         # 可选占位文件
```

不要将运行时快照、任务产物或 `.blend` 文件提交到仓库。确定性的测试输入请放入相应的 `__fixtures__/` 目录。
