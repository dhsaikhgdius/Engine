"""Export a manifest-first Director return package from a refined .blend.

The script only reads Director's source manifest, inspects objects carrying the
stable ``director_id`` custom property, and writes GLB files plus hashes below
``--output-dir``. It never executes package code or resolves remote URLs.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
import traceback
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

_INTERCHANGE_DIR = str(Path(__file__).resolve().parent)
if _INTERCHANGE_DIR not in sys.path:
    sys.path.insert(0, _INTERCHANGE_DIR)

from director_pose_bones import (
    LOCATION_TOLERANCE,
    MIN_DELTA_DEGREES,
    SCALE_TOLERANCE,
    pose_bone_rotation_delta,
    reconcile_pose_bone_deltas,
    rotation_angle_degrees,
    vectors_close,
)
from director_properties import (
    POSE_BONE_BASELINE_PROPERTY,
    POSE_BONE_MAP_PROPERTY,
    POSE_CONTROL_PREFIX,
    POSE_CONTROLS_BASELINE_PROPERTY,
    SOURCE_CAMERA_OPTICS_PROPERTY,
    SOURCE_LIGHT_PROPERTY,
    SOURCE_MESH_SIGNATURE_PROPERTY,
    SOURCE_POSE_FINGERPRINT_PROPERTY,
    SOURCE_TRANSFORM_PROPERTY,
    SOURCE_UNMAPPED_POSE_FINGERPRINT_PROPERTY,
)
from director_signature import armature_pose_fingerprint, mesh_content_signature

try:  # Allows CI to exercise --help and pure helpers without Blender installed.
    import bpy  # type: ignore
except ModuleNotFoundError:  # pragma: no cover - real execution happens in Blender.
    bpy = None


CONTRACT = "director-dcc-return-v1"
RESULT_PREFIX = "DIRECTOR_DCC_RETURN_RESULT:"
TRANSFORM_TOLERANCE = 1e-6
# Optics/light/pose baselines survive float32 storage in Blender datablocks,
# so diffs use a coarser tolerance than transforms to avoid phantom changes.
BASELINE_VALUE_TOLERANCE = 1e-4
CAMERA_OPTICS_RETURN_FIELDS = ("focalLengthMm", "apertureFStop", "focusDistanceM", "nearClipM", "farClipM")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """Parse CLI arguments, honoring Blender's ``--`` script-argument separator.

    When run as ``blender ... --python this.py -- <args>``, everything before
    ``--`` belongs to Blender itself and must not reach argparse.
    """
    raw = list(sys.argv if argv is None else argv)
    separator = raw.index("--") if "--" in raw else 0
    arguments = raw[separator + 1 :] if separator else raw[1:]
    parser = argparse.ArgumentParser(description="Export a Director Blender return package")
    parser.add_argument("--source-manifest", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--report", required=True)
    return parser.parse_args(arguments)


def ensure_inside(parent: Path, child: Path) -> Path:
    """Resolve ``child`` and reject it unless it stays under ``parent``.

    Every output path (meshes, manifest, report) is gated through this check
    so a hostile manifest id or report argument cannot escape ``--output-dir``.
    """
    resolved_parent = parent.resolve()
    resolved_child = child.resolve()
    try:
        resolved_child.relative_to(resolved_parent)
    except ValueError as error:
        raise ValueError(f"Output path escaped {resolved_parent}: {resolved_child}") from error
    return resolved_child


def read_source_manifest(path: Path) -> dict[str, Any]:
    """Load and gate Director's source manifest (director-dcc-scene-v1).

    The packageId/sourceRevision pair is what lets the gateway apply the
    return package against the exact snapshot the artist refined, so a
    manifest missing either is rejected instead of guessed at.
    """
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("schemaVersion") != 1 or payload.get("contract") != "director-dcc-scene-v1":
        raise ValueError("Unsupported Director source DCC contract")
    if not isinstance(payload.get("packageId"), str) or not isinstance(payload.get("sourceRevision"), str):
        raise ValueError("Director source manifest is missing packageId/sourceRevision")
    return payload


def safe_file_stem(value: str) -> str:
    """Turn a director_id into a filesystem-safe GLB stem (never empty)."""
    normalized = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-.")[:96]
    return normalized or "director-object"


def sha256_file(path: Path) -> str:
    """Stream a file's sha256 for the manifest's fileHashes integrity map."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def blender_transform(target: Any) -> dict[str, list[float]]:
    """Decompose a world matrix into the Blender-space transform record.

    Values stay in Blender's Z-up frame; the gateway applies the manifest's
    declared linearMap when converting back to Director's Y-up scene, so this
    script never performs the axis swap itself.
    """
    location, rotation, scale = target.matrix_world.decompose()
    rotation.normalize()
    return {
        "location": [float(location.x), float(location.y), float(location.z)],
        "rotationQuaternion": [float(rotation.x), float(rotation.y), float(rotation.z), float(rotation.w)],
        "scale": [float(scale.x), float(scale.y), float(scale.z)],
    }


