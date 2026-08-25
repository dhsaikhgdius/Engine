# SPDX-FileCopyrightText: 2026 OpenEnvision Authors
#
# SPDX-License-Identifier: GPL-2.0-or-later

"""Director modeling kernel denylist for Blender long-tail operators.

Keep in sync with packages/protocol/src/blenderKernel.ts.
"""

from __future__ import annotations

import re
from typing import Any


OPERATOR_CATEGORY_DENYLIST = {
    "console",
    "help",
    "preferences",
    "screen",
    "workspace",
}

OPERATOR_ID_DENYLIST = {
    "wm.quit_blender",
    "wm.window_close",
}

RNA_TARGET_KIND_ALLOWLIST = {
    "object",
    "object_data",
    "modifier",
    "constraint",
    "material",
    "collection",
    "scene",
    "world",
}

_OPERATOR_ID = re.compile(r"^([a-z][a-z0-9_]*)\.[a-z][a-z0-9_]*$", re.IGNORECASE)
_RNA_PATH_DENY = re.compile(r"^(library|script|expression)$", re.IGNORECASE)

# Typed modeling surfaces (geometry-node and modifier properties) never take
# file-system paths, so path-like names are denied by name before any RNA
# lookup. set_rna_property keeps the narrower _RNA_PATH_DENY: explicit render
# output filepaths stay writable there (see blenderKernel.test.ts).
_TYPED_PROPERTY_DENY = re.compile(
    r"^(library|script|expression|filepath|filename|directory)$", re.IGNORECASE
)


def operator_category(identifier: str) -> str | None:
    match = _OPERATOR_ID.match(identifier.strip())
    return match.group(1).lower() if match else None


def is_allowed_operator(identifier: str) -> bool:
    category = operator_category(identifier)
    if category is None or category in OPERATOR_CATEGORY_DENYLIST:
        return False
    if identifier.strip().lower() in OPERATOR_ID_DENYLIST:
        return False
    return True


def is_allowed_rna_write(operation: dict[str, Any]) -> bool:
    target = operation.get("target")
    path = operation.get("path")
    if not isinstance(target, dict) or not isinstance(path, list):
        return False
    kind = target.get("kind")
    if kind not in RNA_TARGET_KIND_ALLOWLIST:
        return False
    return not any(isinstance(segment, str) and _RNA_PATH_DENY.match(segment) for segment in path)


def assert_kernel_policy(operation: dict[str, Any]) -> None:
    op = operation.get("op")
    if op in {"invoke_operator", "describe_operator"}:
        identifier = operation.get("operator")
        if not isinstance(identifier, str) or not is_allowed_operator(identifier):
            raise ValueError(
                f"Blender operator is outside the Director modeling kernel: {identifier}"
            )
    if op == "set_rna_property" and not is_allowed_rna_write(operation):
        raise ValueError(
            "RNA writes are limited to object, mesh, modifier, constraint, "
            "material, collection, scene, and world properties."
        )
