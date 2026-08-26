# Director Godot 4 连接器

仅源码分发的编辑器插件（`addons/director_bridge`），带固定的
`godot --headless --script` 入口，用于将本机已授权的 Godot 4.2+（仅限 Godot 4.x）
与 Director 连接。

Godot 4 的世界基（右手、Y-up、米制、相机朝向 -Z）与 Director 规范空间完全一致，
因此提供方边界的转换是恒等映射 `(x, y, z) -> (x, y, z)`；转换仍统一经过
`director_space.gd`，保证边界显式、可测试。

## 功能

- **导入**（`--mode import`）：读取 `director-dcc-exchange-package-v1` 包目录，
  在 `res://director/scenes/` 下构建并保存场景，内容包括：
  - 为每个 Director 物体创建 `Node3D`（GLB 资产通过 `GLTFDocument` 实例化，可在
    无头模式运行），为每个 Director 相机创建带光学参数的 `Camera3D`，所有节点
    写入 `director_id` 元数据；
  - 恢复 Director 父子层级（本地变换按 `parent_world^-1 * child_world` 重建，
    在负缩放与镜像变换下依然精确），并做环路检测；
  - Director 灯光映射为 `OmniLight3D` / `SpotLight3D` / `DirectionalLight3D`
    节点并带 `director_id`；第一个可见的环境光/半球光烘焙为 `WorldEnvironment`
    的环境光项（半球光的天空/地面渐变会被拍平为混合色并带近似码）；面光与
    重复的环境光带结构化代码警告省略（`light_rect_area_unsupported`、
    `light_ambient_duplicate`）；
  - glTF PBR 载荷材质导入为 `StandardMaterial3D`，再叠加 Director PBR 覆写；
    不支持的通道（如 transmission）与自定义 `ShaderMaterial` 带结构化代码警告
    省略（`material_channel_unsupported`、`material_custom_shader`）；
  - 内嵌载荷纹理外置为内容哈希命名的 `res://director/textures/` 资源，保存的
    场景引用相对哈希文件；
  - 从带蒙皮的 GLB 载荷导入 `Skeleton3D` + 蒙皮，校验绑定姿态（bind pose），
    并在骨架根节点写入 `director_id`；无可用骨架的角色警告省略；
  - 当 Gateway 固定了动画烘焙（`--animation` + `--animation-sha256`）时，在场景
    根上按有理时基（`秒 = 帧 * 分母 / 分子`）从哈希校验后的边车文件写出
    `AnimationPlayer`/`AnimationLibrary` 关键帧；glTF 载荷动画保留为各自的
    AnimationPlayer；
  - 哈希固定烘焙中的分镜镜头区间映射为时间线动画内离散的 `Camera3D.current`
    切换轨道（播放该动画即执行分镜的相机切换），原始分镜同时以
    `director_shots` 元数据保留；无法映射相机的镜头带结构化代码警告省略
    （`shot_no_camera_binding`、`shot_camera_not_imported`、
    `shot_target_not_camera`），Gateway 烘焙侧对重复与被夹取的镜头区间也带
    自己的结构化代码（`shot_duplicate_id`、`shot_clamped_to_playback`、
    `shot_outside_playback`）；
  - 写出 `director-dcc-engine-report-v1` 回执，其中的 Godot 专属 `godot` 字段
    （轨道/关键帧/镜头切换计数、灯光/骨架/材质/纹理计数、
    `worldEnvironmentAmbient`、`worldEnvironmentCount`、`omittedLightCount`）。
    灯光计数是读回计数——通过重新扫描已构建的场景树得出，绝不取自导入循环的
    意图，二者不一致时还会额外警告——并回写一个规范空间的返回包。
- **导出**（`--mode export`）：重新加载 Director 场景，仅导出相对交换包基线发生
  变化的 `director_id` 物体/相机节点的规范空间变换，写出
  `director-dcc-return-v1` 返回包。漂移在矩阵层级判定，因此镜像变换不会产生
  误报；骨架与灯光标记永不产生变更条目。
- **健康检查**（`--mode health`）：输出包含引擎与连接器版本的 JSON，由 Gateway
  就绪探测校验。

## 安装

1. 将 `addons/director_bridge` 复制到 `<你的工程>/addons/director_bridge`。
2. 在 Project → Project Settings → Plugins 中启用 **Director Bridge**。
3. 配置 Director Gateway 环境变量：

```bash
export DIRECTOR_GODOT_BIN=/path/to/godot4
export DIRECTOR_GODOT_PROJECT=/path/to/YourProject
```

