# Vendor

> Languages: **English** · [中文](README.zh-CN.md)

Official third-party Git submodules. Director does not fork these trees.
Gateway jobs spawn their Python CLIs when needed. Weights stay outside Git.

| Path | Upstream | Lock | Setup |
| --- | --- | --- | --- |
| `deepseek-harness/` | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | submodule gitlink | `npm run dsh` initializes it |
| `ltx-2/` | [Lightricks/LTX-2](https://github.com/Lightricks/LTX-2) | `ltx-2.lock.json` | `DIRECTOR_ACCEPT_LTX2_LICENSE=1 npm run setup:ltx2` |
| `hunyuan3d/` | [Tencent-Hunyuan/Hunyuan3D-2](https://github.com/Tencent-Hunyuan/Hunyuan3D-2) | `hunyuan3d.lock.json` | `DIRECTOR_ACCEPT_HUNYUAN3D_LICENSE=1 npm run setup:hunyuan3d` |
| `trellis/` | [microsoft/TRELLIS](https://github.com/microsoft/TRELLIS) | `trellis.lock.json` | `npm run setup:trellis` |
| `ardy/` | [nv-tlabs/ardy](https://github.com/nv-tlabs/ardy) | `ardy.lock.json` | `npm run setup:ardy` |

The Gateway spawns `tools/scripts/ltx23-generate.py` against `vendor/ltx-2` when LTX-2.3
weights are configured. There is no resident FastAPI worker.
