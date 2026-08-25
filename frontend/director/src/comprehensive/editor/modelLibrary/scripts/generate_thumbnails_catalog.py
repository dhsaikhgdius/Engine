#!/usr/bin/env python3
"""Generate catalog thumbnail paths for locally mirrored Flick Stage props.

Rendered WebP previews are produced by generate_rendered_thumbnails.mjs.
This script only ensures catalog.json points at the expected local paths.

Run from repo root:
  python3 frontend/director/src/comprehensive/editor/modelLibrary/scripts/generate_thumbnails_catalog.py
"""

from __future__ import annotations

import json
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[4]
PUBLIC_PROPS_DIR = REPO_ROOT / "public" / "flick-stage-props"
CATALOG_PATH = PUBLIC_PROPS_DIR / "catalog.json"


def main() -> None:
    if not CATALOG_PATH.exists():
        raise SystemExit(f"catalog.json not found at {CATALOG_PATH}")

    catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    items = catalog.get("items", [])
    updated = []

    for item in items:
        category = item.get("category")
        file_name = item.get("fileName")
        if not isinstance(category, str) or not isinstance(file_name, str):
            updated.append(item)
            continue
        if not file_name.lower().endswith(".glb"):
            updated.append(item)
            continue

        stem = file_name[:-4]
        thumb_rel = f"/flick-stage-props/thumbnails/{category}/{stem}.webp"
        next_item = dict(item)
        next_item["thumbnailUrl"] = thumb_rel
        updated.append(next_item)

    catalog["items"] = updated
    CATALOG_PATH.write_text(json.dumps(catalog, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"catalog items: {len(updated)}")


if __name__ == "__main__":
    main()
