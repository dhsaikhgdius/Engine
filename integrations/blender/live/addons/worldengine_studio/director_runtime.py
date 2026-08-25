# SPDX-FileCopyrightText: 2026 OpenEnvision Authors
#
# SPDX-License-Identifier: GPL-2.0-or-later

"""Lifecycle for the Director services bundled with Blender."""

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
    if process.stdout is None:
        return
    for line in process.stdout:
        _log.append(line.rstrip())


def is_running() -> bool:
    return _process is not None and _process.poll() is None


def application_directory() -> Path | None:
    return _application_dir


def recent_log() -> tuple[str, ...]:
    return tuple(_log)


def start(
    *,
    ui_port: int = 5175,
    gateway_port: int = 8787,
    session_port: int = 8791,
) -> Path:
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
