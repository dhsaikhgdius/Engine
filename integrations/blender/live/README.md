# WorldEngine Studio — Headless Live Modeling Kernel

> Languages: **English** · [中文](README.zh-CN.md)

`integrations/blender/live/` is Director's headless Blender live modeling kernel.
`BLENDER_USER_SCRIPTS` points here so Blender auto-discovers and loads
`addons/worldengine_studio/`.

## File-level inventory

### Backend entry

| Path | Purpose |
| --- | --- |
| `worldengine_backend.py` | Headless backend entry: loads addon, opens/creates project `.blend`, configures metric 24fps 1080p, starts loopback HTTP session on `127.0.0.1:8791`, runs event loop until SIGTERM. |

### `addons/worldengine_studio/` — Blender 4.2+ Addon (v0.1.0, GPL-2.0)

Addon registration: `bl_info.name = "WorldEngine Studio"`, located at 3D View > Sidebar > WorldEngine.
Two registration modes: `register()` (full UI) and `register_backend()` (headless, properties + session only).

| Path | Purpose |
| --- | --- |
| `__init__.py` | Addon registration entry: `register()`/`unregister()` (full) and `register_backend()`/`unregister_backend()` (headless). Handles module reload. |
| `live_protocol.py` | Lightweight wire-format parser (`worldengine-blender-live-v1` contract): validates JSON requests, parses batch operations, supports 40+ operation types (import asset, create primitive/curve/text, transform update, camera/light/opening, blockout, collection, constraint, modeling kernel, etc.). |
| `native_session.py` | Loopback HTTP session server: `ThreadingHTTPServer` on `127.0.0.1`, handles session requests, HMAC auth, job queue, detached large payload store (GLB/PNG), pre/post-save snapshot comparison. |
| `modeling.py` | Agent-facing native modeling kernel: typed ops, Blender operator/RNA long tail, and `execute_code` (Python in the live scene). |
| `kernel_policy.py` | Kernel policy: a small operator denylist (quit Blender and a few UI categories). |
| `blockout.py` | Blockout/rough massing: fast creation of architectural volumes, openings, floors, etc. |
| `asset_import.py` | Import Director model assets (GLB/USD) into the Blender scene. |
| `asset_libraries.py` | Poly Haven / Sketchfab search and import (HTTPS, zip-slip checks). |
| `asset_library_http.py` | Stdlib HTTPS/JSON/zip helpers for asset libraries (no bpy). |
| `coordinates.py` | Coordinate system conversion between Blender and Director. |
| `director_project.py` | Project file management: open, create, save `.blend` project files. |
| `director_runtime.py` | Runtime management: start/stop addon runtime state. |
| `material_nodes.py` | Materials and nodes: PBR material creation, node graph operations. |
| `mixamo_actions.py` | Mixamo action handling: load, apply Mixamo skeletal actions. |
| `modifier_stack.py` | Modifier stack: manage Blender modifiers (mirror, array, bevel, etc.). |
| `operators.py` | Blender operators: operator definitions for UI and background operations. |
| `preferences.py` | Addon preferences panel. |
| `properties.py` | Custom properties: `director_id` and other scene/object custom property definitions. |
| `rig.py` | Rig/skeleton: armature creation and manipulation. |
| `semantic_geometry.py` | Semantic geometry: geometry operations with semantic labels. |
| `spatial_query.py` | Spatial query: scene spatial relationship queries. |
| `tests/` | Test suite: 7 test files covering gateway smoke, geometry, modeling, camera, coordinates, protocol. |

### Test files

| Path | Purpose |
| --- | --- |
| `tests/__init__.py` | Test package init. |
| `tests/blender_smoke.py` | Basic smoke test. |
| `tests/blender_gateway_smoke.py` | Gateway connectivity smoke test. |
| `tests/blender_geometry_smoke.py` | Geometry operation smoke test. |
| `tests/blender_modeling_smoke.py` | Modeling operation smoke test. |
| `tests/blender_camera_snapshot_smoke.py` | Camera snapshot smoke test. |
| `tests/test_coordinates.py` | Coordinate conversion unit tests. |
| `tests/test_live_protocol.py` | Live protocol unit tests. |
| `tests/test_asset_library_http.py` | Poly Haven/Sketchfab HTTP helper unit tests (no Blender). |

## Run

```bash
npm run blender
```

The launcher sets `BLENDER_USER_SCRIPTS` to `integrations/blender/live` so
Blender finds `addons/worldengine_studio/`. The backend entry is
`worldengine_backend.py`.

## Auth

The loopback session is unauthenticated by default. To require bearer auth,
export `DIRECTOR_BLENDER_TOKEN` (Blender inherits shell env;
`WORLDENGINE_SESSION_TOKEN` overrides it for Blender only).
Sketchfab import also needs `SKETCHFAB_API_TOKEN` (or the Studio preference).