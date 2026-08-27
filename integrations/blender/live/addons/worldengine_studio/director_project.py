# SPDX-FileCopyrightText: 2026 OpenEnvision Authors
#
# SPDX-License-Identifier: GPL-2.0-or-later

"""Director-owned native scene storage.

One managed blend file contains one Blender Scene per Director project.  The
browser owns project identity and composition metadata; Blender owns the mesh,
material, UV, modifier, and rig data inside the bound scene.

Persistence model: saving goes through a debounce (``request_save`` marks a
deadline, ``flush_pending_save`` performs the actual ``save_as_mainfile`` once
the deadline passes). Live edits arrive in rapid batches and a full .blend
write per batch would stall the session; one durable save shortly after the
burst is equivalent because the store file is wholly owned by this process.
"""

from __future__ import annotations

import time
from pathlib import Path

import bpy


PROJECT_ID_PROPERTY = "director_project_id"
SAVE_DEBOUNCE_SECONDS = 1.0
_store_path: Path | None = None
_save_due_at: float | None = None


def configure_store(path: str | Path) -> Path:
    """Point the module at its managed .blend without loading it (the file may
    not exist yet; the first save creates it)."""
    global _store_path, _save_due_at
    _store_path = Path(path).resolve()
    _save_due_at = None
    return _store_path


def open_store(path: str | Path) -> bool:
    """Load the managed .blend if present; returns False for a fresh store.

    Deduplication runs immediately after load because a crash between scene
    creation and save can leave duplicate per-project scenes in the file.
    """
    store_path = configure_store(path)
    if not store_path.is_file():
        return False
    bpy.ops.wm.open_mainfile(filepath=str(store_path))
    if deduplicate_managed_scenes():
        request_save()
    return True


def current_project_id(scene=None) -> str | None:
    """Director project id bound to a scene (defaults to the active scene), or None."""
    scene = scene or bpy.context.scene
    value = scene.get(PROJECT_ID_PROPERTY) if scene is not None else None
    return value if isinstance(value, str) and value else None


def _managed_scenes(project_id: str) -> list[bpy.types.Scene]:
    """All scenes tagged with this project id (more than one only after a crash)."""
    return [scene for scene in bpy.data.scenes if current_project_id(scene) == project_id]


def _best_managed_scene(project_id: str) -> bpy.types.Scene | None:
    """Prefer the populated scene so an empty duplicate cannot wipe a set."""
    best: bpy.types.Scene | None = None
    best_count = -1
    for scene in _managed_scenes(project_id):
        count = len(scene.objects)
        if count >= best_count:
            best = scene
            best_count = count
    return best


def deduplicate_managed_scenes() -> int:
    """Keep one Blender scene per Director project, preferring the one with objects."""
    keep = {
        project_id: scene
        for scene in bpy.data.scenes
        if (project_id := current_project_id(scene)) and _best_managed_scene(project_id) is scene
    }
    duplicates = [
        scene
        for scene in list(bpy.data.scenes)
        if (project_id := current_project_id(scene)) and keep.get(project_id) is not scene
    ]
    window = bpy.context.window
    if window is not None and duplicates:
        active = window.scene
        active_project = current_project_id(active) if active is not None else None
        kept = keep.get(active_project) if active_project else None
        if kept is not None and window.scene != kept:
            window.scene = kept
    for scene in duplicates:
        bpy.data.scenes.remove(scene, do_unlink=True)
    if duplicates:
        bpy.data.orphans_purge(do_recursive=True)
    return len(duplicates)


def _configure_scene(scene) -> None:
    """Pin a managed scene to Director's canonical units and preview render size."""
    # The Director contract fixes metric meters and 24 fps; render size is a
    # preview-friendly default (1080p at 50%), not a delivery setting.
    scene.unit_settings.system = 'METRIC'
    scene.unit_settings.length_unit = 'METERS'
    scene.unit_settings.scale_length = 1.0
    scene.render.fps = 24
    scene.render.resolution_x = 1920
    scene.render.resolution_y = 1080
    scene.render.resolution_percentage = 50


def save_store() -> bool:
    """Immediately write the managed .blend and clear any pending debounce."""
    global _save_due_at
    if _store_path is None:
        return False
    _store_path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(_store_path), check_existing=False)
    _save_due_at = None
    return True


def request_save() -> bool:
    """Coalesce rapid live-edit batches into one durable Blender save."""
    global _save_due_at
    if _store_path is None:
        return False
    _save_due_at = time.monotonic() + SAVE_DEBOUNCE_SECONDS
    return True


def has_pending_save() -> bool:
    """True while a debounced save is scheduled but not yet flushed."""
    return _save_due_at is not None


def flush_pending_save(*, force: bool = False) -> bool:
    """Perform the debounced save once its deadline passed (or immediately with force)."""
    global _save_due_at
    if _save_due_at is None:
        return False
    if not force and time.monotonic() < _save_due_at:
        return False
    saved = save_store()
    if saved:
        _save_due_at = None
    return saved


def bind_project(project_id: str) -> dict[str, object]:
    """Switch the window to (or create) the scene bound to a Director project.

    Idempotent: rebinding the already-active project reports
    ``changed: False`` and touches nothing. The first ever bind adopts the
    current (startup) scene instead of creating a new one, so work done
    before binding is not stranded in an unmanaged scene.
    """
    project_id = project_id.strip()
    current = bpy.context.scene
    target = _best_managed_scene(project_id)
    if target is not None and current is target:
        return {
            "projectId": project_id,
            "created": False,
            "changed": False,
            "sceneName": current.name,
        }

    created = target is None
    if target is None:
        has_managed_scene = any(current_project_id(scene) for scene in bpy.data.scenes)
        target = current if current is not None and not has_managed_scene else bpy.data.scenes.new("Director Scene")
        target[PROJECT_ID_PROPERTY] = project_id
        target.name = f"Director · {project_id[:24]}"

    _configure_scene(target)
    if bpy.context.window.scene != target:
        bpy.context.window.scene = target
    request_save()
    return {
        "projectId": project_id,
        "created": created,
        "changed": True,
        "sceneName": target.name,
    }


__all__ = (
    "PROJECT_ID_PROPERTY",
    "bind_project",
    "configure_store",
    "current_project_id",
    "deduplicate_managed_scenes",
    "flush_pending_save",
    "has_pending_save",
    "open_store",
    "request_save",
    "save_store",
)