只有当以下条件全部通过检查时，`director_dcc {"op":"status","provider":"godot"}`
才会报告 `nativeReady: true`：连接器源码、Godot 4 可执行文件、版本探测、工程内
已安装的插件、`project.godot` 中已启用的插件条目（`[editor_plugins]`），以及
连接器版本与工作区一致的有效 `--mode health` JSON 输出。仅 PATH 上有 `godot`
只算 `installed`。便携 GLB 交换始终可用。

## 无头调用（Gateway 实际执行的命令）

```bash
"$DIRECTOR_GODOT_BIN" --headless --path "$DIRECTOR_GODOT_PROJECT" \
  --script res://addons/director_bridge/director_headless.gd -- \
  --mode import --package <包目录> --report <job>/report.json \
  --return-dir <job>/return \
  --animation <job>/animation.json --animation-sha256 <哈希>
```

入口脚本是固定的；Gateway 绝不执行请求方提供的 GDScript。动画边车文件是哈希
固定的：连接器会重新计算磁盘字节的 SHA-256，拒绝被篡改或截断的烘焙。每次运行
都会写出 `director-dcc-engine-report-v1` 回执，Gateway 会做 schema 校验，并核对
交换包 ID 与源修订号。

连接器模块全部通过 `preload` 引用，从不依赖全局 `class_name` 查找：从未在编辑器
中打开过的全新工程没有全局类缓存，而无头入口必须在这种工程上照常工作。

## 实时预览（仅出站）

编辑器插件的 **Director: Toggle Live Preview** 工具菜单项会把
`director_id` 标记节点的临时、带序号的预览帧推送到 Director Gateway 的
令牌保护实时链接路由（`director-godot-live-link-v1`：hello → frame… → bye）。
传输严格出站——Godot 绝不监听端口、绝不暴露脚本端点——且预览帧永不具备
权威性：持久变更仍只经由受审的 `director-dcc-return-v1` 返回包路径。hello
授予中带有会话专属令牌，之后每个 frame 与 bye 都必须携带它；会话 ID 在可
观测的预览快照中可见，因此仅凭 ID 绝不能让第二个客户端注入帧或结束会话
（`live_link_token_invalid`）。过期或重放的序号会被 Gateway 拒绝；被会话
实体上限丢弃的实体在每个确认中如实计数（`droppedEntityCount`）；连接中断
（未发 bye）由 Gateway 的空闲超时清扫，不会触碰最后一次提交的 Director
修订。通过 `DIRECTOR_GATEWAY_URL` 与 `DIRECTOR_GATEWAY_TOKEN` 配置目标。

## 能力诚实性

已实现且有版本校验（由 host-free 黄金用例加缺失即跳过的真实无头往返测试
`backend/gateway/tests/dcc/godotHeadlessRoundtrip.test.ts` 背书）：无头导入/导出、稳定
`director_id` 往返、含负缩放与镜像变换的场景层级、带垂直视场角动画的相机、
基于有理时基的 Gateway 烘焙变换动画、分镜镜头区间映射为 `Camera3D.current`
相机切换轨道、绑定姿态的蒙皮 GLB 骨架、带哈希外置纹理的 `StandardMaterial3D`
材质转换、Omni/Spot/Directional 灯光加带读回计数的 `WorldEnvironment`
环境光烘焙，以及仅出站的实时预览链接（会话令牌/序号/重放/丢弃计数/断连
黄金用例见 `backend/gateway/tests/dcc/godotLiveLink.test.ts`）。

压测面由专门测试钉死：被篡改或未钉哈希的动画边车、畸形包与路径逃逸在真实
主机上硬失败（`godotHeadlessRoundtrip.test.ts`）；超大回执、伪造返回目录与
回执身份不匹配在无主机环境下硬失败（`godotEngineBridge.test.ts`）；
`backend/gateway/tests/dcc/godotConnectorGoldens.test.ts` 证明插件不声明任何
`class_name`、只 preload 已提交的字面路径（全新工程没有全局类缓存）、
`connector.json`/`plugin.cfg`/`director_package.gd` 三处连接器版本一致，且
只发出 `@director/dcc-protocol`（`directorGodotOmissionCodes.ts`）中登记的
结构化代码。

仍为警告省略（绝不静默拍平）：绑定姿态通道与角色动作片段（仅烘焙世界变换，
烘焙中携带结构化 `omittedDetail`，列出受影响的姿态控制器与片段，计数在超出
32 条采样上限后依然权威）、面光、重复的环境光源、自定义着色器转换。每个省略
都带结构化代码，方便代理据此行动而不是解析散文。
