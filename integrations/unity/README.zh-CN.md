# Director Unity 连接器

仅源码分发的 UPM 编辑器包（`com.director.bridge`），带固定的 `-batchmode
-executeMethod` 入口，用于将本机已授权的 Unity 2022.3+ 与 Director 连接。场景数据
通过 GLB 加 Director manifest JSON 传递；Unity YAML 绝不作为交换格式，Director
Gateway 也绝不解析它。

## 功能

- **导入**（`Director.Bridge.Editor.DirectorBridgeCli.Import`）：读取
  `director-dcc-exchange-package-v1` 包目录，新建场景，为每个 Director 物体创建
  GameObject（工程中装有 glTF 导入器时——如 `com.unity.cloud.gltfast`——将实例化
  GLB 资产，否则创建空 GameObject 并写入警告），为每个 Director 相机创建
  `Camera`，恢复父子层级，为所有实体挂载 `DirectorId` 组件，把分镜映射为
  Timeline 激活轨道，将场景保存到 `Assets/Director/Scenes/`，并回写一个规范空间
  的返回包。
- **导出**（`...DirectorBridgeCli.Export`）：重新打开 Director 场景，在提供方边界
  把所有 `DirectorId` 实体的变换转换回 Director 规范空间，仅导出相对交换包基线
  发生变化的实体，写出 `director-dcc-return-v1` 返回包。
- **健康检查**（`...DirectorBridgeCli.Health`）：输出 JSON 健康信息。

坐标转换（右手 Y-up ↔ 左手 Y-up，均为米制，`(x, y, z) -> (x, y, -z)`，四元数
`(x, y, z, w) -> (-x, -y, z, w)`）实现在 `DirectorSpace.cs`。Gateway 的 CI 测试
无需安装 Unity 即可用 TypeScript 参考实现校验同一组黄金用例。

## 安装

1. 将 `com.director.bridge` 复制到 `<你的工程>/Packages/com.director.bridge`
   （或在 `Packages/manifest.json` 中作为本地包引用）。
2. 建议安装 `com.unity.cloud.gltfast`，GLB 资产可作为网格导入，而不是
   “警告并省略”的占位对象。
3. 配置 Director Gateway 环境变量：

```bash
export DIRECTOR_UNITY_BIN=/path/to/Unity/Editor/Unity
export DIRECTOR_UNITY_PROJECT=/path/to/YourProject
```

只有当连接器源码、可执行文件、版本探测、工程内已安装的包全部通过检查时，
`director_dcc {"op":"status","provider":"unity"}` 才会报告 `nativeReady: true`。
便携 GLB/USDA 交换始终可用。

## 无头调用（Gateway 实际执行的命令）

```bash
"$DIRECTOR_UNITY_BIN" -batchmode -nographics -quit \
  -projectPath "$DIRECTOR_UNITY_PROJECT" \
  -executeMethod Director.Bridge.Editor.DirectorBridgeCli.Import \
  -logFile <job>/host.log \
  -directorPackage <包目录> -directorReport <job>/report.json \
  -directorReturnDir <job>/return
```

入口方法是固定的；Gateway 绝不执行请求方提供的 C#。每次运行都会写出
`director-dcc-engine-report-v1` 回执，Gateway 会做 schema 校验，并核对交换包 ID
与源修订号。

## 能力诚实性

已实现且有版本校验：无头导入/导出、稳定 `director_id` 往返、场景层级、变换、
相机、分镜 → Timeline 激活轨道。仍为规划中（宁可警告省略，绝不静默拍平）：
动画曲线、骨骼重定向、材质转换、实时链接（live link）。
