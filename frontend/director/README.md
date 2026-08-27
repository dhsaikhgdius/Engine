# Director Frontend

> Languages: **English** · [中文](README.zh-CN.md)

## Introduction

**Director** is an agent-native 3D film production frontend product (codename WorldEngine) running in the browser. It provides four core workspaces: 3D Stage, production Canvas (DAG), Video Editor, and review Gallery. A human director arranges scenes visually in the browser while coding agents inspect and change the same project through typed MCP, HTTP, and CLI surfaces.

### Tech Stack

| Technology | Purpose |
|---|---|
| **React 18** | UI framework |
| **React Three Fiber (R3F)** | Declarative Three.js 3D rendering |
| **Three.js** | 3D graphics engine |
| **Zustand** | State management |
| **Zod** | Runtime type validation |
| **Tailwind CSS** | Utility-first CSS |
| **xterm.js** | Terminal emulator (Agent CLI panel) |
| **@xterm/addon-fit / addon-webgl** | Terminal fit & WebGL addons |
| **Lucide React** | Icon library |
| **Rapier** | Physics engine (player locomotion, vehicles) |
| **Vite** | Build tool |
| **Vitest** | Test framework |

### Gateway Relationship

The Director frontend connects to the **Gateway** (`backend/gateway/`, default `127.0.0.1:8787`) via WebSocket. The Gateway handles Agent session management, job scheduling, media storage, and collaboration. Shared contracts live in `packages/protocol/`. Start with `npm run dev` (Gateway + Vite UI together), or `npm run dev:ui` alone.

---

## Workspaces

| Workspace | URL Parameter | Description |
|---|---|---|
| **Stage** | `?workspace=stage` | 3D scene layout, camera cinematography, character animation, timeline, storyboard, physics preview |
| **Canvas** | `?workspace=canvas` | Node-based production DAG (image/video/speech/music generation pipeline) |
| **Video** | `?workspace=video` | Non-linear video editing, media library, timeline export |
| **Gallery** | `?workspace=gallery` | Media review, generation result browsing (redirects to Stage) |

---

## Layout

| Path | Purpose |
|---|---|
| `index.html` | App entry HTML, theme switching, viewport setup |
| `src/main.tsx` | App bootstrap entry |
| `src/index.css` | Tailwind base layer injection |
| `src/agent/` | Browser Agent runtime: PTY terminal, gateway bridge, workbench executor |
| `src/comprehensive/` | Main application body: App shell, all workspaces, editor features, i18n, styles |
| `src/dcc/` | DCC interop contracts: Blender import/export, exchange formats, capability discovery |
| `tsconfig.json` | Thin `extends` of `tools/tsconfig.json` so the IDE type-checks this tree |
| `tests/` | Vitest suites mirroring `src/` (`*.test.ts(x)`). Runner config is `tools/vitest.config.ts` |

---

## Files

### `index.html` & Root Entry

| Path | Purpose |
|---|---|
| `index.html` | App HTML entry with inline theme script (`data-theme`), dark/light mode |
| `src/main.tsx` | App bootstrap: mounts the Director App, lazy-loads Agent bridge |
| `src/index.css` | Tailwind CSS directives |

---

### `src/agent/` — Agent browser runtime

Shared contracts, compact Stage `executeStageTool`, authoring, and audit live in `@director/agent-engine`. Stage scene types live in `@director/stage-protocol`. This folder owns the browser store-backed execution path and the PTY terminal.

| Path | Purpose |
|---|---|
| `agent/gatewayClient.ts` | WebSocket target binding, workbench/creative dispatch, capture and persistence |
| `agent/directorWorkbenchExecutor.ts` | Revision-guarded workbench operations against the live Zustand store |
| `agent/TerminalAssistantPanel.tsx` | Floating/sidebar xterm panel for Codex and Claude CLI |
| `agent/useTerminalSession.ts` | xterm instance, Fit/WebGL addons, and the `term.*` WebSocket PTY protocol |
| `agent/terminalAssistant.css` | Terminal panel styles |
| `agent/terminalTheme.json` | xterm theme colors |

---

### `src/dcc/` — DCC Interop Contracts

The DCC layer defines typed contracts between Director and external DCC tools (e.g. Blender). Zod schemas ensure data integrity for Blender scene import/export, exchange formats (`.blend`/`.glb`/`.usda`), and DCC capability discovery.

| Path | Purpose |
|---|---|
| `dcc/directorDccContract.ts` | DCC scene contract (480 lines): animation keyframes, assets, cameras, scene conversion |
| `dcc/directorDccProviderContract.ts` | DCC provider contract (338 lines): capability IDs, levels, exchange format declarations |
| `dcc/directorDccSharedContract.ts` | DCC shared types: `Vec3`, `Transform`, finite number base schemas |
| `dcc/directorDccExchangePackageContract.ts` | DCC exchange package contract: import/export package structure |
| `dcc/directorDccReturnContract.ts` | DCC return contract: Blender return data import plan |
| `dcc/directorBlendSceneImportContract.ts` | Blender scene import selection contract |
| Various `*.test.ts` files | Unit tests for each contract |

---

### `src/comprehensive/` — Main Application Body

`comprehensive/` is the main body of Director, containing the App shell, three workspaces, all editor feature modules, i18n, and styles. It has three subdirectories: `app/` (app infrastructure), `editor/` (editor feature modules), `i18n/` (internationalization), `styles/` (stylesheets).

