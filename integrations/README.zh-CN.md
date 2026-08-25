# 集成

> 语言：**中文** · [English](README.md)

外部连接器，位于 Director 前端与网关之侧，非独立产品。

Blender DCC 目录将 `connectorDirectory` 设为 `"integrations/blender"`——
该路径是 Blender 集成**根目录**，而非每个 Python 文件所在目录。

## 三个任务

| 路径 | 中文用途 |
| --- | --- |
| `blender/live/` | 无头 Blender 实时建模内核。`BLENDER_USER_SCRIPTS` 指向此处，Blender 自动加载 `addons/worldengine_studio/`。`npm run blender` 启动。 |
| `blender/interchange/` | 可信 `.blend` 导入与 Director 场景往返（`director_bridge.py`、`director_scene_export.py`、`director_return_export.py`）。 |
| `plugins/director-workbench/` | 可移植 Agent/MCP 插件，基于同一套工作台合约构建。**勿手改**生成的 `mcp/server.mjs`。 |
| `dcc-providers.example.json` | 声明式、仅交换的 DCC provider 目录模板。复制到旁边（如 `integrations/dcc-providers.json`）并将 `DIRECTOR_DCC_PROVIDER_CONFIG` 指向该副本。 |

## 外部 AI 桥接

| 路径 | 中文用途 |
| --- | --- |
| `ardy/` | NVIDIA ARDY 文本→全身骨骼动作桥接。官方源码是 Git 子模块 `vendor/ardy`。网关调用上游 `scripts/generate.py`，生成 `.npz` 后重定向到 Mixamo 骨骼预览。 |
| `infinigen/` | Infinigen 本地程序化 3D 资产生成 provider。与 Meshy/Tripo 等远程 API provider 同权：工厂生成→烘焙→GLB→资产库。含四个内置环境地形预设。 |

## 各子目录文件级概览

### `blender/live/`

| 路径 | 中文用途 |
| --- | --- |
| `worldengine_backend.py` | 无头 Blender 后端入口：配置项目、启动 loopback HTTP 会话、运行事件循环。 |
| `addons/worldengine_studio/` | Blender 4.2+ addon（WorldEngine Studio v0.1.0），含 17 个模块 + 测试套件。详见 `blender/live/README.md`。 |

### `blender/interchange/`

| 路径 | 中文用途 |
| --- | --- |
| `director_bridge.py` | 将经验证的 Director DCC 场景包导入 Blender，写入 `director_id` 与签名属性。 |
| `director_scene_export.py` | 从已打开的 `.blend` 提取场景，导出米制 Y-up GLB、相机参数、manifest 与哈希收据。 |
| `director_return_export.py` | 从精修后的 `.blend` 导出 manifest-first 返回包，仅导出携带 `director_id` 的对象。 |
| `director_signature.py` | 共享的网格内容指纹（SHA-256），供 bridge 与 return-export 双向使用，保证字节级一致。 |
| `director_scene_export.test.ts` | 场景导出脚本的 vitest 测试。 |
| `director_return_export.test.ts` | 返回导出脚本的 vitest 测试。 |

### `plugins/director-workbench/`

| 路径 | 中文用途 |
| --- | --- |
| `.codex-plugin/plugin.json` | Codex CLI 插件清单：名称、版本、能力声明、默认提示词。 |
| `.mcp.json` | MCP 服务器配置：启动 `director-workbench` 服务器，连接 `STAGE_GATEWAY_URL`。 |
| `mcp/server.mjs` | **生成文件**，构建产物：单文件 bundle 的 MCP 服务器。勿手改。 |
| `skills/director-workbench/SKILL.md` | 技能主指令：工作循环、3D Stage、Canvas、Video Editor 操作规范。 |
| `skills/director-workbench/agents/openai.yaml` | OpenAI Agent 配置：工具依赖、隐式调用策略。 |
| `skills/director-workbench/references/operations.md` | 操作示例参考：observe、describe、catalog、author、capture、audit 等最短可用请求。 |

### `ardy/`

| 路径 | 中文用途 |
| --- | --- |
| `README.md` | 安装、配置、使用说明：ARDY 检出、网关环境变量、HTTP API 端点。 |

### `infinigen/`

| 路径 | 中文用途 |
| --- | --- |
| `README.md` | 安装、配置、使用说明：Infinigen 环境、网关环境变量、手动冒烟测试。 |
| `director_infinigen_runner.py` | 单资产 runner：网关拉起，原子写入 `status.json`/`model.glb`/`thumbnail.png`。 |
| `factory_catalog.json` | 工厂目录：4 个环境预设 + 30+ 个 Infinigen 自然/室内工厂，含中英文关键词。 |

## 运行

```bash
npm run blender          # 启动无头 Blender 实时建模内核
npm run build:mcp-plugin      # 构建可移植 MCP 插件
npm run sync:skills           # 从规范源同步技能到各 Agent 目录
npm run validate:agent-plugin # 校验 Agent 插件集成
```

安装 Blender 4.2+（或设置 `BLENDER_BIN`）以使用实时内核。Director 不捆绑 Blender 的 C 源码。