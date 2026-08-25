# SPDX-FileCopyrightText: 2026 OpenEnvision Authors
#
# SPDX-License-Identifier: GPL-2.0-or-later

"""Blender operation identities and transaction effects.

The adjacent JSON file is generated from the canonical protocol manifest by
``npm run sync:blender-operations``.
"""

from __future__ import annotations

import json
from pathlib import Path


_manifest = json.loads(
    Path(__file__).with_name("blenderOperationManifest.json").read_text(
        encoding="utf-8"
    )
)

CONTRACT = _manifest["contract"]
OPERATIONS = tuple(_manifest["operations"])
SUPPORTED_OPERATIONS = frozenset(operation["op"] for operation in OPERATIONS)
AGENT_OPERATIONS = frozenset(
    operation["op"] for operation in OPERATIONS if operation["surface"] != "internal"
)
OPERATION_EFFECTS = {
    operation["op"]: operation["effect"] for operation in OPERATIONS
}

READ_ONLY_LIVE_OPERATIONS = frozenset(
    operation for operation, effect in OPERATION_EFFECTS.items() if effect == "read"
)
SELECTION_LIVE_OPERATIONS = frozenset(
    operation for operation, effect in OPERATION_EFFECTS.items() if effect == "selection"
)
FRAME_LIVE_OPERATIONS = frozenset(
    operation for operation, effect in OPERATION_EFFECTS.items() if effect == "frame"
)
TRANSFORM_ONLY_LIVE_OPERATIONS = frozenset(
    operation for operation, effect in OPERATION_EFFECTS.items() if effect == "transform"
)
UNDO_LIVE_OPERATIONS = frozenset(
    operation for operation, effect in OPERATION_EFFECTS.items() if effect == "history"
)
PROJECT_LIFECYCLE_OPERATIONS = frozenset(
    operation for operation, effect in OPERATION_EFFECTS.items() if effect == "project"
)


__all__ = (
    "AGENT_OPERATIONS",
    "CONTRACT",
    "FRAME_LIVE_OPERATIONS",
    "OPERATION_EFFECTS",
    "OPERATIONS",
    "PROJECT_LIFECYCLE_OPERATIONS",
    "READ_ONLY_LIVE_OPERATIONS",
    "SELECTION_LIVE_OPERATIONS",
    "SUPPORTED_OPERATIONS",
    "TRANSFORM_ONLY_LIVE_OPERATIONS",
    "UNDO_LIVE_OPERATIONS",
)
