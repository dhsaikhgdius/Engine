# Director 前端

> 语言:**中文** · [English](README.md)

## 简介

**Director** 是一款在浏览器中运行的面向智能体(agent-native)的 3D 影视制作前端产品(代号 WorldEngine)。它提供四个核心工作区:3D Stage(舞台)、生产 Canvas(画布 DAG)、Video(视频剪辑器)和审阅 Gallery(画廊)。人类导演在浏览器中可视化地布置场景,同时编码智能体通过类型化的 MCP、HTTP 和 CLI 接口检视并修改同一个项目。

### 技术栈

| 技术 | 用途 |
|---|---|
| **React 18** | UI 框架 |
| **React Three Fiber (R3F)** | 声明式 Three.js 3D 渲染 |
| **Three.js** | 3D 图形引擎 |
| **Zustand** | 状态管理 |
| **Zod** | 运行时类型校验 |
| **Tailwind CSS** | 实用优先的 CSS |
| **xterm.js** | 终端模拟器(智能体 CLI 面板) |
| **@xterm/addon-fit / addon-webgl** | 终端自适应与 WebGL 插件 |
| **Lucide React** | 图标库 |
| **Rapier** | 物理引擎(玩家移动、载具) |
| **Vite** | 构建工具 |
| **Vitest** | 测试框架 |

### 网关关系

Director 前端通过 WebSocket 连接到 **Gateway**(网关,`backend/gateway/`,默认 `127.0.0.1:8787`)。网关负责智能体会话管理、任务调度、媒体存储与协作。共享契约位于 `packages/protocol/`。使用 `npm run dev`(网关 + Vite UI 一起启动)启动,或单独使用 `npm run dev:ui`。

---

## 工作区

| 工作区 | URL 参数 | 描述 |
|---|---|---|
| **Stage** | `?workspace=stage` | 3D 场景布局、摄影机运镜、角色动画、时间轴、分镜板、物理预览 |
| **Canvas** | `?workspace=canvas` | 基于节点的生产 DAG(图像/视频/语音/音乐生成管线) |
| **Video** | `?workspace=video` | 非线性视频剪辑、媒体库、时间轴导出 |
| **Gallery** | `?workspace=gallery` | 媒体审阅、生成结果浏览(重定向至 Stage) |

---

## 目录结构

| 路径 | 用途 |
|---|---|
| `index.html` | 应用入口 HTML,主题切换、视口设置 |
| `src/main.tsx` | 应用启动入口 |
| `src/index.css` | Tailwind 基础层注入 |
| `src/agent/` | 浏览器 Agent 运行时：PTY 终端、网关桥、工作台执行器 |
| `src/comprehensive/` | 应用主体:应用外壳、全部工作区、编辑器功能、i18n、样式 |
| `src/dcc/` | DCC 互操作契约:Blender 导入/导出、交换格式、能力发现 |
| `tsconfig.json` | 薄 `extends`，指向 `tools/tsconfig.json`，供 IDE 类型检查本目录 |
| `tests/` | 与 `src/` 镜像的 Vitest 套件（`*.test.ts(x)`）。运行器配置为 `tools/vitest.config.ts` |

---

## 文件清单

### `index.html` 与根入口

| 路径 | 用途 |
|---|---|
| `index.html` | 应用 HTML 入口,内联主题脚本(`data-theme`)、深色/浅色模式 |
| `src/main.tsx` | 应用启动:挂载 Director App,惰性加载智能体桥接 |
| `src/index.css` | Tailwind CSS 指令 |

---

### `src/agent/` — Agent 浏览器运行时

共享契约、紧凑 Stage 的 `executeStageTool`、创作与审计在 `@director/agent-engine`。Stage 场景类型在 `@director/stage-protocol`。本目录负责绑定浏览器 store 的执行路径和 PTY 终端。

| 路径 | 用途 |
|---|---|
| `agent/gatewayClient.ts` | WebSocket target 绑定、工作台/创意空间调度、捕获与持久化 |
| `agent/directorWorkbenchExecutor.ts` | 对着 live Zustand store 执行带 revision 守卫的工作台操作 |
| `agent/TerminalAssistantPanel.tsx` | Codex/Claude CLI 的浮动/侧栏 xterm 面板 |
| `agent/useTerminalSession.ts` | xterm 实例、Fit/WebGL 插件，以及 `term.*` WebSocket PTY 协议 |
| `agent/terminalAssistant.css` | 终端面板样式 |
| `agent/terminalTheme.json` | xterm 主题色 |

---

### `src/dcc/` — DCC 互操作契约


DCC 层定义 Director 与外部 DCC 工具(如 Blender)之间的类型化契约。Zod schema 确保 Blender 场景导入/导出、交换格式(`.blend`/`.glb`/`.usda`)以及 DCC 能力发现的数据完整性。

| 路径 | 用途 |
|---|---|
| `dcc/directorDccContract.ts` | DCC 场景契约(480 行):动画关键帧、资产、摄影机、场景转换 |
| `dcc/directorDccProviderContract.ts` | DCC 提供者契约(338 行):能力 id、等级、交换格式声明 |
| `dcc/directorDccSharedContract.ts` | DCC 共享类型:`Vec3`、`Transform`、有限数基础 schema |
| `dcc/directorDccExchangePackageContract.ts` | DCC 交换包契约:导入/导出包结构 |
| `dcc/directorDccReturnContract.ts` | DCC 返回契约:Blender 返回数据导入计划 |
| `dcc/directorBlendSceneImportContract.ts` | Blender 场景导入选择契约 |
| 各 `*.test.ts` 文件 | 各契约单元测试 |

---

### `src/comprehensive/` — 应用主体

