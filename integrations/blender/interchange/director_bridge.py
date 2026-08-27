"""Import a validated Director DCC scene package into Blender.

This script intentionally accepts data only. It never evaluates Python from a
scene package, follows no remote URL, and writes only to paths supplied by the
trusted local gateway process.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import traceback
from pathlib import Path
from typing import Any

_INTERCHANGE_DIR = str(Path(__file__).resolve().parent)
if _INTERCHANGE_DIR not in sys.path:
    sys.path.insert(0, _INTERCHANGE_DIR)

from director_pose_bones import resolve_pose_bone_roles
from director_properties import (
    CAMERA_TARGET_PROPERTY,
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

import bpy
from mathutils import Vector


REPORT_PREFIX = "DIRECTOR_DCC_RESULT:"


def parse_args() -> argparse.Namespace:
    separator = sys.argv.index("--") if "--" in sys.argv else len(sys.argv)
    parser = argparse.ArgumentParser(description="Build a Blender scene from a Director DCC package")
    parser.add_argument("--package", required=True)
    parser.add_argument("--output-blend", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--preview")
    return parser.parse_args(sys.argv[separator + 1 :])


def read_package(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("schemaVersion") != 1 or payload.get("contract") != "director-dcc-scene-v1":
        raise ValueError("Unsupported Director DCC scene contract")
    return payload


def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for collection in list(bpy.data.collections):
        if collection.users == 0:
            bpy.data.collections.remove(collection)


def rgba(hex_color: str | None, fallback: tuple[float, float, float, float]) -> tuple[float, float, float, float]:
    value = (hex_color or "").strip().lstrip("#")
    if len(value) == 3:
        value = "".join(character * 2 for character in value)
    if len(value) not in (6, 8):
        return fallback
    try:
        channels = [int(value[index : index + 2], 16) / 255 for index in range(0, len(value), 2)]
    except ValueError:
        return fallback
    return (channels[0], channels[1], channels[2], channels[3] if len(channels) == 4 else 1.0)


def material_for(name: str, color: str | None = None):
    material = bpy.data.materials.new(name=f"{name}_Material")
    material_color = rgba(color, (0.66, 0.69, 0.74, 1.0))
    material.diffuse_color = material_color
    material.roughness = 0.82
    material.metallic = 0.0
    material.use_nodes = True
    principled = material.node_tree.nodes.get("Principled BSDF") if material.node_tree else None
    if principled:
        principled.inputs["Base Color"].default_value = material_color
        principled.inputs["Roughness"].default_value = 0.82
        principled.inputs["Metallic"].default_value = 0.0
    return material


def apply_transform(target, transform: dict[str, Any]) -> None:
    # Package quaternions are (x, y, z, w); Blender stores (w, x, y, z).
    target.location = transform["location"]
    x, y, z, w = transform["rotationQuaternion"]
    target.rotation_mode = "QUATERNION"
    target.rotation_quaternion = (w, x, y, z)
    target.scale = transform["scale"]


def blender_transform(target: Any) -> dict[str, list[float]]:
    """Return the evaluated world transform used by the return bridge."""
    location, rotation, scale = target.matrix_world.decompose()
    rotation.normalize()
    return {
        "location": [float(location.x), float(location.y), float(location.z)],
        "rotationQuaternion": [float(rotation.x), float(rotation.y), float(rotation.z), float(rotation.w)],
        "scale": [float(scale.x), float(scale.y), float(scale.z)],
    }


def camera_optics_state(camera_object: Any, sensor_format: str | None) -> dict[str, Any]:
    """Read the evaluated camera optics that the return exporter diffs against."""
    data = camera_object.data
    state: dict[str, Any] = {
        "focalLengthMm": float(data.lens),
        "apertureFStop": float(data.dof.aperture_fstop),
        "focusDistanceM": float(data.dof.focus_distance),
        "nearClipM": float(data.clip_start),
        "farClipM": float(data.clip_end),
        "sensorWidthMm": float(data.sensor_width),
        "sensorHeightMm": float(data.sensor_height),
    }
    if sensor_format:
        state["sensorFormat"] = sensor_format
    return state


def stamp_pose_bone_baselines(root: Any) -> None:
    """Stamp the Director bone-role map plus per-bone baselines for the return trip.

    Only bones stamped here reconcile direct pose edits back into portable
    ``director_pose.*`` control values; the exporter warns about and omits
    everything else. When several armatures sit under one root, the one that
    resolves the most Director roles is mapped and the rest stay covered by
    the unmapped-bone fingerprint.
    """
    armatures = sorted(
        (item for item in [root, *list(root.children_recursive)] if item.type == "ARMATURE"),
        key=lambda item: item.name,
    )
    best: tuple[Any, dict[str, str]] | None = None
    for armature in armatures:
        resolved = resolve_pose_bone_roles(bone.name for bone in armature.pose.bones)
        if resolved and (best is None or len(resolved) > len(best[1])):
            best = (armature, resolved)
    if best is None:
        return
    armature, resolved = best
    baselines: dict[str, dict[str, list[float]]] = {}
    for role, bone_name in resolved.items():
        bone = armature.pose.bones.get(bone_name)
        if bone is None:
            continue
        location, rotation, scale = bone.matrix_basis.decompose()
        baselines[role] = {
            "rotation": [float(rotation.w), float(rotation.x), float(rotation.y), float(rotation.z)],
            "location": [float(location.x), float(location.y), float(location.z)],
            "scale": [float(scale.x), float(scale.y), float(scale.z)],
        }
    root[POSE_BONE_MAP_PROPERTY] = json.dumps(
        {"armature": armature.name, "bones": resolved}, separators=(",", ":"), sort_keys=True
    )
    root[POSE_BONE_BASELINE_PROPERTY] = json.dumps(baselines, separators=(",", ":"), sort_keys=True)
    unmapped_fingerprint = armature_pose_fingerprint(
        root, exclude={(armature.name, bone_name) for bone_name in resolved.values()}
    )
    if unmapped_fingerprint is not None:
        root[SOURCE_UNMAPPED_POSE_FINGERPRINT_PROPERTY] = unmapped_fingerprint


def stamp_source_baselines(payload: dict[str, Any]) -> None:
    """Persist evaluated import baselines after Blender has returned to currentFrame."""
    object_ids = {item["id"] for item in payload["objects"]}
    camera_items = {item["id"]: item for item in payload["cameras"]}
    for root in bpy.context.scene.objects:
        director_id = root.get("director_id")
        if not isinstance(director_id, str):
            continue
        root[SOURCE_TRANSFORM_PROPERTY] = json.dumps(blender_transform(root), separators=(",", ":"), sort_keys=True)
        if director_id in object_ids:
            if any(item.type == "MESH" for item in [root, *list(root.children_recursive)]):
                root[SOURCE_MESH_SIGNATURE_PROPERTY] = mesh_content_signature(root)
            pose_fingerprint = armature_pose_fingerprint(root)
            if pose_fingerprint is not None:
                root[SOURCE_POSE_FINGERPRINT_PROPERTY] = pose_fingerprint
                stamp_pose_bone_baselines(root)
        camera_item = camera_items.get(director_id)
        if camera_item is not None:
            root[CAMERA_TARGET_PROPERTY] = json.dumps(camera_item["target"], separators=(",", ":"))
            if root.type == "CAMERA":
                # The optics baseline uses evaluated values (a focal-length
                # animation may have moved data.lens away from the package
                # value at currentFrame), so an untouched round trip is a no-op.
                root[SOURCE_CAMERA_OPTICS_PROPERTY] = json.dumps(
                    camera_optics_state(root, camera_item.get("sensorFormat")),
                    separators=(",", ":"),
                    sort_keys=True,
                )


def add_primitive(kind: str | None, name: str, color: str | None):
    if kind == "sphere":
        bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=16, radius=0.5)
    elif kind == "cylinder":
        bpy.ops.mesh.primitive_cylinder_add(vertices=32, radius=0.5, depth=1.0)
    elif kind == "torus":
        bpy.ops.mesh.primitive_torus_add(major_radius=0.36, minor_radius=0.14, major_segments=32, minor_segments=12)
    elif kind == "cone":
        bpy.ops.mesh.primitive_cone_add(vertices=32, radius1=0.5, radius2=0.0, depth=1.0)
    elif kind == "pyramid":
        bpy.ops.mesh.primitive_cone_add(vertices=4, radius1=math.sqrt(0.5), radius2=0.0, depth=1.0)
    else:
        bpy.ops.mesh.primitive_cube_add(size=1.0)
    primitive = bpy.context.object
    primitive.name = f"{name}_Geometry"
    primitive.data.materials.append(material_for(name, color))
    return primitive


def import_glb(source_path: str) -> list[Any]:
    path = Path(source_path)
    if path.suffix.lower() not in (".glb", ".gltf"):
        raise ValueError(f"Bridge v1 imports GLB/glTF only, received {path.suffix or 'no extension'}")
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(path))
    return [item for item in bpy.data.objects if item not in before]


def parent_imported_roots(imported: list[Any], root) -> None:
    imported_set = set(imported)
    for item in imported:
        if item.parent not in imported_set:
            item.parent = root


def apply_interpolation(target, interpolation: str) -> None:
    action = target.animation_data.action if target.animation_data and target.animation_data.action else None
    if not action:
        return
    blender_interpolation = {"step": "CONSTANT", "smooth": "BEZIER"}.get(interpolation, "LINEAR")
    for curve in getattr(action, "fcurves", []):
        if curve.keyframe_points:
            curve.keyframe_points[-1].interpolation = blender_interpolation


def set_new_keyframe_interpolation(interpolation: str) -> None:
    blender_interpolation = {"step": "CONSTANT", "smooth": "BEZIER"}.get(interpolation, "LINEAR")
    bpy.context.preferences.edit.keyframe_new_interpolation_type = blender_interpolation


def keyframe_transform(target, keyframe: dict[str, Any]) -> None:
    transform = keyframe.get("transform")
    if not transform:
        return
    apply_transform(target, transform)
    frame = keyframe["frame"]
    set_new_keyframe_interpolation(keyframe.get("interpolation", "linear"))
    target.keyframe_insert(data_path="location", frame=frame)
    target.keyframe_insert(data_path="rotation_quaternion", frame=frame)
    target.keyframe_insert(data_path="scale", frame=frame)
    apply_interpolation(target, keyframe.get("interpolation", "linear"))


def add_object(item: dict[str, Any], warnings: list[str]) -> Any:
    """Build one Director scene object as a `director_id`-tagged empty root.

    The empty is the stable handle the return exporter diffs against; the
    imported GLB (or a proxy primitive when the asset is missing or fails to
    import) hangs underneath it. Transform keyframes and portable pose
    controls from the package are applied to the root, never to the asset
    geometry.
    """
    root = bpy.data.objects.new(item["name"], None)
    bpy.context.scene.collection.objects.link(root)
    root.empty_display_type = "PLAIN_AXES"
    root["director_id"] = item["id"]
    root["director_kind"] = item["kind"]
    if item.get("parentObjectId"):
        root["director_parent_id"] = item["parentObjectId"]
    apply_transform(root, item["transform"])
    root.hide_render = not item["visible"]
    root.hide_viewport = not item["visible"]

    imported: list[Any] = []
    if item.get("sourcePath"):
        try:
            imported = import_glb(item["sourcePath"])
            parent_imported_roots(imported, root)
        except Exception as error:  # Blender importer errors are asset-specific.
            warnings.append(f"{item['id']}: asset import failed ({error}); used a proxy.")
    if not imported:
        proxy_kind = item.get("geometryType") or ("sphere" if item["kind"] == "character" else "box")
        primitive = add_primitive(proxy_kind, item["name"], item.get("color"))
        primitive.parent = root

    for keyframe in item.get("animation", []):
        keyframe_transform(root, keyframe)
        if keyframe.get("poseValues"):
            root[f"director_pose_frame_{keyframe['frame']}"] = json.dumps(keyframe["poseValues"], sort_keys=True)

    pose_controls = item.get("poseControls")
    if isinstance(pose_controls, dict) and pose_controls:
        # The baseline JSON is immutable; the per-control custom properties are
        # the editable surface. The return exporter diffs one against the other
        # and sends a portable pose_update back to the same Director binding.
        root[POSE_CONTROLS_BASELINE_PROPERTY] = json.dumps(pose_controls, separators=(",", ":"), sort_keys=True)
        for control, value in pose_controls.items():
            root[POSE_CONTROL_PREFIX + control] = float(value)
    return root


def aim_camera(camera_object, target: list[float]) -> None:
    direction = Vector(target) - camera_object.location
    if direction.length_squared > 1e-12:
        camera_object.rotation_mode = "QUATERNION"
        camera_object.rotation_quaternion = direction.to_track_quat("-Z", "Y")


def add_camera(item: dict[str, Any]) -> Any:
    """Build one physical Blender camera from Director optics.

    The sensor is resized so its aspect matches the shot's declared aspect
    ratio (fit within the declared physical sensor); combined with the fixed
    HORIZONTAL sensor fit this reproduces Director's field of view exactly at
    the render resolution chosen by configure_output_aspect.
    """
    camera_data = bpy.data.cameras.new(name=f"{item['name']}_Data")
    camera_data.lens = item["focalLengthMm"]
    camera_data.sensor_fit = "HORIZONTAL"
    aspect_values = {"16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1, "4:3": 4 / 3, "1.85:1": 1.85, "2.39:1": 2.39}
    aspect_value = aspect_values.get(item["aspectRatio"], 16 / 9)
    used_sensor_height = min(item["sensorHeightMm"], item["sensorWidthMm"] / aspect_value)
    camera_data.sensor_width = used_sensor_height * aspect_value
    camera_data.sensor_height = used_sensor_height
    camera_data.clip_start = item["nearClipM"]
    camera_data.clip_end = item["farClipM"]
    camera_data.dof.use_dof = True
    camera_data.dof.aperture_fstop = item["apertureFStop"]
    camera_data.dof.focus_distance = item["focusDistanceM"]
    camera_object = bpy.data.objects.new(item["name"], camera_data)
    bpy.context.scene.collection.objects.link(camera_object)
    camera_object["director_id"] = item["id"]
    camera_object["director_shutter_angle"] = item["shutterAngle"]
    camera_object["director_iso"] = item["iso"]
    camera_object["director_anamorphic_squeeze"] = item["anamorphicSqueeze"]
    camera_object["director_aspect_ratio"] = item["aspectRatio"]
    camera_object[CAMERA_TARGET_PROPERTY] = json.dumps(item["target"], separators=(",", ":"))
    camera_object["director_camera_orientation_authority"] = "target"
    apply_transform(camera_object, item["transform"])
    # Director renders cameras from position + target. Resolve that single
    # authoritative representation once in Blender, then stamp the evaluated
    # quaternion as the no-op baseline after returning to currentFrame.
    aim_camera(camera_object, item["target"])

    base_target = item["target"]
    for keyframe in item.get("animation", []):
        if keyframe.get("transform"):
            apply_transform(camera_object, keyframe["transform"])
        aim_camera(camera_object, keyframe.get("lookTarget", base_target))
        frame = keyframe["frame"]
        set_new_keyframe_interpolation(keyframe.get("interpolation", "linear"))
        camera_object.keyframe_insert(data_path="location", frame=frame)
        camera_object.keyframe_insert(data_path="rotation_quaternion", frame=frame)
        if keyframe.get("focalLengthMm"):
            camera_data.lens = keyframe["focalLengthMm"]
            camera_data.keyframe_insert(data_path="lens", frame=frame)
        apply_interpolation(camera_object, keyframe.get("interpolation", "linear"))
    return camera_object


BLENDER_LIGHT_TYPES = {"directional": "SUN", "point": "POINT", "spot": "SPOT", "rect-area": "AREA"}


def light_baseline(item: dict[str, Any]) -> dict[str, Any]:
    """The import-time light state the return exporter diffs against."""
    baseline = {
        "type": item["type"],
        "position": [float(value) for value in item["position"]],
        "color": item["color"],
        "intensity": float(item["intensity"]),
        "energy": float(item["energy"]),
        "wattsPerIntensity": float(item["wattsPerIntensity"]),
    }
    if item.get("target") is not None:
        baseline["target"] = [float(value) for value in item["target"]]
    return baseline


def add_light(item: dict[str, Any], warnings: list[str]) -> Any:
    """Build one Blender light from a Director light record, stamping the
    import-time baseline the return exporter needs to detect edits. Types
    without a Blender equivalent are warned about and skipped — the warning
    list is the omitted-lights channel surfaced back to Director."""
    blender_type = BLENDER_LIGHT_TYPES.get(item["type"])
    if blender_type is None:
        warnings.append(f"{item['id']}: light type {item['type']!r} has no Blender equivalent; skipped.")
        return None
    light_data = bpy.data.lights.new(name=f"{item['name']}_Data", type=blender_type)
    # Director colors are #RRGGBB; the raw 0-1 triplet is stored without a
    # color-space conversion so the return exporter can invert it exactly.
    light_data.color = rgba(item["color"], (1.0, 1.0, 1.0, 1.0))[:3]
    light_data.energy = float(item["energy"])
    light_data.use_shadow = bool(item.get("castShadow", False))
    if blender_type == "SPOT":
        if item.get("angleRad") is not None:
            # Director stores the half-angle; Blender spot_size is the full cone.
            light_data.spot_size = 2.0 * float(item["angleRad"])
        light_data.spot_blend = float(item.get("penumbra", 0.0))
    if blender_type == "AREA":
        light_data.shape = "RECTANGLE"
        light_data.size = float(item.get("widthM", 1.0))
        light_data.size_y = float(item.get("heightM", 1.0))
    light_object = bpy.data.objects.new(item["name"], light_data)
    bpy.context.scene.collection.objects.link(light_object)
    light_object["director_id"] = item["id"]
    light_object.location = item["position"]
    if item.get("target") is not None:
        aim_camera(light_object, item["target"])  # Blender lights also aim along -Z.
    visible = bool(item.get("visible", True))
    light_object.hide_render = not visible
    light_object.hide_viewport = not visible
    light_object[SOURCE_LIGHT_PROPERTY] = json.dumps(light_baseline(item), separators=(",", ":"), sort_keys=True)
    return light_object


def add_ground(scene_payload: dict[str, Any]) -> None:
    if not scene_payload["showGround"]:
        return
    bpy.ops.mesh.primitive_plane_add(size=200.0, location=(0.0, 0.0, scene_payload["groundHeight"]))
    ground = bpy.context.object
    ground.name = "Director_Ground"
    material = material_for("Director_Ground", "#5A5E63")
    material.diffuse_color = (*material.diffuse_color[:3], scene_payload["groundOpacity"])
    ground.data.materials.append(material)


def configure_scene(payload: dict[str, Any]) -> None:
    """Apply the package timeline, render engine, and world background.

    The exact rational timebase is preserved as scene metadata (numerator/
    denominator custom properties) because Blender's fps/fps_base pair is
    float-based; the return trip reads those properties back rather than
    re-deriving the rate from floats.
    """
    scene = bpy.context.scene
    timeline = payload["timeline"]
    timebase = timeline.get("timebase")
    if isinstance(timebase, dict) and isinstance(timebase.get("rate"), dict):
        rate = timebase["rate"]
        numerator = int(rate["numerator"])
        denominator = int(rate["denominator"])
        exact_fps = numerator / denominator
        nominal_fps = max(1, round(exact_fps))
        scene.render.fps = nominal_fps
        # Blender represents fractional rates as fps / fps_base. Keep the exact
        # rational components as scene metadata because fps_base itself is a float.
        scene.render.fps_base = nominal_fps * denominator / numerator
        scene["director_timebase_numerator"] = numerator
        scene["director_timebase_denominator"] = denominator
        scene["director_timebase_drop_frame"] = bool(timebase.get("dropFrame", False))
        scene["director_timebase_start_timecode"] = str(timebase.get("startTimecode", "00:00:00:00"))
    else:
        legacy_fps = float(timeline["fps"])
        nominal_fps = max(1, round(legacy_fps))
        scene.render.fps = nominal_fps
        scene.render.fps_base = nominal_fps / legacy_fps
    scene.frame_start = round(timeline["frameStart"])
    scene.frame_end = round(timeline["frameEnd"])
    scene.frame_set(round(timeline["currentFrame"]))
    try:
        scene.render.engine = "BLENDER_EEVEE_NEXT"
    except TypeError:
        scene.render.engine = "BLENDER_EEVEE"
    scene.render.image_settings.file_format = "PNG"
    scene.render.resolution_percentage = 100
    scene.world.color = rgba(payload["scene"]["backgroundColor"], (0.035, 0.045, 0.065, 1.0))[:3]

    if payload.get("lights"):
        # The package carries the authored Director lights; adding the default
        # blocking rig on top would double-light the scene.
        return
    bpy.ops.object.light_add(type="AREA", location=(4.0, -4.0, 7.0))
    key = bpy.context.object
    key.name = "Director_Key_Light"
    # A restrained blocking-stage rig preserves the authored grey/gold palette.
    # The previous 1300 W / 550 W pair clipped clay materials almost to white.
    key.data.energy = 420
    key.data.shape = "DISK"
    key.data.size = 5.0
    key.rotation_euler = (math.radians(25), 0.0, math.radians(35))
    bpy.ops.object.light_add(type="AREA", location=(-4.0, 2.0, 4.0))
    fill = bpy.context.object
    fill.name = "Director_Fill_Light"
    fill.data.energy = 140
    fill.data.size = 4.0


def configure_output_aspect(aspect: str) -> None:
    ratios = {"16:9": (1280, 720), "9:16": (720, 1280), "1:1": (1024, 1024), "4:3": (1024, 768), "1.85:1": (1332, 720), "2.39:1": (1721, 720)}
    width, height = ratios.get(aspect, (1280, 720))
    bpy.context.scene.render.resolution_x = width
    bpy.context.scene.render.resolution_y = height


def apply_previz_preview_materials(payload: dict[str, Any]) -> None:
    """Apply the Director camera look to a preview render only.

    The .blend is saved before this runs, so imported production materials stay
    intact in the handoff while the generated blocking frame remains visually
    consistent with the browser camera: warm mannequins, neutral props and a
    medium-grey stage.
    """
    preview_materials = {
        "character": material_for("Director_Preview_Character", "#D19A3A"),
        "prop": material_for("Director_Preview_Prop", "#D8DCE2"),
    }
    kinds_by_id = {item["id"]: item["kind"] for item in payload["objects"]}
    for root in bpy.context.scene.objects:
        director_id = root.get("director_id")
        kind = kinds_by_id.get(director_id)
        material = preview_materials.get(kind)
        if material is None:
            continue
        descendants = [root, *list(root.children_recursive)]
        for item in descendants:
            if item.type != "MESH":
                continue
            item.data.materials.clear()
            item.data.materials.append(material)


def main() -> dict[str, Any]:
    """Build the .blend from a package: clear → configure → objects/lights/
    cameras → return to currentFrame → stamp baselines → save, then render
    the optional previz preview *after* saving so preview-only material
    overrides never leak into the handoff file."""
    args = parse_args()
    package_path = Path(args.package).resolve()
    output_blend = Path(args.output_blend).resolve()
    report_path = Path(args.report).resolve()
    preview_path = Path(args.preview).resolve() if args.preview else None
    payload = read_package(package_path)
    warnings = list(payload.get("warnings", []))

    clear_scene()
    configure_scene(payload)
    add_ground(payload["scene"])
    for item in payload["objects"]:
        add_object(item, warnings)
    lights = [added for item in payload.get("lights") or [] if (added := add_light(item, warnings)) is not None]

    cameras = {item["id"]: add_camera(item) for item in payload["cameras"]}
    active_camera = cameras.get(payload.get("activeCameraId")) or next(iter(cameras.values()), None)
    if active_camera:
        bpy.context.scene.camera = active_camera
        source = next((item for item in payload["cameras"] if item["id"] == active_camera["director_id"]), None)
        configure_output_aspect(source["aspectRatio"] if source else "16:9")
    else:
        warnings.append("No camera was available; preview rendering was skipped.")

    # Keyframe insertion leaves Blender objects at the last authored key. Return
    # to the requested frame before recording no-op baselines, otherwise every
    # animated object appears modified on an untouched round trip.
    bpy.context.scene.frame_set(round(payload["timeline"]["currentFrame"]))
    bpy.context.view_layer.update()
    stamp_source_baselines(payload)

    output_blend.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(output_blend), check_existing=False)
    rendered_preview = None
    if preview_path and active_camera:
        preview_path.parent.mkdir(parents=True, exist_ok=True)
        bpy.context.scene.render.filepath = str(preview_path)
        # Render the authored neutral previz colours. A global white override
        # made camera frames diverge from the live Director view and erased the
        # warm character/neutral prop distinction. Editor helpers are Blender
        # viewport overlays and therefore never enter this render.
        apply_previz_preview_materials(payload)
        bpy.ops.render.render(write_still=True)
        rendered_preview = str(preview_path)

    result = {
        "ok": True,
        "contract": payload["contract"],
        "packageId": payload["packageId"],
        "blendPath": str(output_blend),
        "previewPath": rendered_preview,
        "objectCount": len(payload["objects"]),
        "cameraCount": len(payload["cameras"]),
        "lightCount": len(lights),
        "warnings": warnings,
        "blenderVersion": bpy.app.version_string,
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return result


if __name__ == "__main__":
    try:
        report = main()
        print(f"{REPORT_PREFIX}{json.dumps(report, ensure_ascii=False)}")
    except Exception as error:
        failure = {"ok": False, "error": str(error), "traceback": traceback.format_exc(limit=16)}
        try:
            arguments = parse_args()
            Path(arguments.report).write_text(json.dumps(failure, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception:
            pass
        print(f"{REPORT_PREFIX}{json.dumps(failure, ensure_ascii=False)}")
        raise