def transforms_equal(left: dict[str, Any], right: dict[str, Any], tolerance: float = TRANSFORM_TOLERANCE) -> bool:
    """Compare two transform records, treating q and -q as the same rotation.

    Used to decide whether the artist moved an object at all; a false
    positive would emit a spurious transform_update that could clobber a
    Director-side animation, so malformed records compare as unequal.
    """
    for key in ("location", "scale"):
        left_values = left.get(key)
        right_values = right.get(key)
        if not isinstance(left_values, list) or not isinstance(right_values, list) or len(left_values) != len(right_values):
            return False
        if any(not math.isclose(float(a), float(b), abs_tol=tolerance, rel_tol=tolerance) for a, b in zip(left_values, right_values)):
            return False
    left_rotation = left.get("rotationQuaternion")
    right_rotation = right.get("rotationQuaternion")
    if not isinstance(left_rotation, list) or not isinstance(right_rotation, list) or len(left_rotation) != 4 or len(right_rotation) != 4:
        return False
    left_norm = math.sqrt(sum(float(value) ** 2 for value in left_rotation))
    right_norm = math.sqrt(sum(float(value) ** 2 for value in right_rotation))
    if left_norm <= tolerance or right_norm <= tolerance:
        return False
    dot = sum(float(a) * float(b) for a, b in zip(left_rotation, right_rotation)) / (left_norm * right_norm)
    # q and -q encode the same rotation. Blender may choose either sign when a
    # matrix is decomposed after saving/reopening a file.
    return math.isclose(abs(dot), 1.0, abs_tol=tolerance, rel_tol=tolerance)


def _stored_transform(root: Any, fallback: dict[str, Any]) -> dict[str, Any]:
    """Read the import-time transform baseline stamped by director_bridge.py.

    The stamped baseline beats the manifest value because Blender's float32
    datablock storage may have quantized what the bridge actually applied;
    diffing against the manifest directly would report phantom edits.
    """
    raw = root.get(SOURCE_TRANSFORM_PROPERTY)
    if not isinstance(raw, str):
        return fallback
    try:
        value = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return fallback
    required = ("location", "rotationQuaternion", "scale")
    return value if isinstance(value, dict) and all(isinstance(value.get(key), list) for key in required) else fallback


def _stored_json_object(root: Any, property_name: str) -> dict[str, Any] | None:
    """Decode a JSON-object custom property; None for missing/corrupt values."""
    raw = root.get(property_name)
    if not isinstance(raw, str):
        return None
    try:
        value = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def scalar_close(left: float, right: float, tolerance: float = BASELINE_VALUE_TOLERANCE) -> bool:
    """Relative-with-floor comparison sized for float32 baseline round-trips."""
    return abs(left - right) <= max(abs(left), abs(right), 1.0) * tolerance


def vector_close(left: Any, right: Any, tolerance: float = BASELINE_VALUE_TOLERANCE) -> bool:
    """Component-wise scalar_close over two same-length numeric sequences."""
    if not isinstance(left, (list, tuple)) or not isinstance(right, (list, tuple)) or len(left) != len(right):
        return False
    return all(scalar_close(float(a), float(b), tolerance) for a, b in zip(left, right))


def color_to_hex(channels: Any) -> str:
    """Encode a Blender 0-1 RGB triplet as #rrggbb, inverting the bridge's raw mapping."""
    clamped = [min(1.0, max(0.0, float(value))) for value in list(channels)[:3]]
    return "#" + "".join(f"{round(value * 255):02x}" for value in clamped)


def diff_camera_optics(
    baseline: dict[str, Any],
    current: dict[str, Any],
    tolerance: float = BASELINE_VALUE_TOLERANCE,
) -> tuple[dict[str, float], list[str]]:
    """Return the changed camera optics fields plus warn-and-omit notes.

    Sensor dimensions are compared but never emitted: Director sensor formats
    are named gates, so a Blender-side sensor edit cannot be mapped back
    without guessing. It is reported as a warning instead of silently flattened.
    """
    warnings: list[str] = []
    optics: dict[str, float] = {}
    for field in CAMERA_OPTICS_RETURN_FIELDS:
        base = baseline.get(field)
        value = current.get(field)
        if base is None or value is None:
            continue
        if not scalar_close(float(value), float(base), tolerance):
            if float(value) > 0 and math.isfinite(float(value)):
                optics[field] = float(value)
            else:
                warnings.append(f"camera {field} {value!r} is not a positive finite number; the edit was omitted.")
    for field in ("sensorWidthMm", "sensorHeightMm"):
        base = baseline.get(field)
        value = current.get(field)
        if base is not None and value is not None and not scalar_close(float(value), float(base), tolerance):
            warnings.append(
                "camera sensor dimensions changed in Blender, but Director sensor formats are named gates; "
                "the sensor edit was omitted (choose a sensor format in Director instead)."
            )
            break
    return optics, warnings


