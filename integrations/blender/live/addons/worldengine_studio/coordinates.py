# SPDX-FileCopyrightText: 2026 OpenEnvision Authors
#
# SPDX-License-Identifier: GPL-2.0-or-later

"""Coordinate conversion between Director and Blender.

Director's Stage (three.js) is right-handed Y-up; Blender is right-handed
Z-up. The mapping is the fixed permutation ``(x, y, z) → (x, -z, y)`` and its
inverse — no scaling, both sides are metric meters. These two functions are
the only sanctioned place for that axis swap; every other module converts at
the wire boundary and works in native Blender coordinates internally.

Validation lives here too because these functions sit directly on untrusted
wire input: components must be finite numbers within ±100 km so a bad payload
fails with a protocol error instead of producing NaN transforms in the scene.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from typing import Any


def _point(value: Any) -> tuple[float, float, float]:
    """Validate one 3-component point; strings are Sequences, so exclude them
    explicitly, and reject bools because ``bool`` subclasses ``int``."""
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