`comprehensive/` 是 Director 的主体,包含应用外壳、三个工作区、全部编辑器功能模块、i18n 和样式。它有三个子目录:`app/`(应用基础设施)、`editor/`(编辑器功能模块)、`i18n/`(国际化)、`styles/`(样式表)。

#### `comprehensive/` 根文件

| 路径 | 用途 |
|---|---|
| `comprehensive/App.tsx` | 应用根组件(398 行):工作区路由、顶部导航栏、主题/语言切换、快捷键 |
| `tests/comprehensive/App.test.tsx` | 应用组件测试 |
| `comprehensive/vite-env.d.ts` | Vite 环境类型声明 |

#### `comprehensive/app/` — 应用基础设施

| 路径 | 用途 |
|---|---|
| `app/errors/WorkspaceErrorBoundary.tsx` | 工作区错误边界组件 |
| `app/errors/workspaceErrorBoundary.css` | 错误边界样式 |
| `app/help/HelpMenu.tsx` | 帮助菜单(快捷键参考等) |
| `app/help/HelpMenu.css` | 帮助菜单样式 |
| `tests/app/help/HelpMenu.test.tsx` | 帮助菜单测试 |
| `app/layout/workspaceLayout.ts` | 工作区布局配置(面板宽度、折叠状态) |
| `app/layout/DirectorDeskShell.tsx` | 工作区桌面外壳组件 |
| `app/layout/CollapsedTimelineSash.tsx` | 折叠时间轴展开拉条 |
| `app/layout/CollapsedRightPanelSash.tsx` | 折叠右面板展开拉条 |
| `app/layout/GlobalTooltipLayer.tsx` | 全局提示层 |
| `app/layout/escapeLayerStack.ts` | Escape 键层栈管理 |
| `tests/app/layout/useModalDialogFocus.test.tsx` | 模态对话框焦点管理 hook |
| `app/layout/animationFrameScheduler.ts` | 动画帧调度器 |
| `tests/app/layout/workspaceLayout.test.ts` | 布局配置测试 |
| `tests/app/layout/CollapsedTimelineSash.test.tsx` | 折叠时间轴测试 |
| `tests/app/layout/CollapsedRightPanelSash.test.tsx` | 折叠右面板测试 |
| `tests/app/layout/escapeLayerStack.test.ts` | Escape 层栈测试 |
| `app/notifications/directorNotificationStore.ts` | 通知状态 store(Zustand) |
| `app/notifications/DirectorNotificationLayer.tsx` | 通知 toast 层组件 |
| `app/notifications/directorNotifications.css` | 通知样式 |
| `tests/app/notifications/directorNotificationStore.test.ts` | 通知 store 测试 |
| `tests/app/notifications/DirectorNotificationLayer.test.tsx` | 通知层测试 |
| `app/tasks/DirectorTaskTrayMenu.tsx` | 任务托盘菜单(制作任务进度) |
| `app/tasks/directorTaskTrayStore.ts` | 任务托盘状态 store |
| `app/tasks/productionRunTaskClient.ts` | 制作运行任务客户端 |
| `app/tasks/productionTaskClient.ts` | 制作任务 HTTP 客户端 |
| `app/tasks/productionRunPresentation.ts` | 制作运行展示逻辑 |
| `app/tasks/taskTrayPresentation.ts` | 任务托盘展示逻辑 |
| `app/tasks/taskTray.css` | 任务托盘样式 |
| `tests/app/tasks/directorTaskTrayStore.test.ts` | 任务托盘 store 测试 |
| `tests/app/tasks/productionRunPresentation.test.ts` | 制作运行展示测试 |
| `tests/app/tasks/productionRunTaskClient.test.ts` | 制作运行客户端测试 |
| `tests/app/tasks/taskTrayPresentation.test.ts` | 任务托盘展示测试 |
| `app/theme/directorTheme.ts` | 主题管理:浅色/深色切换、持久化、CSS 变量注入 |
| `tests/app/theme/directorTheme.test.ts` | 主题管理测试 |
| `app/welcome/WelcomeGuide.tsx` | 新用户欢迎引导 |
| `app/welcome/WelcomeGuide.css` | 欢迎引导样式 |
| `tests/app/welcome/WelcomeGuide.test.tsx` | 欢迎引导测试 |

#### `comprehensive/editor/` — 编辑器功能模块

editor 目录包含约 30 个按功能领域组织的子模块。以下是各子模块的说明。

##### `editor/store/` — 核心状态管理

| 路径 | 用途 |
|---|---|
| `store/directorStore.ts` | **主 Zustand Store**(3619 行):全部 3D 场景状态 —— 对象、摄影机、时间轴、动画、灯光、材质、世界等 |
| `store/directorStoreTypes.ts` | Store 类型定义 |
| `store/directorStoreUtils.ts` | Store 工具函数 |
| `store/directorSelectors.ts` | Store 选择器(派生状态) |
| `store/directorScaleMigration.ts` | 缩放迁移逻辑 |
| `tests/store/directorStore.test.ts` | 主 store 测试 |
| `tests/store/directorScaleMigration.test.ts` | 缩放迁移测试 |

##### `editor/workspaces/` — 工作区