def light_update_properties(
    baseline: dict[str, Any],
    current: dict[str, Any],
    tolerance: float = BASELINE_VALUE_TOLERANCE,
) -> tuple[dict[str, Any], list[str]]:
    """Diff a light's current state against its import baseline.

    ``current['energy']`` is inverted to Director intensity through the
    deterministic watts-per-intensity factor stamped at import; values outside
    Director's 0-100 range are baked to the nearest limit with a warning.
    """
    warnings: list[str] = []
    properties: dict[str, Any] = {}
    if isinstance(baseline.get("position"), list) and not vector_close(current["position"], baseline["position"], tolerance):
        properties["position"] = [float(value) for value in current["position"]]
    if (
        isinstance(baseline.get("target"), list)
        and isinstance(current.get("target"), (list, tuple))
        # Aim recovery goes through a quaternion, so allow more float noise.
        and not vector_close(current["target"], baseline["target"], max(tolerance, 1e-3))
    ):
        properties["target"] = [float(value) for value in current["target"]]
    if isinstance(baseline.get("color"), str) and current["color"].lower() != baseline["color"].lower():
        properties["color"] = current["color"]
    watts = float(baseline.get("wattsPerIntensity") or 1.0)
    intensity = float(current["energy"]) / watts
    if intensity < 0.0 or intensity > 100.0:
        clamped = min(100.0, max(0.0, intensity))
        warnings.append(
            f"intensity {intensity:.3f} (from {float(current['energy']):.3f} W at {watts:g} W per unit) is outside "
            f"Director's 0-100 range and was baked to {clamped:g}."
        )
        intensity = clamped
    if not scalar_close(intensity, float(baseline.get("intensity", 0.0)), max(tolerance, 1e-3)):
        properties["intensity"] = intensity
    return properties, warnings


def current_pose_controls(root: Any, baseline: dict[str, Any]) -> tuple[dict[str, float], list[str]]:
    """Read the editable director_pose.* custom properties for every baseline control.

    Controls whose property was deleted or is not a finite number keep their
    baseline value with a warning; unknown director_pose.* properties are
    reported and ignored so a Blender-side typo cannot silently become a no-op.
    """
    warnings: list[str] = []
    sample: dict[str, float] = {}
    for control, value in baseline.items():
        raw = root.get(POSE_CONTROL_PREFIX + control)
        if isinstance(raw, (int, float)) and math.isfinite(float(raw)):
            sample[control] = float(raw)
        else:
            warnings.append(
                f"pose control {control!r} custom property is missing or not a finite number; "
                f"its baseline value {float(value):g} was kept."
            )
            sample[control] = float(value)
    known = {POSE_CONTROL_PREFIX + control for control in baseline}
    for key in root.keys():
        if isinstance(key, str) and key.startswith(POSE_CONTROL_PREFIX) and key not in known:
            warnings.append(f"pose control property {key!r} is not a portable Director control; it was ignored.")
    return sample, warnings


def pose_controls_changed(
    baseline: dict[str, Any],
    sample: dict[str, float],
    tolerance: float = BASELINE_VALUE_TOLERANCE,
) -> bool:
    """True when any director_pose.* control drifted from its export baseline."""
    return any(not scalar_close(sample[control], float(value), tolerance) for control, value in baseline.items())


def reconcile_pose_bones(root: Any, pose_baseline: dict[str, Any]) -> tuple[dict[str, float], list[str]] | None:
    """Reconcile direct pose-bone edits into portable director_pose.* controls.

    Uses the bone map plus per-bone baselines stamped by director_bridge.py.
    Only local rotations of mapped bones reconcile (as per-axis degree deltas
    added to the exported control baseline); bone translations, bone scale,
    unmapped bones, and rotation components without a portable control are
    warned about and omitted. Returns ``None`` when this .blend predates the
    stamped bone map, in which case the caller keeps the blanket warning.
    """
    bone_map = _stored_json_object(root, POSE_BONE_MAP_PROPERTY)
    bone_baselines = _stored_json_object(root, POSE_BONE_BASELINE_PROPERTY)
    if not bone_map or not bone_baselines or not isinstance(bone_map.get("bones"), dict):
        return None
    warnings: list[str] = []
    armature = next(
        (item for item in descendants(root) if item.type == "ARMATURE" and item.name == bone_map.get("armature")),
        None,
    )
    if armature is None:
        warnings.append(
            f"the mapped armature {bone_map.get('armature')!r} was renamed or removed; direct pose-bone edits "
            "were not reconciled."
        )
        return {}, warnings
    stored_unmapped = root.get(SOURCE_UNMAPPED_POSE_FINGERPRINT_PROPERTY)
    if isinstance(stored_unmapped, str):
        live_unmapped = armature_pose_fingerprint(
            root, exclude={(armature.name, str(name)) for name in bone_map["bones"].values()}
        )
        if live_unmapped is not None and live_unmapped != stored_unmapped:
            warnings.append(
                "pose bones outside the Director character binding were edited; those edits have no portable "
                "director_pose.* controls and were omitted."
            )
    deltas: dict[str, tuple[float, float, float, float]] = {}
    for role in sorted(bone_map["bones"]):
        bone_name = str(bone_map["bones"][role])
        baseline = bone_baselines.get(role)
        if not isinstance(baseline, dict) or not isinstance(baseline.get("rotation"), list):
            continue
        bone = armature.pose.bones.get(bone_name)
        if bone is None:
            warnings.append(f"mapped {role} bone {bone_name!r} no longer exists; its pose edit was omitted.")
            continue
        location, rotation, scale = bone.matrix_basis.decompose()
        if isinstance(baseline.get("location"), list) and not vectors_close(
            (location.x, location.y, location.z), baseline["location"], LOCATION_TOLERANCE
        ):
            hint = " (edit the director_pose.body.offsetY custom property instead)" if role == "body" else ""
            warnings.append(
                f"{role} bone {bone_name!r} was translated; bone translations have no portable Director "
                f"control and were omitted{hint}."
            )
        if isinstance(baseline.get("scale"), list) and not vectors_close(
            (scale.x, scale.y, scale.z), baseline["scale"], SCALE_TOLERANCE
        ):
            warnings.append(
                f"{role} bone {bone_name!r} was scaled; bone scale has no portable Director control and was omitted."
            )
        delta = pose_bone_rotation_delta(baseline["rotation"], (rotation.w, rotation.x, rotation.y, rotation.z))
        if rotation_angle_degrees(delta) >= MIN_DELTA_DEGREES:
            deltas[role] = delta
    controls, reconcile_warnings = reconcile_pose_bone_deltas(deltas, pose_baseline)
    warnings.extend(reconcile_warnings)
    return controls, warnings


