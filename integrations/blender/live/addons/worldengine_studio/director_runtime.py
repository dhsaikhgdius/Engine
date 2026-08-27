# SPDX-FileCopyrightText: 2026 OpenEnvision Authors
#
# SPDX-License-Identifier: GPL-2.0-or-later

"""Lifecycle for the Director services bundled with Blender.

Runs ``npm run dev`` (gateway + UI) as a child of the Blender process so the
"Start Blender Studio" button can bring up the whole product. The child is
started in its own process group / session: npm spawns a tree (vite, tsx,
esbuild…) and stopping must signal the group, not just npm, or orphaned dev
servers would keep the ports busy. A ring buffer of recent output lines is
kept for the status panel instead of streaming to Blender's console.
"""

from __future__ import annotations

import os
import shutil
import signal
import subprocess
import threading
from collections import deque
from pathlib import Path


_process: subprocess.Popen[str] | None = None
_reader_thread: threading.Thread | None = None
_log: deque[str] = deque(maxlen=160)
_application_dir: Path | None = None


def resolve_application_directory() -> Path:
    """Locate the WorldEngine repository root.

    WORLDENGINE_APP_DIR wins when set (installed addons live outside the
    repo); otherwise walk up from this file looking for the repo's signature
    layout. Also used by mixamo_actions to find the packaged motion catalog,
    so it must work even when the dev services never start.
    """
    configured = os.environ.get("WORLDENGINE_APP_DIR")
    if configured:
        application = Path(configured).expanduser().resolve()
        if not (application / "package.json").is_file():
            raise RuntimeError(f"WorldEngine application is missing at {application}")
        return application

    # Discover the WorldEngine product root above this addon.
    for candidate in Path(__file__).resolve().parents:
        if (
            (candidate / "package.json").is_file()
            and (candidate / "frontend" / "director").is_dir()
            and (candidate / "backend" / "gateway").is_dir()
        ):
            return candidate
    raise RuntimeError("WorldEngine root could not be found above the WorldEngine Studio addon")


def _read_output(process: subprocess.Popen[str]) -> None:
    """Daemon-thread reader draining child stdout into the status ring buffer."""
    if process.stdout is None:
        return
    for line in process.stdout:
        _log.append(line.rstrip())


def is_running() -> bool:
    """True while the dev-service child process is alive."""
    return _process is not None and _process.poll() is None


def application_directory() -> Path | None:
    """Repository root of the running services, or None when stopped."""
    return _application_dir


def recent_log() -> tuple[str, ...]:
    """Immutable snapshot of the most recent dev-service output lines."""
    return tuple(_log)


def start(
    *,
    ui_port: int = 5175,
    gateway_port: int = 8787,
    session_port: int = 8791,
) -> Path:
    """Launch ``npm run dev`` in its own process group and return the repo root.

    Idempotent while running. Port choices flow through environment
    variables so the gateway and UI bind where the addon expects them, and
    DIRECTOR_BLENDER_URL points the gateway back at this Blender's session.
    """
    global _process, _application_dir, _reader_thread
    if is_running():
        return _application_dir or resolve_application_directory()

    application = resolve_application_directory()
    npm = shutil.which("npm")
    if npm is None:
        raise RuntimeError("Node.js/npm is required to run the Director workspace.")

    environment = os.environ.copy()
    environment.update(
        {
            "DIRECTOR_UI_PORT": str(int(ui_port)),
            "STAGE_GATEWAY_PORT": str(int(gateway_port)),
            "DIRECTOR_BLENDER_URL": f"http://127.0.0.1:{int(session_port)}",
        }
    )
    popen_options: dict[str, object] = {}
    if os.name == "nt":
        popen_options["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        popen_options["start_new_session"] = True

    _log.clear()
    _process = subprocess.Popen(
        [npm, "run", "dev"],
        cwd=application,
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        **popen_options,
    )
    _application_dir = application
    _reader_thread = threading.Thread(target=_read_output, args=(_process,), name="WorldEngineDirector", daemon=True)
    _reader_thread.start()
    return application


def stop() -> None:
    """Terminate the dev-service tree: polite group signal first, hard kill
    after a 5 s grace period. Safe to call when nothing is running."""
    global _process, _application_dir, _reader_thread
    process = _process
    _process = None
    _application_dir = None
    _reader_thread = None
    if process is None or process.poll() is not None:
        return
    if os.name == "nt":
        process.send_signal(signal.CTRL_BREAK_EVENT)
    else:
        os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=5.0)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=2.0)


__all__ = (
    "application_directory",
    "is_running",
    "recent_log",
    "resolve_application_directory",
    "start",
    "stop",
)
