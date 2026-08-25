# SPDX-FileCopyrightText: 2026 OpenEnvision Authors
#
# SPDX-License-Identifier: GPL-2.0-or-later

from __future__ import annotations

import base64
import hmac
import json
import os
import queue
import threading
import uuid
from collections import deque
from copy import deepcopy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

import bpy
from bpy.app.handlers import persistent

from .live_link import LiveLinkBuffer
from .live_protocol import (
    CONTRACT as LIVE_CONTRACT,
    LiveProtocolError,
    parse_live_batch,
    snapshots_differ_only_by_transforms,
)
from .operation_manifest import (
    FRAME_LIVE_OPERATIONS,
    PROJECT_LIFECYCLE_OPERATIONS,
    READ_ONLY_LIVE_OPERATIONS,
    SELECTION_LIVE_OPERATIONS,
    TRANSFORM_ONLY_LIVE_OPERATIONS,
    UNDO_LIVE_OPERATIONS,
)


SESSION_HOST = "127.0.0.1"
MAX_REQUEST_BYTES = 256 * 1024
MAX_RESULTS = 256
MAX_DETACHED_PAYLOADS = 4
_POLL_INTERVAL = 0.05

# Large base64 payloads are moved out of the job records into one bounded side
# store so long sessions cannot accumulate render/preview bytes inside Blender.
DETACHABLE_PAYLOAD_MIME_TYPES = {"model/gltf-binary", "image/png"}
PREVIEW_GLB_MIME_TYPE = "model/gltf-binary"


class _LoopbackServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True
    request_queue_size = 128


_server: _LoopbackServer | None = None
_server_thread: threading.Thread | None = None
_pending: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=512)
_pending_event = threading.Event()
_records: dict[str, dict[str, Any]] = {}
_request_commands: dict[str, dict[str, Any]] = {}
_record_order: deque[str] = deque()
_detached_payloads: dict[str, dict[int, str]] = {}
_detached_payload_order: deque[str] = deque()
_snapshot: dict[str, Any] | None = None
_session_token: str | None = None
_blender_version = "unknown"
_state_lock = threading.Lock()
_applying_command = False
_manual_change_pending = False
_manual_content_change_pending = False
_manual_frame_change_pending = False
_published_mode = "OBJECT"
_session_revision: int | None = None
# Revision at which the visible scene content (anything except pure object
# transforms) last changed. None means "unknown", which publishes the current
# revision so clients always fall back to a full preview reload.
_content_revision: int | None = None
_scene_epoch = str(uuid.uuid4())
# Preview-only live-link delta feed. Frames are never authoritative: dropping
# the link or evicting history only forces consumers back to the snapshot.
_live_link = LiveLinkBuffer()


class IntentConflictError(ValueError):
    code = "intent_conflict"

    def __init__(self, request_id: str):
        self.request_id = request_id
        super().__init__(
            f"Intent {request_id} was already submitted with different request content"
        )


class SceneEpochConflictError(ValueError):
    code = "scene_epoch_conflict"

    def __init__(self, expected: str, current: str):
        super().__init__(
            f"Scene changed: expected epoch {expected}, current epoch {current}"
        )


class RevisionConflictError(ValueError):
    code = "revision_conflict"

    def __init__(self, expected: int, current: int):
        super().__init__(
            f"Scene changed: expected revision {expected}, current revision {current}"
        )


def scene_epoch_value() -> str:
    return _scene_epoch


def _stamp_scene_epoch(snapshot: dict[str, Any]) -> dict[str, Any]:
    snapshot["sceneEpoch"] = _scene_epoch
    revision = int(snapshot.get("revision", 0))
    # Clamping preserves the contract contentRevision <= revision even when an
    # older cached snapshot is re-stamped; a clamp can only force a reload,
    # never enable a stale transform-only path.
    snapshot["contentRevision"] = revision if _content_revision is None else min(_content_revision, revision)
    return snapshot


def _revision_value(scene=None) -> int:
    """Return the session revision and keep the undoable Scene property as a mirror."""
    global _session_revision
    scene = scene or bpy.context.scene
    stored = int(scene.worldengine_studio.scene_revision)
    if _session_revision is None:
        _session_revision = stored
    elif stored > _session_revision and not _applying_command:
        # Native Blender UI operators update the Scene property before the
        # depsgraph callback publishes their snapshot. Adopt that revision once.
        _session_revision = stored
    scene.worldengine_studio.scene_revision = _session_revision
    return _session_revision


def _set_revision(scene, revision: int) -> int:
    global _session_revision
    _session_revision = int(revision)
    scene.worldengine_studio.scene_revision = _session_revision
    return _session_revision


