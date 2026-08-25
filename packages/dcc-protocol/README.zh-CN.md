# @director/dcc-protocol — DCC 协议

> 语言：**中文** · [English](README.md)

DCC（数字内容创作）互操作协议层。定义 Blender、Blender 与 Director 之间的交换合约、导入/导出格式、provider 能力声明与返回变更 schema。

**Package:** `@director/dcc-protocol` — `"main": "./src/index.ts"` — 依赖：`zod`, `@director/protocol`

## 文件清单

| 路径 | 中文用途 |
| --- | --- |
| `index.ts` | 桶导出，汇总所有 DCC 合约 |
| `directorDccContract.ts` | DCC 核心合约：坐标系转换（Three.js ↔ Blender）、项目往返序列化 |
| `directorDccExchangePackageContract.ts` | DCC 交换包合约：GLB/USDA 格式的 zip 打包、SHA-256 校验、manifest 定义 |
| `directorDccProviderContract.ts` | DCC provider 合约：provider ID、交换格式、能力声明、功能标志 schema |
| `directorDccReturnContract.ts` | DCC 返回合约：mesh 替换、transform 更新、动画、材质变更等导入计划 |
| `directorBlendSceneImportContract.ts` | Blender 场景导入合约：相机、网格、灯光、材质、动画的导入计划 |
| `directorDccSharedContract.ts` | DCC 共享类型：有限数字、Vec3、四元数、Transform schema（含归一化校验） |

## 构建

作为 npm workspace 参与根目录 `npm run build` 类型检查。