| 路径 | 用途 |
|---|---|
| `workspaces/directorWorkspaceStore.ts` | 创意工作区 store(2247 行):Canvas/Video/Gallery 状态管理 |
| `workspaces/StageWorkspace.tsx` | Stage 3D 工作区组件 |
| `workspaces/CanvasWorkspace.tsx` | Canvas 生产工作区组件 |
| `workspaces/VideoEditorWorkspace.tsx` | 视频编辑器工作区组件 |
| `workspaces/AgentWorkspace.tsx` | 全屏 Agent 对话/轨迹工作区 |
| `workspaces/CreativeMediaBrowser.tsx` | 创意媒体浏览器(媒体库面板) |
| `workspaces/CreativeMediaWaveform.tsx` | 创意媒体波形组件 |
| `workspaces/CreativeTransportDropdown.tsx` | 创意传输控制下拉 |
| `workspaces/CreativeWorkspacePanelResizer.tsx` | 工作区面板拖拽缩放 |
| `workspaces/canvasDag.ts` | Canvas DAG 布局算法(无环图自动布局) |
| `workspaces/canvasPipeline.ts` | Canvas 管线执行引擎 |
| `workspaces/canvasPipelineProtocol.ts` | Canvas 管线协议定义 |
| `workspaces/canvasSections.ts` | Canvas 分区/分组逻辑 |
| `workspaces/canvasTimelineBridge.ts` | Canvas 到时间轴的桥接 |
| `workspaces/canvasWorkflowPresets.json` | Canvas 工作流预设 |
| `workspaces/captionImport.ts` | 字幕导入逻辑 |
| `workspaces/clipFilmstrip.ts` | 片段胶片条生成 |
| `workspaces/creativeProjectBundle.ts` | 创意项目包(导入/导出) |
| `workspaces/directorGallery.ts` | 画廊状态管理 |
| `workspaces/directorGalleryView.ts` | 画廊视图组件 |
| `workspaces/directorMediaAssembly.ts` | 媒体装配逻辑 |
| `workspaces/directorMediaLibrary.ts` | 媒体库管理 |
| `workspaces/directorMediaReviewStore.ts` | 媒体审阅 store |
| `workspaces/directorTimelineVideoExport.ts` | 时间轴视频导出 |
| `workspaces/galleryGenerationBridge.ts` | 画廊到生成的桥接 |
| `workspaces/generationPromptHandoff.ts` | 生成提示词交接 |
| `workspaces/windowPointerDrag.ts` | 窗口指针拖拽工具 |
| 各 `*.test.*` 文件 | 各模块单元测试 |

##### `editor/canvas/` — 3D 画布渲染

| 路径 | 用途 |
|---|---|
| `canvas/SceneRoot.tsx` | R3F 场景根组件(灯光、背景、对象渲染) |
| `canvas/DirectorCanvas.tsx` | 3D 画布主组件(OrbitControls、射线检测、选择) |
| `canvas/DirectorKeyboardController.tsx` | 键盘控制器(WASD 移动等) |
| `canvas/ViewportToolbar.tsx` | 视口工具栏(工具选择、模式切换) |
| `canvas/ViewportNavigationSettings.tsx` | 视口导航设置面板 |
| `canvas/ViewportBackground.tsx` | 视口背景(纯色/渐变/全景) |
| `canvas/DirectorClippingPlanes.tsx` | 视口裁剪平面配置 |
| `canvas/DirectorSceneLighting.tsx` | 场景灯光系统 |
| `canvas/DirectorPbrMaterial.tsx` | PBR 材质组件 |
| `canvas/StaticPrimitiveBatches.tsx` | 静态图元批量渲染 |
| `canvas/QuadViewportRenderer.tsx` | 四视口渲染器 |
| `canvas/BlenderSceneLayer.tsx` | Blender 实时场景层 |
| `canvas/ModelLibraryPreview.tsx` | 模型库预览渲染 |
| `canvas/AssetBindingPreview.tsx` | 资产绑定预览 |
| `canvas/ArdyMotionPreviewLayer.tsx` | Ardy 动作预览层 |
| `canvas/CameraViewportProperties.tsx` | 摄影机视口属性面板 |
| `canvas/cameraPreviewModeGlyph.tsx` | 摄影机预览模式字形 |
| `canvas/viewportNavigation.ts` | 视口导航逻辑 |
| `canvas/viewportWheelZoom.ts` | 视口滚轮缩放 |
| `canvas/viewportObjectFocus.ts` | 视口对象聚焦 |
| `canvas/viewportAspectFrame.ts` | 视口宽高比画框 |
| `canvas/viewportChromeDrag.ts` | 视口边框拖拽 |
| `canvas/viewportChromeSuppression.ts` | 视口边框抑制 |
| `canvas/lassoSelection.ts` | 套索选择工具 |
| `canvas/quadViewport.ts` | 四视口逻辑 |
| `canvas/sceneOverlays.ts` | 场景叠加层 |
| `canvas/visualBounds.ts` | 视觉边界计算 |
| `canvas/panoramaMath.ts` | 全景数学工具 |
| `canvas/directorObjectBatch.ts` | 对象批量处理 |
| `canvas/characterViewportBudget.ts` | 角色视口性能预算 |
| `canvas/blenderViewportResize.ts` | Blender 视口缩放 |
| `canvas/cameraPictureInPictureFreeze.ts` | 摄影机画中画冻结 |
| `canvas/importedModelDepth.ts` | 导入模型深度处理 |
| `canvas/blenderCamera.ts` | Blender 摄影机同步 |
| 各 `*.test.*` 文件 | 各模块单元测试 |

##### `editor/schema/` — 数据模型与 schema

