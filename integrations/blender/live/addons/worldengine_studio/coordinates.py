# SPDX-FileCopyrightText: 2026 OpenEnvision Authors
#
# SPDX-License-Identifier: GPL-2.0-or-later

"""Coordinate conversion between Director and Blender."""

from __future__ import annotations

import math
from collections.abc import Sequence
from typing import Any


def _point(value: Any) -> tuple[float, float, float]:
    if (
        isinstance(value, (str, bytes, bytearray))
        or not isinstance(value, Sequence)
        or len(value) != 3
    ):
        raise ValueError("point must contain exactly three numbers")
    result: list[float] = []
    for component in value:
        if isinstance(component, bool) or not isinstance(component, (int, float)):
            raise ValueError("point must contain exactly three numbers")
        number = float(component)
        if not math.isfinite(number) or abs(number) > 100_000.0:
            raise ValueError("point coordinates must be finite and between -100000 and 100000")
        result.append(number)
    return (result[0], result[1], result[2])


def director_to_blender_point(point: Any) -> tuple[float, float, float]:
    """Map a Director point ``(x, y, z)`` to Blender ``(x, -z, y)``."""

    x, y, z = _point(point)
    return (x, -z, y)


def blender_to_director_point(point: Any) -> tuple[float, float, float]:
    """Map a Blender point back to Director coordinates."""

    x, y, z = _point(point)
    return (x, z, -y)


__all__ = ("blender_to_director_point", "director_to_blender_point")
