"""Extract an arbitrary, already-open Blender scene into a Director import package.

The gateway opens a snapshotted ``.blend`` with Blender's
``--disable-autoexec`` flag before this script runs.  This module does not load
another blend file, execute embedded text blocks or drivers, follow URLs, or
evaluate scene-provided Python.  It exports one metre-normalized GLB scene,
camera optics, a strict manifest, and a bounded status report.
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
from fractions import Fraction
from pathlib import Path
from typing import Any, Iterable

try:  # Keep --help and pure helpers testable without Blender installed.
    import bpy  # type: ignore
except ModuleNotFoundError:  # pragma: no cover - production execution is inside Blender.
    bpy = None


CONTRACT = "director-blend-scene-v1"
RESULT_PREFIX = "DIRECTOR_BLEND_SCENE_RESULT:"
MAX_WARNINGS = 20_000
MAX_UNSUPPORTED = 20_000
MAX_CAMERAS = 512
MAX_SOURCE_BYTES = 2_147_483_648
RENDERABLE_TYPES = {"MESH", "CURVE", "SURFACE", "META", "FONT"}
DEPENDENCY_TYPES = {"EMPTY", "ARMATURE"}
# Object types the Stage cannot represent. Each entry becomes a typed
# `unsupported` record in the manifest (kind/name/reason) — Director's UI and
# agents surface these as the omitted-channel report, so the reasons are
# user-facing copy, not internal notes. Silent omission is forbidden.
UNSUPPORTED_OBJECT_TYPES = {
    "LIGHT": "Director scene import v1 does not model Blender lights.",
    "VOLUME": "Volumes are not represented by the Director GLB scene importer.",
    "GREASEPENCIL": "Grease Pencil objects are not represented by the Director GLB scene importer.",
    "POINTCLOUD": "Point clouds are not represented by the Director GLB scene importer.",
    "CURVES": "Hair Curves objects are not represented by the Director GLB scene importer.",
    "LATTICE": "Lattice control objects are not exported as scene geometry.",
    "SPEAKER": "Audio speakers are not represented by the Director Stage.",
}


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    # Inside Blender, script arguments follow a "--" separator on the Blender
    # command line; standalone (tests, --help) they are plain argv.
    raw = list(sys.argv if argv is None else argv)
    separator = raw.index("--") if "--" in raw else 0
    arguments = raw[separator + 1 :] if separator else raw[1:]
    parser = argparse.ArgumentParser(description="Extract an open Blender scene for Director")
    parser.add_argument("--source-blend", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--report", required=True)
    return parser.parse_args(arguments)


def ensure_inside(parent: Path, child: Path) -> Path:
    """Refuse any output path that resolves outside the job directory —
    the scene (via director_id strings etc.) must not choose write targets."""
    resolved_parent = parent.resolve()
    resolved_child = child.resolve()
    try:
        resolved_child.relative_to(resolved_parent)
    except ValueError as error:
        raise ValueError(f"Output path escaped {resolved_parent}: {resolved_child}") from error
    return resolved_child


def safe_stem(value: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-.")[:96]
    return normalized or "blender-scene"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def bounded_text(value: Any, maximum: int = 2_000) -> str:
    # Scene-provided names flow into the manifest and UI; bound their length
    # so a pathological .blend cannot bloat the report.
    text = str(value).strip() or "Unknown Blender item"
    return text[:maximum]


def append_warning(warnings: list[str], message: Any) -> None:
    if len(warnings) < MAX_WARNINGS:
        warnings.append(bounded_text(message))


def append_unsupported(unsupported: list[dict[str, str]], kind: Any, name: Any, reason: Any) -> None:
    if len(unsupported) < MAX_UNSUPPORTED:
        unsupported.append(
            {
                "kind": bounded_text(kind, 120),
                "name": bounded_text(name, 240),
                "reason": bounded_text(reason),
            }
        )


def source_id_for_camera(camera_object: Any, used: set[str], warnings: list[str]) -> str:
    """Stable source id for a camera: an explicit unique ``director_id`` wins
    (round-tripped scenes keep identity); otherwise derive a deterministic id
    from the object+data names so re-exports of an unchanged scene produce
    the same ids and Director can match cameras across imports."""
    explicit = camera_object.get("director_id")
    if isinstance(explicit, str) and explicit.strip():
        candidate = explicit.strip()[:240]
        if candidate not in used:
            used.add(candidate)
            return candidate
        append_warning(warnings, f"Camera {camera_object.name} has duplicate director_id {candidate!r}; generated a source ID.")
    identity = f"{camera_object.name_full}\0{getattr(camera_object.data, 'name_full', camera_object.data.name)}"
    stem = safe_stem(camera_object.name)[:180]
    candidate = f"blender-camera-{stem}-{hashlib.sha256(identity.encode('utf-8')).hexdigest()[:16]}"[:240]
    suffix = 2
    base = candidate
    while candidate in used:
        candidate = f"{base[:230]}-{suffix}"
        suffix += 1
    used.add(candidate)
    return candidate


def effective_unit_scale(scene: Any, warnings: list[str]) -> float:
    raw = float(getattr(scene.unit_settings, "scale_length", 1.0) or 1.0)
    if not math.isfinite(raw) or raw <= 0:
        append_warning(warnings, f"Invalid Blender unit scale_length {raw!r}; treated one Blender unit as one metre.")
        return 1.0
    if not math.isclose(raw, 1.0, rel_tol=1e-12, abs_tol=1e-12):
        append_warning(
            warnings,
            f"Blender unit scale_length={raw:.12g} was explicitly applied to scene geometry and camera distances.",
        )
    return raw


def exact_timebase(scene: Any) -> tuple[int, int, float]:
    """Recover the scene frame rate as an exact rational (numerator, denominator, float).

    A previously stamped exact timebase (round-tripped scene) is trusted
    verbatim; otherwise the float fps is snapped to the known NTSC
    24000/1001-family rates, then to integers, then approximated with a
    bounded-denominator fraction. Director's timeline math is rational, so
    shipping a float here would accumulate drift over long timelines.
    """
    stored_numerator = scene.get("director_timebase_numerator")
    stored_denominator = scene.get("director_timebase_denominator")
    if (
        isinstance(stored_numerator, int)
        and isinstance(stored_denominator, int)
        and 0 < stored_numerator <= 1_000_000
        and 0 < stored_denominator <= 1_000_000
    ):
        return stored_numerator, stored_denominator, stored_numerator / stored_denominator
    fps = float(scene.render.fps) / float(scene.render.fps_base or 1.0)
    if not math.isfinite(fps) or fps <= 0 or fps > 1_000:
        raise ValueError(f"Blender scene has invalid frame rate {fps!r}")
    # fps_base is stored as a float, so well-known 1000/1001 broadcast rates
    # otherwise turn into large, unstable fractions after reopening a .blend.
    for numerator in (24_000, 30_000, 48_000, 60_000, 120_000):
        candidate = numerator / 1_001
        if math.isclose(fps, candidate, rel_tol=1e-5, abs_tol=5e-4):
            return numerator, 1_001, candidate
    nearest_integer = round(fps)
    if math.isclose(fps, nearest_integer, rel_tol=1e-9, abs_tol=1e-9):
        return nearest_integer, 1, float(nearest_integer)
    denominator_limit = max(1, min(1_000_000, int(1_000_000 / max(fps, 1.0))))
    rate = Fraction(fps).limit_denominator(denominator_limit)
    return rate.numerator, rate.denominator, rate.numerator / rate.denominator


def is_renderable_seed(item: Any) -> bool:
    """Does this object contribute visible geometry (mesh-like types and
    collection-instance empties)? hide_render is the artist's own exclusion
    switch and is honored over everything else."""
    if bool(getattr(item, "hide_render", False)):
        return False
    if item.type in RENDERABLE_TYPES:
        return True
    return item.type == "EMPTY" and getattr(item, "instance_type", "NONE") == "COLLECTION" and item.instance_collection


def export_objects(scene: Any) -> tuple[list[Any], list[Any]]:
    """Choose (seeds, selected) for the GLB export.

    Seeds are the renderable objects themselves; ``selected`` additionally
    pulls in every ancestor and armature dependency (and the armatures'
    ancestors) so exported transforms and skinning stay correct — but never
    cameras or lights, which travel through their own manifest channels.
    Both lists are name-sorted for deterministic exports.
    """
    seeds = [item for item in scene.objects if is_renderable_seed(item)]
    selected = set(seeds)
    for item in list(seeds):
        parent = item.parent
        while parent is not None:
            if parent.type not in {"CAMERA", "LIGHT"}:
                selected.add(parent)
            parent = parent.parent
        if item.type == "MESH":
            armature = item.find_armature()
            if armature is not None:
                selected.add(armature)
                parent = armature.parent
                while parent is not None:
                    if parent.type not in {"CAMERA", "LIGHT"}:
                        selected.add(parent)
                    parent = parent.parent
    allowed = [item for item in selected if item.type in RENDERABLE_TYPES | DEPENDENCY_TYPES]
    return sorted(seeds, key=lambda candidate: candidate.name_full), sorted(allowed, key=lambda candidate: candidate.name_full)


def relevant_action_count(objects: Iterable[Any]) -> int:
    actions: set[Any] = set()

    def collect(owner: Any) -> None:
        animation = getattr(owner, "animation_data", None)
        if animation is None:
            return
        action = getattr(animation, "action", None)
        if action is not None:
            actions.add(action)
        for track in getattr(animation, "nla_tracks", []):
            for strip in getattr(track, "strips", []):
                strip_action = getattr(strip, "action", None)
                if strip_action is not None:
                    actions.add(strip_action)

    for item in objects:
        collect(item)
        data = getattr(item, "data", None)
        if data is not None:
            collect(data)
            shape_keys = getattr(data, "shape_keys", None)
            if shape_keys is not None:
                collect(shape_keys)
    return len(actions)


def has_animation(owner: Any) -> bool:
    animation = getattr(owner, "animation_data", None)
    if animation is None:
        return False
    if getattr(animation, "action", None) is not None:
        return True
    return any(getattr(track, "strips", None) for track in getattr(animation, "nla_tracks", []))


@contextmanager
def selected_for_export(objects: list[Any]):
    """Temporarily select exactly the export set (unhiding as needed) because
    the glTF exporter works on selection; the artist's original selection,
    hide state, and active object are restored afterwards even on failure."""
    if bpy is None:
        raise RuntimeError("Blender Python API is unavailable")
    scene_objects = list(bpy.context.scene.objects)
    selection = {item: item.select_get() for item in scene_objects}
    hidden = {item: item.hide_get() for item in scene_objects}
    active = bpy.context.view_layer.objects.active
    try:
        bpy.ops.object.select_all(action="DESELECT")
        for item in objects:
            item.hide_set(False)
            item.select_set(True)
        bpy.context.view_layer.objects.active = next((item for item in objects if item.type == "ARMATURE"), objects[0])
        bpy.context.view_layer.update()
        yield
    finally:
        bpy.ops.object.select_all(action="DESELECT")
        for item in scene_objects:
            item.hide_set(hidden[item])
            item.select_set(selection[item])
        bpy.context.view_layer.objects.active = active
        bpy.context.view_layer.update()


def rebuild_glb_json(path: Path, mutate: Any) -> None:
    """Apply ``mutate`` to a GLB's JSON chunk and rewrite the container.

    Parses the GLB 2.0 chunk table by hand (no glTF library dependency
    inside Blender), replaces only the first JSON chunk, re-pads to the
    4-byte alignment the spec requires, and fixes the total-length header.
    Binary chunks pass through untouched.
    """
    payload = bytearray(path.read_bytes())
    if len(payload) < 20 or bytes(payload[:4]) != b"glTF" or int.from_bytes(payload[4:8], "little") != 2:
        raise ValueError(f"Blender did not produce a GLB 2.0 file at {path}")
    offset = 12
    chunks: list[tuple[int, bytes]] = []
    json_payload: dict[str, Any] | None = None
    while offset + 8 <= len(payload):
        length = int.from_bytes(payload[offset : offset + 4], "little")
        chunk_type = int.from_bytes(payload[offset + 4 : offset + 8], "little")
        start = offset + 8
        end = start + length
        if end > len(payload):
            raise ValueError("GLB chunk exceeds file length")
        content = bytes(payload[start:end])
        chunks.append((chunk_type, content))
        if chunk_type == 0x4E4F534A and json_payload is None:
            try:
                json_payload = json.loads(content.rstrip(b" \t\r\n").decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise ValueError("GLB JSON chunk is invalid") from error
        offset = end
    if offset != len(payload) or json_payload is None:
        raise ValueError("GLB chunk table is invalid or has no JSON chunk")
    mutate(json_payload)
    encoded = json.dumps(json_payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    encoded += b" " * ((4 - len(encoded) % 4) % 4)
    rebuilt = bytearray(payload[:12])
    replaced = False
    for chunk_type, content in chunks:
        next_content = encoded if chunk_type == 0x4E4F534A and not replaced else content
        if chunk_type == 0x4E4F534A and not replaced:
            replaced = True
        rebuilt.extend(len(next_content).to_bytes(4, "little"))
        rebuilt.extend(chunk_type.to_bytes(4, "little"))
        rebuilt.extend(next_content)
    rebuilt[8:12] = len(rebuilt).to_bytes(4, "little")
    path.write_bytes(rebuilt)


def apply_meter_root(path: Path, scale_length: float) -> None:
    """Wrap every GLB scene in one scale node because Blender ignores scale_length."""
    if math.isclose(scale_length, 1.0, rel_tol=1e-12, abs_tol=1e-12):
        return

    def mutate(document: dict[str, Any]) -> None:
        nodes = document.setdefault("nodes", [])
        scenes = document.setdefault("scenes", [])
        if not isinstance(nodes, list) or not isinstance(scenes, list):
            raise ValueError("GLB nodes/scenes must be arrays")
        for index, scene in enumerate(scenes):
            if not isinstance(scene, dict):
                raise ValueError("GLB scene must be an object")
            roots = scene.get("nodes", [])
            if not isinstance(roots, list) or not all(isinstance(value, int) for value in roots):
                raise ValueError("GLB scene root nodes must be integer indices")
            wrapper = {
                "name": f"Director_Meter_Root_{index + 1}",
                "scale": [scale_length, scale_length, scale_length],
                "children": roots,
                "extras": {"director": {"unit": "meter", "sourceScaleLength": scale_length}},
            }
            nodes.append(wrapper)
            scene["nodes"] = [len(nodes) - 1]

    rebuild_glb_json(path, mutate)


def export_scene_glb(objects: list[Any], destination: Path, unit_scale: float) -> None:
    """Export the selected objects as one Y-up GLB with animations sampled.

    Exporter options that only exist in newer Blender versions are probed via
    the operator's RNA before being passed, so one script supports the full
    supported Blender range without version branching.
    """
    if bpy is None:
        raise RuntimeError("director_scene_export.py must run inside Blender")
    destination.parent.mkdir(parents=True, exist_ok=True)
    options: dict[str, Any] = {
        "filepath": str(destination),
        "export_format": "GLB",
        "use_selection": True,
        "export_extras": True,
        "export_yup": True,
        "export_materials": "EXPORT",
        "export_cameras": False,
        "export_lights": False,
        "export_animations": True,
        "export_skins": True,
        "export_morph": True,
        "export_force_sampling": True,
    }
    properties = bpy.ops.export_scene.gltf.get_rna_type().properties
    if "export_gn_mesh" in properties:
        options["export_gn_mesh"] = True
    if "export_apply" in properties:
        options["export_apply"] = False
    if "export_current_frame" in properties:
        # Director currently renders imported GLB content without playing its
        # embedded clips, so the authored Blender current frame must be the
        # visible rest snapshot.
        options["export_current_frame"] = True
    scene = bpy.context.scene
    authored_frame = int(scene.frame_current)
    authored_subframe = float(scene.frame_subframe)
    try:
        with selected_for_export(objects):
            bpy.ops.export_scene.gltf(**options)
    finally:
        # Blender's glTF exporter samples animation by advancing the active
        # scene through its frame range.  Restore the authored frame before we
        # read cameras/timeline metadata or the import preview would silently
        # describe the animation's final sample instead of the saved view.
        scene.frame_set(authored_frame, subframe=authored_subframe)
        bpy.context.view_layer.update()
    apply_meter_root(destination, unit_scale)


def clamp_camera_value(
    value: float,
    minimum: float,
    maximum: float,
    label: str,
    camera_name: str,
    warnings: list[str],
) -> float:
    if not math.isfinite(value):
        append_warning(warnings, f"Camera {camera_name} has non-finite {label}; used {minimum}.")
        return minimum
    clamped = min(maximum, max(minimum, value))
    if not math.isclose(value, clamped, rel_tol=1e-12, abs_tol=1e-12):
        append_warning(warnings, f"Camera {camera_name} {label}={value:.12g} was clamped to {clamped:.12g}.")
    return clamped


def camera_record(
    camera_object: Any,
    unit_scale: float,
    source_id: str,
    render_aspect_ratio: float,
    warnings: list[str],
) -> dict[str, Any]:
    """One manifest camera: world transform plus physical optics in meters.

    Every optical value is clamped to Director's accepted ranges with a
    warning (never a hard failure — one odd camera must not sink the whole
    scene import). The vertical FOV is derived from the sensor-fit-effective
    sensor height so Director reproduces Blender's framing at the scene's
    render aspect ratio. Lens shift and camera object scale are reported as
    compatibility warnings because the Stage cannot represent them.
    """
    data = camera_object.data
    location, rotation, scale = camera_object.matrix_world.decompose()
    rotation.normalize()
    if abs(float(data.shift_x)) > 1e-9 or abs(float(data.shift_y)) > 1e-9:
        append_warning(warnings, f"Camera {camera_object.name} lens shift is retained only as a compatibility warning.")
    if any(not math.isclose(abs(float(value)), 1.0, rel_tol=1e-6, abs_tol=1e-6) for value in scale):
        append_warning(warnings, f"Camera {camera_object.name} has object scale; Director imports position and rotation only.")
    focus_object = getattr(data.dof, "focus_object", None)
    if focus_object is not None:
        focus_distance = (focus_object.matrix_world.translation - location).length * unit_scale
    else:
        focus_distance = float(data.dof.focus_distance) * unit_scale
    near_clip = float(data.clip_start) * unit_scale
    far_clip = float(data.clip_end) * unit_scale
    near_clip = clamp_camera_value(near_clip, 1e-9, 100_000, "near clip", camera_object.name, warnings)
    far_clip = clamp_camera_value(far_clip, near_clip + 1e-9, 10_000_000, "far clip", camera_object.name, warnings)
    sensor_fit = str(data.sensor_fit).lower()
    horizontal_fit = sensor_fit == "horizontal" or (sensor_fit == "auto" and render_aspect_ratio >= 1)
    effective_sensor_height = (
        float(data.sensor_width) / render_aspect_ratio if horizontal_fit else float(data.sensor_height)
    )
    vertical_fov_degrees = math.degrees(2 * math.atan(effective_sensor_height / (2 * float(data.lens))))
    return {
        "sourceId": source_id,
        "name": bounded_text(camera_object.name, 240),
        "transform": {
            "location": [float(location.x) * unit_scale, float(location.y) * unit_scale, float(location.z) * unit_scale],
            "rotationQuaternion": [float(rotation.x), float(rotation.y), float(rotation.z), float(rotation.w)],
            "scale": [float(scale.x), float(scale.y), float(scale.z)],
        },
        "focalLengthMm": clamp_camera_value(float(data.lens), 1, 2_000, "focal length", camera_object.name, warnings),
        "sensorWidthMm": clamp_camera_value(
            float(data.sensor_width), 1e-9, 1_000, "sensor width", camera_object.name, warnings
        ),
        "sensorHeightMm": clamp_camera_value(
            float(data.sensor_height), 1e-9, 1_000, "sensor height", camera_object.name, warnings
        ),
        "sensorFit": sensor_fit,
        "renderAspectRatio": render_aspect_ratio,
        "verticalFovDegrees": clamp_camera_value(
            vertical_fov_degrees, 1e-9, 179, "vertical field of view", camera_object.name, warnings
        ),
        "apertureFStop": clamp_camera_value(
            float(data.dof.aperture_fstop), 1e-9, 256, "aperture", camera_object.name, warnings
        ),
        "focusDistanceM": clamp_camera_value(
            focus_distance, 1e-9, 1_000_000, "focus distance", camera_object.name, warnings
        ),
        "nearClipM": near_clip,
        "farClipM": far_clip,
    }


def collect_compatibility(scene: Any, warnings: list[str], unsupported: list[dict[str, str]]) -> None:
    """Populate the manifest's omitted-channel report.

    Walks the scene for objects the Stage cannot model (lights, volumes,
    ortho cameras…) and scene-level features that will not survive the GLB
    (compositor nodes, world HDRI, linked libraries, unpacked images). This
    is the honesty channel: Director shows these to the user instead of
    letting content disappear silently.
    """
    for item in sorted(scene.objects, key=lambda candidate: candidate.name_full):
        if item.type == "CAMERA":
            if item.data.type != "PERSP":
                append_unsupported(
                    unsupported,
                    f"camera-{str(item.data.type).lower()}",
                    item.name,
                    "Director scene import v1 supports perspective cameras only.",
                )
            continue
        reason = UNSUPPORTED_OBJECT_TYPES.get(item.type)
        if reason and not bool(getattr(item, "hide_render", False)):
            append_unsupported(unsupported, str(item.type).lower(), item.name, reason)
    if getattr(scene, "use_nodes", False):
        append_warning(warnings, "Blender compositor nodes are not imported into Director.")
    world = getattr(scene, "world", None)
    if world is not None and getattr(world, "use_nodes", False):
        append_warning(warnings, "Blender world nodes/HDRI are not imported into Director.")
    for library in bpy.data.libraries if bpy is not None else []:
        append_warning(warnings, f"Linked Blender library {library.name} was evaluated for the GLB snapshot, not linked live.")
    for image in bpy.data.images if bpy is not None else []:
        if getattr(image, "source", "") == "FILE" and getattr(image, "packed_file", None) is None:
            append_warning(warnings, f"External image {image.name} is not packed; verify its texture in the GLB preview.")


def build_manifest(source_path: Path, output_dir: Path) -> dict[str, Any]:
    """Produce the strict ``director-blend-scene-v1`` manifest and its GLB.

    The manifest is the contract the gateway validates with Zod: source file
    provenance (sha256), the explicit coordinate-system mapping, an exact
    rational timebase, per-camera optics, scene statistics, and the bounded
    warning/unsupported channels. ``bundleFile`` stays None for a scene with
    no renderable geometry — a valid, empty import.
    """
    if bpy is None:
        raise RuntimeError("director_scene_export.py must run inside Blender")
    scene = bpy.context.scene
    warnings: list[str] = []
    unsupported: list[dict[str, str]] = []
    unit_scale = effective_unit_scale(scene, warnings)
    collect_compatibility(scene, warnings, unsupported)
    if len(bpy.data.scenes) > 1:
        append_warning(
            warnings,
            f"The .blend contains {len(bpy.data.scenes)} scenes; only active scene {scene.name!r} is imported.",
        )
    seeds, selected = export_objects(scene)
    bundle_relative: str | None = None
    file_hashes: dict[str, str] = {}
    if seeds:
        bundle_relative = "assets/scene.glb"
        bundle_path = ensure_inside(output_dir, output_dir / bundle_relative)
        export_scene_glb(selected, bundle_path, unit_scale)
        file_hashes[bundle_relative] = sha256_file(bundle_path)

    cameras: list[dict[str, Any]] = []
    source_ids: set[str] = set()
    render_width = float(scene.render.resolution_x) * float(scene.render.pixel_aspect_x)
    render_height = float(scene.render.resolution_y) * float(scene.render.pixel_aspect_y)
    render_aspect_ratio = render_width / render_height if render_height > 0 else 0.0
    if not math.isfinite(render_aspect_ratio) or render_aspect_ratio <= 0 or render_aspect_ratio > 20:
        append_warning(warnings, "Blender render aspect ratio is invalid; cameras use 16:9 in Director.")
        render_aspect_ratio = 16 / 9
    camera_objects = [item for item in sorted(scene.objects, key=lambda candidate: candidate.name_full) if item.type == "CAMERA"]
    for camera_object in camera_objects:
        if camera_object.data.type != "PERSP":
            continue
        if len(cameras) >= MAX_CAMERAS:
            append_warning(warnings, f"Only the first {MAX_CAMERAS} perspective cameras were included.")
            break
        source_id = source_id_for_camera(camera_object, source_ids, warnings)
        if has_animation(camera_object) or has_animation(camera_object.data):
            append_warning(
                warnings,
                f"Camera {camera_object.name} animation is flattened at the current frame; no Director camera track is created.",
            )
        cameras.append(camera_record(camera_object, unit_scale, source_id, render_aspect_ratio, warnings))

    materials: set[Any] = set()
    for item in selected:
        data = getattr(item, "data", None)
        for material in getattr(data, "materials", []) if data is not None else []:
            if material is not None:
                materials.add(material)
    numerator, denominator, fps = exact_timebase(scene)
    return {
        "schemaVersion": 1,
        "contract": CONTRACT,
        "packageId": str(uuid.uuid4()),
        "exportedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "blenderVersion": bpy.app.version_string,
        "source": {
            "fileName": bounded_text(source_path.name, 512),
            "sha256": sha256_file(source_path),
            "sizeBytes": source_path.stat().st_size,
        },
        "coordinateSystem": {
            "source": "right-handed-z-up-negative-z-camera-forward",
            "destination": "right-handed-y-up-negative-z-forward",
            "unit": "meter",
            "linearMap": "(x,y,z)->(x,z,-y)",
        },
        "timeline": {
            "frameStart": float(scene.frame_start),
            "frameEnd": float(scene.frame_end),
            "currentFrame": float(scene.frame_current),
            "fps": fps,
            "timebase": {"rate": {"numerator": numerator, "denominator": denominator}},
        },
        "scene": {
            "name": bounded_text(scene.name, 240),
            "bundleFile": bundle_relative,
            "objectCount": len(seeds),
            "meshCount": sum(1 for item in selected if item.type == "MESH"),
            "materialCount": len(materials),
            "actionCount": relevant_action_count(selected),
        },
        "cameras": cameras,
        "unsupported": unsupported,
        "warnings": warnings,
        "fileHashes": file_hashes,
    }


def validate_source(source_path: Path) -> None:
    """Sanity-check that Blender actually loaded the requested .blend.

    Checks size bounds, a recognizable container header (raw BLENDER magic or
    zstd/gzip compression), and — decisively — that ``bpy.data.filepath``
    resolves to the requested source, guarding against Blender silently
    falling back to an empty startup scene when a load fails.
    """
    if bpy is None:
        raise RuntimeError("Blender Python API is unavailable")
    if not source_path.is_file():
        raise ValueError(f"Source blend does not exist: {source_path}")
    size = source_path.stat().st_size
    if size <= 0 or size > MAX_SOURCE_BYTES:
        raise ValueError(f"Source blend size {size} is outside the supported range")
    with source_path.open("rb") as handle:
        header = handle.read(12)
    raw_blend = (
        len(header) == 12
        and header[:7] == b"BLENDER"
        and header[7:8] in {b"_", b"-"}
        and header[8:9] in {b"v", b"V"}
        and header[9:12].isdigit()
    )
    # Blender 5.x may save compressed files as Zstandard; older compressed
    # files may be gzip.  Exact validation is Blender's successful file load
    # plus the canonical bpy.data.filepath comparison below.
    compressed_blend = header.startswith(b"\x28\xb5\x2f\xfd") or header.startswith(b"\x1f\x8b")
    if not raw_blend and not compressed_blend:
        raise ValueError("Source file does not have a recognized Blender container header")
    opened = Path(bpy.data.filepath).resolve() if bpy.data.filepath else None
    if opened is None or opened != source_path.resolve():
        raise ValueError(f"Blender opened {opened or 'an unsaved scene'}, not the requested source {source_path.resolve()}")


def success_report(manifest: dict[str, Any], manifest_path: Path) -> dict[str, Any]:
    return {
        "ok": True,
        "contract": CONTRACT,
        "packageId": manifest["packageId"],
        "manifestPath": str(manifest_path),
        "bundlePath": str(manifest_path.parent / manifest["scene"]["bundleFile"])
        if manifest["scene"]["bundleFile"]
        else None,
        "objectCount": manifest["scene"]["objectCount"],
        "cameraCount": len(manifest["cameras"]),
        "warningCount": len(manifest["warnings"]),
        "unsupportedCount": len(manifest["unsupported"]),
        "blenderVersion": manifest["blenderVersion"],
    }


def run() -> int:
    """CLI entry point: validate, extract, and always leave a machine-readable
    trail — report.json plus a RESULT_PREFIX line on stdout that the gateway
    parses even when Blender's own output is noisy. Failures still attempt to
    write the failure report before re-raising for a nonzero exit."""
    args = parse_args()
    output_dir = Path(args.output_dir).resolve()
    source_path = Path(args.source_blend).resolve()
    # The server convention keeps report.json beside package/. All extracted
    # payload files remain below output_dir, while the report stays inside the
    # same trusted job directory.
    report_path = ensure_inside(output_dir.parent, Path(args.report))
    output_dir.mkdir(parents=True, exist_ok=True)
    try:
        validate_source(source_path)
        manifest = build_manifest(source_path, output_dir)
        manifest_path = ensure_inside(output_dir, output_dir / "manifest.json")
        write_json_atomic(manifest_path, manifest)
        report = success_report(manifest, manifest_path)
        write_json_atomic(report_path, report)
        print(RESULT_PREFIX + json.dumps(report, ensure_ascii=False, separators=(",", ":")))
        return 0
    except Exception as error:
        failure = {"ok": False, "contract": CONTRACT, "error": bounded_text(error, 4_000)}
        try:
            write_json_atomic(report_path, failure)
        except Exception:
            pass
        print(RESULT_PREFIX + json.dumps(failure, ensure_ascii=False, separators=(",", ":")))
        traceback.print_exc()
        raise


if __name__ == "__main__":
    run()