| 路径 | 用途 |
|---|---|
| `schema/directorProject.ts` | Director 项目类型定义(对象、摄影机、灯光、材质、世界等) |
| `schema/directorProjectSchema.ts` | Director 项目 Zod schema(校验、解析、迁移) |
| `schema/directorProjectRevision.ts` | 项目版本管理(乐观锁) |
| `schema/directorProjectOptions.json` | 项目选项常量(几何体类型、资产种类等) |
| `schema/directorProduction.ts` | 制作模型:集数、场景、镜头 |
| `schema/directorProductionEvaluator.ts` | 制作评估器 |
| `schema/directorAnimation.ts` | 动画数据模型 |
| `schema/animationEasing.ts` | 动画缓动函数 |
| `schema/cameraGeometry.ts` | 摄影机几何计算(焦距、视场、传感器) |
| `schema/cameraProjection.ts` | 摄影机投影矩阵 |
| `schema/cameraTarget.ts` | 摄影机目标跟踪 |
| `schema/cameraIdentity.ts` | 摄影机身份 |
| `schema/cameraExposure.ts` | 摄影机曝光参数 |
| `schema/directorLighting.ts` | 灯光类型定义 |
| `schema/directorMaterial.ts` | 材质类型定义 |
| `schema/characterMotionCatalog.ts` | 角色动作目录 |
| `schema/directorAgentAssetCatalog.ts` | 智能体资产目录 |
| `schema/directorUiProtocol.ts` | UI 协议类型(变换模式、选择状态) |
| `schema/objectLayers.ts` | 对象图层管理 |
| `schema/adapters.ts` | 数据适配器 |
| `schema/poseSchema.ts` | 姿态 schema |
| `schema/poseProtocol.json` | 姿态协议常量 |
| `schema/flickHumanAppearance.ts` | Flick 角色外观定义 |
| `schema/viewportAspectRatio.ts` | 视口宽高比 |
| `schema/viewportLayout.ts` | 视口布局 |
| `schema/viewportLabels.ts` | 视口标签 |
| `schema/viewportNavigation.ts` | 视口导航配置 |
| 各 `*.test.*` 文件 | 各模块单元测试 |

##### `editor/session/` — 会话管理

| 路径 | 用途 |
|---|---|
| `session/directorSessionRuntime.ts` | 会话运行时状态(sceneId、sessionId 等) |
| `tests/session/directorSessionRuntime.test.ts` | 会话运行时测试 |

##### `editor/timeline/` — 时间轴

| 路径 | 用途 |
|---|---|
| `timeline/DirectorTimelineDock.tsx` | 时间轴停靠面板 |
| `timeline/DirectorTimelineEnablePrompt.tsx` | 时间轴启用提示 |
| `timeline/DirectorDatasetOptions.tsx` | 数据集选项面板 |
| `timeline/frameRate.ts` | 帧率工具(24/25/30/60 fps) |
| `timeline/frameTime.ts` | 帧到时间的转换 |
| `timeline/frameTimeline.ts` | 帧时间轴逻辑 |
| `timeline/timecode.ts` | 时间码工具 |
| `timeline/timelineRecording.ts` | 时间轴录制 |
| `timeline/characterMotionBlocks.ts` | 角色动作块 |
| `timeline/TimingCurveEditor.tsx` | 时间曲线编辑器 |
| 各 `*.test.*` 文件 | 各模块单元测试 |

##### `editor/storyboard/` — 分镜板

| 路径 | 用途 |
|---|---|
| `storyboard/directorStoryboard.ts` | 分镜板数据模型 |
| `storyboard/DirectorStoryboardPanel.tsx` | 分镜板面板 |
| `storyboard/DirectorStoryboardExportDialog.tsx` | 分镜板导出对话框 |
| `storyboard/storyboardCapture.ts` | 分镜板捕获 |
| `storyboard/storyboardPdf.ts` | 分镜板 PDF 导出 |
| 各 `*.test.*` 文件 | 各模块单元测试 |

##### `editor/shot/` — 镜头管理

| 路径 | 用途 |
|---|---|
| `shot/shotPackage.ts` | 镜头包定义(渲染通道等) |
| `shot/shotPackageCapture.ts` | 镜头包捕获 |
| `shot/shotIr.ts` | 镜头中间表示(IR) |
| `shot/cameraTrajectory.ts` | 摄影机轨迹计算 |
| `shot/aiControlPackage.ts` | AI 控制包 |
| `shot/shotControlPackageExport.ts` | 镜头控制包导出 |
| `shot/defaultRenderPasses.json` | 默认渲染通道配置 |
| 各 `*.test.*` 文件 | 各模块单元测试 |

##### `editor/video/` — 视频处理

| 路径 | 用途 |
|---|---|
| `video/directorVideoExport.ts` | 视频导出引擎 |
| `video/deterministicFrameExport.ts` | 确定性帧导出 |
| `video/deterministicZip.ts` | 确定性 ZIP 打包 |
| `video/instanceAnnotations.ts` | 实例标注 |
| 各 `*.test.*` 文件 | 各模块单元测试 |

##### `editor/panels/` — UI 面板

| 路径 | 用途 |
|---|---|
| `panels/RightPanel.tsx` | 右面板容器(根据选择切换内容) |
| `panels/ScenePanel.tsx` | 场景属性面板 |
| `panels/CameraPanel.tsx` | 摄影机属性面板 |
| `panels/CharacterPanel.tsx` | 角色属性面板 |
| `panels/PropPanel.tsx` | 道具属性面板 |
| `panels/AssetLibraryPanel.tsx` | 资产库面板 |
| `panels/ObjectTreePanel.tsx` | 对象树面板(层级视图) |
| `panels/ObjectAdvancedToolsPanel.tsx` | 对象高级工具面板 |
| `panels/ObjectReferenceBindings.tsx` | 对象引用绑定 |
| `panels/InspectorControls.tsx` | 检视器控件 |
| `panels/SceneWorldSection.tsx` | 场景世界参数分区 |
| `panels/CinematographyAdvisor.tsx` | 摄影指导面板 |
| `panels/ArdyMotionSection.tsx` | Ardy 动作分区 |
| `panels/ModelLibraryThumb.tsx` | 模型库缩略图 |
| `panels/VirtualizedAssetGrid.tsx` | 虚拟化资产网格 |
| `panels/VirtualizedObjectList.tsx` | 虚拟化对象列表 |
| `panels/BlenderNativeRigPanel.tsx` | Blender 原生绑定面板 |
| `panels/virtualizedAssetGridLayout.ts` | 虚拟化网格布局算法 |
| `panels/objectTreeHierarchy.ts` | 对象树层级计算 |
| `panels/characterPoseGroups.json` | 角色姿态分组 |
| `panels/assetLibrary.css` | 资产库样式 |
| `panels/blenderNativeRigPanel.css` | Blender 绑定面板样式 |
| 各 `*.test.*` 文件 | 各模块单元测试 |

