# SPDX-FileCopyrightText: 2026 OpenEnvision Authors
#
# SPDX-License-Identifier: GPL-2.0-or-later

"""Pure helpers for Blender material name resolution and compact listings.

Blender appends ``.001``-style suffixes to duplicate datablock names, and
agents frequently reference a material by an approximate name. These helpers
(a) collapse duplicate clones into one canonical entry for listings and
(b) rank near-miss suggestions for rejection messages, so a typo'd
``assign_material`` fails with "did you mean …" instead of a dead end.
Token matching handles both Latin words and CJK runs because material names
in this codebase are frequently Simplified Chinese. Kept ``bpy``-free so the
standalone unit tests can run without Blender.
"""

from __future__ import annotations

import difflib
import re

BLENDER_DUP_SUFFIX = re.compile(r"^(.*)\.\d{3}$")
# One token is either a Latin alphanumeric run or a CJK ideograph run.
MATERIAL_TOKEN = re.compile(r"[a-z0-9]+|[\u4e00-\u9fff]+", re.IGNORECASE)
# Below this SequenceMatcher ratio a candidate is dropped unless it earns a
# shared-token or substring boost; keeps suggestions typo-close, not fuzzy.
NEARBY_MIN_RATIO = 0.72
# Latin tokens shorter than this ("of", "v2") are too generic to signal a
# real match; CJK tokens are always significant.
SIGNIFICANT_TOKEN_LENGTH = 3


def blender_material_base_name(name: str) -> str:
    match = BLENDER_DUP_SUFFIX.match(name)
    return match.group(1) if match else name


def normalize_material_key(name: str) -> str:
    return "".join(character for character in name.casefold() if character.isalnum())


def material_name_tokens(name: str) -> frozenset[str]:
    tokens: set[str] = set()
    for token in MATERIAL_TOKEN.findall(name):
        folded = token.casefold()
        if any("\u4e00" <= character <= "\u9fff" for character in folded) or len(folded) >= SIGNIFICANT_TOKEN_LENGTH:
            tokens.add(folded)
    return frozenset(tokens)


def unique_material_names(
    names: list[str],
    *,
    used: list[str] | None = None,
    limit: int = 64,
) -> list[str]:
    """Collapse Blender `.001` clones and put in-use materials first."""
    present = {name: True for name in names}
    preferred: list[str] = []
    seen_bases: set[str] = set()

    def take(name: str) -> None:
        if not name:
            return
        base = blender_material_base_name(name)
        key = base.casefold()
        if key in seen_bases:
            return
        seen_bases.add(key)
        preferred.append(base if base in present else name)

    for name in used or []:
        take(name)
    for name in names:
        take(name)
    if limit < 0 or len(preferred) <= limit:
        return preferred
    return preferred[:limit]


def nearby_material_names_from(
    requested: str,
    names: list[str],
    *,
    limit: int = 8,
) -> list[str]:
    """Suggest existing names that share tokens or are close typos, not weak fuzzy hits."""
    unique = unique_material_names(names, limit=-1)
    requested_key = normalize_material_key(requested)
    requested_tokens = material_name_tokens(requested)
    scored: list[tuple[float, str]] = []
    for name in unique:
        key = normalize_material_key(name)
        ratio = (
            difflib.SequenceMatcher(None, requested_key, key).ratio()
            if requested_key and key
            else 0.0
        )
        shared = requested_tokens & material_name_tokens(name)
        # CJK names carry meaning in fewer characters, so a 2-character
        # substring already indicates intent where Latin needs 3+.
        cjk = any("\u4e00" <= character <= "\u9fff" for character in requested_key + key)
        min_span = 2 if cjk else 3
        substring = bool(
            requested_key
            and key
            and min(len(requested_key), len(key)) >= min_span
            and (requested_key in key or key in requested_key)
        )
        if shared or substring:
            ratio = max(ratio, 0.8)
        elif ratio < NEARBY_MIN_RATIO:
            continue
        scored.append((ratio, name))
    scored.sort(key=lambda item: (-item[0], item[1]))
    return [name for _, name in scored[:limit]]
