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

# Vendor submodules required by repo:check and optional inference sources
git submodule update --init --depth 1 \
  vendor/deepseek-harness \
  vendor/ltx-2 \
  vendor/hunyuan3d \
  vendor/trellis \
  vendor/ardy

# Runtime directories
mkdir -p data/blender .runtime

# Agent skill copies and MCP plugin bundle
npm run sync:skills
npm run build:mcp-plugin

# Repository boundary checks
npm run repo:check

echo "[director-install] Blender: $($BLENDER_BIN --version 2>/dev/null | head -1 || echo 'not found')"
echo "[director-install] Node: $(node -v)"
echo "[director-install] npm: $(npm -v)"
echo "[director-install] ffmpeg: ${DIRECTOR_FFMPEG_PATH:-missing}"
echo "[director-install] done"