##### `editor/player/` — 玩家模式

| 路径 | 用途 |
|---|---|
| `player/PlayerController.tsx` | 玩家控制器主组件(Rapier 物理) |
| `player/PlayerModeHud.tsx` | 玩家模式 HUD |
| `player/playerLocomotion.ts` | 玩家移动逻辑 |
| `player/playerInput.ts` | 玩家输入处理 |
| `player/playerGamepad.ts` | 手柄支持 |
| `player/playerInteractions.ts` | 玩家交互逻辑 |
| `player/playerCameraRig.ts` | 玩家摄影机装置 |
| `player/playerCameraCollision.ts` | 玩家摄影机碰撞检测 |
| `player/playerCollisionMesh.ts` | 玩家碰撞网格 |
| `player/playerMotionRecorder.ts` | 玩家动作录制 |
| `player/playerEmotes.ts` | 玩家表情动作 |
| `player/playerStaticEnvironment.ts` | 玩家静态环境 |
| `player/playerRoamAudio.ts` | 玩家漫游音频 |
| `player/playerVehicles.ts` | 玩家载具交互 |
| `player/playerVehicleSession.ts` | 玩家载具会话 |
| `player/playerRaycastAcceleration.ts` | 玩家射线检测加速 |
| `player/rapierPlayerMotor.ts` | Rapier 玩家物理马达 |
| `player/characterFollowRuntime.ts` | 角色跟随运行时 |
| `player/playerRuntimeStatusStore.ts` | 玩家运行时状态 store |
| `player/playerDefaults.json` | 玩家默认配置 |
| 各 `*.test.*` 文件 | 各模块单元测试 |

##### `editor/runtime/` — 运行时

| 路径 | 用途 |
|---|---|
| `runtime/timelineRuntimeStore.ts` | 时间轴运行时 store |
| `runtime/timelineExportLifecycle.ts` | 时间轴导出生命周期 |
| `runtime/blenderRuntimeStore.ts` | Blender 运行时 store |
| `runtime/blenderCharacterAdapter.ts` | Blender 角色适配器 |
| `runtime/useRafCoalescedTransformInteraction.ts` | RAF 合并的变换交互 hook |
| `runtime/PrimitiveMannequin.tsx` | 基础人偶组件 |
| `tests/runtime/PrimitiveMannequin.test.tsx` | 基础人偶测试 |
| 各 `*.test.*` 文件 | 各模块单元测试 |

##### `editor/io/` — 输入/输出

| 路径 | 用途 |
|---|---|
| `io/captureBridge.ts` | 捕获桥接(视口 → 媒体库) |
| `io/hostBridge.ts` | 宿主桥接(iframe postMessage) |
| `io/exportProjectJson.ts` | 项目 JSON 导出 |
| `io/importProjectJson.ts` | 项目 JSON 导入 |
| `io/localCaptureImport.ts` | 本地捕获导入 |
| `io/screenshotExport.ts` | 截图导出 |
| 各 `*.test.*` 文件 | 各模块单元测试 |

##### `editor/assistant/` — 智能体助手

| 路径 | 用途 |
|---|---|
| `assistant/DirectorAgentWorkbench.tsx` | 智能体工作台主面板 |
| `assistant/DirectorAgentModelPicker.tsx` | 智能体模型选择器 |
| `assistant/agentGatewayClient.ts` | 智能体网关 HTTP 客户端 |
| `assistant/agentSessionClient.ts` | 智能体会话客户端 |
| `assistant/agentTaskBridge.ts` | 智能体任务桥接 |
| `assistant/agentToolActivityCard.ts` | 智能体工具活动卡片 |
| `tests/assistant/agentToolActivityCard.test.ts` | 智能体工具活动卡片测试 |
| `assistant/assistantProtocol.ts` | 助手协议定义 |
| `assistant/directorAgentModelOptions.ts` | 智能体模型选项 |
| `assistant/pageStateBridge.ts` | 页面状态桥接 |
| `assistant/scriptToProductionPipeline.ts` | 脚本到制作的管线 |
| `assistant/agentWorkbench.css` | 智能体工作台样式 |
| `assistant/assistant.css` | 助手样式 |
| `assistant/taskFailurePresentation.json` | 任务失败展示文案 |
| 各 `*.test.*` 文件 | 各模块单元测试 |

##### `editor/interchange/` — 数据交换

| 路径 | 用途 |
|---|---|
| `interchange/index.ts` | 交换模块入口 |
| `interchange/contract.ts` | 交换契约定义 |
| `interchange/encoding.ts` | 编码工具 |
| `interchange/gltf.ts` | glTF 导入/导出 |
| `interchange/usd.ts` | USD 导入/导出 |
| `interchange/otio.ts` | OpenTimelineIO 导入/导出 |
| `interchange/creativeOtio.ts` | 创意 OTIO 适配 |
| `interchange/fountain.ts` | Fountain 剧本格式导入 |
| `interchange/mesh.ts` | 网格交换工具 |
| `interchange/importedModelMesh.ts` | 导入模型网格处理 |
| `interchange/cameraOrientation.ts` | 摄影机朝向转换 |
| `interchange/DirectorInterchangeMenu.tsx` | 交换菜单(导入/导出入口) |
| `interchange/DccProviderBrowser.tsx` | DCC 提供者浏览器 |
| `interchange/BlenderLivePanel.tsx` | Blender 实时连接面板 |
| `interchange/BlenderMaterialEditor.tsx` | Blender 材质编辑器 |
| `interchange/BlenderMaterialNodesEditor.tsx` | Blender 材质节点编辑器 |
| `interchange/BlenderMeshEditor.tsx` | Blender 网格编辑器 |
| `interchange/blenderColorSpace.ts` | Blender 色彩空间转换 |
| `tests/interchange/characterAssetBoundaries.test.ts` | 角色资产边界测试 |
| 各 `*.test.*` 文件 | 各模块单元测试 |