def _record_external_change(scene) -> int:
    """Advance once for a native UI edit, direct bpy edit, undo, or redo."""
    global _session_revision
    stored = int(scene.worldengine_studio.scene_revision)
    if _session_revision is None:
        return _set_revision(scene, stored)
    published = current_snapshot()
    published_revision = int(published.get("revision", 0)) if published else _session_revision
    if stored > published_revision:
        # Native Blender operators already advance the mirrored property.
        return _set_revision(scene, max(stored, _session_revision))
    return _set_revision(scene, _session_revision + 1)


def _interaction_mode() -> str:
    active = bpy.context.view_layer.objects.active
    return active.mode if active is not None else "OBJECT"


def _visible_snapshot_content(snapshot: dict[str, Any] | None):
    if snapshot is None:
        return None
    return (
        snapshot.get("sceneName"),
        snapshot.get("objects"),
        snapshot.get("cameras"),
        snapshot.get("lights"),
    )


def _depsgraph_changes_visible_content(depsgraph) -> bool:
    mode_changed = _interaction_mode() != _published_mode
    for update in depsgraph.updates:
        identifier = update.id.bl_rna.identifier
        if identifier in {
            "Material",
            "ShaderNodeTree",
            "GeometryNodeTree",
            "Image",
            "Texture",
            "Camera",
            "AreaLight",
            "PointLight",
            "SunLight",
            "SpotLight",
            "Armature",
            "Action",
            "Curve",
            "Curves",
            "GreasePencil",
            "MetaBall",
            "PointCloud",
            "Volume",
        }:
            return True
        if identifier == "Object" and getattr(update.id, "type", None) == 'ARMATURE':
            return True
        if identifier == "Mesh" and update.is_updated_geometry and not mode_changed:
            return True
    return False


def _refresh_manual_snapshot():
    global _applying_command, _manual_change_pending, _content_revision
    global _manual_content_change_pending, _manual_frame_change_pending
    _manual_change_pending = False
    if _server is None or _applying_command or bpy.context.scene is None:
        return None
    from .blockout import snapshot_live_scene

    _applying_command = True
    try:
        previous_snapshot = current_snapshot()
        fresh_snapshot = snapshot_live_scene(bpy.context.scene)
        visible_state_changed = _visible_snapshot_content(
            fresh_snapshot
        ) != _visible_snapshot_content(previous_snapshot)
        if _manual_content_change_pending or (
            visible_state_changed and not _manual_frame_change_pending
        ):
            # A viewport drag replays as a pure transform delta between the
            # published and fresh snapshots. Anything the depsgraph flagged as
            # content (mesh/material/armature edits) or that the diff cannot
            # prove transform-only invalidates cached preview GLBs as well.
            transform_only_manual = not _manual_content_change_pending and snapshots_differ_only_by_transforms(
                previous_snapshot, fresh_snapshot
            )
            revision = _record_external_change(bpy.context.scene)
            if not transform_only_manual:
                _content_revision = revision
            fresh_snapshot = snapshot_live_scene(bpy.context.scene)
            from .director_project import request_save

            request_save()
        set_snapshot(fresh_snapshot)
    finally:
        _manual_content_change_pending = False
        _manual_frame_change_pending = False
        _applying_command = False
    return None


def _schedule_manual_snapshot(*, content_changed: bool, frame_changed: bool = False) -> None:
    global _manual_change_pending, _manual_content_change_pending, _manual_frame_change_pending
    if _server is None or _applying_command:
        return
    _manual_content_change_pending = _manual_content_change_pending or content_changed
    _manual_frame_change_pending = _manual_frame_change_pending or frame_changed
    if _manual_change_pending:
        return
    _manual_change_pending = True
    bpy.app.timers.register(_refresh_manual_snapshot, first_interval=0.15)


@persistent
def _on_depsgraph_update(_scene, depsgraph) -> None:
    if depsgraph.updates:
        _schedule_manual_snapshot(
            content_changed=(
                False
                if _manual_frame_change_pending
                else _depsgraph_changes_visible_content(depsgraph)
            )
        )


@persistent
def _on_undo_redo(_scene) -> None:
    _schedule_manual_snapshot(content_changed=True)


@persistent
def _on_frame_change(_scene, _depsgraph=None) -> None:
    global _manual_content_change_pending
    _manual_content_change_pending = False
    _schedule_manual_snapshot(content_changed=False, frame_changed=True)


@persistent
def _on_load_post(_filepath) -> None:
    if _server is None or bpy.context.scene is None:
        return
    _reset_session_state()
    _publish_current_snapshot()


