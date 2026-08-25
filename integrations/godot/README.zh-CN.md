# Director Godot 4 连接器

仅源码分发的编辑器插件（`addons/director_bridge`），带固定的
`godot --headless --script` 入口，用于将本机已授权的 Godot 4.2+ 与 Director 连接。

Godot 4 的世界基（右手、Y-up、米制、相机朝向 -Z）与 Director 规范空间完全一致，
因此提供方边界的转换是恒等映射 `(x, y, z) -> (x, y, z)`；转换仍统一经过
`director_space.gd`，保证边界显式、可测试。

## 功能

- **导入**（`--mode import`）：读取 `director-dcc-exchange-package-v1` 包目录，
  为每个 Director 物体创建 `Node3D`（GLB 资产通过 `GLTFDocument` 实例化，可在
  无头模式运行），为每个 Director 相机创建 `Camera3D`，恢复父子层级，为所有节点
  写入 `director_id` 元数据，将分镜以 `director_shots` 元数据形式保留在场景根
  节点上（Godot 没有内置镜头时间线；宁可警告省略，绝不静默拍平），把场景保存到
  `res://director/scenes/`，并回写一个规范空间的返回包。
- **导出**（`--mode export`）：重新加载 Director 场景，仅导出相对交换包基线发生
  变化的 `director_id` 节点的规范空间变换，写出 `director-dcc-return-v1` 返回包。
- **健康检查**（`--mode health`）：输出包含引擎与连接器版本的 JSON。

## 安装

1. 将 `addons/director_bridge` 复制到 `<你的工程>/addons/director_bridge`。
2. 在 Project → Project Settings → Plugins 中启用 **Director Bridge**。
3. 配置 Director Gateway 环境变量：

```bash
export DIRECTOR_GODOT_BIN=/path/to/godot4
export DIRECTOR_GODOT_PROJECT=/path/to/YourProject
```

只有当连接器源码、可执行文件、版本探测、工程内已安装的插件全部通过检查时，
`director_dcc {"op":"status","provider":"godot"}` 才会报告 `nativeReady: true`。
便携 GLB 交换始终可用。

## 无头调用（Gateway 实际执行的命令）

```bash
"$DIRECTOR_GODOT_BIN" --headless --path "$DIRECTOR_GODOT_PROJECT" \
  --script res://addons/director_bridge/director_headless.gd -- \
  --mode import --package <包目录> --report <job>/report.json \
  --return-dir <job>/return
```

入口脚本是固定的；Gateway 绝不执行请求方提供的 GDScript。每次运行都会写出
`director-dcc-engine-report-v1` 回执，Gateway 会做 schema 校验，并核对交换包 ID
与源修订号。

## 能力诚实性

已实现且有版本校验：无头导入/导出、稳定 `director_id` 往返、场景层级、变换、
相机。仍为规划中（宁可警告省略，绝不静默拍平）：元数据之外的镜头时间线映射、
动画曲线、骨骼、材质转换、实时链接（live link）。
