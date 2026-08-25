#!/usr/bin/env bash
# Installs headless-capable DCC runtimes for the Director cloud environment so
# `director_dcc` status/discover can probe them for real.
#
# - Blender  -> /opt/director-dcc/blender-<version>-linux-x64 (+ PATH symlink)
# - Unity    -> /opt/director-dcc/unity-<version>/Editor/Unity (+ PATH symlinks);
#               the provider registry also scans /opt/director-dcc/*/Editor/Unity.
# - Unreal   -> cannot be fetched anonymously: Epic requires an Epic Games
#               account (EULA) for both binary and source distribution. Install
#               it manually and set DIRECTOR_UNREAL_EDITOR_BIN, or import
#               director-engine-scene-v1 .zip packages exported inside the
#               editor instead.
#
# Best-effort and idempotent: every step is skipped when the runtime is already
# present, and failures never break the environment install.

set -u

DCC_ROOT="${DIRECTOR_DCC_ROOT:-/opt/director-dcc}"

BLENDER_VERSION="4.5.12"
BLENDER_SERIES="4.5"
BLENDER_URL="https://download.blender.org/release/Blender${BLENDER_SERIES}/blender-${BLENDER_VERSION}-linux-x64.tar.xz"
BLENDER_HOME="${DCC_ROOT}/blender-${BLENDER_VERSION}-linux-x64"

UNITY_VERSION="6000.0.82f1"
UNITY_CHANGESET="2fb0dae735e1"
UNITY_URL="https://download.unity3d.com/download_unity/${UNITY_CHANGESET}/LinuxEditorInstaller/Unity-${UNITY_VERSION}.tar.xz"
UNITY_HOME="${DCC_ROOT}/unity-${UNITY_VERSION}"

SUDO=""
if [ "$(id -u)" != "0" ] && command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
fi

log() { echo "[install-dcc] $*"; }

ensure_root_dir() {
  if [ ! -d "${DCC_ROOT}" ]; then
    ${SUDO} mkdir -p "${DCC_ROOT}" && ${SUDO} chown "$(id -u):$(id -g)" "${DCC_ROOT}" || return 1
  fi
}

link_binary() {
  local target="$1" name="$2"
  if [ -x "${target}" ]; then
    ${SUDO} ln -sf "${target}" "/usr/local/bin/${name}" || true
  fi
}

install_blender() {
  if command -v blender >/dev/null 2>&1; then
    log "Blender already on PATH: $(command -v blender)"
    return 0
  fi
  if [ ! -x "${BLENDER_HOME}/blender" ]; then
    log "Downloading Blender ${BLENDER_VERSION} (~350 MB)"
    local archive="${DCC_ROOT}/blender.tar.xz"
    curl -fsSL --retry 3 -o "${archive}" "${BLENDER_URL}" || { log "Blender download failed; skipping"; return 0; }
    tar -xJf "${archive}" -C "${DCC_ROOT}" || { log "Blender extract failed; skipping"; rm -f "${archive}"; return 0; }
    rm -f "${archive}"
  fi
  link_binary "${BLENDER_HOME}/blender" blender
  log "Blender ready: ${BLENDER_HOME}/blender"
}

install_unity() {
  if [ -x "${UNITY_HOME}/Editor/Unity" ]; then
    log "Unity already installed: ${UNITY_HOME}/Editor/Unity"
  else
    log "Downloading Unity ${UNITY_VERSION} (~4.4 GB; skipped automatically on failure)"
    local archive="${DCC_ROOT}/unity.tar.xz"
    curl -fsSL --retry 3 -o "${archive}" "${UNITY_URL}" || { log "Unity download failed; skipping"; return 0; }
    mkdir -p "${UNITY_HOME}"
    tar -xJf "${archive}" -C "${UNITY_HOME}" || { log "Unity extract failed; skipping"; rm -rf "${UNITY_HOME}"; rm -f "${archive}"; return 0; }
    rm -f "${archive}"
  fi
  link_binary "${UNITY_HOME}/Editor/Unity" unity
  link_binary "${UNITY_HOME}/Editor/Unity" unity-editor
  log "Unity ready: ${UNITY_HOME}/Editor/Unity (headless export additionally needs an activated license)"
}

report_unreal() {
  if [ -n "${DIRECTOR_UNREAL_EDITOR_BIN:-}" ] && [ -x "${DIRECTOR_UNREAL_EDITOR_BIN}" ]; then
    log "Unreal Editor configured: ${DIRECTOR_UNREAL_EDITOR_BIN}"
    return 0
  fi
  for candidate in \
    "${DCC_ROOT}/unreal/Engine/Binaries/Linux/UnrealEditor-Cmd" \
    "/opt/UnrealEngine/Engine/Binaries/Linux/UnrealEditor-Cmd"; do
    if [ -x "${candidate}" ]; then
      log "Unreal Editor detected: ${candidate}"
      return 0
    fi
  done
  log "Unreal Engine not installed: Epic requires an Epic Games account (EULA) for binaries and source;"
  log "anonymous download is blocked. Install it manually and set DIRECTOR_UNREAL_EDITOR_BIN, or upload"
  log "director-engine-scene-v1 .zip packages exported by integrations/unreal/interchange/director_scene_export.py."
}

ensure_root_dir || { log "Cannot create ${DCC_ROOT}; skipping DCC runtime install"; exit 0; }
install_blender
install_unity
report_unreal
exit 0