def descendants(root: Any) -> list[Any]:
    """Root plus all recursive children -- the whole Director object subtree."""
    return [root, *list(root.children_recursive)]


def descendant_meshes(root: Any) -> list[Any]:
    """The mesh objects inside a Director object subtree."""
    return [item for item in descendants(root) if item.type == "MESH"]


# Object types the Director return contract tracks. Everything else is either
# baked by the GLB exporter (curves, text) or silently dropped (grease pencil),
# so an addition carrying them must say so instead of pretending fidelity.
ADDITION_TRACKED_TYPES = frozenset({"MESH", "EMPTY", "ARMATURE"})

# Default Blender datablock names; an addition keeping one becomes an equally
# anonymous Director object, which is worth a review warning.
_DEFAULT_BLENDER_NAMES = frozenset(
    name.lower()
    for name in (
        "cube",
        "sphere",
        "icosphere",
        "cylinder",
        "cone",
        "torus",
        "plane",
        "circle",
        "grid",
        "monkey",
        "suzanne",
        "empty",
        "text",
        "curve",
        "surface",
        "mball",
    )
)


def is_default_blender_name(name: Any) -> bool:
    """True for unnamed/auto-named datablocks like ``Cube`` or ``Cube.001``."""
    if not isinstance(name, str) or not name.strip():
        return True
    stem = re.sub(r"\.\d{3,}$", "", name.strip())
    return stem.lower() in _DEFAULT_BLENDER_NAMES


def addition_review_warnings(root: Any) -> list[str]:
    """Review notes for a new Blender object before it becomes a Director prop.

    The addition is still exported; these warnings surface unnamed datablocks,
    untracked datablock types, and linked-library provenance so the reviewer
    can reject the plan instead of discovering silent loss later.
    """
    director_id = root.get("director_id")
    warnings: list[str] = []
    if is_default_blender_name(getattr(root, "name", None)):
        warnings.append(
            f"{director_id}: new object keeps the default Blender name {getattr(root, 'name', '')!r}; "
            "rename it before import so the Director object is identifiable."
        )
    for item in descendants(root):
        if item.type not in ADDITION_TRACKED_TYPES:
            warnings.append(
                f"{director_id}: {item.name} is a {item.type} datablock that Director does not track; "
                "the GLB exporter may bake or drop it, so verify the imported mesh."
            )
        if getattr(item, "library", None) is not None or getattr(getattr(item, "data", None), "library", None) is not None:
            warnings.append(
                f"{director_id}: {item.name} uses a linked library datablock; the return package embeds a baked "
                "copy and Director does not track the library reference."
            )
    return warnings


def has_director_ancestor(root: Any) -> bool:
    """True when any ancestor carries its own director_id (root is inside a tracked object)."""
    parent = getattr(root, "parent", None)
    while parent is not None:
        parent_id = parent.get("director_id")
        if isinstance(parent_id, str) and parent_id.strip():
            return True
        parent = getattr(parent, "parent", None)
    return False


def unapplied_modifier_warnings(root: Any) -> list[str]:
    """Warn about live modifier stacks so evaluated-vs-authored geometry is explicit.

    The GLB exporter evaluates modifiers, which may differ from what the
    artist sees in edit mode; Director never applies or bakes them itself.
    """
    warnings: list[str] = []
    for mesh in descendant_meshes(root):
        if len(mesh.modifiers):
            names = ", ".join(modifier.name for modifier in mesh.modifiers)
            warnings.append(
                f"{root.get('director_id')}: {mesh.name} has unapplied modifiers ({names}); "
                "the GLB exporter may evaluate them, but Director did not silently apply or bake them."
            )
    return warnings


def set_director_extras(root: Any, source_item: dict[str, Any]) -> tuple[bool, Any]:
    """Temporarily stamp the Director glTF extras block onto the export root.

    Returns the previous state so restore_director_extras can undo the write:
    exporting must not permanently mutate the artist's .blend.
    """
    existed = "director" in root
    previous = root.get("director")
    root["director"] = {
        "adapter": "director-gltf-v1",
        "contract": "director-interchange-v1",
        "stableId": source_item["id"],
        "entityType": "object",
        "kind": source_item.get("kind", "prop"),
        **({"assetRefId": source_item["assetRefId"]} if source_item.get("assetRefId") else {}),
    }
    return existed, previous


def restore_director_extras(root: Any, state: tuple[bool, Any]) -> None:
    """Undo set_director_extras exactly, including a previously absent key."""
    existed, previous = state
    if existed:
        root["director"] = previous
    elif "director" in root:
        del root["director"]


