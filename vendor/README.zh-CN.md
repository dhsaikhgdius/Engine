# Vendor

> 语言：**中文** · [English](README.md)

官方第三方 Git 子模块。Director 不分叉这些树。网关在需要时 spawn 其 Python CLI。
权重不进 Git。

| 路径 | 上游 | Lock | 安装 |
| --- | --- | --- | --- |
| `deepseek-harness/` | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | submodule gitlink | `npm run dsh` 会初始化 |
| `ltx-2/` | [Lightricks/LTX-2](https://github.com/Lightricks/LTX-2) | `ltx-2.lock.json` | `DIRECTOR_ACCEPT_LTX2_LICENSE=1 npm run setup:ltx2` |
| `hunyuan3d/` | [Tencent-Hunyuan/Hunyuan3D-2](https://github.com/Tencent-Hunyuan/Hunyuan3D-2) | `hunyuan3d.lock.json` | `DIRECTOR_ACCEPT_HUNYUAN3D_LICENSE=1 npm run setup:hunyuan3d` |
| `trellis/` | [microsoft/TRELLIS](https://github.com/microsoft/TRELLIS) | `trellis.lock.json` | `npm run setup:trellis` |
| `ardy/` | [nv-tlabs/ardy](https://github.com/nv-tlabs/ardy) | `ardy.lock.json` | `npm run setup:ardy` |

配置好 LTX-2.3 权重后，网关对 `vendor/ltx-2` spawn `tools/scripts/ltx23-generate.py`。
没有常驻 FastAPI worker。