##### `editor/performance/` — 性能

| 路径 | 用途 |
|---|---|
| `performance/PerformanceSettings.tsx` | 性能设置面板 |
| `performance/AdaptivePerformanceController.tsx` | 自适应性能控制器 |
| `performance/DirectorShadowMapController.tsx` | 阴影贴图控制器 |
| `performance/performanceProfiles.ts` | 性能配置定义 |
| `performance/performanceProfiles.json` | 性能配置数据 |
| `performance/performanceRuntime.ts` | 性能运行时 |
| `performance/renderBudget.ts` | 渲染预算管理 |
| 各 `*.test.*` 文件 | 各模块单元测试 |

##### `editor/motion/` — 运镜控制

| 路径 | 用途 |
|---|---|
| `motion/CameraPilotController.tsx` | 摄影机飞行员控制器(关键帧插值) |
| `motion/CameraPilotHud.tsx` | 摄影机飞行员 HUD |
| `motion/cameraPilotMotion.ts` | 摄影机飞行员运镜计算 |
| `motion/pilotControls.ts` | 飞行员控制定义 |
| 各 `*.test.*` 文件 | 各模块单元测试 |

##### `editor/trajectory/` — 轨迹

| 路径 | 用途 |
|---|---|
| `trajectory/TrajectoryPropertiesPanel.tsx` | 轨迹属性面板 |
| `trajectory/TrajectoryViewportOverlay.tsx` | 轨迹视口叠加 |
| `trajectory/trajectoryMath.ts` | 轨迹数学(贝塞尔、样条) |
| `trajectory/cameraMoveAuthoring.ts` | 摄影机运镜创作 |
| `trajectory/animationRecipes.ts` | 动画配方 |
| `trajectory/proceduralGait.ts` | 程序化步态 |
| 各 `*.test.*` 文件 | 各模块单元测试 |

##### `editor/audio/` — 音频

| 路径 | 用途 |
|---|---|
| `audio/stageTimelineAudio.ts` | 时间轴音频播放 |
| `audio/stageViewportAudio.ts` | 视口音频播放 |
| `audio/stageAudioMediaResolver.ts` | 音频媒体解析器 |
| `audio/useStageTimelineAudioRehearsal.ts` | 音频排练 hook |
| 各 `*.test.*` 文件 | 各模块单元测试 |

##### `editor/loaders/` — 资产加载器

| 路径 | 用途 |
|---|---|
| `loaders/humanoidRig.ts` | 人形绑定加载器 |
| `loaders/localModelImport.ts` | 本地模型导入 |
| `loaders/localModelSize.ts` | 本地模型尺寸估算 |
| `loaders/panoramaImport.ts` | 全景导入 |
| `loaders/splatFormats.ts` | 高斯泼溅格式支持 |
| `loaders/textureImport.ts` | 纹理导入 |
| 各 `*.test.*` 文件 | 各模块单元测试 |

##### `editor/media/` — 媒体

| 路径 | 用途 |
|---|---|
| `media/persistentCreativeMediaStore.ts` | 持久化媒体 store(IndexedDB) |
| `media/creativeMediaEngineering.ts` | 媒体工程工具 |
| `media/creativeMediaFormats.json` | 媒体格式定义 |
| `media/creativeMediaProbe.ts` | 媒体探测(元数据提取) |
| `media/MediaTranscriptionPanel.tsx` | 媒体转录面板 |
| `media/mediaTranscriptionBridge.ts` | 媒体转录桥接 |
| `media/pngMetadata.ts` | PNG 元数据读写 |
| 各 `*.test.*` 文件 | 各模块单元测试 |

##### `editor/modelLibrary/` — 模型库

| 路径 | 用途 |
|---|---|
| `modelLibrary/modelLibraryCatalog.ts` | 模型库目录 |
| `modelLibrary/modelLibraryDrag.ts` | 模型库拖拽 |
| `modelLibrary/mixamoCharacterCatalog.ts` | Mixamo 角色目录 |
| `modelLibrary/flickPublicCatalog.ts` | Flick 公开角色目录 |
| `modelLibrary/flickNativeItems.json` | Flick 原生项目列表 |
| `modelLibrary/flickSourceCategories.json` | Flick 来源分类 |
| `modelLibrary/flickStandardCategories.json` | Flick 标准分类 |
| `modelLibrary/characterCatalogParser.ts` | 角色目录解析器 |
| `modelLibrary/assetSizeCatalog.ts` | 资产尺寸目录 |
| 各 `*.test.*` 文件 | 各模块单元测试 |

##### `editor/render/` — 渲染

| 路径 | 用途 |
|---|---|
| `render/renderPassCapture.ts` | 渲染通道捕获 |
| `render/renderCaptureUtils.ts` | 渲染捕获工具 |
| `render/directorPrevizPalette.ts` | 预可视化调色板 |
| `render/semanticPalette.ts` | 语义调色板 |
| `render/cinematicOpticsCapture.ts` | 电影光学捕获 |
| `render/captureVisibility.ts` | 捕获可见性控制 |
| `render/cameraPreviewModality.ts` | 摄影机预览模态 |
| `render/depthFloatCapture.ts` | 深度浮点捕获 |
| `render/denseMotionFlow.ts` | 稠密光流 |
| `render/lineartPassCapture.ts` | 线稿通道捕获 |
| `render/motionVectorPass.ts` | 运动矢量通道 |
| `render/pbrGbufferPass.ts` | PBR G-buffer 通道 |
| `render/posePassCapture.ts` | 姿态通道捕获 |
| `render/previzMaterialScope.ts` | 预可视化材质作用域 |
| `render/exrEncoder.ts` | EXR 格式编码器 |
| `render/viewportLook.tsx` | 视口外观配置 |
| `render/dofFragment.glsl` | 景深片元着色器 |
| `render/dofVertex.glsl` | 景深顶点着色器 |
| 各 `*.test.*` 文件 | 各模块单元测试 |