def _ensure_change_handlers() -> None:
    for handlers, callback in (
        (bpy.app.handlers.depsgraph_update_post, _on_depsgraph_update),
        (bpy.app.handlers.undo_post, _on_undo_redo),
        (bpy.app.handlers.redo_post, _on_undo_redo),
        (bpy.app.handlers.frame_change_post, _on_frame_change),
        (bpy.app.handlers.load_post, _on_load_post),
    ):
        if callback not in handlers:
            handlers.append(callback)


def _remove_change_handlers() -> None:
    for handlers, callback in (
        (bpy.app.handlers.depsgraph_update_post, _on_depsgraph_update),
        (bpy.app.handlers.undo_post, _on_undo_redo),
        (bpy.app.handlers.redo_post, _on_undo_redo),
        (bpy.app.handlers.frame_change_post, _on_frame_change),
        (bpy.app.handlers.load_post, _on_load_post),
    ):
        if callback in handlers:
            handlers.remove(callback)


def _undo_push(message: str) -> bool:
    from .modeling import operator_context

    with operator_context():
        if not bpy.ops.ed.undo_push.poll():
            return False
        bpy.ops.ed.undo_push(message=message)
        return True


def _undo_once() -> bool:
    from .modeling import operator_context

    with operator_context():
        if not bpy.ops.ed.undo.poll():
            return False
        bpy.ops.ed.undo()
        return True


def _capture_interaction_state() -> dict[str, Any]:
    from .blockout import ID_PROPERTY

    active = bpy.context.view_layer.objects.active

    def object_ref(obj) -> dict[str, str | None]:
        identifier = obj.get(ID_PROPERTY)
        return {"id": str(identifier) if identifier else None, "name": obj.name}

    mesh_selection = None
    if active is not None and active.type == 'MESH' and active.mode == 'EDIT':
        active.update_from_editmode()
        mesh_selection = {
            "vertices": [item.index for item in active.data.vertices if item.select],
            "edges": [item.index for item in active.data.edges if item.select],
            "faces": [item.index for item in active.data.polygons if item.select],
        }
    pose_selection = None
    if active is not None and active.type == 'ARMATURE':
        bones = active.data.edit_bones if active.mode == 'EDIT' else active.pose.bones
        active_bone = (
            active.data.edit_bones.active
            if active.mode == 'EDIT'
            else active.data.bones.active
        )
        pose_selection = {
            "active": active_bone.name if active_bone is not None else None,
            "selected": [bone.name for bone in bones if bone.select],
        }
    return {
        "active": object_ref(active) if active is not None else None,
        "selected": [object_ref(obj) for obj in bpy.context.selected_objects],
        "mode": active.mode if active is not None else "OBJECT",
        "mesh_selection": mesh_selection,
        "pose_selection": pose_selection,
        "frame": int(bpy.context.scene.frame_current),
    }


def _restore_interaction_state(interaction: dict[str, Any]) -> None:
    from . import blockout
    from .modeling import operator_context

    def resolve(reference):
        if reference is None:
            return None
        return (
            blockout.find_object(reference["id"])
            if reference.get("id")
            else bpy.data.objects.get(reference["name"])
        )

    current = bpy.context.view_layer.objects.active
    if current is not None and current.mode != 'OBJECT':
        with operator_context():
            bpy.ops.object.mode_set(mode='OBJECT')
    for obj in bpy.context.selected_objects:
        obj.select_set(False)
    selected = [obj for reference in interaction["selected"] if (obj := resolve(reference))]
    active = resolve(interaction["active"])
    if active is not None and active not in selected:
        selected.append(active)
    for obj in selected:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = active or (selected[0] if selected else None)

    mesh_selection = interaction["mesh_selection"]
    if active is not None and active.type == 'MESH' and mesh_selection is not None:
        selected_vertices = set(mesh_selection["vertices"])
        selected_edges = set(mesh_selection["edges"])
        selected_faces = set(mesh_selection["faces"])
        for item in active.data.vertices:
            item.select = item.index in selected_vertices
        for item in active.data.edges:
            item.select = item.index in selected_edges
        for item in active.data.polygons:
            item.select = item.index in selected_faces
        active.data.update()

    mode = interaction["mode"]
    if active is not None and mode != 'OBJECT':
        with operator_context():
            bpy.ops.object.mode_set(mode=mode)
    pose_selection = interaction["pose_selection"]
    if active is not None and active.type == 'ARMATURE' and pose_selection is not None:
        selected_bones = set(pose_selection["selected"])
        bones = active.data.edit_bones if active.mode == 'EDIT' else active.pose.bones
        for bone in bones:
            bone.select = bone.name in selected_bones
        if active_ref := pose_selection["active"]:
            active_bone = bones.get(active_ref)
            if active_bone is not None:
                if active.mode == 'EDIT':
                    active.data.edit_bones.active = active_bone
                else:
                    active.data.bones.active = active.data.bones.get(active_ref)
        elif active.mode != 'EDIT':
            active.data.bones.active = None
    bpy.context.scene.frame_set(interaction["frame"])