#### `comprehensive/` Root Files

| Path | Purpose |
|---|---|
| `comprehensive/App.tsx` | App root component (398 lines): workspace routing, top nav bar, theme/language toggle, shortcuts |
| `tests/comprehensive/App.test.tsx` | App component tests |
| `comprehensive/vite-env.d.ts` | Vite environment type declarations |

#### `comprehensive/app/` — App Infrastructure

| Path | Purpose |
|---|---|
| `app/errors/WorkspaceErrorBoundary.tsx` | Workspace error boundary component |
| `app/errors/workspaceErrorBoundary.css` | Error boundary styles |
| `app/help/HelpMenu.tsx` | Help menu (keyboard shortcut reference, etc.) |
| `app/help/HelpMenu.css` | Help menu styles |
| `tests/app/help/HelpMenu.test.tsx` | Help menu tests |
| `app/layout/workspaceLayout.ts` | Workspace layout config (panel widths, collapsed state) |
| `app/layout/DirectorDeskShell.tsx` | Workspace desk shell component |
| `app/layout/CollapsedTimelineSash.tsx` | Collapsed timeline expand sash |
| `app/layout/CollapsedRightPanelSash.tsx` | Collapsed right panel expand sash |
| `app/layout/GlobalTooltipLayer.tsx` | Global tooltip layer |
| `app/layout/escapeLayerStack.ts` | Escape key layer stack management |
| `tests/app/layout/useModalDialogFocus.test.tsx` | Modal dialog focus management hook |
| `app/layout/animationFrameScheduler.ts` | Animation frame scheduler |
| `tests/app/layout/workspaceLayout.test.ts` | Layout config tests |
| `tests/app/layout/CollapsedTimelineSash.test.tsx` | Collapsed timeline tests |
| `tests/app/layout/CollapsedRightPanelSash.test.tsx` | Collapsed right panel tests |
| `tests/app/layout/escapeLayerStack.test.ts` | Escape layer stack tests |
| `app/notifications/directorNotificationStore.ts` | Notification state store (Zustand) |
| `app/notifications/DirectorNotificationLayer.tsx` | Notification toast layer component |
| `app/notifications/directorNotifications.css` | Notification styles |
| `tests/app/notifications/directorNotificationStore.test.ts` | Notification store tests |
| `tests/app/notifications/DirectorNotificationLayer.test.tsx` | Notification layer tests |
| `app/tasks/DirectorTaskTrayMenu.tsx` | Task tray menu (production task progress) |
| `app/tasks/directorTaskTrayStore.ts` | Task tray state store |
| `app/tasks/productionRunTaskClient.ts` | Production run task client |
| `app/tasks/productionTaskClient.ts` | Production task HTTP client |
| `app/tasks/productionRunPresentation.ts` | Production run presentation logic |
| `app/tasks/taskTrayPresentation.ts` | Task tray presentation logic |
| `app/tasks/taskTray.css` | Task tray styles |
| `tests/app/tasks/directorTaskTrayStore.test.ts` | Task tray store tests |
| `tests/app/tasks/productionRunPresentation.test.ts` | Production run presentation tests |
| `tests/app/tasks/productionRunTaskClient.test.ts` | Production run client tests |
| `tests/app/tasks/taskTrayPresentation.test.ts` | Task tray presentation tests |
| `app/theme/directorTheme.ts` | Theme management: light/dark toggle, persistence, CSS variable injection |
| `tests/app/theme/directorTheme.test.ts` | Theme management tests |
| `app/welcome/WelcomeGuide.tsx` | New user welcome guide |
| `app/welcome/WelcomeGuide.css` | Welcome guide styles |
| `tests/app/welcome/WelcomeGuide.test.tsx` | Welcome guide tests |

#### `comprehensive/editor/` — Editor Feature Modules

The editor directory contains ~30 sub-modules organized by feature domain. Below is each sub-module's description.

##### `editor/store/` — Core State Management

| Path | Purpose |
|---|---|
| `store/directorStore.ts` | **Main Zustand Store** (3619 lines): all 3D scene state — objects, cameras, timeline, animation, lights, materials, world, etc. |
| `store/directorStoreTypes.ts` | Store type definitions |
| `store/directorStoreUtils.ts` | Store utility functions |
| `store/directorSelectors.ts` | Store selectors (derived state) |
| `store/directorScaleMigration.ts` | Scale migration logic |
| `tests/store/directorStore.test.ts` | Main store tests |
| `tests/store/directorScaleMigration.test.ts` | Scale migration tests |

##### `editor/workspaces/` — Workspaces

