# @director/dcc-interchange — DCC 格式转换

> 语言：**中文** · [English](README.md)

DCC 格式转换引擎。提供 GLTF（glTF/GLB）与 USD（USDA/USDZ）的双向导出/导入，Mixamo 角色目录解析，模型库管理，以及编码/相机方向等辅助工具。

**Package:** `@director/dcc-interchange` — `"main": "./src/index.ts"` — 依赖：`zod`, `three`, `@gltf-transform/core`, `jszip`, `@director/protocol`, `@director/project-schema`

## 文件清单


| 路径                             | 中文用途                                                           |
| ------------------------------ | -------------------------------------------------------------- |
| `index.ts`                     | 桶导出，汇总所有交换模块                                                   |
| `contract.ts`                  | 交换合约核心：坐标系常量（米制、Y-up、右手系）、manifest 定义、导入/导出接口                  |
| `gltf.ts`                      | GLTF/GLB 适配器：Director 项目 ↔ glTF 的导出与导入，含相机、变换、材质转换             |
| `usd.ts`                       | USD/USDZ 适配器：Director 项目 ↔ USDA/USDZ 的导出与导入，含 zip 打包与 manifest |
| `encoding.ts`                  | UTF-8 ↔ Base64 编解码工具                                           |
| `cameraOrientation.ts`         | 相机方向计算：从 position→target 推导 glTF/USD 的 look-at 四元数与欧拉角         |
| `mixamoCharacterCatalog.ts`    | Mixamo 角色目录解析器：从 JSON 解析、别名匹配、默认角色 X-Bot 回退                    |
| `mixamoCharacterCatalog.json`  | Mixamo 角色目录数据                                                  |
| `characterCatalogParser.ts`    | 通用角色目录解析器：字段映射、别名、去重、高度/偏移量提取                                  |
| `modelLibraryCatalog.ts`       | 模型库目录：Flick 分类、原生操作、ModelLibraryItem 类型定义                      |
| `flickSourceCategories.json`   | Flick 源分类数据                                                    |
| `flickNativeItems.json`        | Flick 原生操作项数据                                                  |
| `flickStandardCategories.json` | Flick 标准分类数据                                                   |




## 构建

作为 npm workspace 参与根目录 `npm run build` 类型检查。