def _rollback_to_checkpoint() -> None:
    # Direct bpy data edits are not captured until a state is pushed. Capture
    # the failed state, step back to the transaction checkpoint, then push the
    # restored state so Blender cannot redo the discarded partial transaction.
    if not _undo_push("WorldEngine discarded transaction") or not _undo_once():
        raise RuntimeError("Blender could not roll back the WorldEngine transaction")
    if not _undo_push("WorldEngine transaction restored"):
        raise RuntimeError("Blender could not seal the restored transaction state")


def _operation_applied_content(operation: dict[str, Any], result: Any) -> bool:
    op = operation.get("op")
    if (
        op in READ_ONLY_LIVE_OPERATIONS
        or op in SELECTION_LIVE_OPERATIONS
        or op in FRAME_LIVE_OPERATIONS
        or op in UNDO_LIVE_OPERATIONS
    ):
        return False
    return not (isinstance(result, dict) and result.get("skipped") is True)


def _execute_live_batch(command, execute_live_operations, snapshot_live_scene):
    global _applying_command, _scene_epoch, _session_revision, _content_revision

    scene = bpy.context.scene
    before_revision = _revision_value(scene)
    operations = command["operations"]
    lifecycle_operations = [
        operation for operation in operations
        if operation["op"] in PROJECT_LIFECYCLE_OPERATIONS
    ]
    if lifecycle_operations:
        if len(operations) != 1:
            raise ValueError("bind_director_project must be submitted as a standalone batch")
        _applying_command = True
        try:
            results = execute_live_operations(operations)
            binding_changed = not (
                isinstance(results[0], dict) and results[0].get("changed") is False
            )
            if binding_changed:
                _scene_epoch = str(uuid.uuid4())
                _session_revision = None
                _content_revision = None
            bpy.context.view_layer.update()
            snapshot = _stamp_scene_epoch(snapshot_live_scene(bpy.context.scene))
            revision_after = _revision_value(bpy.context.scene)
        finally:
            _applying_command = False
        return {
            "sceneEpoch": _scene_epoch,
            "revisionBefore": before_revision,
            "revisionAfter": revision_after,
            "operations": results,
        }, snapshot, revision_after

    expected_scene_epoch = command.get("expected_scene_epoch")
    if expected_scene_epoch is not None and expected_scene_epoch != _scene_epoch:
        raise SceneEpochConflictError(expected_scene_epoch, _scene_epoch)
    expected = command.get("expected_revision")
    if expected is not None and expected != before_revision:
        raise RevisionConflictError(expected, before_revision)

    undo_operations = [operation for operation in operations if operation["op"] in UNDO_LIVE_OPERATIONS]
    if undo_operations and len(operations) != 1:
        raise ValueError("undo_scene and redo_scene must each be submitted as a standalone batch")

    content_mutating = any(
        operation["op"] not in READ_ONLY_LIVE_OPERATIONS
        and operation["op"] not in SELECTION_LIVE_OPERATIONS
        and operation["op"] not in FRAME_LIVE_OPERATIONS
        and operation["op"] not in UNDO_LIVE_OPERATIONS
        for operation in operations
    )
    # Undo/redo can resurrect or reshape anything, so it always counts as a
    # visible-content change even though the batch itself edits nothing.
    visible_content_mutating = bool(undo_operations) or any(
        operation["op"] not in READ_ONLY_LIVE_OPERATIONS
        and operation["op"] not in SELECTION_LIVE_OPERATIONS
        and operation["op"] not in FRAME_LIVE_OPERATIONS
        and operation["op"] not in UNDO_LIVE_OPERATIONS
        and operation["op"] not in TRANSFORM_ONLY_LIVE_OPERATIONS
        for operation in operations
    )
    changes_scene = content_mutating or bool(undo_operations)
    changes_selection = any(operation["op"] in SELECTION_LIVE_OPERATIONS for operation in operations)
    changes_frame = any(operation["op"] in FRAME_LIVE_OPERATIONS for operation in operations)
    refresh_snapshot = changes_scene or changes_selection or changes_frame
    interaction = _capture_interaction_state() if refresh_snapshot else None
    checkpoint = False

    if content_mutating:
        checkpoint = _undo_push("WorldEngine transaction start")
        if not checkpoint:
            raise RuntimeError("Blender undo is unavailable for an atomic WorldEngine transaction")

    _applying_command = True
    try:
        results = execute_live_operations(operations)
        applied_content = any(
            _operation_applied_content(operation, result)
            for operation, result in zip(operations, results)
        )
        if checkpoint and not applied_content:
            _undo_once()
            content_mutating = False
            changes_scene = bool(undo_operations)
            visible_content_mutating = bool(undo_operations)
            refresh_snapshot = changes_scene or changes_selection or changes_frame
        elif content_mutating and not _undo_push("WorldEngine Director edit"):
            raise RuntimeError("Blender could not commit the WorldEngine transaction")
        if changes_scene:
            _set_revision(bpy.context.scene, before_revision + 1)
        if refresh_snapshot:
            bpy.context.view_layer.update()
            snapshot = _stamp_scene_epoch(snapshot_live_scene(bpy.context.scene))
        else:
            snapshot = current_snapshot()
            if snapshot is None:
                snapshot = _stamp_scene_epoch(snapshot_live_scene(bpy.context.scene))
        revision_after = _revision_value(bpy.context.scene)
        if changes_scene and visible_content_mutating:
            _content_revision = revision_after
        if changes_scene:
            from .director_project import request_save

            request_save()
    except Exception:
        if checkpoint:
            _rollback_to_checkpoint()
        if interaction is not None:
            _restore_interaction_state(interaction)
        _set_revision(bpy.context.scene, before_revision)
        bpy.context.view_layer.update()
        set_snapshot(snapshot_live_scene(bpy.context.scene))
        raise
    finally:
        # Some Blender operators publish their final depsgraph notifications only
        # after returning. Consume those notifications while the command guard is
        # still active so a read-only preview cannot look like a second manual edit.
        if bpy.context.scene is not None:
            bpy.context.view_layer.update()
        _applying_command = False

    result = {
        "sceneEpoch": _scene_epoch,
        "revisionBefore": before_revision,
        "revisionAfter": revision_after,
        "operations": results,
    }
    return result, snapshot, revision_after