@contextmanager
def asset_space_root(root: Any):
    """Temporarily remove the Director wrapper transform/action from a GLB export."""
    if bpy is None:
        raise RuntimeError("Blender Python API is unavailable")
    from mathutils import Matrix  # Blender-only and keeps this module import-safe in CI.

    original_matrix = root.matrix_world.copy()
    animation = getattr(root, "animation_data", None)
    original_action = getattr(animation, "action", None) if animation else None
    tracks = list(getattr(animation, "nla_tracks", [])) if animation else []
    original_mutes = [track.mute for track in tracks]
    try:
        if animation:
            animation.action = None
            for track in tracks:
                track.mute = True
        root.matrix_world = Matrix.Identity(4)
        bpy.context.view_layer.update()
        yield
    finally:
        root.matrix_world = original_matrix
        if animation:
            animation.action = original_action
            for track, muted in zip(tracks, original_mutes):
                track.mute = muted
        bpy.context.scene.frame_set(bpy.context.scene.frame_current)
        bpy.context.view_layer.update()


def export_glb(root: Any, destination: Path, source_item: dict[str, Any]) -> None:
    """Export one Director object subtree as a selection-scoped GLB.

    The root is neutralized to asset space (identity transform, animation
    muted) during export so the GLB carries pure geometry; the Director
    wrapper transform travels separately in the manifest change record.
    ``export_apply=False`` is attempted first to keep modifiers unapplied.
    """
    if bpy is None:
        raise RuntimeError("Blender Python API is unavailable")
    bpy.ops.object.select_all(action="DESELECT")
    for item in descendants(root):
        item.hide_set(False)
        item.select_set(True)
    bpy.context.view_layer.objects.active = root
    extras_state = set_director_extras(root, source_item)
    try:
        options = {
            "filepath": str(destination),
            "export_format": "GLB",
            "use_selection": True,
            "export_extras": True,
        }
        with asset_space_root(root):
            try:
                bpy.ops.export_scene.gltf(**options, export_apply=False)
            except TypeError:  # Blender versions that do not expose export_apply.
                bpy.ops.export_scene.gltf(**options)
    finally:
        restore_director_extras(root, extras_state)
        bpy.ops.object.select_all(action="DESELECT")
    inject_stable_id_extras(destination, root.name, source_item)