| Path | Purpose |
|---|---|
| `workspaces/directorWorkspaceStore.ts` | Creative workspace store (2247 lines): Canvas/Video/Gallery state management |
| `workspaces/StageWorkspace.tsx` | Stage 3D workspace component |
| `workspaces/CanvasWorkspace.tsx` | Canvas production workspace component |
| `workspaces/VideoEditorWorkspace.tsx` | Video editor workspace component |
| `workspaces/AgentWorkspace.tsx` | Full-screen Agent chat/trajectory workspace |
| `workspaces/CreativeMediaBrowser.tsx` | Creative media browser (media library panel) |
| `workspaces/CreativeMediaWaveform.tsx` | Creative media waveform component |
| `workspaces/CreativeTransportDropdown.tsx` | Creative transport control dropdown |
| `workspaces/CreativeWorkspacePanelResizer.tsx` | Workspace panel drag resize |
| `workspaces/canvasDag.ts` | Canvas DAG layout algorithm (auto-layout for acyclic graphs) |
| `workspaces/canvasPipeline.ts` | Canvas pipeline execution engine |
| `workspaces/canvasPipelineProtocol.ts` | Canvas pipeline protocol definitions |
| `workspaces/canvasSections.ts` | Canvas sections/grouping logic |
| `workspaces/canvasTimelineBridge.ts` | Canvas-to-timeline bridge |
| `workspaces/canvasWorkflowPresets.json` | Canvas workflow presets |
| `workspaces/captionImport.ts` | Caption import logic |
| `workspaces/clipFilmstrip.ts` | Clip filmstrip generation |
| `workspaces/creativeProjectBundle.ts` | Creative project bundle (import/export) |
| `workspaces/directorGallery.ts` | Gallery state management |
| `workspaces/directorGalleryView.ts` | Gallery view component |
| `workspaces/directorMediaAssembly.ts` | Media assembly logic |
| `workspaces/directorMediaLibrary.ts` | Media library management |
| `workspaces/directorMediaReviewStore.ts` | Media review store |
| `workspaces/directorTimelineVideoExport.ts` | Timeline video export |
| `workspaces/galleryGenerationBridge.ts` | Gallery-to-generation bridge |
| `workspaces/generationPromptHandoff.ts` | Generation prompt handoff |
| `workspaces/windowPointerDrag.ts` | Window pointer drag utility |
| Various `*.test.*` files | Unit tests for each module |

##### `editor/canvas/` — 3D Canvas Rendering

| Path | Purpose |
|---|---|
| `canvas/SceneRoot.tsx` | R3F scene root component (lights, background, object rendering) |
| `canvas/DirectorCanvas.tsx` | 3D canvas main component (OrbitControls, raycasting, selection) |
| `canvas/DirectorKeyboardController.tsx` | Keyboard controller (WASD movement, etc.) |
| `canvas/ViewportToolbar.tsx` | Viewport toolbar (tool selection, mode switching) |
| `canvas/ViewportNavigationSettings.tsx` | Viewport navigation settings panel |
| `canvas/ViewportBackground.tsx` | Viewport background (solid/gradient/panorama) |
| `canvas/DirectorClippingPlanes.tsx` | Viewport clipping planes configuration |
| `canvas/DirectorSceneLighting.tsx` | Scene lighting system |
| `canvas/DirectorPbrMaterial.tsx` | PBR material component |
| `canvas/StaticPrimitiveBatches.tsx` | Static primitive batch rendering |
| `canvas/QuadViewportRenderer.tsx` | Quad viewport renderer |
| `canvas/BlenderSceneLayer.tsx` | Blender live scene layer |
| `canvas/ModelLibraryPreview.tsx` | Model library preview render |
| `canvas/AssetBindingPreview.tsx` | Asset binding preview |
| `canvas/ArdyMotionPreviewLayer.tsx` | Ardy motion preview layer |
| `canvas/CameraViewportProperties.tsx` | Camera viewport properties panel |
| `canvas/cameraPreviewModeGlyph.tsx` | Camera preview mode glyph |
| `canvas/viewportNavigation.ts` | Viewport navigation logic |
| `canvas/viewportWheelZoom.ts` | Viewport wheel zoom |
| `canvas/viewportObjectFocus.ts` | Viewport object focus |
| `canvas/viewportAspectFrame.ts` | Viewport aspect ratio frame |
| `canvas/viewportChromeDrag.ts` | Viewport chrome drag |
| `canvas/viewportChromeSuppression.ts` | Viewport chrome suppression |
| `canvas/lassoSelection.ts` | Lasso selection tool |
| `canvas/quadViewport.ts` | Quad viewport logic |
| `canvas/sceneOverlays.ts` | Scene overlays |
| `canvas/visualBounds.ts` | Visual bounds calculation |
| `canvas/panoramaMath.ts` | Panorama math utilities |
| `canvas/directorObjectBatch.ts` | Object batch processing |
| `canvas/characterViewportBudget.ts` | Character viewport performance budget |
| `canvas/blenderViewportResize.ts` | Blender viewport resize |
| `canvas/cameraPictureInPictureFreeze.ts` | Camera picture-in-picture freeze |
| `canvas/importedModelDepth.ts` | Imported model depth handling |
| `canvas/blenderCamera.ts` | Blender camera sync |
| Various `*.test.*` files | Unit tests for each module |

##### `editor/schema/` — Data Models & Schemas