def _is_allowed_origin(origin: str | None) -> bool:
    if not origin:
        return True
    try:
        parsed = urlparse(origin)
    except ValueError:
        return False
    return parsed.scheme in {"http", "https"} and parsed.hostname in {"127.0.0.1", "localhost", "::1"}


def _detach_operation_payloads(record: dict[str, Any]) -> tuple[dict[str, Any], dict[int, str] | None]:
    result = record.get("result")
    if not isinstance(result, dict):
        return record, None
    operations = result.get("operations")
    if not isinstance(operations, list):
        return record, None
    detachable = [
        index
        for index, operation in enumerate(operations)
        if isinstance(operation, dict)
        and operation.get("mimeType") in DETACHABLE_PAYLOAD_MIME_TYPES
        and isinstance(operation.get("dataBase64"), str)
    ]
    if not detachable:
        return record, None
    stored = deepcopy(record)
    payloads = {
        index: stored["result"]["operations"][index].pop("dataBase64")
        for index in detachable
    }
    return stored, payloads


def _attach_operation_payloads(record: dict[str, Any], payloads: dict[int, str]) -> None:
    result = record.get("result")
    operations = result.get("operations") if isinstance(result, dict) else None
    if not isinstance(operations, list):
        return
    for index, payload in payloads.items():
        if 0 <= index < len(operations) and isinstance(operations[index], dict):
            operations[index]["dataBase64"] = payload


def _discard_record_locked(request_id: str) -> None:
    _records.pop(request_id, None)
    _request_commands.pop(request_id, None)
    if request_id in _record_order:
        _record_order.remove(request_id)
    _detached_payloads.pop(request_id, None)
    if request_id in _detached_payload_order:
        _detached_payload_order.remove(request_id)


def _remember(request_id: str, record: dict[str, Any]) -> None:
    stored_record, detached_payloads = _detach_operation_payloads(record)
    with _state_lock:
        if request_id not in _records:
            _record_order.append(request_id)
        _records[request_id] = stored_record
        if detached_payloads is not None:
            if request_id not in _detached_payloads:
                _detached_payload_order.append(request_id)
            _detached_payloads[request_id] = detached_payloads
            while len(_detached_payload_order) > MAX_DETACHED_PAYLOADS:
                expired_payload = _detached_payload_order.popleft()
                _detached_payloads.pop(expired_payload, None)
        while len(_record_order) > MAX_RESULTS:
            expired = _record_order.popleft()
            _records.pop(expired, None)
            _request_commands.pop(expired, None)
            _detached_payloads.pop(expired, None)
            if expired in _detached_payload_order:
                _detached_payload_order.remove(expired)


