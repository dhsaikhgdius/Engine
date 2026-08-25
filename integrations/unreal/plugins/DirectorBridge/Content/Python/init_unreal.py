"""Editor startup hook for the Director Bridge plugin.

Registers a `Director` section under Tools with import/export helpers so a
human can run the same fixed entry points the Gateway uses. Headless runs
(`-ExecutePythonScript`) do not depend on this file.
"""

from __future__ import annotations

import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

try:
    import unreal  # type: ignore
except ImportError:  # pragma: no cover - only reachable outside the editor
    unreal = None


def _register_menu() -> None:
    menus = unreal.ToolMenus.get()
    main_menu = menus.find_menu("LevelEditor.MainMenu.Tools")
    if main_menu is None:
        return
    entry = unreal.ToolMenuEntry(
        name="DirectorBridgeHealth",
        type=unreal.MultiBlockType.MENU_ENTRY,
    )
    entry.set_label("Director Bridge: 健康检查 (Health Check)")
    entry.set_tool_tip(
        "Prints the Director connector health line. Import/export runs are driven headlessly by the Director Gateway."
    )
    entry.set_string_command(
        unreal.ToolMenuStringCommandType.PYTHON,
        "",
        "import director_headless; director_headless.run_health(__import__('unreal'))",
    )
    main_menu.add_menu_entry("Director", entry)
    menus.refresh_all_widgets()


if unreal is not None:
    _register_menu()
