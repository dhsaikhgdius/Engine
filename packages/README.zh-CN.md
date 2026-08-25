# 共享包

> 语言：**中文** · [English](README.md)

本目录是前后端共享的 npm workspaces —— 传输契约与无进程副作用的运行时逻辑。官方 Python 模型源码在 `vendor/`，不在这里。


| 包路径                     | 包名                               | 职责                                                |
| ----------------------- | -------------------------------- | ------------------------------------------------- |
| `protocol/`             | `@director/protocol`             | 传输契约：Zod schema、Stage 协议、Agent 网关、视频生成、Blender 内核 |
| `stage-protocol/`       | `@director/stage-protocol`       | Stage 场景 schema、类型、默认场景工厂与道具目录                    |
| `project-schema/`       | `@director/project-schema`       | DirectorProject 类型、相机几何、姿态、动画、时间轴                 |
| `agent-engine/`         | `@director/agent-engine`         | Agent 引擎：工作台合约、命令执行、创作动作、审计、自动化                   |
| `dcc-protocol/`         | `@director/dcc-protocol`         | DCC 互操作协议：Blender 交换、Blender 导入/导出合约              |
| `dcc-interchange/`      | `@director/dcc-interchange`      | DCC 格式转换：glTF/USD 导入导出、Mixamo 目录、模型库              |
| `model-provider/`       | `@director/model-provider`       | 可插拔 LLM provider 与 Model Driver                   |
| `di/`                   | `@director/di`                   | Gateway 使用的轻量依赖注入容器                               |
| `scene-pipeline/`       | `@director/scene-pipeline`       | 文本→布局场景管线（planner、assembler、validator）            |
| `dsh-plugin-workbench/` | `@director/dsh-plugin-workbench` | DeepSeek Harness 插件：导演台、画布、视频编辑与 Blender 工具       |




## 构建

所有 TypeScript 包都在根目录 `package.json` 的 npm workspaces 中；根目录 `npm run build` 会做类型检查（`tsc -p tools/tsconfig.json`）。`packages/tsconfig.json` 是薄 `extends`，IDE 从包源码向上查找时能落到该工程。

网关在 `npm run setup:ltx2` 之后对 `vendor/ltx-2` spawn `tools/scripts/ltx23-generate.py`。