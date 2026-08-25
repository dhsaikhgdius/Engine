#!/usr/bin/env sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

export BLENDER_BIN="${BLENDER_BIN:-/usr/bin/blender}"
export DIRECTOR_BLENDER_BIN="${DIRECTOR_BLENDER_BIN:-$BLENDER_BIN}"
export DIRECTOR_FFMPEG_PATH="${DIRECTOR_FFMPEG_PATH:-$(command -v ffmpeg || true)}"
export DIRECTOR_FFPROBE_PATH="${DIRECTOR_FFPROBE_PATH:-$(command -v ffprobe || true)}"
export STAGE_GATEWAY_URL="${STAGE_GATEWAY_URL:-http://127.0.0.1:8787}"

echo "[director-install] workspace: $ROOT"

# Node dependencies (root + docs site)
npm ci
npm --prefix docs/site ci

# The agent harness (npm run dsh, evals overlay) needs vendor/deepseek-harness.
# repo:check does not read vendor checkouts. The inference sources (LTX-2,
# Hunyuan3D-2, TRELLIS, ARDY) are only needed for local model work; opt in with
# DIRECTOR_INSTALL_INFERENCE_VENDORS=1 instead of paying the clone cost on every boot.
git submodule update --init --depth 1 vendor/deepseek-harness
if [ "${DIRECTOR_INSTALL_INFERENCE_VENDORS:-0}" = "1" ]; then
  git submodule update --init --depth 1 \
    vendor/ltx-2 \
    vendor/hunyuan3d \
    vendor/trellis \
    vendor/ardy
fi

# Runtime directories
mkdir -p data/blender .runtime

# Repository boundary checks. Do not regenerate committed artifacts here
# (sync:skills / build:mcp-plugin rewrite tracked files and would leave the
# workspace dirty at boot); regenerating them belongs to the dev loop.
npm run repo:check

echo "[director-install] Blender: $($BLENDER_BIN --version 2>/dev/null | head -1 || echo 'not found')"
echo "[director-install] Node: $(node -v)"
echo "[director-install] npm: $(npm -v)"
echo "[director-install] ffmpeg: ${DIRECTOR_FFMPEG_PATH:-missing}"
echo "[director-install] done"
