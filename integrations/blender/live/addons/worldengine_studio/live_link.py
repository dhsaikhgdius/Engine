# SPDX-FileCopyrightText: 2026 OpenEnvision Authors
#
# SPDX-License-Identifier: GPL-2.0-or-later

"""Bounded, preview-only live-link delta feed for the Blender live kernel.

This module is host-free (no ``bpy`` import) so the sequencing, diffing, and
replay-protection logic can be unit-tested outside Blender. The native session
publishes every scene snapshot through :class:`LiveLinkBuffer`; consumers poll
``GET /v1/live-link`` and apply contiguous delta frames on top of the last
authoritative snapshot they loaded.

Live-link frames are NEVER authoritative. They only exist so a Director
client can mirror an in-progress Blender edit with low latency. Dropping the
link, evicting history, or restarting Blender always resolves to "reload the
authoritative snapshot"; the last committed Director revision is untouched.

Replay protection: frames carry a per-scene-epoch monotonic sequence number.
The buffer serves only contiguous runs after a consumer-supplied cursor; a
cursor it cannot serve (older than retained history, unknown epoch, first
contact) yields an explicit ``resync`` response instead of a silent gap.
"""

from __future__ import annotations

from collections import deque
from typing import Any

CONTRACT = "worldengine-blender-live-v1"

DEFAULT_CAPACITY = 128
MAX_UPDATES_PER_FRAME = 512
MAX_FRAMES_PER_POLL = 1_024

_TRANSFORM_FIELDS = ("position", "rotation", "scale")
_CAMERA_FIELDS = ("position", "rotation", "focalLengthMm", "active")
_LIGHT_FIELDS = ("position", "rotation", "color", "energy")


def _entries_by_id(entries: Any) -> dict[str, dict[str, Any]] | None:
    if not isinstance(entries, list):
        return None
    result: dict[str, dict[str, Any]] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            return None
        identifier = entry.get("id")
        if not isinstance(identifier, str) or identifier in result:
            return None
        result[identifier] = entry
    return result


def _object_update(entry: dict[str, Any]) -> dict[str, Any]:
    update: dict[str, Any] = {
        "id": entry["id"],
        "position": entry.get("position"),
        "rotation": entry.get("rotation"),
        "scale": entry.get("scale"),
    }
    director_id = entry.get("directorId")
    if isinstance(director_id, str) and director_id:
        update["directorId"] = director_id
    return update


def _camera_update(entry: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": entry["id"],
        "position": entry.get("position"),
        "rotation": entry.get("rotation"),
        "focalLengthMm": entry.get("focalLengthMm"),
        "active": bool(entry.get("active", False)),
    }


def _light_update(entry: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": entry["id"],
        "position": entry.get("position"),
        "rotation": entry.get("rotation"),
        "color": entry.get("color"),
        "energy": entry.get("energy"),
    }


def _diff_entries(
    before: dict[str, dict[str, Any]],
    after: dict[str, dict[str, Any]],
    delta_fields: tuple[str, ...],
    build_update,
) -> tuple[list[dict[str, Any]], bool]:
    """Return (updates, structural) for one entity collection.

    ``structural`` is True when entities were created or deleted, or when any
    field outside ``delta_fields`` changed (name, visibility, parenting,
    modifier counts, mesh dimensions…). Structural changes cannot be expressed
    as a transform delta, so consumers must refetch the snapshot.
    """
    if before.keys() != after.keys():
        return [], True
    updates: list[dict[str, Any]] = []
    for identifier, entry in after.items():
        previous = before[identifier]
        changed = False
        for key in previous.keys() | entry.keys():
            if previous.get(key) == entry.get(key):
                continue
            if key not in delta_fields:
                return [], True
            changed = True
        if changed:
            updates.append(build_update(entry))
    return updates, False