##### `editor/` 其他子模块

| 路径 | 用途 |
|---|---|
| `editor/useDropdownDisclosure.ts` | 下拉展开 hook |
| `tests/editor/useDropdownDisclosure.test.tsx` | 下拉展开 hook 测试 |
| `editor/keyboard/EditorShortcuts.tsx` | 快捷键注册与展示 |
| `tests/editor/keyboard/EditorShortcuts.test.tsx` | 快捷键测试 |
| `editor/comfy/ComfyNodesDialog.tsx` | ComfyUI 节点对话框 |
| `editor/comfy/comfyNodes.css` | ComfyUI 节点样式 |
| `tests/editor/comfy/ComfyNodesDialog.test.tsx` | ComfyUI 节点测试 |
| `editor/generated3d/Generated3DDialog.tsx` | 生成式 3D 对话框 |
| `editor/generated3d/generated3dClient.ts` | 生成式 3D 客户端 |
| `editor/generated3d/generated3dPromotion.ts` | 生成式 3D 提升 |
| `editor/generated3d/generated3d.css` | 生成式 3D 样式 |
| 各 `*.test.*` 文件 | 各模块单元测试 |
| `editor/reconstruction/CaptureReconstructionDialog.tsx` | 捕获重建对话框 |
| `editor/reconstruction/ReferenceSceneReconstructionDialog.tsx` | 参考场景重建对话框 |
| `editor/reconstruction/captureReconstructionClient.ts` | 捕获重建客户端 |
| `editor/reconstruction/captureReconstructionApply.ts` | 捕获重建应用 |
| `editor/reconstruction/captureCompare.ts` | 捕获对比 |
| `editor/reconstruction/referenceImageAnalysis.ts` | 参考图像分析 |
| `editor/reconstruction/referenceSceneReconstruction.ts` | 参考场景重建 |
| `editor/reconstruction/captureReconstruction.css` | 捕获重建样式 |
| `editor/reconstruction/referenceSceneReconstruction.css` | 参考场景重建样式 |
| 各 `*.test.*` 文件 | 各模块单元测试 |
| `editor/procedural/ProceduralToolsDialog.tsx` | 程序化工具对话框 |
| `editor/procedural/proceduralTools.css` | 程序化工具样式 |
| `tests/editor/procedural/ProceduralToolsDialog.test.tsx` | 程序化工具测试 |
| `editor/production/ProductionPanel.tsx` | 制作面板 |
| `editor/production/productionClient.ts` | 制作 HTTP 客户端 |
| `editor/production/sceneCameraThumbnailCache.ts` | 场景摄影机缩略图缓存 |
| `tests/editor/production/ProductionPanel.test.tsx` | 制作面板测试 |
| `editor/productionGraph/productionGraph.ts` | 制作图 |
| `editor/productionGraph/productionGraphSchema.ts` | 制作图 schema |
| `editor/productionGraph/productionGraphIntegrity.ts` | 制作图完整性检查 |
| `editor/productionGraph/productionGraphMigration.ts` | 制作图迁移 |
| `editor/productionGraph/directorProjectProductionGraph.ts` | 项目制作图 |
| `editor/productionGraph/productionGraphProtocol.json` | 制作图协议 |
| `editor/productionGraph/productionGraphRelations.json` | 制作图关系 |
| 各 `*.test.*` 文件 | 各模块单元测试 |
| `editor/presets/mannequinPosePresets.ts` | 人偶姿态预设 |
| `editor/presets/mannequinPosePresets.json` | 姿态预设数据 |
| `tests/editor/presets/mannequinPosePresets.test.ts` | 姿态预设测试 |
| `editor/templates/index.ts` | 场景模板入口 |
| `editor/templates/DirectorTemplateDialog.tsx` | 场景模板对话框 |
| `tests/editor/templates/directorSceneTemplates.test.ts` | 场景模板测试 |
| `editor/templates/emptyStage.json` | 空舞台模板 |
| `editor/templates/followShot.json` | 跟随镜头模板 |
| `editor/templates/orbitShowcase.json` | 环绕展示模板 |
| `editor/templates/threePointPortrait.json` | 三点人像模板 |
| `editor/templates/dialogueTwoCharacters.json` | 双人对白模板 |
| `editor/templates/DirectorTemplateDialog.css` | 模板对话框样式 |
| `editor/collaboration/directorCollaboration.ts` | 协作逻辑 |
| `editor/collaboration/directorCollaborationGatewayTransport.ts` | 协作网关传输 |
| 各 `*.test.*` 文件 | 各模块单元测试 |
| `editor/datarecorder/sessionRecorder.ts` | 会话录制器 |
| `editor/datarecorder/sessionReplay.ts` | 会话回放 |
| `editor/datarecorder/sessionRecordTypes.ts` | 会话录制类型 |
| `editor/datarecorder/sessionFingerprint.ts` | 会话指纹 |
| `editor/datarecorder/episodePackageClient.ts` | 集数包客户端 |
| `editor/datarecorder/episodePackageJob.ts` | 集数包任务 |
| `editor/datarecorder/episodeCaptionComposer.ts` | 集数字幕合成器 |
| `editor/datarecorder/sessionEpisodeExport.ts` | 会话集数导出 |
| 各 `*.test.*` 文件 | 各模块单元测试 |
| `editor/drag/transparentDragImage.ts` | 透明拖拽图像生成 |
| `editor/geometry/physicalPlacement.ts` | 物理放置计算 |
| `editor/geometry/primitiveGeometry.ts` | 基础几何体定义 |
| `tests/editor/geometry/physicalPlacement.test.ts` | 物理放置测试 |
| `editor/vehicle/rapierVehicleRuntime.ts` | Rapier 载具运行时 |
| `editor/vehicle/vehicleContracts.ts` | 载具契约定义 |
| `editor/vehicle/vehicleTuning.ts` | 载具调校参数 |
| 各 `*.test.*` 文件 | 各模块单元测试 |
| `editor/world/LivingWorldLayer.tsx` | 生机世界层(野生动物、环境效果) |
| `editor/world/worldClock.ts` | 世界时钟(昼夜循环) |
| `editor/world/worldTime.ts` | 世界时间管理 |
| `editor/world/worldWind.ts` | 世界风系统 |
| `editor/world/worldGround.ts` | 世界地面系统 |
| `editor/world/worldRandom.ts` | 世界随机生成 |
| `editor/world/livingWorldContracts.ts` | 生机世界契约 |
| 各 `*.test.*` 文件 | 各模块单元测试 |
| `editor/cinematography/directorCinematography.ts` | 摄影参数计算 |
| `tests/editor/cinematography/directorCinematography.test.ts` | 摄影测试 |
| `editor/api/directorControlPlaneClient.ts` | 控制平面 API 客户端 |
| `editor/api/assetSizeClient.ts` | 资产尺寸 API 客户端 |
| `editor/api/dccProviderClient.ts` | DCC 提供者 API 客户端 |
| `editor/api/dccReturnClient.ts` | DCC 返回 API 客户端 |
| `editor/api/dccSceneImportClient.ts` | DCC 场景导入 API 客户端 |
| `editor/api/productionRunClient.ts` | 制作运行 API 客户端 |
| `editor/api/blenderLiveClient.ts` | Blender 实时 API 客户端 |
| `editor/api/friendlyError.ts` | 友好错误信息 |
| 各 `*.test.*` 文件 | 各模块单元测试 |
| `editor/gateway/browserTargetRegistry.ts` | 浏览器目标注册表 |