def inject_stable_id_extras(path: Path, root_name: str, source_item: dict[str, Any]) -> None:
    """Ensure Blender's GLB exporter emits the Director metadata shape.

    Blender versions differ in how nested ID properties are serialized. Patch
    the JSON chunk after export so the return contract remains deterministic.
    The binary chunk is copied byte-for-byte and no mesh bytes are interpreted.
    """
    payload = bytearray(path.read_bytes())
    if len(payload) < 20 or bytes(payload[:4]) != b"glTF":
        raise ValueError(f"Blender did not produce a GLB at {path}")
    version = int.from_bytes(payload[4:8], "little")
    if version != 2:
        raise ValueError(f"Unsupported GLB version {version}")
    offset = 12
    json_start = None
    json_end = None
    json_payload: dict[str, Any] | None = None
    chunks: list[tuple[int, bytes]] = []
    while offset + 8 <= len(payload):
        chunk_length = int.from_bytes(payload[offset : offset + 4], "little")
        chunk_type = int.from_bytes(payload[offset + 4 : offset + 8], "little")
        chunk_start = offset + 8
        chunk_end = chunk_start + chunk_length
        if chunk_end > len(payload):
            raise ValueError("GLB chunk exceeds file length")
        chunk = bytes(payload[chunk_start:chunk_end])
        chunks.append((chunk_type, chunk))
        if chunk_type == 0x4E4F534A and json_payload is None:
            json_start, json_end = chunk_start, chunk_end
            try:
                json_payload = json.loads(chunk.rstrip(b" \t\r\n").decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise ValueError("GLB JSON chunk is invalid") from error
        offset = chunk_end
    if json_payload is None or json_start is None or json_end is None:
        raise ValueError("GLB has no JSON chunk")
    nodes = json_payload.setdefault("nodes", [])
    if not isinstance(nodes, list):
        raise ValueError("GLB nodes must be an array")
    selected = next((node for node in nodes if isinstance(node, dict) and node.get("name") == root_name), None)
    if selected is None:
        selected = next((node for node in nodes if isinstance(node, dict)), None)
    if selected is None:
        selected = {"name": root_name}
        nodes.append(selected)
    extras = selected.setdefault("extras", {})
    if not isinstance(extras, dict):
        extras = {}
        selected["extras"] = extras
    extras["director"] = {
        "adapter": "director-gltf-v1",
        "contract": "director-interchange-v1",
        "stableId": source_item["id"],
        "entityType": "object",
        "kind": source_item.get("kind", "prop"),
        **({"assetRefId": source_item["assetRefId"]} if source_item.get("assetRefId") else {}),
    }
    encoded = json.dumps(json_payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    encoded += b" " * ((4 - len(encoded) % 4) % 4)
    rebuilt = bytearray(payload[:12])
    replaced = False
    for chunk_type, chunk in chunks:
        content = encoded if chunk_type == 0x4E4F534A and not replaced else chunk
        replaced = replaced or chunk_type == 0x4E4F534A
        rebuilt.extend(len(content).to_bytes(4, "little"))
        rebuilt.extend(chunk_type.to_bytes(4, "little"))
        rebuilt.extend(content)
    rebuilt[8:12] = len(rebuilt).to_bytes(4, "little")
    path.write_bytes(rebuilt)


def current_camera_optics(root: Any) -> dict[str, float]:
    """Read the live camera optics in the shape stamped by director_bridge.py."""
    data = root.data
    return {
        "focalLengthMm": float(data.lens),
        "apertureFStop": float(data.dof.aperture_fstop),
        "focusDistanceM": float(data.dof.focus_distance),
        "nearClipM": float(data.clip_start),
        "farClipM": float(data.clip_end),
        "sensorWidthMm": float(data.sensor_width),
        "sensorHeightMm": float(data.sensor_height),
    }


def current_light_state(root: Any, baseline: dict[str, Any]) -> dict[str, Any]:
    """Read a light's world position, aim target, color, and energy.

    The target is recovered on the light's -Z aim ray at the baseline
    target distance, because Blender stores an orientation while Director
    stores a look-at point; the distance itself is not an authored quantity.
    """
    from mathutils import Vector  # Blender-only; keeps this module import-safe in CI.

    translation = root.matrix_world.translation
    state: dict[str, Any] = {
        "position": [float(translation.x), float(translation.y), float(translation.z)],
        "color": color_to_hex(root.data.color),
        "energy": float(root.data.energy),
    }
    if isinstance(baseline.get("target"), list) and isinstance(baseline.get("position"), list):
        distance = (Vector(baseline["target"]) - Vector(baseline["position"])).length
        direction = root.matrix_world.to_quaternion() @ Vector((0.0, 0.0, -1.0))
        target = translation + direction * distance
        state["target"] = [float(target.x), float(target.y), float(target.z)]
    return state


def director_roots(objects: Iterable[Any]) -> list[Any]:
    """Objects that carry their own director_id (not inherited from a parent).

    A child sharing its parent's director_id is part of the same Director
    object (the bridge stamps imported subtrees that way) and must not be
    diffed or exported as a second root.
    """
    roots: list[Any] = []
    for item in objects:
        director_id = item.get("director_id")
        if not isinstance(director_id, str) or not director_id.strip():
            continue
        parent_id = item.parent.get("director_id") if item.parent else None
        if parent_id == director_id:
            continue
        roots.append(item)
    return roots


def build_return_package(source: dict[str, Any], output_dir: Path) -> dict[str, Any]:
    """Diff the open .blend against the source snapshot and emit the manifest.

    Walks every director_roots object and classifies it into exactly one
    change kind per entity -- object_addition, light_update, camera_update,
    mesh_replacement, pose_update, or transform_update -- diffing current
    state against the baselines stamped at import. Anything that cannot
    round-trip faithfully (sensor edits, unmapped pose bones, untracked
    datablocks, id-less objects) becomes a warning instead of a silent guess,
    matching the omitted-channel policy of the source export.

    The returned manifest declares the Blender->Director coordinate mapping
    ((x,y,z)->(x,z,-y), Z-up to Y-up) so the gateway owns the axis conversion.
    """
    if bpy is None:
        raise RuntimeError("director_return_export.py must run inside Blender")
    meshes_dir = ensure_inside(output_dir, output_dir / "meshes")
    meshes_dir.mkdir(parents=True, exist_ok=True)
    source_objects = {item["id"]: item for item in source.get("objects", []) if isinstance(item.get("id"), str)}
    source_cameras = {item["id"]: item for item in source.get("cameras", []) if isinstance(item.get("id"), str)}
    source_lights = {item["id"]: item for item in source.get("lights") or [] if isinstance(item.get("id"), str)}
    changes: list[dict[str, Any]] = []
    warnings: list[str] = []
    file_hashes: dict[str, str] = {}
    used_stems: set[str] = set()

    seen_addition_ids: set[str] = set()
    for root in director_roots(bpy.context.scene.objects):
        director_id = str(root.get("director_id"))
        source_object = source_objects.get(director_id)
        source_camera = source_cameras.get(director_id)
        source_light = source_lights.get(director_id)
        current_transform = blender_transform(root)
        if source_object is None and source_camera is None and source_light is None:
            # A director_id the snapshot never issued marks a new Blender object
            # offered for reviewed, opt-in import. Only explicitly marked roots
            # are considered; the whole .blend is never swept for additions.
            if has_director_ancestor(root):
                warnings.append(
                    f"{root.name}: new director_id {director_id!r} sits inside an existing Director object; "
                    "it was not exported as an addition (refine the parent object's mesh instead)."
                )
                continue
            if director_id in seen_addition_ids:
                warnings.append(
                    f"{root.name}: duplicate new director_id {director_id!r}; only the first object was exported."
                )
                continue
            if not descendant_meshes(root):
                warnings.append(
                    f"{root.name}: new director_id {director_id!r} has no mesh geometry; Director additions import "
                    "as mesh props, so it was skipped."
                )
                continue
            seen_addition_ids.add(director_id)
            warnings.extend(addition_review_warnings(root))
            warnings.extend(unapplied_modifier_warnings(root))
            stem = safe_file_stem(director_id)
            if stem in used_stems:
                stem = f"{stem}-{hashlib.sha256(director_id.encode('utf-8')).hexdigest()[:8]}"
            used_stems.add(stem)
            relative_path = f"meshes/{stem}.glb"
            mesh_path = ensure_inside(output_dir, output_dir / relative_path)
            export_glb(root, mesh_path, {"id": director_id, "kind": "prop"})
            file_hashes[relative_path] = sha256_file(mesh_path)
            changes.append(
                {
                    "kind": "object_addition",
                    "directorId": director_id,
                    "entityType": "object",
                    "name": str(root.name)[:240],
                    "meshFile": relative_path,
                    "transform": current_transform,
                    "assetLabel": f"{str(root.name)[:230]} (Blender)",
                }
            )
            continue
        if source_light is not None:
            if root.type != "LIGHT":
                warnings.append(
                    f"{director_id}: {root.name} carries a Director light id but is not a Blender light; skipped."
                )
                continue
            light_baseline = _stored_json_object(root, SOURCE_LIGHT_PROPERTY) or source_light
            properties, light_warnings = light_update_properties(light_baseline, current_light_state(root, light_baseline))
            warnings.extend(f"{director_id}: {message}" for message in light_warnings)
            if properties:
                changes.append(
                    {
                        "kind": "light_update",
                        "directorId": director_id,
                        "entityType": "light",
                        "properties": properties,
                    }
                )
            continue
        if source_camera is not None:
            transform_changed = not transforms_equal(current_transform, _stored_transform(root, source_camera["transform"]))
            optics_baseline = _stored_json_object(root, SOURCE_CAMERA_OPTICS_PROPERTY)
            legacy_optics_baseline = optics_baseline is None
            if legacy_optics_baseline:
                optics_baseline = {
                    field: source_camera.get(field)
                    for field in CAMERA_OPTICS_RETURN_FIELDS
                    if source_camera.get(field) is not None
                }
            optics: dict[str, float] = {}
            if getattr(root, "type", None) == "CAMERA" and optics_baseline:
                optics, optics_warnings = diff_camera_optics(optics_baseline, current_camera_optics(root))
                warnings.extend(f"{director_id}: {message}" for message in optics_warnings)
                if optics and legacy_optics_baseline:
                    # A pre-optics .blend cannot distinguish an artist edit from
                    # a focal-length animation evaluated at currentFrame, so the
                    # optics are omitted rather than silently guessed.
                    warnings.append(
                        f"{director_id}: camera optics appear edited, but this .blend predates stamped optics "
                        "baselines; the optics were omitted. Re-export the scene from Director to round-trip optics."
                    )
                    optics = {}
            if optics:
                change = {
                    "kind": "camera_update",
                    "directorId": director_id,
                    "entityType": "camera",
                    "optics": optics,
                }
                if transform_changed:
                    change["transform"] = current_transform
                changes.append(change)
            elif transform_changed:
                changes.append(
                    {
                        "kind": "transform_update",
                        "directorId": director_id,
                        "entityType": "camera",
                        "transform": current_transform,
                    }
                )
            continue

        meshes = descendant_meshes(root)
        source_transform = _stored_transform(root, source_object["transform"])
        transform_changed = not transforms_equal(current_transform, source_transform)
        source_mesh_signature = root.get(SOURCE_MESH_SIGNATURE_PROPERTY)
        current_mesh_signature = mesh_content_signature(root) if meshes else None
        mesh_changed = bool(meshes) and (
            not isinstance(source_mesh_signature, str) or source_mesh_signature != current_mesh_signature
        )

        pose_baseline = _stored_json_object(root, POSE_CONTROLS_BASELINE_PROPERTY)
        pose_changed = False
        pose_sample: dict[str, float] = {}
        explicit_controls: set[str] = set()
        if pose_baseline:
            pose_sample, pose_warnings = current_pose_controls(root, pose_baseline)
            warnings.extend(f"{director_id}: {message}" for message in pose_warnings)
            explicit_controls = {
                control for control, value in pose_baseline.items() if not scalar_close(pose_sample[control], float(value))
            }
            pose_changed = bool(explicit_controls)
        stored_pose_fingerprint = root.get(SOURCE_POSE_FINGERPRINT_PROPERTY)
        if isinstance(stored_pose_fingerprint, str):
            live_pose_fingerprint = armature_pose_fingerprint(root)
            if live_pose_fingerprint is not None and live_pose_fingerprint != stored_pose_fingerprint:
                reconciled = reconcile_pose_bones(root, pose_baseline) if pose_baseline else None
                if reconciled is None:
                    # Legacy .blend without a stamped bone map, or an armature
                    # object with no Director pose binding: stay warn-and-omit.
                    warnings.append(
                        f"{director_id}: armature pose bones were edited directly in Blender; those edits are not "
                        "reconciled to Director. Only director_pose.* control values round-trip — bake the intent "
                        "into those controls, or export the refined mesh instead."
                    )
                else:
                    bone_controls, bone_warnings = reconciled
                    warnings.extend(f"{director_id}: {message}" for message in bone_warnings)
                    for control in sorted(bone_controls):
                        if control in explicit_controls:
                            # Custom-property edits are explicit intent; a bone
                            # edit on the same control never overrides them.
                            warnings.append(
                                f"{director_id}: pose control {control!r} was edited both as a custom property and "
                                "through its mapped pose bone; the explicit custom-property value wins."
                            )
                            continue
                        pose_sample[control] = bone_controls[control]
                        pose_changed = True

        if mesh_changed:
            if not isinstance(source_mesh_signature, str):
                warnings.append(
                    f"{director_id}: source mesh fingerprint is missing (legacy .blend); exported conservatively."
                )
            stem = safe_file_stem(director_id)
            if stem in used_stems:
                stem = f"{stem}-{hashlib.sha256(director_id.encode('utf-8')).hexdigest()[:8]}"
            used_stems.add(stem)
            relative_path = f"meshes/{stem}.glb"
            mesh_path = ensure_inside(output_dir, output_dir / relative_path)
            warnings.extend(unapplied_modifier_warnings(root))
            export_glb(root, mesh_path, source_object)
            file_hashes[relative_path] = sha256_file(mesh_path)
            change = {
                "kind": "mesh_replacement",
                "directorId": director_id,
                "entityType": "object",
                "meshFile": relative_path,
                "assetLabel": f"{source_object.get('name', director_id)} refined",
            }
            # The GLB root is already neutralized to asset space. Only carry the
            # Director wrapper transform when the artist changed it as a separate
            # intent; otherwise a mesh-only refinement must not rewrite the base
            # transform (especially for an object animated at currentFrame).
            if transform_changed:
                change["transform"] = current_transform
            changes.append(change)
            if pose_changed:
                # The return contract allows one change per entity; a mesh
                # replacement wins over a pose sample, never silently both.
                warnings.append(
                    f"{director_id}: the pose sample was omitted because this return already replaces the mesh; "
                    "apply the mesh, then run another return export for the pose."
                )
        elif pose_changed:
            change = {
                "kind": "pose_update",
                "directorId": director_id,
                "entityType": "object",
                "controls": pose_sample,
            }
            # Root motion sampled together with the pose keeps feet planted.
            if transform_changed:
                change["transform"] = current_transform
            changes.append(change)
        elif transform_changed:
            changes.append(
                {
                    "kind": "transform_update",
                    "directorId": director_id,
                    "entityType": "object",
                    "transform": current_transform,
                }
            )

    for item in bpy.context.scene.objects:
        if item.parent is not None or item.get("director_id") or item.name.startswith("Director_"):
            continue
        if item.type == "LIGHT":
            warnings.append(
                f"{item.name}: Blender light has no director_id; Director does not auto-create lights from a "
                "return package, so it was not included."
            )
            continue
        warnings.append(
            f"{item.name}: top-level Blender object has no director_id and was not included in the return package. "
            "Assign a fresh director_id custom property to offer it as a reviewed, opt-in addition."
        )

    return {
        "schemaVersion": 1,
        "contract": CONTRACT,
        "packageId": str(uuid.uuid4()),
        "sourcePackageId": source["packageId"],
        "sourceRevision": source["sourceRevision"],
        "exportedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "blenderVersion": bpy.app.version_string,
        "coordinateSystem": {
            "source": "right-handed-z-up-negative-z-camera-forward",
            "destination": "right-handed-y-up-negative-z-forward",
            "unit": "meter",
            "linearMap": "(x,y,z)->(x,z,-y)",
        },
        "changes": changes,
        "warnings": warnings,
        "fileHashes": file_hashes,
    }


def write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    """Write JSON via a temp file + rename so watchers never read a partial file."""
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def main() -> int:
    """Entry point: build the package and report the outcome on stdout.

    Success and failure both print a single RESULT_PREFIX-tagged JSON line
    that the gateway parses out of Blender's noisy stdout, and both attempt
    to persist the same report to ``--report`` for post-mortem inspection.
    """
    args = parse_args()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    report_input = Path(args.report)
    report_path = ensure_inside(output_dir, report_input if report_input.is_absolute() else output_dir / report_input)
    manifest_path = ensure_inside(output_dir, output_dir / "manifest.json")
    try:
        source = read_source_manifest(Path(args.source_manifest).resolve())
        manifest = build_return_package(source, output_dir)
        write_json_atomic(manifest_path, manifest)
        report = {
            "ok": True,
            "contract": CONTRACT,
            "packageId": manifest["packageId"],
            "manifestPath": str(manifest_path),
            "changeCount": len(manifest["changes"]),
            "meshCount": sum(change["kind"] == "mesh_replacement" for change in manifest["changes"]),
            "cameraCount": sum(change["kind"] == "camera_update" for change in manifest["changes"]),
            "lightCount": sum(change["kind"] == "light_update" for change in manifest["changes"]),
            "poseCount": sum(change["kind"] == "pose_update" for change in manifest["changes"]),
            "additionCount": sum(change["kind"] == "object_addition" for change in manifest["changes"]),
            "warnings": manifest["warnings"],
            "blenderVersion": manifest["blenderVersion"],
        }
        write_json_atomic(report_path, report)
        print(f"{RESULT_PREFIX}{json.dumps(report, ensure_ascii=False, sort_keys=True)}")
        return 0
    except Exception as error:
        failure = {"ok": False, "contract": CONTRACT, "error": str(error)}
        try:
            write_json_atomic(report_path, failure)
        except Exception:
            pass
        print(f"{RESULT_PREFIX}{json.dumps(failure, ensure_ascii=False, sort_keys=True)}")
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