def command_record(request_id: str, *, consume: bool = False) -> dict[str, Any] | None:
    with _state_lock:
        record = _records.get(request_id)
        if record is None:
            return None
        response_record = deepcopy(record)
        terminal = record.get("status") in {"succeeded", "failed"}
        if consume and terminal:
            if payloads := _detached_payloads.get(request_id):
                _attach_operation_payloads(response_record, payloads)
            _discard_record_locked(request_id)
        return response_record


def preview_glb_payload(request_id: str) -> tuple[str, str, int] | None:
    """Return the detached (base64 GLB, sceneEpoch, revision) of a succeeded job."""
    with _state_lock:
        record = _records.get(request_id)
        payloads = _detached_payloads.get(request_id)
        if record is None or record.get("status") != "succeeded" or not payloads:
            return None
        result = record.get("result")
        operations = result.get("operations") if isinstance(result, dict) else None
        if not isinstance(operations, list):
            return None
        for index, operation in enumerate(operations):
            if (
                isinstance(operation, dict)
                and operation.get("mimeType") == PREVIEW_GLB_MIME_TYPE
                and index in payloads
            ):
                return (
                    payloads[index],
                    str(operation.get("sceneEpoch", "")),
                    int(operation.get("revision") or 0),
                )
        return None


def discard_record(request_id: str) -> None:
    with _state_lock:
        _discard_record_locked(request_id)


def set_snapshot(snapshot: dict[str, Any]) -> None:
    global _published_mode, _snapshot
    with _state_lock:
        _snapshot = _stamp_scene_epoch(snapshot)
        _published_mode = _interaction_mode()
        _live_link.publish(_scene_epoch, _snapshot)


def current_snapshot() -> dict[str, Any] | None:
    with _state_lock:
        return _snapshot


def _queue_command(command: dict[str, Any]) -> dict[str, Any] | None:
    """Queue a new intent, or return the existing record for an idempotent retry."""
    request_id = command.get("job_id", command["request_id"])
    queued_record = (
        {
            "contract": LIVE_CONTRACT,
            "jobId": command["job_id"],
            "requestId": command["request_id"],
            "status": "queued",
            "revision": None,
            "error": None,
        }
        if "job_id" in command
        else {"request_id": request_id, "status": "queued"}
    )
    normalized_command = deepcopy(command)
    with _state_lock:
        existing = _records.get(request_id)
        if existing is not None:
            if _request_commands[request_id] != normalized_command:
                raise IntentConflictError(request_id)
            return dict(existing)
        _records[request_id] = queued_record
        _request_commands[request_id] = normalized_command
        _record_order.append(request_id)
        while len(_record_order) > MAX_RESULTS:
            expired = _record_order.popleft()
            _records.pop(expired, None)
            _request_commands.pop(expired, None)
    try:
        _pending.put_nowait(command)
    except queue.Full:
        with _state_lock:
            _records.pop(request_id, None)
            _request_commands.pop(request_id, None)
            _record_order.remove(request_id)
            _detached_payloads.pop(request_id, None)
            if request_id in _detached_payload_order:
                _detached_payload_order.remove(request_id)
        raise
    _pending_event.set()
    return None


