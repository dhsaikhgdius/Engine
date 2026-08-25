---
title: UI Icon Reference
description: Function, state, and improvement backlog for every icon button across Director workspaces.
---

This page is maintained in sync with the product UI. Each section has a **review status** for
incremental verification against `frontend/director/src/comprehensive`.

Last verified: **2026-08-13**.

## How to use this page

| Status               | Meaning                                    |
| -------------------- | ------------------------------------------ |
| ⬜ Pending review    | Drafted from code, not yet confirmed in UI |
| ✅ Confirmed         | Matches shipped behavior                   |
| 🔧 Needs improvement | Confirmed gap; track in backlog            |

Suggested order: global top bar → 3D Stage (viewport / scene tree / inspector / timeline) →
Canvas → Video → Gallery → settings popovers.

---

## 1. Global top bar

**Code**: `frontend/director/src/comprehensive/App.tsx`  
**Review status**: ✅ Confirmed

### 1.1 Workspace tabs

| Icon              | Label        | Action                      | Active                         |
| ----------------- | ------------ | --------------------------- | ------------------------------ |
| `LayoutDashboard` | Canvas       | Switch to Canvas workspace  | `aria-selected` on current tab |
| `Boxes`           | 3D Stage     | Switch to Stage workspace   | same                           |
| `Film`            | Video Editor | Switch to Video workspace   | same                           |
| `Bot`             | Agent workspace | Switch to Agent workspace   | same                           |

### 1.2 Global settings

| Icon                        | aria-label              | Action               | Notes                     |
| --------------------------- | ----------------------- | -------------------- | ------------------------- |
| `Sun` / `Moon`              | Switch light/dark theme | Toggle app theme     | `aria-pressed` when light |
| `Languages` + `ChevronDown` | Interface language      | zh-CN / en-US select |                           |

### 1.3 Stage-only floating controls

A cold Stage session starts with the timeline and right inspector collapsed; the scene tree stays open.

| Icon              | Label               | When visible                              | Action               |
| ----------------- | ------------------- | ----------------------------------------- | -------------------- |
| Bottom sash       | Expand bottom panel | Stage + timeline enabled + dock collapsed | Pull up or click to restore |
| Top sash          | Resize timeline height | Stage + timeline expanded              | Click to collapse; drag to resize; pull past minimum to collapse |
| Right sash        | Expand right panel  | Stage + right panel collapsed             | Pull left or click to restore |
| Right-panel left sash | Resize properties panel | Stage + right panel expanded        | Click to collapse; drag to resize; pull past minimum to collapse |
| `Minimize2`       | Exit frameless mode | Stage frameless fullscreen                | Exit frameless              |

### 1.4 Top-bar popover triggers

| Icon        | Label            | Panel                                  | Workspaces             |
| ----------- | ---------------- | -------------------------------------- | ---------------------- |
| `RefreshCw` | Interchange      | Import/export OTIO, glTF, USD, Blender | Canvas / Stage / Video |
| `Settings2` | Viewport feel    | Navigation, camera pilot, stage sound  | mainly Stage           |
| `Gauge`     | Performance tier | Quality preset                         | global                 |
| `Keyboard`  | Shortcuts        | Shortcut list                          | global                 |

---

## 2. 3D Stage — right sidebar modes

**Code**: `DirectorDeskShell.tsx`  
**Review status**: ✅ Confirmed

| Icon                | Label      | Action                    | Notes                                 |
| ------------------- | ---------- | ------------------------- | ------------------------------------- |
| `SlidersHorizontal` | Properties | Show RightPanel inspector |                                       |
| `Box`               | Modeling   | Show Blender live    | Native Blender scene                  |
| `FolderOpen`        | Assets     | Show AssetLibraryPanel    | Stage import/model library lives here |

---

## 3. Viewport toolbar

**Code**: `ViewportToolbar.tsx`  
**Review status**: ✅ Confirmed

Container: `aria-label="3D视口快捷工具"`. Buttons are **icon-only**; labels appear on
hover/focus via `.viewport-toolbar-label`.

> **Stage mode**: **Import panorama**, **Import local model**, and **Model library** move to the
> right **Assets** panel (`assetActionsInSidebar=true`).

See the [Chinese page](/zh/editor/ui-icons/) for the full per-icon table (sections 3.1–3.5).

Key controls:

| Icon                              | Label                  | Action                                                               |
| --------------------------------- | ---------------------- | -------------------------------------------------------------------- |
| `LassoSelect`                     | Lasso select           | Toggle lasso multi-select                                            |
| `Move3D` / `Rotate3D` / `Scale3D` | Move / Rotate / Scale  | Transform modes                                                      |
| `Hand` / `MousePointer2`          | Hand / Cursor navigate | Navigation modes                                                     |
| `Footprints`                      | Character roam         | Toggle player mode                                                   |
| `Crosshair`                       | Camera pilot           | Toggle camera pilot                                                  |
| `Tag`                             | Viewport labels        | Toggle `showLabels` (characters, cameras, annotations, measurements) |
| `LayoutGrid`                      | Quad view              | Toggle quad viewport layout                                          |
| `Camera` / `Grid2X2` / `Grid3X3`  | Capture presets        | 1 / 4 / 12 angle captures                                            |

---

## Improvement backlog

Remaining gaps confirmed against `frontend/director/src/comprehensive` on 2026-08-13.
Closed: Prop inspector uses 贴地放置; PlayerModeHud toggles have visible labels;
timeline toolbar icons no longer collide (play vs rehearse, tabs, export, loop).

| Priority | Area                | Issue                           | Suggestion                               |
| -------- | ------------------- | ------------------------------- | ---------------------------------------- |
| P1       | Viewport toolbar    | Icon-only by default            | First-run hint or persistent tooltips    |
| P1       | Character inspector | `Down 2 Earth` English label    | Localize to “Ground to floor” / 贴地放置 |
| P2       | Model library       | No active state when panel open | Highlight `Boxes` button                 |

---

## Related docs

- [3D Editor overview](/editor/)
- [Scenes & Assets](/editor/scenes-and-assets/)
- [Cameras](/editor/cameras/)
- [Animation & Timeline](/editor/animation/)
- [Canvas & Video Editor](/editor/canvas-video/)
- [Project Gallery](/editor/gallery/)