| Path | Purpose |
|---|---|
| `schema/directorProject.ts` | Director project type definitions (objects, cameras, lights, materials, world, etc.) |
| `schema/directorProjectSchema.ts` | Director project Zod schema (validation, parsing, migration) |
| `schema/directorProjectRevision.ts` | Project revision management (optimistic locking) |
| `schema/directorProjectOptions.json` | Project option constants (geometry types, asset kinds, etc.) |
| `schema/directorProduction.ts` | Production model: episodes, scenes, shots |
| `schema/directorProductionEvaluator.ts` | Production evaluator |
| `schema/directorAnimation.ts` | Animation data model |
| `schema/animationEasing.ts` | Animation easing functions |
| `schema/cameraGeometry.ts` | Camera geometry calculations (focal length, FOV, sensor) |
| `schema/cameraProjection.ts` | Camera projection matrix |
| `schema/cameraTarget.ts` | Camera target tracking |
| `schema/cameraIdentity.ts` | Camera identity |
| `schema/cameraExposure.ts` | Camera exposure parameters |
| `schema/directorLighting.ts` | Lighting type definitions |
| `schema/directorMaterial.ts` | Material type definitions |
| `schema/characterMotionCatalog.ts` | Character motion catalog |
| `schema/directorAgentAssetCatalog.ts` | Agent asset catalog |
| `schema/directorUiProtocol.ts` | UI protocol types (transform mode, selection state) |
| `schema/objectLayers.ts` | Object layer management |
| `schema/adapters.ts` | Data adapters |
| `schema/poseSchema.ts` | Pose schema |
| `schema/poseProtocol.json` | Pose protocol constants |
| `schema/flickHumanAppearance.ts` | Flick character appearance definitions |
| `schema/viewportAspectRatio.ts` | Viewport aspect ratio |
| `schema/viewportLayout.ts` | Viewport layout |
| `schema/viewportLabels.ts` | Viewport labels |
| `schema/viewportNavigation.ts` | Viewport navigation config |
| Various `*.test.*` files | Unit tests for each module |

##### `editor/session/` — Session Management

| Path | Purpose |
|---|---|
| `session/directorSessionRuntime.ts` | Session runtime state (sceneId, sessionId, etc.) |
| `tests/session/directorSessionRuntime.test.ts` | Session runtime tests |

##### `editor/timeline/` — Timeline

| Path | Purpose |
|---|---|
| `timeline/DirectorTimelineDock.tsx` | Timeline dock panel |
| `timeline/DirectorTimelineEnablePrompt.tsx` | Timeline enable prompt |
| `timeline/DirectorDatasetOptions.tsx` | Dataset options panel |
| `timeline/frameRate.ts` | Frame rate utilities (24/25/30/60 fps) |
| `timeline/frameTime.ts` | Frame-to-time conversion |
| `timeline/frameTimeline.ts` | Frame timeline logic |
| `timeline/timecode.ts` | Timecode utilities |
| `timeline/timelineRecording.ts` | Timeline recording |
| `timeline/characterMotionBlocks.ts` | Character motion blocks |
| `timeline/TimingCurveEditor.tsx` | Timing curve editor |
| Various `*.test.*` files | Unit tests for each module |

##### `editor/storyboard/` — Storyboard

| Path | Purpose |
|---|---|
| `storyboard/directorStoryboard.ts` | Storyboard data model |
| `storyboard/DirectorStoryboardPanel.tsx` | Storyboard panel |
| `storyboard/DirectorStoryboardExportDialog.tsx` | Storyboard export dialog |
| `storyboard/storyboardCapture.ts` | Storyboard capture |
| `storyboard/storyboardPdf.ts` | Storyboard PDF export |
| Various `*.test.*` files | Unit tests for each module |

##### `editor/shot/` — Shot Management

| Path | Purpose |
|---|---|
| `shot/shotPackage.ts` | Shot package definition (render passes, etc.) |
| `shot/shotPackageCapture.ts` | Shot package capture |
| `shot/shotIr.ts` | Shot intermediate representation (IR) |
| `shot/cameraTrajectory.ts` | Camera trajectory computation |
| `shot/aiControlPackage.ts` | AI control package |
| `shot/shotControlPackageExport.ts` | Shot control package export |
| `shot/defaultRenderPasses.json` | Default render pass configuration |
| Various `*.test.*` files | Unit tests for each module |

##### `editor/video/` — Video Processing

| Path | Purpose |
|---|---|
| `video/directorVideoExport.ts` | Video export engine |
| `video/deterministicFrameExport.ts` | Deterministic frame export |
| `video/deterministicZip.ts` | Deterministic ZIP packaging |
| `video/instanceAnnotations.ts` | Instance annotations |
| Various `*.test.*` files | Unit tests for each module |

##### `editor/panels/` — UI Panels

| Path | Purpose |
|---|---|
| `panels/RightPanel.tsx` | Right panel container (switches content based on selection) |
| `panels/ScenePanel.tsx` | Scene properties panel |
| `panels/CameraPanel.tsx` | Camera properties panel |
| `panels/CharacterPanel.tsx` | Character properties panel |
| `panels/PropPanel.tsx` | Prop properties panel |
| `panels/AssetLibraryPanel.tsx` | Asset library panel |
| `panels/ObjectTreePanel.tsx` | Object tree panel (hierarchy view) |
| `panels/ObjectAdvancedToolsPanel.tsx` | Object advanced tools panel |
| `panels/ObjectReferenceBindings.tsx` | Object reference bindings |
| `panels/InspectorControls.tsx` | Inspector controls |
| `panels/SceneWorldSection.tsx` | Scene world parameters section |
| `panels/CinematographyAdvisor.tsx` | Cinematography advisor panel |
| `panels/ArdyMotionSection.tsx` | Ardy motion section |
| `panels/ModelLibraryThumb.tsx` | Model library thumbnail |
| `panels/VirtualizedAssetGrid.tsx` | Virtualized asset grid |
| `panels/VirtualizedObjectList.tsx` | Virtualized object list |
| `panels/BlenderNativeRigPanel.tsx` | Blender native rig panel |
| `panels/virtualizedAssetGridLayout.ts` | Virtualized grid layout algorithm |
| `panels/objectTreeHierarchy.ts` | Object tree hierarchy computation |
| `panels/characterPoseGroups.json` | Character pose groups |
| `panels/assetLibrary.css` | Asset library styles |
| `panels/blenderNativeRigPanel.css` | Blender rig panel styles |
| Various `*.test.*` files | Unit tests for each module |