#### `comprehensive/i18n/` — 国际化

| 路径 | 用途 |
|---|---|
| `i18n/language.tsx` | 语言 Provider(324 行):中文源 + 英文翻译 + 短语规则引擎 |
| `i18n/en-US.json` | 英文翻译字典(3147 行) |
| `i18n/phraseRules.json` | 短语规则配置(正则匹配 → 英文模板) |
| `tests/i18n/language.test.tsx` | 语言模块测试 |
| `tests/i18n/languageCoverage.test.ts` | 翻译覆盖率测试 |
| `tests/i18n/rawTextCoverage.test.ts` | 原始文本覆盖率测试 |

#### `comprehensive/styles/` — 样式表

| 路径 | 用途 |
|---|---|
| `styles/index.css` | 主样式表入口(Tailwind + 全局变量) |
| `styles/agentNativeTheme.css` | 智能体原生主题样式 |
| `styles/premiumDirectorTheme.css` | 高级 Director 主题样式 |
| `styles/sceneInspector.css` | 场景检视器样式 |
| `styles/characterInspector.css` | 角色检视器样式 |
| `styles/cameraInspector.css` | 摄影机检视器样式 |
| `styles/cameraPilot.css` | 摄影机飞行员样式 |
| `styles/canvasEditor.css` | 画布编辑器样式 |
| `styles/propInspector.css` | 道具检视器样式 |
| `styles/trajectoryInspector.css` | 轨迹检视器样式 |
| `styles/videoEditor.css` | 视频编辑器样式 |
| `styles/objectTreePanel.css` | 对象树面板样式 |
| `styles/objectAdvancedToolsPanel.css` | 对象高级工具面板样式 |
| `styles/rightSidebar.css` | 右侧栏样式 |
| `styles/workspaceLoading.css` | 工作区加载状态样式 |
| `styles/workspaces.css` | 工作区通用样式 |
| `styles/mediaTranscription.css` | 媒体转录样式 |
| `styles/timeline.css` | 时间轴样式 |
| 各 `*.css.test.ts` 文件 | CSS 文件存在性/完整性测试 |

---

## 运行

### 开发

```bash
# From the repository root
npm run dev:ui
```

- Vite 开发服务器默认端口:**5175**(通过 `DIRECTOR_UI_PORT` 环境变量覆盖)
- 启用热模块替换(HMR)

### 随网关启动

```bash
npm run dev
```

同时启动网关(`:8787`)和 Vite UI(`:5175`)。

### 工作区 URL 参数

| URL | 工作区 |
|---|---|
| `http://127.0.0.1:5175/?workspace=stage` | 3D Stage |
| `http://127.0.0.1:5175/?workspace=canvas` | Canvas |
| `http://127.0.0.1:5175/?workspace=video` | 视频编辑器 |
| `http://127.0.0.1:5175/?workspace=gallery` | 画廊(重定向至 Stage) |
| `http://127.0.0.1:5175/?theme=light` | 浅色模式 |
| `http://127.0.0.1:5175/?theme=dark` | 深色模式 |

### 构建

```bash
npm run build
```

### 测试

```bash
npm test                          # 全部测试（`tools/vitest.config.ts`）
npx vitest run --config tools/vitest.config.ts <path>   # 单个测试文件
```

- 测试框架:**Vitest**,环境:**jsdom**
- 测试文件放在 `tests/`，目录结构与 `src/` 对应，命名约定 `*.test.ts(x)`
- Vite、Tailwind 与规范 `tsconfig.json` 在 `tools/`，见 [`tools/README.md`](../../tools/README.md)
