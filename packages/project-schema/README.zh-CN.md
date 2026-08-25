# @director/project-schema — 项目 Schema

> 语言：**中文** · [English](README.md)

Director 项目共享 Zod schema 与类型定义。包含 DirectorProject 文档模型、相机几何、姿态系统、动画、帧率/时间轴、程序化步态与轨迹数学。

**Package:** `@director/project-schema` — `"main": "./src/index.ts"` — 依赖：`zod`, `three`, `@director/protocol`

## 文件清单

| 路径 | 中文用途 |
| --- | --- |
| `index.ts` | 桶导出，汇总所有 schema 模块 |
| `directorProject.ts` | DirectorProject 类型定义：对象、相机、灯光、动画、材质、故事板、世界等所有类型导出 |
| `directorProjectSchema.ts` | DirectorProject 的 Zod schema 实现：完整的解析、常量枚举（身体类型、资产类型、放置模式等），约 1137 行 |
| `directorProjectRevision.ts` | 项目版本控制：SHA-256 规范化用于乐观并发与幂等性 |
| `directorProjectOptions.json` | 项目选项数据 |
| `cameraGeometry.ts` | 相机几何：视口参数、FOV 计算、传感器格式、焦距转换、view snapshot |
| `directorProduction.ts` | 制片数据：Performance take、Coverage sequence、默认值、问题检测 |
| `directorAnimation.ts` | 动画系统：关键帧插值、相机动作目标、变换混合 |
| `animationEasing.ts` | 缓动函数：CSS cubic-bezier 曲线评估（linear、easeIn、easeOut、easeInOut） |
| `frameRate.ts` | 帧率系统：有理数帧率、常见帧率常量（23.976、24、25、29.97、30、59.94、60）、时间基准 |
| `frameTime.ts` | 帧时间：帧范围限制、FPS 规范化、帧→秒转换 |
| `poseSchema.ts` | 姿态协议：PosePresetId、CharacterPoseControlKey 枚举与控制值限制 |
| `poseProtocol.json` | 姿态控制键与预设 ID 数据 |
| `mannequinPosePresets.ts` | 人体模型姿态预设：A-pose、T-pose、walking、sitting、fighting 等 |
| `mannequinPosePresets.json` | 人体模型姿态预设数据 |
| `proceduralGait.ts` | 程序化步态：轨迹运动检测、步态循环激活判断 |
| `trajectoryMath.ts` | 轨迹数学：路径点评估、Bezier 曲线、圆弧、循环轨迹的帧权威变换计算 |

## 构建

作为 npm workspace 参与根目录 `npm run build` 类型检查。