class _RequestHandler(BaseHTTPRequestHandler):
    server_version = "WorldEngineLoopback/1"
    protocol_version = "HTTP/1.1"

    def log_message(self, _format, *_args):
        return

    def _cors_origin(self) -> str | None:
        origin = self.headers.get("Origin")
        return origin if _is_allowed_origin(origin) and origin else None

    def _authorized(self) -> bool:
        if not _session_token:
            return True
        scheme, _, credentials = self.headers.get("Authorization", "").partition(" ")
        return scheme.lower() == "bearer" and hmac.compare_digest(
            credentials.strip().encode("utf-8"), _session_token.encode("utf-8")
        )

    def _send(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if (origin := self._cors_origin()) is not None:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        if not _is_allowed_origin(self.headers.get("Origin")):
            self._send(403, {"success": False, "error": "Origin is not a loopback URL"})
            return
        self.send_response(204)
        if (origin := self._cors_origin()) is not None:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Headers", "authorization, content-type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def do_GET(self):
        if not _is_allowed_origin(self.headers.get("Origin")):
            self._send(403, {"success": False, "error": "Origin is not a loopback URL"})
            return
        if not self._authorized():
            self._send(401, {"success": False, "error": "A valid session bearer token is required"})
            return
        parsed_url = urlparse(self.path)
        path = parsed_url.path
        if path == "/health":
            from .director_project import has_pending_save

            snapshot = current_snapshot() or {}
            revision = int(snapshot.get("revision", 0))
            with _state_lock:
                live_link_state = _live_link.state()
            self._send(200, {
                "ok": True,
                "contract": LIVE_CONTRACT,
                "projectId": snapshot.get("projectId"),
                "sceneEpoch": _scene_epoch,
                "blenderVersion": _blender_version,
                "revision": revision,
                "contentRevision": int(snapshot.get("contentRevision", revision)),
                "busy": _applying_command or not _pending.empty() or has_pending_save(),
                "liveLink": live_link_state,
            })
            return
        if path == "/v1/scene":
            snapshot = current_snapshot()
            self._send(200 if snapshot is not None else 404, snapshot or {"error": "Scene snapshot unavailable"})
            return
        if path == "/v1/live-link":
            query = parse_qs(parsed_url.query)
            requested_epoch = (query.get("epoch") or [None])[0]
            raw_since = (query.get("since") or [None])[0]
            since: int | None = None
            if raw_since is not None:
                try:
                    since = int(raw_since)
                except ValueError:
                    self._send(400, {"success": False, "error": "since must be an integer sequence number"})
                    return
                if since < 0:
                    self._send(400, {"success": False, "error": "since must be a non-negative sequence number"})
                    return
            with _state_lock:
                if _live_link.epoch != _scene_epoch:
                    _live_link.reset(_scene_epoch)
                payload = _live_link.poll(requested_epoch, since)
            self._send(200, payload)
            return
        job_prefix = "/v1/jobs/"
        if path.startswith(job_prefix):
            job_id = path[len(job_prefix):]
            consume = parse_qs(parsed_url.query).get("consume") == ["1"]
            record = command_record(job_id, consume=consume)
            self._send(200 if record else 404, record or {"error": "Unknown job"})
            return
        preview_prefix = "/v1/previews/"
        preview_suffix = ".glb"
        if path.startswith(preview_prefix) and path.endswith(preview_suffix):
            job_id = path[len(preview_prefix):-len(preview_suffix)]
            preview = preview_glb_payload(job_id)
            if preview is None:
                self._send(404, {"error": "Unknown preview"})
                return
            payload, scene_epoch, revision = preview
            body = base64.b64decode(payload)
            self.send_response(200)
            self.send_header("Content-Type", PREVIEW_GLB_MIME_TYPE)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Blender-Scene-Epoch", scene_epoch)
            self.send_header("X-Blender-Revision", str(revision))
            if (origin := self._cors_origin()) is not None:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
            self.end_headers()
            self.wfile.write(body)
            if parse_qs(parsed_url.query).get("consume") == ["1"]:
                discard_record(job_id)
            return
        self._send(404, {"success": False, "error": "Unknown endpoint"})

    def do_POST(self):
        if not _is_allowed_origin(self.headers.get("Origin")):
            self._send(403, {"success": False, "error": "Origin is not a loopback URL"})
            return
        if not self._authorized():
            self._send(401, {"success": False, "error": "A valid session bearer token is required"})
            return
        if self.path != "/v1/commands":
            self._send(404, {"success": False, "error": "Unknown endpoint"})
            return
        content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            self._send(415, {"success": False, "error": "Content-Type must be application/json"})
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            content_length = -1
        if content_length <= 0 or content_length > MAX_REQUEST_BYTES:
            self._send(413, {"success": False, "error": "Invalid or oversized command body"})
            return
        raw = self.rfile.read(content_length)
        try:
            command = parse_live_batch(raw)
            existing = _queue_command(command)
        except LiveProtocolError as error:
            self._send(400, {"success": False, "error": str(error)})
            return
        except queue.Full:
            self._send(503, {"success": False, "error": "Command queue is full"})
            return
        except IntentConflictError as error:
            self._send(409, {
                "success": False,
                "code": error.code,
                "requestId": error.request_id,
                "error": str(error),
            })
            return
        except ValueError as error:
            self._send(409, {"success": False, "error": str(error)})
            return
        self._send(202, {
            "contract": LIVE_CONTRACT,
            "jobId": command["job_id"],
            "requestId": command["request_id"],
            "status": existing["status"] if existing is not None else "queued",
        })


def drain_pending(limit: int = 64) -> int:
    """Apply queued work. Must only be called on Blender's main thread."""
    from .blockout import snapshot_live_scene
    from .operators import execute_live_operations

    _pending_event.clear()
    processed = 0
    for _index in range(limit):
        try:
            command = _pending.get_nowait()
        except queue.Empty:
            break
        request_id = command["job_id"]
        _remember(request_id, {
            "contract": LIVE_CONTRACT,
            "jobId": command["job_id"],
            "requestId": command["request_id"],
            "status": "running",
            "revision": None,
            "error": None,
        })
        try:
            result, snapshot, revision = _execute_live_batch(
                command, execute_live_operations, snapshot_live_scene
            )
            set_snapshot(snapshot)
            record = {
                "contract": LIVE_CONTRACT,
                "jobId": command["job_id"],
                "requestId": command["request_id"],
                "status": "succeeded",
                "revision": revision,
                "result": result,
                "error": None,
            }
        except Exception as error:
            record = {
                "contract": LIVE_CONTRACT,
                "jobId": command["job_id"],
                "requestId": command["request_id"],
                "status": "failed",
                "revision": _revision_value(bpy.context.scene),
                "code": getattr(error, "code", None),
                "error": str(error),
            }
        _remember(request_id, record)
        _pending.task_done()
        processed += 1
    if not _pending.empty():
        _pending_event.set()
    return processed


def wait_for_pending(timeout: float = 1.0) -> bool:
    """Wait without polling until an HTTP worker queues main-thread work."""
    return _pending_event.wait(timeout=max(0.0, float(timeout)))


def wake_pending_waiter() -> None:
    """Wake a headless backend loop so it can observe shutdown state."""
    _pending_event.set()


def flush_pending_save(*, force: bool = False) -> bool:
    if not force and (_applying_command or not _pending.empty()):
        return False
    from .director_project import flush_pending_save as flush_store_save

    return flush_store_save(force=force)


def _timer_callback():
    if _server is None:
        return None
    drain_pending()
    flush_pending_save()
    return _POLL_INTERVAL


def is_running() -> bool:
    return _server is not None


def session_url() -> str:
    port = _server.server_port if _server is not None else 8791
    return f"http://{SESSION_HOST}:{port}"


def _reset_session_state() -> None:
    global _applying_command, _manual_change_pending, _scene_epoch, _session_revision, _snapshot
    global _manual_content_change_pending, _manual_frame_change_pending, _published_mode
    global _content_revision
    _applying_command = True
    if bpy.app.timers.is_registered(_refresh_manual_snapshot):
        bpy.app.timers.unregister(_refresh_manual_snapshot)
    with _state_lock:
        _records.clear()
        _request_commands.clear()
        _record_order.clear()
        _detached_payloads.clear()
        _detached_payload_order.clear()
        _snapshot = None
        _scene_epoch = str(uuid.uuid4())
        _live_link.reset(_scene_epoch)
    while True:
        try:
            _pending.get_nowait()
        except queue.Empty:
            break
        _pending.task_done()
    _pending_event.clear()
    _session_revision = None
    _content_revision = None
    _manual_change_pending = False
    _manual_content_change_pending = False
    _manual_frame_change_pending = False
    _published_mode = "OBJECT"
    _applying_command = False


def _publish_current_snapshot() -> None:
    global _applying_command
    from .blockout import snapshot_live_scene

    _applying_command = True
    try:
        _revision_value(bpy.context.scene)
        set_snapshot(snapshot_live_scene(bpy.context.scene))
    finally:
        _applying_command = False


def start(port: int = 8791, *, use_timer: bool = True) -> None:
    global _blender_version, _server, _server_thread, _session_token
    if _server is not None:
        return
    _reset_session_state()
    # Opt-in bearer auth: Blender inherits the shell env, so the gateway and
    # this session can share one token. Empty or unset keeps auth disabled.
    _session_token = (
        os.environ.get("WORLDENGINE_SESSION_TOKEN", "").strip()
        or os.environ.get("DIRECTOR_BLENDER_TOKEN", "").strip()
        or None
    )
    server = _LoopbackServer((SESSION_HOST, int(port)), _RequestHandler)
    thread = threading.Thread(target=server.serve_forever, name="WorldEngineLoopback", daemon=True)
    _server = server
    _server_thread = thread
    _blender_version = bpy.app.version_string
    _ensure_change_handlers()
    thread.start()
    _publish_current_snapshot()
    if use_timer and not bpy.app.timers.is_registered(_timer_callback):
        bpy.app.timers.register(_timer_callback, first_interval=_POLL_INTERVAL, persistent=True)


def stop() -> None:
    global _server, _server_thread, _session_token
    server = _server
    thread = _server_thread
    _server = None
    _server_thread = None
    _session_token = None
    if bpy.app.timers.is_registered(_timer_callback):
        bpy.app.timers.unregister(_timer_callback)
    if bpy.app.timers.is_registered(_refresh_manual_snapshot):
        bpy.app.timers.unregister(_refresh_manual_snapshot)
    if server is not None:
        server.shutdown()
        server.server_close()
    if thread is not None and thread is not threading.current_thread():
        thread.join(timeout=1.0)
    flush_pending_save(force=True)
    _remove_change_handlers()
    _reset_session_state()


def register():
    pass


def unregister():
    stop()
    _remove_change_handlers()
