# 集成

> 语言：**中文** · [English](README.md)

外部连接器，位于 Director 前端与网关之侧，非独立产品。

Blender DCC 目录将 `connectorDirectory` 设为 `"integrations/blender"`——
该路径是 Blender 集成**根目录**，而非每个 Python 文件所在目录。

## 连接器目录

| 路径 | 中文用途 |
| --- | --- |
| `blender/live/` | 无头 Blender 实时建模内核。`BLENDER_USER_SCRIPTS` 指向此处，Blender 自动加载 `addons/worldengine_studio/`。`npm run blender` 启动。 |
| `blender/interchange/` | 可信 `.blend` 导入与 Director 场景往返（`director_bridge.py`、`director_scene_export.py`、`director_return_export.py`）。 |
| `unreal/` | Director 自研 `DirectorBridge` Unreal 编辑器插件（Python），提供固定的无头导入/导出入口。配置 `DIRECTOR_UNREAL_EDITOR_BIN` + `DIRECTOR_UNREAL_PROJECT`。详见 `unreal/README.zh-CN.md`。 |
| `unreal/interchange/` | Unreal Engine 5 → Director 场景导入：引擎内 Python 导出器，产出 `director-engine-scene-v1` 包。详见 `unreal/README.zh-CN.md`。 |
| `unity/` | Director 自研 `com.director.bridge` UPM 编辑器包（C#），提供 `-batchmode -executeMethod` 入口。配置 `DIRECTOR_UNITY_BIN` + `DIRECTOR_UNITY_PROJECT`。详见 `unity/README.zh-CN.md`。 |
| `unity/interchange/` | Unity → Director 场景导入：Editor-only C# 导出器，产出 `director-engine-scene-v1` 包。详见 `unity/README.zh-CN.md`。 |
| `godot/` | Director 自研 `director_bridge` Godot 4 编辑器插件（GDScript），提供固定的 `--headless` 入口。配置 `DIRECTOR_GODOT_BIN` + `DIRECTOR_GODOT_PROJECT`。详见 `godot/README.zh-CN.md`。 |
| `plugins/director-workbench/` | 可移植 Agent/MCP 插件，基于同一套工作台合约构建。**勿手改**生成的 `mcp/server.mjs`。 |
| `dcc-providers.example.json` | 声明式、仅交换的 DCC provider 目录模板。复制到旁边（如 `integrations/dcc-providers.json`）并将 `DIRECTOR_DCC_PROVIDER_CONFIG` 指向该副本。 |

每个引擎连接器目录都带有 `connector.json` 清单（`director-dcc-connector-v1`），
固定网关可调用的 health/import/export 入口。引擎交接通过 `director_dcc`
（`send_to_engine`、`receive_from_engine`、`apply_import_plan`）执行，且仅在
连接器健康检查通过（`nativeReady`）时可用；仅检测到可执行文件永远不够。
仓库不捆绑任何引擎源码、SDK 或二进制。

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

### `unreal/`

| 路径 | 中文用途 |
| --- | --- |
| `connector.json` | 固定连接器清单（`director-dcc-connector-v1`），声明 health/import/export 入口。 |
| `plugins/DirectorBridge/DirectorBridge.uplugin` | 编辑器插件描述（依赖 PythonScriptPlugin、EditorScriptingUtilities、LevelSequenceEditor）。 |
| `plugins/DirectorBridge/Content/Python/director_space.py` | 纯 Python 的 Director ↔ Unreal 坐标转换，含自检用例。 |
| `plugins/DirectorBridge/Content/Python/director_package.py` | 交换包读取器与返回包/报告写入器，含 SHA-256 收据。 |
| `plugins/DirectorBridge/Content/Python/director_headless.py` | 固定无头入口：health、import（Actor + CineCamera + Sequencer 机位切换）、export（打标 Actor 返回差异）。 |
| `plugins/DirectorBridge/Content/Python/init_unreal.py` | 编辑器菜单钩子，提供编辑器内健康检查。 |

### `unreal/interchange/`

| 路径 | 中文用途 |
| --- | --- |
| `director_scene_export.py` | 引擎内（UE5）导出器：将已加载关卡转换为 `director-engine-scene-v1` 包（manifest + 经 glTF Exporter 插件导出的 GLB），支持 headless。 |

### `unity/`

| 路径 | 中文用途 |
| --- | --- |
| `connector.json` | 固定连接器清单，声明 `Director.Bridge.Editor.DirectorBridgeCli` 批处理方法。 |
| `com.director.bridge/package.json` | UPM 包清单（依赖 Timeline 与 Newtonsoft JSON）。 |
| `com.director.bridge/Runtime/DirectorId.cs` | 在每个交接对象上持久化 Director 稳定 ID 的组件。 |
| `com.director.bridge/Editor/DirectorSpace.cs` | Director ↔ Unity 坐标转换（左手系 Y-up）。 |
| `com.director.bridge/Editor/DirectorExchange.cs` | 交换包读取器与返回包/报告写入器。 |
| `com.director.bridge/Editor/DirectorBridgeCli.cs` | 固定批处理入口：health、import（场景 + Timeline）、export（DirectorId 返回差异）。 |

### `unity/interchange/`

| 路径 | 中文用途 |
| --- | --- |
| `DirectorSceneExport.cs` | Editor-only 导出器：将打开的场景转换为 `director-engine-scene-v1` 包（manifest + 经 `com.unity.cloud.gltfast` 导出的 GLB），支持 batch 模式。网关在 `extract_engine_scene` 时复制到 `Assets/Editor/DirectorInterchange/`。 |

### `godot/`

| 路径 | 中文用途 |
| --- | --- |
| `connector.json` | 固定连接器清单，声明无头 GDScript 入口。 |
| `addons/director_bridge/plugin.cfg` | Godot 4 编辑器插件描述。 |
| `addons/director_bridge/director_space.gd` | Director ↔ Godot 转换（基变换为恒等；保留以对齐接口与世界合成）。 |
| `addons/director_bridge/director_package.gd` | 交换包读取器与返回包/报告写入器。 |
| `addons/director_bridge/director_headless.gd` | 固定无头入口：health、import（Node3D 场景 + GLB 实例化 + 元数据）、export（打标节点返回差异）。 |
| `addons/director_bridge/director_bridge.gd` | 编辑器插件脚本，提供编辑器内健康检查。 |

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