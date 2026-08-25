# WorldEngine Studio — 无头实时建模内核

> 语言：**中文** · [English](README.md)

`integrations/blender/live/` 是 Director 的无头 Blender 实时建模内核。
`BLENDER_USER_SCRIPTS` 指向此目录，使 Blender 自动发现并加载 `addons/worldengine_studio/`。

## 文件级清单

### 后端入口

| 路径 | 中文用途 |
| --- | --- |
| `worldengine_backend.py` | 无头后端入口：加载 addon、打开/创建项目 `.blend`、配置为米制 24fps 1080p、在 `127.0.0.1:8791` 启动 loopback HTTP 会话、运行事件循环直到 SIGTERM。 |

### `addons/worldengine_studio/` — Blender 4.2+ Addon（v0.1.0，GPL-2.0）

Addon 注册信息：`bl_info.name = "WorldEngine Studio"`，位于 3D View > Sidebar > WorldEngine。
支持两种注册模式：`register()`（完整 UI）和 `register_backend()`（无头，仅属性与会话）。

| 路径 | 中文用途 |
| --- | --- |
| `__init__.py` | Addon 注册入口：`register()`/`unregister()`（完整）与 `register_backend()`/`unregister_backend()`（无头）。处理模块重载。 |
| `live_protocol.py` | 轻量级有线格式解析器（`worldengine-blender-live-v1` 合约）：验证 JSON 请求、解析批量操作、支持 40+ 操作类型（导入资产、创建图元/曲线/文本、变换更新、相机/灯光/开口、blockout、集合、约束、建模内核等）。 |
| `native_session.py` | Loopback HTTP 会话服务器：`ThreadingHTTPServer` 监听 `127.0.0.1`，处理会话请求、HMAC 认证、任务队列、分离式大 payload 存储（GLB/PNG）、保存前/后快照比较。 |
| `modeling.py` | Agent 可访问的 Blender 原生建模内核：typed 操作、operator/RNA 长尾，以及 `execute_code`（在 live 场景中执行 Python）。 |
| `kernel_policy.py` | 内核策略：小拒绝列表（退出 Blender 及少量 UI 类别）。 |
| `blockout.py` | 体块粗模（blockout）：快速创建建筑体量、开口、楼层等粗模几何体。 |
| `asset_import.py` | 资产导入：将 Director 模型资产导入 Blender 场景。 |
| `asset_libraries.py` | Poly Haven / Sketchfab 搜索与导入（HTTPS，防 zip-slip）。 |
| `asset_library_http.py` | 资源库用的标准库 HTTPS/JSON/zip 辅助（不依赖 bpy）。 |
| `coordinates.py` | 坐标系转换：Blender 与 Director 之间的坐标换算。 |
| `director_project.py` | 项目文件管理：打开、创建、保存 `.blend` 项目文件。 |
| `director_runtime.py` | 运行时管理：启动/停止 addon 运行时状态。 |
| `material_nodes.py` | 材质与节点：PBR 材质创建、节点图操作。 |
| `mixamo_actions.py` | Mixamo 动作处理：加载、应用 Mixamo 骨骼动作。 |
| `modifier_stack.py` | 修改器堆栈：管理 Blender 修改器（镜像、阵列、倒角等）。 |
| `operators.py` | Blender operators：UI 与后台操作的 operator 定义。 |
| `preferences.py` | Addon 偏好设置面板。 |
| `properties.py` | 自定义属性：`director_id` 等场景/对象自定义属性定义。 |
| `rig.py` | 骨骼绑定：骨架创建与操作。 |
| `semantic_geometry.py` | 语义几何体：带语义标签的几何体操作。 |
| `spatial_query.py` | 空间查询：场景空间关系查询。 |
| `tests/` | 测试套件：7 个测试文件，覆盖网关冒烟、几何体、建模、相机、坐标、协议。 |

### 测试文件

| 路径 | 中文用途 |
| --- | --- |
| `tests/__init__.py` | 测试包初始化。 |
| `tests/blender_smoke.py` | 基础冒烟测试。 |
| `tests/blender_gateway_smoke.py` | 网关连接冒烟测试。 |
| `tests/blender_geometry_smoke.py` | 几何体操作冒烟测试。 |
| `tests/blender_modeling_smoke.py` | 建模操作冒烟测试。 |
| `tests/blender_camera_snapshot_smoke.py` | 相机快照冒烟测试。 |
| `tests/test_coordinates.py` | 坐标系转换单元测试。 |
| `tests/test_live_protocol.py` | 实时协议单元测试。 |
| `tests/test_asset_library_http.py` | Poly Haven/Sketchfab HTTP 辅助单元测试（不依赖 Blender）。 |

## 运行

```bash
npm run blender
```

启动器将 `BLENDER_USER_SCRIPTS` 设为 `integrations/blender/live`，使 Blender 找到
`addons/worldengine_studio/`。后端入口为 `worldengine_backend.py`。

## 认证

Loopback 会话默认无认证。如需 bearer 认证，导出 `DIRECTOR_BLENDER_TOKEN`
（Blender 继承 shell 环境变量；`WORLDENGINE_SESSION_TOKEN` 仅对 Blender 覆盖）。
Sketchfab 导入另需 `SKETCHFAB_API_TOKEN`（或 Studio 偏好设置中的令牌）。