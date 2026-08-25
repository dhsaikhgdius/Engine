# Director Unreal Engine 连接器

仅源码分发的编辑器插件与固定无头入口，用于将本机已授权的 Unreal Engine 5.3+
与 Director 连接。本目录不包含任何 Epic 发行内容；连接器完全运行在用户自己的
引擎与工程中，符合 Unreal Engine EULA。

## 功能

- **导入**（`--mode import`）：读取 `director-dcc-exchange-package-v1` 包目录，
  为每个 Director 物体生成一个 Actor（GLB 资产用 StaticMeshActor，否则生成空
  Actor 并写入警告），为每个 Director 相机生成 CineCameraActor，恢复父子层级，
  为所有 Actor 打上 `director_id:<id>` 标签，将分镜（storyboard）映射为
  LevelSequence 的相机切换轨道，把关卡保存到 `/Game/Director/Levels/`，并回写
  一个规范空间（canonical space）的返回包。
- **导出**（`--mode export`）：读取当前关卡中所有带 `director_id` 标签的 Actor，
  在提供方边界处把变换转换回 Director 规范空间，仅导出相对交换包基线发生变化
  的实体，写出 `director-dcc-return-v1` 返回包。
- **健康检查**（`--mode health`）：输出包含引擎与连接器版本的 JSON。

坐标转换（右手 Y-up 米制 ↔ 左手 Z-up 厘米制，
`(x, y, z) -> (-z*100, x*100, y*100)`）实现在 `director_space.py` 中，纯 Python、
不依赖 `unreal` 模块：可直接运行 `python3 director_space.py --self-test`。
Gateway 的 CI 测试会用 TypeScript 参考实现校验同一组黄金用例。

## 安装

1. 将 `plugins/DirectorBridge` 复制到 `<你的工程>/Plugins/DirectorBridge`。
2. 在 Edit → Plugins 中启用 **Director Bridge** 与 **Python Editor Script
   Plugin**，然后重启编辑器。
3. 配置 Director Gateway 环境变量：

```bash
export DIRECTOR_UNREAL_EDITOR_BIN=/path/to/Engine/Binaries/Linux/UnrealEditor-Cmd
export DIRECTOR_UNREAL_PROJECT=/path/to/YourProject/YourProject.uproject
```

只有当连接器源码、可执行文件、引擎版本探测、工程内已安装的插件全部通过检查时，
`director_dcc {"op":"status","provider":"unreal"}` 才会报告 `nativeReady: true`。
仅检测到可执行文件绝不代表原生就绪；便携 USDA/GLB 交换始终可用。

## 无头调用（Gateway 实际执行的命令）

```bash
"$DIRECTOR_UNREAL_EDITOR_BIN" "$DIRECTOR_UNREAL_PROJECT" \
  -ExecutePythonScript="<工程>/Plugins/DirectorBridge/Content/Python/director_headless.py \
      --mode import --package <包目录> --report <job>/report.json --return-dir <job>/return" \
  -unattended -nopause -nosplash -nullrhi -stdout
```

入口脚本是固定的；Gateway 绝不执行请求方提供的 Python。每次运行都会写出
`director-dcc-engine-report-v1` 回执，Gateway 会做 schema 校验，并核对交换包 ID
与源修订号。

## 能力诚实性

已实现且有版本校验：无头导入/导出、稳定 `director_id` 往返、场景层级、变换、
相机、分镜 → Sequencer 相机切换。仍为规划中（宁可警告省略，绝不静默拍平）：
动画曲线、骨骼重定向、材质转换、实时链接（live link）。