def build_live_link_frame(
    previous: dict[str, Any] | None,
    current: dict[str, Any],
) -> dict[str, Any] | None:
    """Diff two scene snapshots into one live-link frame body (without seq).

    Returns None when the snapshots describe identical preview state. Any
    uncertainty (malformed collections, duplicate ids) degrades to a
    ``structure`` frame, which forces consumers back to the authoritative
    snapshot instead of applying a possibly wrong delta.
    """
    body = {
        "revision": int(current.get("revision", 0)),
        "contentRevision": int(current.get("contentRevision", current.get("revision", 0))),
        "frame": int(current.get("frame", 0)),
    }

    def structure_frame() -> dict[str, Any]:
        return {**body, "kind": "structure", "objects": [], "cameras": [], "lights": []}

    if previous is None:
        return structure_frame()

    collections = []
    before_objects = _entries_by_id(previous.get("objects", []))
    for key, fields, build in (
        ("objects", _TRANSFORM_FIELDS + ("localTransform",), _object_update),
        ("cameras", _CAMERA_FIELDS, _camera_update),
        ("lights", _LIGHT_FIELDS, _light_update),
    ):
        before = before_objects if key == "objects" else _entries_by_id(previous.get(key, []))
        after = _entries_by_id(current.get(key, []))
        if before is None or after is None:
            return structure_frame()
        updates, structural = _diff_entries(before, after, fields, build)
        if structural:
            return structure_frame()
        collections.append(updates)

    objects, cameras, lights = collections
    # localTransform mirrors the world transform; drop it from the wire and
    # keep only entries whose world-space fields actually changed.
    objects = [
        update
        for update in objects
        if before_objects is not None
        and any(before_objects[update["id"]].get(field) != update.get(field) for field in _TRANSFORM_FIELDS)
    ]
    frame_changed = int(previous.get("frame", 0)) != body["frame"]
    if not objects and not cameras and not lights and not frame_changed:
        return None
    if any(len(updates) > MAX_UPDATES_PER_FRAME for updates in (objects, cameras, lights)):
        return structure_frame()
    return {**body, "kind": "transform", "objects": objects, "cameras": cameras, "lights": lights}


class LiveLinkBuffer:
    """Bounded per-epoch frame history with monotonic sequencing.

    Not thread-safe on its own; the native session serializes access through
    its existing state lock.
    """

    def __init__(self, capacity: int = DEFAULT_CAPACITY):
        if capacity <= 0:
            raise ValueError("live-link capacity must be positive")
        self._capacity = int(capacity)
        self._epoch: str | None = None
        self._seq = 0
        self._frames: deque[dict[str, Any]] = deque()
        self._baseline: dict[str, Any] | None = None

    @property
    def epoch(self) -> str | None:
        return self._epoch

    @property
    def seq(self) -> int:
        return self._seq

    def reset(self, epoch: str) -> None:
        """Start a new scene epoch: history is dropped, sequencing restarts."""
        self._epoch = str(epoch)
        self._seq = 0
        self._frames.clear()
        self._baseline = None

    def publish(self, epoch: str, snapshot: dict[str, Any]) -> dict[str, Any] | None:
        """Publish one snapshot; returns the emitted frame or None for no delta."""
        if epoch != self._epoch:
            self.reset(epoch)
        frame = build_live_link_frame(self._baseline, snapshot)
        self._baseline = snapshot
        if frame is None:
            return None
        self._seq += 1
        frame["seq"] = self._seq
        self._frames.append(frame)
        while len(self._frames) > self._capacity:
            self._frames.popleft()
        return frame

    def state(self) -> dict[str, Any]:
        """Health stanza for /health."""
        return {
            "seq": self._seq,
            "bufferedFrames": len(self._frames),
            "capacity": self._capacity,
        }

    def poll(self, requested_epoch: str | None, since: int | None) -> dict[str, Any]:
        """Serve a consumer cursor: contiguous frames or an explicit resync."""
        current_epoch = self._epoch or ""
        base = {"contract": CONTRACT, "sceneEpoch": current_epoch, "seq": self._seq}
        if requested_epoch is None or since is None:
            return {**base, "kind": "resync", "reason": "initial"}
        if requested_epoch != current_epoch:
            return {**base, "kind": "resync", "reason": "epoch_changed"}
        since_value = int(since)
        if since_value > self._seq:
            # A cursor from the future can only come from a stale epoch reuse
            # or a corrupted consumer; treat it like lost history.
            return {**base, "kind": "resync", "reason": "history_evicted"}
        oldest_served = self._seq - len(self._frames) + 1 if self._frames else self._seq + 1
        if since_value + 1 < oldest_served and since_value < self._seq:
            return {**base, "kind": "resync", "reason": "history_evicted"}
        frames = [frame for frame in self._frames if frame["seq"] > since_value]
        return {**base, "kind": "frames", "frames": frames[:MAX_FRAMES_PER_POLL]}