##### `editor/player/` — Player Mode

| Path | Purpose |
|---|---|
| `player/PlayerController.tsx` | Player controller main component (Rapier physics) |
| `player/PlayerModeHud.tsx` | Player mode HUD |
| `player/playerLocomotion.ts` | Player locomotion logic |
| `player/playerInput.ts` | Player input handling |
| `player/playerGamepad.ts` | Gamepad support |
| `player/playerInteractions.ts` | Player interaction logic |
| `player/playerCameraRig.ts` | Player camera rig |
| `player/playerCameraCollision.ts` | Player camera collision detection |
| `player/playerCollisionMesh.ts` | Player collision mesh |
| `player/playerMotionRecorder.ts` | Player motion recording |
| `player/playerEmotes.ts` | Player emotes |
| `player/playerStaticEnvironment.ts` | Player static environment |
| `player/playerRoamAudio.ts` | Player roam audio |
| `player/playerVehicles.ts` | Player vehicle interaction |
| `player/playerVehicleSession.ts` | Player vehicle session |
| `player/playerRaycastAcceleration.ts` | Player raycast acceleration |
| `player/rapierPlayerMotor.ts` | Rapier player physics motor |
| `player/characterFollowRuntime.ts` | Character follow runtime |
| `player/playerRuntimeStatusStore.ts` | Player runtime status store |
| `player/playerDefaults.json` | Player default configuration |
| Various `*.test.*` files | Unit tests for each module |

##### `editor/runtime/` — Runtime

| Path | Purpose |
|---|---|
| `runtime/timelineRuntimeStore.ts` | Timeline runtime store |
| `runtime/timelineExportLifecycle.ts` | Timeline export lifecycle |
| `runtime/blenderRuntimeStore.ts` | Blender runtime store |
| `runtime/blenderCharacterAdapter.ts` | Blender character adapter |
| `runtime/useRafCoalescedTransformInteraction.ts` | RAF-coalesced transform interaction hook |
| `runtime/PrimitiveMannequin.tsx` | Primitive mannequin component |
| `tests/runtime/PrimitiveMannequin.test.tsx` | Primitive mannequin tests |
| Various `*.test.*` files | Unit tests for each module |

##### `editor/io/` — I/O

| Path | Purpose |
|---|---|
| `io/captureBridge.ts` | Capture bridge (viewport → media library) |
| `io/hostBridge.ts` | Host bridge (iframe postMessage) |
| `io/exportProjectJson.ts` | Project JSON export |
| `io/importProjectJson.ts` | Project JSON import |
| `io/localCaptureImport.ts` | Local capture import |
| `io/screenshotExport.ts` | Screenshot export |
| Various `*.test.*` files | Unit tests for each module |

##### `editor/assistant/` — Agent Assistant

| Path | Purpose |
|---|---|
| `assistant/DirectorAgentWorkbench.tsx` | Agent workbench main panel |
| `assistant/DirectorAgentModelPicker.tsx` | Agent model picker |
| `assistant/agentGatewayClient.ts` | Agent Gateway HTTP client |
| `assistant/agentSessionClient.ts` | Agent session client |
| `assistant/agentTaskBridge.ts` | Agent task bridge |
| `assistant/agentToolActivityCard.ts` | Agent tool activity card |
| `tests/assistant/agentToolActivityCard.test.ts` | Agent tool activity card tests |
| `assistant/assistantProtocol.ts` | Assistant protocol definitions |
| `assistant/directorAgentModelOptions.ts` | Agent model options |
| `assistant/pageStateBridge.ts` | Page state bridge |
| `assistant/scriptToProductionPipeline.ts` | Script-to-production pipeline |
| `assistant/agentWorkbench.css` | Agent workbench styles |
| `assistant/assistant.css` | Assistant styles |
| `assistant/taskFailurePresentation.json` | Task failure presentation text |
| Various `*.test.*` files | Unit tests for each module |

##### `editor/interchange/` — Data Interchange

| Path | Purpose |
|---|---|
| `interchange/index.ts` | Interchange module entry |
| `interchange/contract.ts` | Interchange contract definitions |
| `interchange/encoding.ts` | Encoding utilities |
| `interchange/gltf.ts` | glTF import/export |
| `interchange/usd.ts` | USD import/export |
| `interchange/otio.ts` | OpenTimelineIO import/export |
| `interchange/creativeOtio.ts` | Creative OTIO adaptation |
| `interchange/fountain.ts` | Fountain screenplay format import |
| `interchange/mesh.ts` | Mesh interchange utilities |
| `interchange/importedModelMesh.ts` | Imported model mesh processing |
| `interchange/cameraOrientation.ts` | Camera orientation conversion |
| `interchange/DirectorInterchangeMenu.tsx` | Interchange menu (import/export entry point) |
| `interchange/DccProviderBrowser.tsx` | DCC provider browser |
| `interchange/BlenderLivePanel.tsx` | Blender live connection panel |
| `interchange/BlenderMaterialEditor.tsx` | Blender material editor |
| `interchange/BlenderMaterialNodesEditor.tsx` | Blender material nodes editor |
| `interchange/BlenderMeshEditor.tsx` | Blender mesh editor |
| `interchange/blenderColorSpace.ts` | Blender color space conversion |
| `tests/interchange/characterAssetBoundaries.test.ts` | Character asset boundary tests |
| Various `*.test.*` files | Unit tests for each module |

