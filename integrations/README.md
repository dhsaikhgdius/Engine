# Integrations

> Languages: **English** · [中文](README.zh-CN.md)

External connectors that sit beside Director's frontend and Gateway. They are
not a separate product.

The Blender DCC catalog keeps `connectorDirectory: "integrations/blender"`.
That path is the Blender integration **root**, not the directory where every
Python file lives.

## Connector directories

| Path | Purpose |
| --- | --- |
| `blender/live/` | Headless live modeling kernel. `BLENDER_USER_SCRIPTS` points here so Blender loads `addons/worldengine_studio/`. Start with `npm run blender`. |
| `blender/interchange/` | Trusted `.blend` import and Director scene round-trip (`director_bridge.py`, `director_scene_export.py`, `director_return_export.py`). |
| `unreal/` | Director-authored `DirectorBridge` Unreal Editor plugin (Python) with fixed headless import/export entry points. Configure `DIRECTOR_UNREAL_EDITOR_BIN` + `DIRECTOR_UNREAL_PROJECT`. See `unreal/README.md`. |
| `unity/` | Director-authored `com.director.bridge` UPM Editor package (C#) with `-batchmode -executeMethod` entry points. Configure `DIRECTOR_UNITY_BIN` + `DIRECTOR_UNITY_PROJECT`. See `unity/README.md`. |
| `godot/` | Director-authored `director_bridge` Godot 4 editor addon (GDScript) with a fixed `--headless` entry point. Configure `DIRECTOR_GODOT_BIN` + `DIRECTOR_GODOT_PROJECT`. See `godot/README.md`. |
| `plugins/director-workbench/` | Portable Agent/MCP plugin built from the same workbench contracts. Do **not** hand-edit generated `mcp/server.mjs`. |
| `dcc-providers.example.json` | Template for the declarative exchange-only DCC provider catalog. Copy it beside itself (e.g. `integrations/dcc-providers.json`) and point `DIRECTOR_DCC_PROVIDER_CONFIG` at the copy. |

Each engine connector directory carries a `connector.json` manifest
(`director-dcc-connector-v1`) that pins the fixed health/import/export entry
points the Gateway may invoke. Engine handoff is available through
`director_dcc` (`send_to_engine`, `receive_from_engine`, `apply_import_plan`)
only when the connector health check passes (`nativeReady`); detecting an
executable alone is never enough. No engine source, SDK, or binary is vendored.

## External AI bridges

| Path | Purpose |
| --- | --- |
| `ardy/` | NVIDIA ARDY text→full-body skeletal motion bridge. Official source is the Git submodule `vendor/ardy`. The gateway invokes upstream `scripts/generate.py`, then retargets generated `.npz` to Mixamo skeleton for preview. |
| `infinigen/` | Infinigen local procedural 3D asset generation provider. Same rank as remote API providers (Meshy/Tripo): factory → bake → GLB → asset library. Includes four built-in environment terrain presets. |

## Per-directory file-level overview

### `blender/live/`

| Path | Purpose |
| --- | --- |
| `worldengine_backend.py` | Headless Blender backend entry: configures project, starts loopback HTTP session, runs event loop. |
| `addons/worldengine_studio/` | Blender 4.2+ addon (WorldEngine Studio v0.1.0) with 17 modules + test suite. See `blender/live/README.md`. |

### `blender/interchange/`

| Path | Purpose |
| --- | --- |
| `director_bridge.py` | Import a validated Director DCC scene package into Blender, stamping `director_id` and signature properties. |
| `director_scene_export.py` | Extract an open `.blend` scene into a metre-scale Y-up GLB, camera optics, manifest, and hash receipts. |
| `director_return_export.py` | Export a manifest-first return package from a refined `.blend`; only objects with `director_id` are exported. |
| `director_signature.py` | Shared mesh-content fingerprint (SHA-256) used by both bridge and return-export for byte-identical digests. |
| `director_scene_export.test.ts` | vitest tests for the scene export script. |
| `director_return_export.test.ts` | vitest tests for the return export script. |

### `unreal/`

| Path | Purpose |
| --- | --- |
| `connector.json` | Fixed connector manifest (`director-dcc-connector-v1`) naming the health/import/export entry points. |
| `plugins/DirectorBridge/DirectorBridge.uplugin` | Editor plugin descriptor (PythonScriptPlugin, EditorScriptingUtilities, LevelSequenceEditor). |
| `plugins/DirectorBridge/Content/Python/director_space.py` | Pure-Python Director ↔ Unreal coordinate conversion with self-test cases. |
| `plugins/DirectorBridge/Content/Python/director_package.py` | Exchange-package reader and return-package/report writer with SHA-256 receipts. |
| `plugins/DirectorBridge/Content/Python/director_headless.py` | Fixed headless entry: health, import (actors + CineCameras + Sequencer camera cuts), export (tagged-actor return diff). |
| `plugins/DirectorBridge/Content/Python/init_unreal.py` | Editor menu hook for an in-editor health check. |

### `unity/`

| Path | Purpose |
| --- | --- |
| `connector.json` | Fixed connector manifest naming the `Director.Bridge.Editor.DirectorBridgeCli` batch methods. |
| `com.director.bridge/package.json` | UPM package manifest (depends on Timeline and Newtonsoft JSON). |
| `com.director.bridge/Runtime/DirectorId.cs` | Component that persists the Director stable ID on every handed-off object. |
| `com.director.bridge/Editor/DirectorSpace.cs` | Director ↔ Unity coordinate conversion (left-handed Y-up). |
| `com.director.bridge/Editor/DirectorExchange.cs` | Exchange-package reader and return-package/report writer. |
| `com.director.bridge/Editor/DirectorBridgeCli.cs` | Fixed batch entry: health, import (scene + Timeline), export (DirectorId return diff). |

### `godot/`

| Path | Purpose |
| --- | --- |
| `connector.json` | Fixed connector manifest naming the headless GDScript entry point. |
| `addons/director_bridge/plugin.cfg` | Godot 4 editor addon descriptor. |
| `addons/director_bridge/director_space.gd` | Director ↔ Godot conversion (identity basis; kept for parity and world composition). |
| `addons/director_bridge/director_package.gd` | Exchange-package reader and return-package/report writer. |
| `addons/director_bridge/director_headless.gd` | Fixed headless entry: health, import (Node3D scene + GLB instancing + metadata), export (tagged-node return diff). |
| `addons/director_bridge/director_bridge.gd` | Editor plugin script with an in-editor health check. |

### `plugins/director-workbench/`

| Path | Purpose |
| --- | --- |
| `.codex-plugin/plugin.json` | Codex CLI plugin manifest: name, version, capability declarations, default prompts. |
| `.mcp.json` | MCP server config: launches the `director-workbench` server, connects to `STAGE_GATEWAY_URL`. |
| `mcp/server.mjs` | **Generated** build artifact: single-file bundled MCP server. Do not hand-edit. |
| `skills/director-workbench/SKILL.md` | Main skill instructions: working loop, 3D Stage, Canvas, Video Editor operation rules. |
| `skills/director-workbench/agents/openai.yaml` | OpenAI Agent config: tool dependencies, implicit invocation policy. |
| `skills/director-workbench/references/operations.md` | Operation examples reference: shortest usable requests for observe, describe, catalog, author, capture, audit, etc. |

### `ardy/`

| Path | Purpose |
| --- | --- |
| `README.md` | Install, configure, usage: ARDY checkout, gateway env vars, HTTP API endpoints. |

### `infinigen/`

| Path | Purpose |
| --- | --- |
| `README.md` | Install, configure, usage: Infinigen environment, gateway env vars, manual smoke test. |
| `director_infinigen_runner.py` | Single-asset runner: launched by gateway, atomically writes `status.json`/`model.glb`/`thumbnail.png`. |
| `factory_catalog.json` | Factory catalog: 4 environment presets + 30+ Infinigen nature/indoor factories with CN/EN keywords. |

## Run

```bash
npm run blender          # Start headless Blender live modeling kernel
npm run build:mcp-plugin      # Build portable MCP plugin
npm run sync:skills           # Sync skills from canonical source to agent directories
npm run validate:agent-plugin # Validate agent plugin integration
```

Install Blender 4.2+ (or set `BLENDER_BIN`) for the live kernel. Director
does not vendor Blender's C source.