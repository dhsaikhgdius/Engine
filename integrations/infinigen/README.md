# Director × Infinigen Integration

> Languages: **English** · [中文](README.zh-CN.md)

Use [Infinigen](https://infinigen.org) (princeton-vl/infinigen, BSD-3-Clause) as a
**local procedural provider** in Director's "Generate 3D" pipeline. Same rank as
remote API providers (Meshy, Tripo): submit from the generation dialog → job
queued → normalized to metre-scale Y-up GLB → enters the asset library, ready
to place on stage.

## File-level inventory

| Path | Purpose |
| --- | --- |
| `README.md` | This file: install, configuration, usage, and known limitations. |
| `director_infinigen_runner.py` | Single-asset runner (447 lines): launched by gateway's `InfinigenGenerated3DProvider`, atomically writes `status.json` (progress snapshot), `model.glb` (baked Y-up metre-scale GLB), `thumbnail.png` (EEVEE render), `runner.log`. No network, no Director imports. |
| `factory_catalog.json` | Factory catalog (66 lines): 4 `kind=environment` built-in terrain presets (SurroundingMountains, MountainValley, RollingHills, DesertDunes) + 30+ `kind=asset` Infinigen factories (nature: cactus, coral, fish, bird, fruit, flower, leaf, etc.; indoor: chair, sofa, bed, table, shelf, etc.), with CN/EN keyword matching. |

> The Infinigen provider code lives inside the gateway (`backend/gateway/`), not in
> `integrations/infinigen/`. This directory contains the runner script, factory
> catalog, and integration documentation. The provider is exposed through the
> gateway's Generate 3D API endpoints.

## How It Works

```
Generated3DDialog ──POST /api/…──▶ Generated3DExecutor
                                        │ submit
                                        ▼
                        InfinigenGenerated3DProvider（网关内 / in gateway）
                                        │ spawn（分离子进程 / detached child process）
                                        ▼
                   director_infinigen_runner.py（infinigen 环境的 Python / Python in infinigen env）
                     工厂生成 → 烘焙材质 → model.glb + thumbnail.png
                      Factory generate → bake materials → model.glb + thumbnail.png
                                        │ status.json（原子快照 / atomic snapshot）
                                        ▼
                     provider 轮询 → 执行器读取 file:// 产物 → 归一化入库
                      provider polls → executor reads file:// artifacts → normalize & ingest
```

- **Prompt to factory**: `factory_catalog.json` maintains a curated list of factories verified by upstream
  smoke tests to generate within 120 seconds (nature + indoor), matched by exact id
  or CN/EN keywords (e.g. "a comfortable chair" → `ChairFactory`).
- **Determinism**: The job `seed` is passed directly to the factory; same params + same seed =
  consistent output.
- **Cancellation**: `cancellation: local-only`, Gateway sends SIGTERM to the runner process and records final state.

## Environment Terrain Presets

Beyond Infinigen single-asset factories, the catalog includes four built-in
**environment terrain presets** generated directly by the same runner using
bpy + numpy (deterministic fBm/ridge noise heightfields + elevation/slope
vertex colors), **without** Infinigen's `[terrain]` compilation, producing
results in seconds:

| Preset | Keywords | Morphology |
| --- | --- | --- |
| `SurroundingMountains` | mountain ring | Ring of mountains around a central flat stage area (snow-capped peaks) |
| `MountainValley` | valley | Valley between two ridges |
| `RollingHills` | rolling hills | Gently rolling grassy slopes |
| `DesertDunes` | dunes | Anisotropic dune striations |

Usage tip: set **target height to 40–100 m** for environment assets in the dialog
(default 1 m shrinks an entire mountain to a desktop model). At 60 m,
"Surrounding Mountains" normalizes to ~450 m square with a ~150 m flat central
stage area, ready to place as a set environment.

If you only want environment presets and don't need Infinigen asset factories yet,
a full Infinigen install is not required:

```bash
python3.11 -m venv ~/.venvs/director-bpy && ~/.venvs/director-bpy/bin/pip install bpy numpy
export DIRECTOR_INFINIGEN_PYTHON="$HOME/.venvs/director-bpy/bin/python"
```

For Infinigen's native full natural scenes (real terrain erosion, vegetation
scattering, procedural materials), you need `pip install -e .[terrain]` and
must accept hour-scale generation times; full scenes only support USDC export —
that path is better suited to the Blender bridge / `.blend` review import than
the asset generation queue.

## Install (One-Time)

Infinigen requires a separate Python 3.11 environment (includes `bpy`, large
footprint), fully isolated from Director's Node processes:

```bash
conda create -n infinigen python=3.11 -y
conda activate infinigen
git clone https://github.com/princeton-vl/infinigen.git
cd infinigen
# 单资产/室内资产用最小安装即可；需要自然地形再装 [terrain]
# Minimal install is sufficient for single/indoor assets; add [terrain] for nature scenes
INFINIGEN_MINIMAL_INSTALL=True pip install -e .
```

Verify environment (printing the class name is enough):

```bash
python -c "from infinigen.assets.objects.seating.chairs import ChairFactory; print(ChairFactory)"
```

## Configure Director

| Env var | Description | Default |
| --- | --- | --- |
| `DIRECTOR_INFINIGEN_PYTHON` | Path to Python in infinigen env (required; provider shows unconfigured if unset) | — |
| `DIRECTOR_INFINIGEN_WORKDIR` | Job working directory | `data/infinigen-jobs` |
| `DIRECTOR_INFINIGEN_TEXTURE_RES` | Bake texture resolution | `1024` |
| `DIRECTOR_3D_PROVIDER` | Default provider, can be set to `infinigen` | meshy/tripo |

```bash
export DIRECTOR_INFINIGEN_PYTHON="$HOME/miniconda3/envs/infinigen/bin/python"
```

After configuring, restart the gateway; "Infinigen (Local Procedural)" will
automatically appear in the Generate 3D dialog's provider list.

## Manual Smoke Test (Bypassing Gateway)

```bash
"$DIRECTOR_INFINIGEN_PYTHON" integrations/infinigen/director_infinigen_runner.py \
  --factory ChairFactory --module infinigen.assets.objects.seating.chairs \
  --seed 7 --name "测试椅子" --texture-res 512 --output /tmp/infinigen-smoke
cat /tmp/infinigen-smoke/status.json
```

On success, the directory should contain `model.glb` and `thumbnail.png`.

## Known Limitations

- Material baking uses Infinigen's official bake pipeline (FBX intermediate then
  GLB); if the bake chain is unavailable, the runner degrades to direct export
  and notes possible missing textures in `status.json.warnings`.
- This integration targets **single-asset** generation (minutes). Full scene
  generation (`generate_nature` / `generate_indoors`, hour-scale, full scene
  only supports USDC export) is better suited to the Blender bridge / `.blend`
  review import path, not the asset generation queue.
- Creatures (fish, birds, etc.) export as static meshes; skeletal rigging is
  outside this pipeline's scope.