##### `editor/performance/` — Performance

| Path | Purpose |
|---|---|
| `performance/PerformanceSettings.tsx` | Performance settings panel |
| `performance/AdaptivePerformanceController.tsx` | Adaptive performance controller |
| `performance/DirectorShadowMapController.tsx` | Shadow map controller |
| `performance/performanceProfiles.ts` | Performance profile definitions |
| `performance/performanceProfiles.json` | Performance profile data |
| `performance/performanceRuntime.ts` | Performance runtime |
| `performance/renderBudget.ts` | Render budget management |
| Various `*.test.*` files | Unit tests for each module |

##### `editor/motion/` — Motion Control

| Path | Purpose |
|---|---|
| `motion/CameraPilotController.tsx` | Camera pilot controller (keyframe interpolation) |
| `motion/CameraPilotHud.tsx` | Camera pilot HUD |
| `motion/cameraPilotMotion.ts` | Camera pilot motion computation |
| `motion/pilotControls.ts` | Pilot control definitions |
| Various `*.test.*` files | Unit tests for each module |

##### `editor/trajectory/` — Trajectory

| Path | Purpose |
|---|---|
| `trajectory/TrajectoryPropertiesPanel.tsx` | Trajectory properties panel |
| `trajectory/TrajectoryViewportOverlay.tsx` | Trajectory viewport overlay |
| `trajectory/trajectoryMath.ts` | Trajectory math (Bezier, splines) |
| `trajectory/cameraMoveAuthoring.ts` | Camera move authoring |
| `trajectory/animationRecipes.ts` | Animation recipes |
| `trajectory/proceduralGait.ts` | Procedural gait |
| Various `*.test.*` files | Unit tests for each module |

##### `editor/audio/` — Audio

| Path | Purpose |
|---|---|
| `audio/stageTimelineAudio.ts` | Timeline audio playback |
| `audio/stageViewportAudio.ts` | Viewport audio playback |
| `audio/stageAudioMediaResolver.ts` | Audio media resolver |
| `audio/useStageTimelineAudioRehearsal.ts` | Audio rehearsal hook |
| Various `*.test.*` files | Unit tests for each module |

##### `editor/loaders/` — Asset Loaders

| Path | Purpose |
|---|---|
| `loaders/humanoidRig.ts` | Humanoid rig loader |
| `loaders/localModelImport.ts` | Local model import |
| `loaders/localModelSize.ts` | Local model size estimation |
| `loaders/panoramaImport.ts` | Panorama import |
| `loaders/splatFormats.ts` | Gaussian splat format support |
| `loaders/textureImport.ts` | Texture import |
| Various `*.test.*` files | Unit tests for each module |

##### `editor/media/` — Media

| Path | Purpose |
|---|---|
| `media/persistentCreativeMediaStore.ts` | Persistent media store (IndexedDB) |
| `media/creativeMediaEngineering.ts` | Media engineering utilities |
| `media/creativeMediaFormats.json` | Media format definitions |
| `media/creativeMediaProbe.ts` | Media probe (metadata extraction) |
| `media/MediaTranscriptionPanel.tsx` | Media transcription panel |
| `media/mediaTranscriptionBridge.ts` | Media transcription bridge |
| `media/pngMetadata.ts` | PNG metadata read/write |
| Various `*.test.*` files | Unit tests for each module |

##### `editor/modelLibrary/` — Model Library

| Path | Purpose |
|---|---|
| `modelLibrary/modelLibraryCatalog.ts` | Model library catalog |
| `modelLibrary/modelLibraryDrag.ts` | Model library drag |
| `modelLibrary/mixamoCharacterCatalog.ts` | Mixamo character catalog |
| `modelLibrary/flickPublicCatalog.ts` | Flick public character catalog |
| `modelLibrary/flickNativeItems.json` | Flick native item list |
| `modelLibrary/flickSourceCategories.json` | Flick source categories |
| `modelLibrary/flickStandardCategories.json` | Flick standard categories |
| `modelLibrary/characterCatalogParser.ts` | Character catalog parser |
| `modelLibrary/assetSizeCatalog.ts` | Asset size catalog |
| Various `*.test.*` files | Unit tests for each module |

##### `editor/render/` — Rendering

| Path | Purpose |
|---|---|
| `render/renderPassCapture.ts` | Render pass capture |
| `render/renderCaptureUtils.ts` | Render capture utilities |
| `render/directorPrevizPalette.ts` | Previsualization palette |
| `render/semanticPalette.ts` | Semantic palette |
| `render/cinematicOpticsCapture.ts` | Cinematic optics capture |
| `render/captureVisibility.ts` | Capture visibility control |
| `render/cameraPreviewModality.ts` | Camera preview modality |
| `render/depthFloatCapture.ts` | Depth float capture |
| `render/denseMotionFlow.ts` | Dense motion flow |
| `render/lineartPassCapture.ts` | Line art pass capture |
| `render/motionVectorPass.ts` | Motion vector pass |
| `render/pbrGbufferPass.ts` | PBR G-buffer pass |
| `render/posePassCapture.ts` | Pose pass capture |
| `render/previzMaterialScope.ts` | Previsualization material scope |
| `render/exrEncoder.ts` | EXR format encoder |
| `render/viewportLook.tsx` | Viewport look configuration |
| `render/dofFragment.glsl` | Depth of field fragment shader |
| `render/dofVertex.glsl` | Depth of field vertex shader |
| Various `*.test.*` files | Unit tests for each module |

