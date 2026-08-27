# SPDX-FileCopyrightText: 2026 OpenEnvision Authors
#
# SPDX-License-Identifier: GPL-2.0-or-later

"""Start Blender as the headless Director modeling backend.

The browser Director is the user-facing application. Blender stays alive in
the background and exposes the native scene, modeling operators, undo stack,
scene inspection, and preview export over the loopback session protocol.

Run with ``blender --background --python worldengine_backend.py``. In this
mode there is no window manager and no timer loop, so instead of the addon's
UI-driven timers the main loop below blocks on the native session's pending
queue: drain commands, wait for more, flush the debounced store save between
batches. SIGTERM sets a flag and wakes the waiter so shutdown is prompt but
still runs the unregister path.
"""

from __future__ import annotations

import os
import signal
import sys
from pathlib import Path

import bpy


# The addon package is imported straight from the repo tree (not installed
# into Blender's addon directory), so its parent must be importable first.
ADDONS = Path(__file__).resolve().parent / "addons"
if str(ADDONS) not in sys.path:
    sys.path.insert(0, str(ADDONS))

import worldengine_studio  # noqa: E402
from worldengine_studio import director_project, native_session  # noqa: E402


_shutdown_requested = False


def _request_shutdown(_signum, _frame) -> None:
    global _shutdown_requested
    _shutdown_requested = True
    native_session.wake_pending_waiter()


def configure_backend() -> None:
    project_file = Path(
        os.environ.get(
            "DIRECTOR_BLENDER_PROJECT_FILE",
            str(Path.cwd() / "data" / "blender" / "director-native.blend"),
        )
    )
    director_project.open_store(project_file)
    worldengine_studio.register_backend()

    scene = bpy.context.scene
    scene.unit_settings.system = 'METRIC'
    scene.unit_settings.length_unit = 'METERS'
    scene.unit_settings.scale_length = 1.0
    scene.render.fps = 24
    scene.render.resolution_x = 1920
    scene.render.resolution_y = 1080
    scene.render.resolution_percentage = 50

    session_port = int(os.environ.get("WORLDENGINE_SESSION_PORT", "8791"))
    native_session.start(session_port, use_timer=False)
    print(f"WorldEngine backend listening on 127.0.0.1:{session_port}", flush=True)


def main() -> None:
    global _shutdown_requested
    _shutdown_requested = False
    configure_backend()
    previous_sigterm = signal.signal(signal.SIGTERM, _request_shutdown)
    try:
        while native_session.is_running() and not _shutdown_requested:
            if native_session.drain_pending() == 0:
                native_session.wait_for_pending()
            native_session.flush_pending_save()
    except KeyboardInterrupt:
        pass
    finally:
        signal.signal(signal.SIGTERM, previous_sigterm)
        worldengine_studio.unregister_backend()


if __name__ == "__main__":
    main()
