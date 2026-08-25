"""Director scene exporter for Unreal Engine 5.

Exports the currently loaded (or explicitly requested) level into a portable
``director-engine-scene-v1`` package that Director's gateway can validate,
plan, and import. The package contains:

- ``manifest.json`` — scene metadata, hierarchy snapshot, cameras, lights,
  animation clip inventory, warnings, and SHA-256 hashes for every file.
- ``assets/scene.glb`` — the renderable level geometry exported through the
  built-in "glTF Exporter" plugin (enable it in Edit > Plugins). Materials,
  skeletal meshes, and animation data ride embedded inside this GLB.

Every transform written into the manifest is converted from Unreal's
left-handed Z-up centimeter convention into Director's right-handed Y-up
meter convention using the documented linear map ``(x,y,z)->(y,z,-x)*0.01``.

Run headless (Director's gateway does this for ``extract_engine_scene``):

    UnrealEditor-Cmd <project.uproject> -run=pythonscript \
        -script="director_scene_export.py --output-dir /abs/out [--scene /Game/Maps/Set] [--zip]" \
        -unattended -nosplash -nullrhi -stdout

Or run from the editor Python console with the same arguments in
``sys.argv``. The optional ``--zip`` flag additionally writes
``director-engine-scene.zip`` next to the output directory, ready to upload
to ``POST /api/dcc/engine-scene/uploads?provider=unreal``.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
import zipfile
from datetime import datetime, timezone

import unreal  # type: ignore[import-not-found]

EXPORTER_NAME = "director-unreal-scene-export"
EXPORTER_VERSION = "1.0.0"
CONTRACT = "director-engine-scene-v1"
MAX_NODES = 20_000
CENTIMETERS_TO_METERS = 0.01

# Intensity heuristics: Director lights use a unitless 0..100 intensity.
# Directional light lux and local light lumens are normalized against
# photographic references (10 lux overcast key, 800 lm household bulb).
DIRECTIONAL_LUX_PER_INTENSITY = 10.0
LUMENS_PER_INTENSITY = 800.0


def _log(message: str) -> None:
    unreal.log(f"[director] {message}")


def _sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _ue_point_to_director(location) -> list:
    """Map an Unreal world point (cm, Z-up, LH) into Director space (m, Y-up, RH)."""
    return [
        location.y * CENTIMETERS_TO_METERS,
        location.z * CENTIMETERS_TO_METERS,
        -location.x * CENTIMETERS_TO_METERS,
    ]


def _ue_direction_to_director(direction) -> list:
    return [direction.y, direction.z, -direction.x]


def _matrix_from_quaternion(q) -> list:
    """Row-major 3x3 rotation matrix from an Unreal quaternion."""
    x, y, z, w = q.x, q.y, q.z, q.w
    return [
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ]


# Change of basis M maps UE basis vectors into Director space:
# ue X -> (0,0,-1), ue Y -> (1,0,0), ue Z -> (0,1,0). det(M) = -1 converts
# left-handed to right-handed. Rotations convert as R' = M @ R @ M^-1.
_BASIS = [[0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [-1.0, 0.0, 0.0]]
_BASIS_INVERSE = [[0.0, 0.0, -1.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]


def _matrix_multiply(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(3)) for j in range(3)] for i in range(3)]


def _euler_xyz_from_matrix(m) -> list:
    """Intrinsic XYZ Euler angles (radians) from a row-major rotation matrix."""
    sy = max(-1.0, min(1.0, m[0][2]))
    y = math.asin(sy)
    if abs(sy) < 0.999999:
        x = math.atan2(-m[1][2], m[2][2])
        z = math.atan2(-m[0][1], m[0][0])
    else:
        x = math.atan2(m[2][1], m[1][1])
        z = 0.0
    return [x, y, z]


def _ue_transform_to_director(transform) -> dict:
    location = _ue_point_to_director(transform.translation)
    rotation_matrix = _matrix_from_quaternion(transform.rotation)
    director_matrix = _matrix_multiply(_BASIS, _matrix_multiply(rotation_matrix, _BASIS_INVERSE))
    scale = transform.scale3d
    return {
        "position": location,
        "rotation": _euler_xyz_from_matrix(director_matrix),
        "scale": [scale.y, scale.z, scale.x],
    }


def _linear_color_to_hex(color) -> str:
    def channel(value: float) -> int:
        srgb = 1.055 * (max(0.0, min(1.0, value)) ** (1.0 / 2.4)) - 0.055 if value > 0.0031308 else value * 12.92
        return max(0, min(255, round(srgb * 255)))

    return "#{:02x}{:02x}{:02x}".format(channel(color.r), channel(color.g), channel(color.b))


def _actor_source_id(actor) -> str:
    return actor.get_path_name()[:240]


def _classify_actor(actor) -> str:
    if isinstance(actor, (unreal.CameraActor,)):
        return "camera"
    if isinstance(actor, (unreal.Light,)) or isinstance(actor, (unreal.SkyLight,)):
        return "light"
    if actor.get_component_by_class(unreal.SkeletalMeshComponent):
        return "skinned-mesh"
    if actor.get_component_by_class(unreal.StaticMeshComponent):
        return "mesh"
    if isinstance(actor, unreal.Actor) and actor.root_component is None:
        return "other"
    return "group"


def _camera_record(actor, warnings: list) -> dict:
    transform = actor.get_actor_transform()
    position = _ue_point_to_director(transform.translation)
    forward = _ue_direction_to_director(actor.get_actor_forward_vector())
    component = actor.get_component_by_class(unreal.CineCameraComponent)
    sensor_width = None
    sensor_height = None
    aperture = None
    focus_distance = None
    if component:
        filmback = component.filmback
        sensor_width = float(filmback.sensor_width)
        sensor_height = float(filmback.sensor_height)
        focal_length = float(component.current_focal_length)
        vertical_fov = math.degrees(2.0 * math.atan(sensor_height / (2.0 * focal_length)))
        aperture = float(component.current_aperture)
        focus_settings = component.focus_settings
        if focus_settings.focus_method == unreal.CameraFocusMethod.MANUAL:
            focus_distance = float(focus_settings.manual_focus_distance) * CENTIMETERS_TO_METERS
        aspect = sensor_width / sensor_height if sensor_height else 16.0 / 9.0
    else:
        camera = actor.get_component_by_class(unreal.CameraComponent)
        horizontal_fov = float(camera.field_of_view) if camera else 90.0
        aspect = float(camera.aspect_ratio) if camera and camera.aspect_ratio else 16.0 / 9.0
        vertical_fov = math.degrees(
            2.0 * math.atan(math.tan(math.radians(horizontal_fov) / 2.0) / max(aspect, 0.0001))
        )
        warnings.append(
            f"Camera {actor.get_actor_label()} is not a cine camera; sensor and aperture use Director defaults."
        )
    distance = focus_distance if focus_distance and focus_distance > 0.01 else 10.0
    look_target = [position[i] + forward[i] * distance for i in range(3)]
    record = {
        "sourceId": _actor_source_id(actor),
        "name": actor.get_actor_label()[:240] or "Camera",
        "position": position,
        "lookTarget": look_target,
        "verticalFovDegrees": max(0.1, min(179.0, vertical_fov)),
        "nearClipM": 0.1,
        "farClipM": 100000.0,
        "renderAspectRatio": max(0.1, min(20.0, aspect)),
    }
    if sensor_width and sensor_height:
        record["sensorWidthMm"] = sensor_width
        record["sensorHeightMm"] = sensor_height
    if aperture:
        record["apertureFStop"] = max(0.1, min(256.0, aperture))
    if focus_distance:
        record["focusDistanceM"] = max(0.01, min(1000000.0, focus_distance))
    warnings.append(
        f"Camera {actor.get_actor_label()} clip planes use Director defaults; Unreal manages near/far clipping globally."
    )
    return record


def _light_record(actor, warnings: list) -> dict | None:
    source_id = _actor_source_id(actor)
    name = actor.get_actor_label()[:240] or "Light"
    transform = actor.get_actor_transform()
    position = _ue_point_to_director(transform.translation)
    forward = _ue_direction_to_director(actor.get_actor_forward_vector())
    target = [position[i] + forward[i] * 10.0 for i in range(3)]

    if isinstance(actor, unreal.SkyLight):
        component = actor.get_component_by_class(unreal.SkyLightComponent)
        intensity = float(component.intensity) if component else 1.0
        color = _linear_color_to_hex(component.light_color) if component else "#ffffff"
        warnings.append(f"Sky light {name} was mapped to a Director ambient light with a heuristic intensity.")
        return {
            "sourceId": source_id,
            "name": name,
            "type": "ambient",
            "color": color,
            "intensity": max(0.0, min(100.0, intensity)),
        }

    component = actor.get_component_by_class(unreal.LightComponent)
    if not component:
        return None
    color = _linear_color_to_hex(component.light_color)
    raw_intensity = float(component.intensity)
    cast_shadow = bool(component.cast_shadows)

    if isinstance(actor, unreal.DirectionalLight):
        return {
            "sourceId": source_id,
            "name": name,
            "type": "directional",
            "color": color,
            "intensity": max(0.0, min(100.0, raw_intensity / DIRECTIONAL_LUX_PER_INTENSITY)),
            "position": position,
            "target": target,
            "castShadow": cast_shadow,
        }
    if isinstance(actor, unreal.SpotLight):
        spot = actor.get_component_by_class(unreal.SpotLightComponent)
        outer = float(spot.outer_cone_angle) if spot else 44.0
        inner = float(spot.inner_cone_angle) if spot else 0.0
        record = {
            "sourceId": source_id,
            "name": name,
            "type": "spot",
            "color": color,
            "intensity": max(0.0, min(100.0, raw_intensity / LUMENS_PER_INTENSITY)),
            "position": position,
            "target": target,
            "angleDegrees": max(0.1, min(179.0, outer * 2.0)),
            "penumbra": max(0.0, min(1.0, 1.0 - (inner / outer if outer else 0.0))),
            "castShadow": cast_shadow,
        }
        radius = float(spot.attenuation_radius) if spot else 0.0
        if radius > 0:
            record["rangeM"] = radius * CENTIMETERS_TO_METERS
        return record
    if isinstance(actor, unreal.RectLight):
        rect = actor.get_component_by_class(unreal.RectLightComponent)
        return {
            "sourceId": source_id,
            "name": name,
            "type": "rect-area",
            "color": color,
            "intensity": max(0.0, min(100.0, raw_intensity / LUMENS_PER_INTENSITY)),
            "position": position,
            "target": target,
            "widthM": max(0.01, float(rect.source_width) * CENTIMETERS_TO_METERS) if rect else 1.0,
            "heightM": max(0.01, float(rect.source_height) * CENTIMETERS_TO_METERS) if rect else 1.0,
            "castShadow": cast_shadow,
        }
    point = actor.get_component_by_class(unreal.PointLightComponent)
    record = {
        "sourceId": source_id,
        "name": name,
        "type": "point",
        "color": color,
        "intensity": max(0.0, min(100.0, raw_intensity / LUMENS_PER_INTENSITY)),
        "position": position,
        "castShadow": cast_shadow,
    }
    radius = float(point.attenuation_radius) if point else 0.0
    if radius > 0:
        record["rangeM"] = radius * CENTIMETERS_TO_METERS
    return record


def _export_glb(world, bundle_path: str, warnings: list, unsupported: list, mesh_actor_count: int) -> bool:
    if mesh_actor_count == 0:
        return False
    exporter = getattr(unreal, "GLTFExporter", None)
    options_class = getattr(unreal, "GLTFExportOptions", None)
    if exporter is None or options_class is None:
        unsupported.append(
            {
                "kind": "geometry",
                "name": "scene",
                "reason": "The glTF Exporter plugin is not enabled; renderable geometry was skipped. Enable it in Edit > Plugins and re-export.",
            }
        )
        return False
    options = options_class()
    options.export_uniform_scale = CENTIMETERS_TO_METERS
    ok = exporter.export_to_gltf(world, bundle_path, options, set())
    if not ok:
        unsupported.append(
            {"kind": "geometry", "name": "scene", "reason": "glTF export reported a failure; geometry was skipped."}
        )
        return False
    warnings.append(
        "Level geometry, materials, skeletal meshes, and animation data are embedded in assets/scene.glb by the glTF Exporter plugin."
    )
    return True


def export_scene(output_dir: str, scene: str | None, make_zip: bool) -> str:
    if scene:
        _log(f"Loading level {scene}")
        unreal.EditorLoadingAndSavingUtils.load_map(scene)

    editor_actor = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    world = unreal.EditorLevelLibrary.get_editor_world()
    actors = list(editor_actor.get_all_level_actors())

    warnings: list = []
    unsupported: list = []
    nodes: list = []
    cameras: list = []
    lights: list = []
    mesh_count = 0
    skinned_count = 0

    truncated = False
    for actor in actors:
        kind = _classify_actor(actor)
        if kind == "camera":
            cameras.append(_camera_record(actor, warnings))
        elif kind == "light":
            record = _light_record(actor, warnings)
            if record:
                lights.append(record)
            else:
                unsupported.append(
                    {
                        "kind": "light",
                        "name": actor.get_actor_label()[:240] or "Light",
                        "reason": "Unsupported light component; only directional, point, spot, rect, and sky lights map to Director.",
                    }
                )
                continue
        elif kind == "mesh":
            mesh_count += 1
        elif kind == "skinned-mesh":
            skinned_count += 1
        if len(nodes) < MAX_NODES:
            parent = actor.get_attach_parent_actor()
            node = {
                "sourceId": _actor_source_id(actor),
                "name": actor.get_actor_label()[:240] or "Actor",
                "kind": kind,
                "transform": _ue_transform_to_director(actor.get_actor_transform()),
            }
            if parent:
                node["parentSourceId"] = _actor_source_id(parent)
            nodes.append(node)
        else:
            truncated = True
    if truncated:
        warnings.append(f"Hierarchy snapshot was truncated to {MAX_NODES} nodes; the GLB bundle keeps the full scene.")
    known_node_ids = {node["sourceId"] for node in nodes}
    for node in nodes:
        if "parentSourceId" in node and node["parentSourceId"] not in known_node_ids:
            del node["parentSourceId"]

    os.makedirs(output_dir, exist_ok=True)
    assets_dir = os.path.join(output_dir, "assets")
    os.makedirs(assets_dir, exist_ok=True)
    bundle_relative = "assets/scene.glb"
    bundle_path = os.path.join(output_dir, bundle_relative)
    bundle_written = _export_glb(world, bundle_path, warnings, unsupported, mesh_count + skinned_count)
    if not bundle_written:
        if mesh_count or skinned_count:
            for node in nodes:
                if node["kind"] in ("mesh", "skinned-mesh"):
                    unsupported.append(
                        {
                            "kind": node["kind"],
                            "name": node["name"],
                            "reason": "Geometry was not exported because the GLB bundle is unavailable.",
                        }
                    )
        mesh_count = 0
        skinned_count = 0

    level_sequences = [actor for actor in actors if isinstance(actor, unreal.LevelSequenceActor)]
    clips = []
    for sequence_actor in level_sequences[:512]:
        sequence = sequence_actor.get_sequence()
        if sequence:
            clips.append({"name": str(sequence.get_name())[:240]})
    if level_sequences:
        warnings.append(
            "Level Sequences are inventoried by name only; Sequencer animation is not baked into Director's timeline in v1."
        )

    file_hashes = {}
    if bundle_written:
        file_hashes[bundle_relative] = _sha256(bundle_path)

    world_name = str(world.get_name())[:240] or "Level"
    project_name = str(unreal.SystemLibrary.get_game_name())[:240] or "UnrealProject"
    engine_version = str(unreal.SystemLibrary.get_engine_version())[:200]
    package_id = f"unreal-scene-{hashlib.sha256((project_name + ':' + world_name).encode('utf-8')).hexdigest()[:20]}"

    manifest = {
        "schemaVersion": 1,
        "contract": CONTRACT,
        "packageId": package_id,
        "provider": "unreal",
        "exportedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "engineVersion": engine_version or "unknown",
        "exporter": {"name": EXPORTER_NAME, "version": EXPORTER_VERSION},
        "source": {"projectName": project_name, "sceneName": world_name},
        "coordinateSystem": {
            "source": "left-handed-z-up-x-forward-centimeter",
            "destination": "right-handed-y-up-negative-z-forward",
            "unit": "meter",
            "linearMap": "(x,y,z)->(y,z,-x)*0.01",
        },
        "timeline": {"frameStart": 0, "frameEnd": 0, "currentFrame": 0, "fps": 30},
        "scene": {
            "name": world_name,
            "bundleFile": bundle_relative if bundle_written else None,
            "nodeCount": max(len(actors), len(nodes)),
            "meshCount": mesh_count,
            "skinnedMeshCount": skinned_count,
            "materialCount": 0,
            "animationClipCount": len(clips),
        },
        "nodes": nodes,
        "cameras": cameras[:512],
        "lights": lights[:1024],
        "animationClips": clips,
        "unsupported": unsupported[:20000],
        "warnings": warnings[:20000],
        "fileHashes": file_hashes,
    }

    manifest_path = os.path.join(output_dir, "manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
    _log(f"Wrote {manifest_path}")

    if make_zip:
        zip_path = os.path.join(os.path.dirname(os.path.abspath(output_dir)), "director-engine-scene.zip")
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as archive:
            for root, _directories, files in os.walk(output_dir):
                for file_name in files:
                    absolute = os.path.join(root, file_name)
                    archive.write(absolute, os.path.relpath(absolute, output_dir))
        _log(f"Wrote {zip_path}")
    return manifest_path


def main() -> int:
    parser = argparse.ArgumentParser(description="Export the current Unreal level as a Director engine scene package.")
    parser.add_argument("--output-dir", required=True, help="Directory that receives manifest.json and assets/")
    parser.add_argument("--scene", default=None, help="Optional level path to load before exporting (/Game/...)")
    parser.add_argument("--zip", action="store_true", help="Also write director-engine-scene.zip next to the output")
    arguments, _unknown = parser.parse_known_args()
    export_scene(os.path.abspath(arguments.output_dir), arguments.scene, arguments.zip)
    return 0


if __name__ == "__main__":
    sys.exit(main())
