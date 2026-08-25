# @director/stage-protocol — Stage 协议

> 语言：**中文** · [English](README.md)

Director Stage 的场景 schema、类型定义、默认场景工厂与道具目录。

**Package:** `@director/stage-protocol` — `"main": "./src/index.ts"` — 依赖：`zod`, `@director/protocol`

## 文件清单

| 路径 | 中文用途 |
| --- | --- |
| `index.ts` | 桶导出，汇总所有公开模块 |
| `sceneSchema.ts` | Stage 场景 Zod schema：人形角色、道具、图元、相机、轨道、关键帧的判别联合 |
| `types.ts` | Stage 场景类型导出：Scene、Object、Camera、Track、Item 等 |
| `defaultScene.ts` | 默认场景工厂：从 `defaultScene.json` 解析并深拷贝，提供 `createStageId` 工具 |
| `defaultScene.json` | 默认场景 JSON 数据：预置人形角色、目标点、相机及轨道 |
| `propCatalog.ts` | 道具目录：椅子、桌子、沙发、树、岩石、船、汽车、猫、马、墙体等预置道具定义 |

## 构建

作为 npm workspace 参与根目录 `npm run build` 类型检查。