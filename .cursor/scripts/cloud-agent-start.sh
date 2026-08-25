#!/usr/bin/env sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

export BLENDER_BIN="${BLENDER_BIN:-/usr/bin/blender}"
export DIRECTOR_BLENDER_BIN="${DIRECTOR_BLENDER_BIN:-$BLENDER_BIN}"
export DIRECTOR_FFMPEG_PATH="${DIRECTOR_FFMPEG_PATH:-$(command -v ffmpeg || true)}"
export DIRECTOR_FFPROBE_PATH="${DIRECTOR_FFPROBE_PATH:-$(command -v ffprobe || true)}"
export STAGE_GATEWAY_URL="${STAGE_GATEWAY_URL:-http://127.0.0.1:8787}"

mkdir -p data/blender .runtime

echo "[director-start] BLENDER_BIN=$BLENDER_BIN"
echo "[director-start] STAGE_GATEWAY_URL=$STAGE_GATEWAY_URL"
echo "[director-start] ready"
