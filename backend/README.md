# WorldEngine backend

> Languages: **English** · [中文](README.zh-CN.md)

WorldEngine is the repository-root platform. Its TypeScript control plane lives in
`gateway/`: Agents, projects, media, generation jobs, collaboration, and the HTTP/MCP
surface. Official model sources (LTX-2, Hunyuan3D-2, TRELLIS, ARDY) are Git submodules
under `vendor/`; the Gateway spawns their Python CLIs when a job needs them.

Director's modeling kernel is the `worldengine_studio` addon at
`integrations/blender/live/addons/worldengine_studio/`. File interchange
scripts live at `integrations/blender/interchange/`. The addon is not a
submodule. Director lives at `../frontend/director/`; its UI and Agent harness
talk to a headless Blender 4.2+ process through a typed local protocol.

Run the integrated product from the WorldEngine root:

```bash
npm run blender
```

The command launches Blender in the background (`BLENDER_BIN` or a local
install) with the WorldEngine Studio addon.

```bash
npm run blender:test
```