##### `editor/` Other Sub-modules

| Path | Purpose |
|---|---|
| `editor/useDropdownDisclosure.ts` | Dropdown disclosure hook |
| `tests/editor/useDropdownDisclosure.test.tsx` | Dropdown disclosure hook tests |
| `editor/keyboard/EditorShortcuts.tsx` | Keyboard shortcut registration & display |
| `tests/editor/keyboard/EditorShortcuts.test.tsx` | Shortcut tests |
| `editor/comfy/ComfyNodesDialog.tsx` | ComfyUI nodes dialog |
| `editor/comfy/comfyNodes.css` | ComfyUI nodes styles |
| `tests/editor/comfy/ComfyNodesDialog.test.tsx` | ComfyUI nodes tests |
| `editor/generated3d/Generated3DDialog.tsx` | Generated 3D dialog |
| `editor/generated3d/generated3dClient.ts` | Generated 3D client |
| `editor/generated3d/generated3dPromotion.ts` | Generated 3D promotion |
| `editor/generated3d/generated3d.css` | Generated 3D styles |
| Various `*.test.*` files | Unit tests for each module |
| `editor/reconstruction/CaptureReconstructionDialog.tsx` | Capture reconstruction dialog |
| `editor/reconstruction/ReferenceSceneReconstructionDialog.tsx` | Reference scene reconstruction dialog |
| `editor/reconstruction/captureReconstructionClient.ts` | Capture reconstruction client |
| `editor/reconstruction/captureReconstructionApply.ts` | Capture reconstruction apply |
| `editor/reconstruction/captureCompare.ts` | Capture comparison |
| `editor/reconstruction/referenceImageAnalysis.ts` | Reference image analysis |
| `editor/reconstruction/referenceSceneReconstruction.ts` | Reference scene reconstruction |
| `editor/reconstruction/captureReconstruction.css` | Capture reconstruction styles |
| `editor/reconstruction/referenceSceneReconstruction.css` | Reference scene reconstruction styles |
| Various `*.test.*` files | Unit tests for each module |
| `editor/procedural/ProceduralToolsDialog.tsx` | Procedural tools dialog |
| `editor/procedural/proceduralTools.css` | Procedural tools styles |
| `tests/editor/procedural/ProceduralToolsDialog.test.tsx` | Procedural tools tests |
| `editor/production/ProductionPanel.tsx` | Production panel |
| `editor/production/productionClient.ts` | Production HTTP client |
| `editor/production/sceneCameraThumbnailCache.ts` | Scene camera thumbnail cache |
| `tests/editor/production/ProductionPanel.test.tsx` | Production panel tests |
| `editor/productionGraph/productionGraph.ts` | Production graph |
| `editor/productionGraph/productionGraphSchema.ts` | Production graph schema |
| `editor/productionGraph/productionGraphIntegrity.ts` | Production graph integrity check |
| `editor/productionGraph/productionGraphMigration.ts` | Production graph migration |
| `editor/productionGraph/directorProjectProductionGraph.ts` | Project production graph |
| `editor/productionGraph/productionGraphProtocol.json` | Production graph protocol |
| `editor/productionGraph/productionGraphRelations.json` | Production graph relations |
| Various `*.test.*` files | Unit tests for each module |
| `editor/presets/mannequinPosePresets.ts` | Mannequin pose presets |
| `editor/presets/mannequinPosePresets.json` | Pose preset data |
| `tests/editor/presets/mannequinPosePresets.test.ts` | Pose preset tests |
| `editor/templates/index.ts` | Scene template entry |
| `editor/templates/DirectorTemplateDialog.tsx` | Scene template dialog |
| `tests/editor/templates/directorSceneTemplates.test.ts` | Scene template tests |
| `editor/templates/emptyStage.json` | Empty stage template |
| `editor/templates/followShot.json` | Follow shot template |
| `editor/templates/orbitShowcase.json` | Orbit showcase template |
| `editor/templates/threePointPortrait.json` | Three-point portrait template |
| `editor/templates/dialogueTwoCharacters.json` | Two-character dialogue template |
| `editor/templates/DirectorTemplateDialog.css` | Template dialog styles |
| `editor/collaboration/directorCollaboration.ts` | Collaboration logic |
| `editor/collaboration/directorCollaborationGatewayTransport.ts` | Collaboration Gateway transport |
| Various `*.test.*` files | Unit tests for each module |
| `editor/datarecorder/sessionRecorder.ts` | Session recorder |
| `editor/datarecorder/sessionReplay.ts` | Session replay |
| `editor/datarecorder/sessionRecordTypes.ts` | Session record types |
| `editor/datarecorder/sessionFingerprint.ts` | Session fingerprint |
| `editor/datarecorder/episodePackageClient.ts` | Episode package client |
| `editor/datarecorder/episodePackageJob.ts` | Episode package job |
| `editor/datarecorder/episodeCaptionComposer.ts` | Episode caption composer |
| `editor/datarecorder/sessionEpisodeExport.ts` | Session episode export |
| Various `*.test.*` files | Unit tests for each module |
| `editor/drag/transparentDragImage.ts` | Transparent drag image generation |
| `editor/geometry/physicalPlacement.ts` | Physical placement computation |
| `editor/geometry/primitiveGeometry.ts` | Primitive geometry definitions |
| `tests/editor/geometry/physicalPlacement.test.ts` | Physical placement tests |
| `editor/vehicle/rapierVehicleRuntime.ts` | Rapier vehicle runtime |
| `editor/vehicle/vehicleContracts.ts` | Vehicle contract definitions |
| `editor/vehicle/vehicleTuning.ts` | Vehicle tuning parameters |
| Various `*.test.*` files | Unit tests for each module |
| `editor/world/LivingWorldLayer.tsx` | Living world layer (wildlife, environmental effects) |
| `editor/world/worldClock.ts` | World clock (day/night cycle) |
| `editor/world/worldTime.ts` | World time management |
| `editor/world/worldWind.ts` | World wind system |
| `editor/world/worldGround.ts` | World ground system |
| `editor/world/worldRandom.ts` | World random generation |
| `editor/world/livingWorldContracts.ts` | Living world contracts |
| Various `*.test.*` files | Unit tests for each module |
| `editor/cinematography/directorCinematography.ts` | Cinematography parameter computation |
| `tests/editor/cinematography/directorCinematography.test.ts` | Cinematography tests |
| `editor/api/directorControlPlaneClient.ts` | Control plane API client |
| `editor/api/assetSizeClient.ts` | Asset size API client |
| `editor/api/dccProviderClient.ts` | DCC provider API client |
| `editor/api/dccReturnClient.ts` | DCC return API client |
| `editor/api/dccSceneImportClient.ts` | DCC scene import API client |
| `editor/api/productionRunClient.ts` | Production run API client |
| `editor/api/blenderLiveClient.ts` | Blender live API client |
| `editor/api/friendlyError.ts` | Friendly error messages |
| Various `*.test.*` files | Unit tests for each module |
| `editor/gateway/browserTargetRegistry.ts` | Browser target registry |

