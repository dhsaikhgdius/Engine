# ARDY Text-to-Motion Bridge

> Languages: **English** · [中文](README.zh-CN.md)

Director bridges [NVIDIA ARDY](https://github.com/nv-tlabs/ardy) (Apache-2.0, SIGGRAPH 2026)
for text→full-body skeletal motion. The bridge invokes the upstream
`scripts/generate.py` CLI directly (local or via SSH to a remote GPU host),
without reimplementing the model. The generated `.npz` (`local_rot_mats` /
`root_positions` / `posed_joints` / `fps`) is cached by the gateway and
streamed to the workbench; the frontend retargets cskel27 global rotations
to the Mixamo skeleton via positional skinning for real-time preview.

## File-level inventory

| Path | Purpose |
| --- | --- |
| `README.md` | This file: install, configuration, usage, and license information. |

> The ARDY bridge code lives inside the gateway (`backend/gateway/`), not in
> `integrations/ardy/`. This directory contains only integration documentation.
> The bridge is exposed through the gateway's motion API endpoints.

## 1. Prepare ARDY Checkout

On the machine that will run inference (local or remote GPU host), use the
pinned submodule (preferred) or an explicit checkout:

```sh
npm run setup:ardy
cd vendor/ardy
python3 -m venv .venv && source .venv/bin/activate
pip install -e .
```

Or clone a matching revision yourself and point `DIRECTOR_ARDY_REPO` at it.
The lock file is `vendor/ardy.lock.json`.

Model weights are downloaded from Hugging Face on first run by default; for
offline deployment, place the official model directory under `checkpoints/` and
export `CHECKPOINTS_DIR=~/ardy/checkpoints`.

Verify generation manually first (the exact command the gateway will run):

```sh
python scripts/generate.py "A person walks in a circle." --model core8 --duration 4 --output /tmp/probe
python - <<'PY'
import numpy as np
data = np.load("/tmp/probe.npz")
print(sorted(data.keys()), data["posed_joints"].shape)  # should contain 27 joints
PY
```

Director only supports the core model family (cskel27, 27 joints). `soma` /
`g1` produce different skeletons; the panel rejects them at decode time with a
clear error.

## 2. Configure Director Gateway

| Env var | Required | Default | Description |
| --- | --- | --- | --- |
| `DIRECTOR_ARDY_REPO` | No | local submodule when present | Absolute path to ARDY checkout (remote path in SSH mode). Defaults to `vendor/ardy` after `npm run setup:ardy`. |
| `DIRECTOR_ARDY_PYTHON` | No | `python3` | Python for running `scripts/generate.py` (prefer venv, e.g. `~/ardy/.venv/bin/python`) |
| `DIRECTOR_ARDY_SSH_HOST` | No | — | When set, generates on remote host via `ssh`/`scp` (BatchMode) and fetches npz |
| `DIRECTOR_ARDY_MODEL` | No | `core8` | Default model alias |
| `DIRECTOR_ARDY_TIMEOUT_MS` | No | `600000` | Hard timeout per generation (30s–1h) |

Local GPU example:

```sh
DIRECTOR_ARDY_PYTHON=$PWD/vendor/ardy/.venv/bin/python \
npm run gateway
```

Remote GPU host example (passwordless SSH required; gateway uses `BatchMode=yes`,
never prompts for password):

```sh
DIRECTOR_ARDY_REPO=/home/gpu/ardy \
DIRECTOR_ARDY_PYTHON=/home/gpu/ardy/.venv/bin/python \
DIRECTOR_ARDY_SSH_HOST=gpu@ardy-box \
npm run gateway
```

## 3. Usage

1. Select a Mixamo-skeleton character in the workbench (imported Mixamo GLB or
   built-in hero asset).
2. In the right sidebar, under "Character → Motion", use the "AI Generate Motion"
   area to enter a motion description, select duration, and click generate.
3. GPU logs stream line-by-line to the panel during generation; the motion
   auto-previews in the viewport on completion, and can be stopped or replayed
   at any time.

Corresponding HTTP endpoints (all require gateway local client credentials):

- `GET /api/motion/ardy/status` — Bridge configuration status
- `POST /api/motion/ardy/generate` — NDJSON stream (`status` → `done`/`error`)
- `GET /api/motion/ardy/motions/:jobId` — Retrieve generated npz (whitelist: only entries generated and verified by this process)

## License

NVIDIA ARDY and its cskel27 skeleton definition (joint order, parent-child
relationships, neutral pose) are released under Apache-2.0. The bridge, decode,
and retargeting code on the Director side is this repository's own
implementation. The reference implementation [CozyClay](https://github.com/HaD0Yun/CozyClay)
(GPL-3.0) was consulted only for integration design research; this repository
contains no copied code from it.