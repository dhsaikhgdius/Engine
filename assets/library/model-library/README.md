# Built-in model library

This folder contains six small, original low-poly props bundled with ComfyUI
3D Director. They replace an untracked external model-library path that could
leave the production panel empty after a clean install.

| Category | File                  | Display name |
| -------- | --------------------- | ------------ |
| 便利生活 | `ATM_low.fbx`         | 自动取款机   |
| 户外出行 | `backpack_low.fbx`    | 背包         |
| 户外出行 | `thermus_low.fbx`     | 保温瓶       |
| 户外出行 | `deer_skull_low.fbx`  | 鹿头骨       |
| 工具配件 | `wrench_low.fbx`      | 扳手         |
| 工具配件 | `drill_press_low.fbx` | 台钻         |

Every FBX is procedurally composed from Blender primitives. Every SVG thumbnail
is generated from local vector markup. No mesh, texture, thumbnail, or weight
was downloaded or copied from a third party. The assets use the adjacent MIT
`LICENSE`. The generator fixes FBX creation metadata and derives FBX object IDs
from SHA-256, so the same Blender version produces byte-identical files even
when Python uses a different randomized hash seed.

Regenerate with the same Blender major version used for the release:

```bash
blender --background --factory-startup \
  --python frontend/director/src/comprehensive/editor/modelLibrary/scripts/generate_builtin_models.py
```

Verify the locally packaged artifacts without rewriting them:

```bash
blender --background --factory-startup \
  --python frontend/director/src/comprehensive/editor/modelLibrary/scripts/generate_builtin_models.py -- --check
```

`SHA256SUMS` covers all generated FBX and SVG files. The generation script,
README, license, and checksum manifest are intentionally excluded from their
own checksum set.