#### `comprehensive/i18n/` — Internationalization

| Path | Purpose |
|---|---|
| `i18n/language.tsx` | Language Provider (324 lines): Chinese source + English translations + phrase rule engine |
| `i18n/en-US.json` | English translation dictionary (3147 lines) |
| `i18n/phraseRules.json` | Phrase rule config (regex match → English template) |
| `tests/i18n/language.test.tsx` | Language module tests |
| `tests/i18n/languageCoverage.test.ts` | Translation coverage tests |
| `tests/i18n/rawTextCoverage.test.ts` | Raw text coverage tests |

#### `comprehensive/styles/` — Stylesheets

| Path | Purpose |
|---|---|
| `styles/index.css` | Main stylesheet entry (Tailwind + global variables) |
| `styles/agentNativeTheme.css` | Agent native theme styles |
| `styles/premiumDirectorTheme.css` | Premium Director theme styles |
| `styles/sceneInspector.css` | Scene inspector styles |
| `styles/characterInspector.css` | Character inspector styles |
| `styles/cameraInspector.css` | Camera inspector styles |
| `styles/cameraPilot.css` | Camera pilot styles |
| `styles/canvasEditor.css` | Canvas editor styles |
| `styles/propInspector.css` | Prop inspector styles |
| `styles/trajectoryInspector.css` | Trajectory inspector styles |
| `styles/videoEditor.css` | Video editor styles |
| `styles/objectTreePanel.css` | Object tree panel styles |
| `styles/objectAdvancedToolsPanel.css` | Object advanced tools panel styles |
| `styles/rightSidebar.css` | Right sidebar styles |
| `styles/workspaceLoading.css` | Workspace loading state styles |
| `styles/workspaces.css` | Workspace general styles |
| `styles/mediaTranscription.css` | Media transcription styles |
| `styles/timeline.css` | Timeline styles |
| Various `*.css.test.ts` files | CSS file existence/integrity tests |

---

## Run

### Development

```bash
# From the repository root
npm run dev:ui
```

- Vite dev server default port: **5175** (override via `DIRECTOR_UI_PORT` env)
- Hot Module Replacement (HMR) enabled

### Start with Gateway

```bash
npm run dev
```

Starts Gateway (`:8787`) and Vite UI (`:5175`) together.

### Workspace URL Parameters

| URL | Workspace |
|---|---|
| `http://127.0.0.1:5175/?workspace=stage` | 3D Stage |
| `http://127.0.0.1:5175/?workspace=canvas` | Canvas |
| `http://127.0.0.1:5175/?workspace=video` | Video Editor |
| `http://127.0.0.1:5175/?workspace=gallery` | Gallery (redirects to Stage) |
| `http://127.0.0.1:5175/?theme=light` | Light mode |
| `http://127.0.0.1:5175/?theme=dark` | Dark mode |

### Build

```bash
npm run build
```

### Test

```bash
npm test                          # All tests (`tools/vitest.config.ts`)
npx vitest run --config tools/vitest.config.ts <path>   # Single test file
```

- Test framework: **Vitest**, environment: **jsdom**
- Test files live in `tests/`, mirroring `src/`, and use `*.test.ts(x)` names
- Vite, Tailwind, and the canonical `tsconfig.json` live under `tools/` — see [`tools/README.md`](../../tools/README.md)