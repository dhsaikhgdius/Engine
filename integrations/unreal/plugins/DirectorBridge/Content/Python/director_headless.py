"""Fixed headless entry point for the Director Unreal connector.

Invoked by the Director Gateway (never with a request-supplied script) as:

    UnrealEditor-Cmd <Project>.uproject -ExecutePythonScript="director_headless.py \
        --mode import --package <dir> --report <report.json> --return-dir <dir>" \
        -unattended -nopause -nosplash -nullrhi -stdout

Modes:
- ``health``  print a JSON health line with the engine and connector version.
- ``import``  import a Director exchange package into a Director level with
  stable ``director_id`` actor tags, then echo a canonical-space return
  package so Director can verify the round trip.
- ``export``  export a ``director-dcc-return-v1`` package containing the
  canonical-space transforms of every ``director_id``-tagged actor that moved
  relative to the exchange package baseline.

All transforms cross the provider boundary in Director canonical space
(right-handed, Y-up, metres); ``director_space`` owns the basis change.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

import director_package as dpkg  # noqa: E402
import director_space as dspace  # noqa: E402

CONNECTOR_VERSION = "0.1.0"
PROVIDER = "unreal"
DIRECTOR_TAG_PREFIX = "director_id:"
CONTENT_ROOT = "/Game/Director"
TRANSFORM_TOLERANCE = 1e-6


def _load_unreal():
    try:
        import unreal  # type: ignore

        return unreal
    except ImportError:
        return None


def host_version(unreal) -> str:
    return f"Unreal Engine {unreal.SystemLibrary.get_engine_version().split('-')[0]}"


def canonical_world_transform(scene: dict, transform: dict) -> dict:
    """Compose the Director scene transform with an entity's local TRS."""
    return dspace.compose_world_transform(
        scene["position"],
        scene["rotation"],
        scene["scale"],
        transform["position"],
        dspace.quat_from_euler_xyz(*transform["rotation"]),
        transform["scale"],
    )


def unreal_transform_from_canonical(unreal, canonical: dict):
    engine = dspace.director_transform_to_unreal(canonical)
    location = unreal.Vector(*engine["location"])
    quaternion = unreal.Quat(*engine["rotationQuaternion"])
    scale = unreal.Vector(*engine["scale"])
    return unreal.Transform(location=location, rotation=quaternion.rotator(), scale=scale)


def canonical_from_unreal_transform(actor_transform) -> dict:
    quaternion = actor_transform.rotation
    return dspace.unreal_transform_to_director(
        {
            "location": [actor_transform.translation.x, actor_transform.translation.y, actor_transform.translation.z],
            "rotationQuaternion": [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
            "scale": [actor_transform.scale3d.x, actor_transform.scale3d.y, actor_transform.scale3d.z],
        }
    )


def director_id_of_actor(actor) -> str | None:
    for tag in actor.tags:
        value = str(tag)
        if value.startswith(DIRECTOR_TAG_PREFIX):
            return value[len(DIRECTOR_TAG_PREFIX) :]
    return None


def safe_asset_name(value: str) -> str:
    cleaned = "".join(character if character.isalnum() or character in "_-" else "_" for character in value)
    return cleaned[:96] or "DirectorAsset"


def import_glb_asset(unreal, glb_path: str, destination_path: str, warnings: list[str]):
    """Import one GLB payload through the editor's asset import pipeline."""
    task = unreal.AssetImportTask()
    task.filename = glb_path
    task.destination_path = destination_path
    task.automated = True
    task.replace_existing = True
    task.save = True
    unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([task])
    imported = list(task.imported_object_paths or [])
    for object_path in imported:
        asset = unreal.EditorAssetLibrary.load_asset(object_path)
        if isinstance(asset, unreal.StaticMesh):
            return asset
    warnings.append(f"GLB import produced no StaticMesh for {os.path.basename(glb_path)}; spawning an empty actor.")
    return None


def spawn_actors(unreal, manifest: dict, package_dir: str, warnings: list[str]):
    """Spawn tagged actors for every Director object and camera."""
    actor_subsystem = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    scene = manifest["project"]["scene"]
    assets_by_id = {}
    for asset_entry in manifest.get("assets", []):
        assets_by_id[asset_entry["assetRefId"]] = dpkg.resolve_package_file(package_dir, asset_entry["relativePath"])

    imported_meshes: dict[str, object] = {}
    spawned: dict[str, object] = {}
    package_folder = safe_asset_name(manifest["packageId"][:8])

    for entity in manifest["project"]["objects"]:
        canonical = canonical_world_transform(scene, entity["transform"])
        transform = unreal_transform_from_canonical(unreal, canonical)
        mesh = None
        asset_ref = entity.get("assetRefId")
        if asset_ref and asset_ref in assets_by_id and assets_by_id[asset_ref].lower().endswith(".glb"):
            if asset_ref not in imported_meshes:
                imported_meshes[asset_ref] = import_glb_asset(
                    unreal,
                    assets_by_id[asset_ref],
                    f"{CONTENT_ROOT}/Assets/{package_folder}",
                    warnings,
                )
            mesh = imported_meshes[asset_ref]
        if mesh is not None:
            actor = actor_subsystem.spawn_actor_from_class(
                unreal.StaticMeshActor, transform.translation, transform.rotation.rotator()
            )
            actor.static_mesh_component.set_static_mesh(mesh)
            actor.static_mesh_component.set_mobility(unreal.ComponentMobility.MOVABLE)
        else:
            actor = actor_subsystem.spawn_actor_from_class(
                unreal.Actor, transform.translation, transform.rotation.rotator()
            )
            if entity.get("assetRefId"):
                warnings.append(
                    f"Object {entity['id']} references asset {entity.get('assetRefId')} that is not a GLB payload; "
                    "spawned as an empty actor (warn-and-omit)."
                )
        actor.set_actor_transform(transform, False, False)
        actor.set_actor_label(entity["name"])
        actor.tags = [unreal.Name(f"{DIRECTOR_TAG_PREFIX}{entity['id']}")]
        actor.set_folder_path(unreal.Name(f"Director/{package_folder}"))
        if not entity.get("visible", True):
            actor.set_actor_hidden_in_game(True)
        spawned[entity["id"]] = actor

    # Restore the Director parent hierarchy while keeping world transforms.
    for entity in manifest["project"]["objects"]:
        parent_id = entity.get("parentObjectId")
        if parent_id and parent_id in spawned and entity["id"] in spawned:
            spawned[entity["id"]].attach_to_actor(
                spawned[parent_id],
                unreal.Name("None"),
                unreal.AttachmentRule.KEEP_WORLD,
                unreal.AttachmentRule.KEEP_WORLD,
                unreal.AttachmentRule.KEEP_WORLD,
                False,
            )

    cameras: dict[str, object] = {}
    for camera in manifest["project"]["cameras"]:
        canonical = canonical_world_transform(scene, camera["transform"])
        transform = unreal_transform_from_canonical(unreal, canonical)
        actor = actor_subsystem.spawn_actor_from_class(
            unreal.CineCameraActor, transform.translation, transform.rotation.rotator()
        )
        actor.set_actor_transform(transform, False, False)
        actor.set_actor_label(camera["name"])
        actor.tags = [unreal.Name(f"{DIRECTOR_TAG_PREFIX}{camera['id']}")]
        actor.set_folder_path(unreal.Name(f"Director/{package_folder}/Cameras"))
        focal_length = camera.get("focalLengthMm")
        if focal_length:
            actor.get_cine_camera_component().current_focal_length = float(focal_length)
        cameras[camera["id"]] = actor
    return spawned, cameras


def build_shot_sequence(unreal, manifest: dict, cameras: dict, warnings: list[str]) -> str | None:
    """Map Director storyboard shots to a LevelSequence with camera cuts.

    Director exchange packages carry a static snapshot, so shots become camera
    cut sections over the shot frame ranges; animation baking stays a Director
    responsibility until the animation capability is promoted.
    """
    storyboard = manifest["project"].get("storyboard")
    timeline = manifest["project"]["scene"].get("timeline")
    shots = [shot for shot in (storyboard or {}).get("shots", []) if shot.get("cameraId") in cameras]
    if not shots:
        return None
    try:
        package_folder = safe_asset_name(manifest["packageId"][:8])
        sequence_path = f"{CONTENT_ROOT}/Sequences/{package_folder}"
        sequence_name = "DirectorShots"
        asset_tools = unreal.AssetToolsHelpers.get_asset_tools()
        sequence = asset_tools.create_asset(
            sequence_name, sequence_path, unreal.LevelSequence, unreal.LevelSequenceFactoryNew()
        )
        fps = int((timeline or {}).get("fps", 24)) or 24
        sequence.set_display_rate(unreal.FrameRate(fps, 1))
        frame_start = min(int(shot["frameStart"]) for shot in shots)
        frame_end = max(int(shot["frameEnd"]) for shot in shots)
        sequence.set_playback_start(frame_start)
        sequence.set_playback_end(frame_end)
        camera_cut_track = sequence.add_track(unreal.MovieSceneCameraCutTrack)
        for shot in shots:
            camera_actor = cameras[shot["cameraId"]]
            binding = sequence.add_possessable(camera_actor)
            section = camera_cut_track.add_section()
            section.set_range(int(shot["frameStart"]), int(shot["frameEnd"]))
            camera_binding_id = unreal.MovieSceneObjectBindingID()
            camera_binding_id.set_editor_property("guid", binding.get_id())
            section.set_editor_property("camera_binding_id", camera_binding_id)
        unreal.EditorAssetLibrary.save_asset(f"{sequence_path}/{sequence_name}")
        warnings.append(
            "Storyboard shots were mapped to LevelSequence camera cuts from the static snapshot; "
            "per-frame animation baking stays planned until the animation capability is promoted."
        )
        return f"{sequence_path}/{sequence_name}"
    except Exception as error:  # noqa: BLE001 - report every sequencer failure as a warning
        warnings.append(f"Sequencer mapping was skipped: {error}")
        return None


def echo_return_changes(spawned: dict, cameras: dict) -> list[dict]:
    """Read back the spawned actors so the echo package proves the round trip."""
    changes: list[dict] = []
    for director_id, actor in spawned.items():
        changes.append(
            {
                "kind": "transform_update",
                "directorId": director_id,
                "entityType": "object",
                "transform": canonical_from_unreal_transform(actor.get_actor_transform()),
            }
        )
    for director_id, actor in cameras.items():
        changes.append(
            {
                "kind": "transform_update",
                "directorId": director_id,
                "entityType": "camera",
                "transform": canonical_from_unreal_transform(actor.get_actor_transform()),
            }
        )
    return changes


def run_import(unreal, arguments) -> int:
    warnings: list[str] = []
    manifest = dpkg.load_exchange_package(arguments.package, PROVIDER)
    level_subsystem = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)
    package_folder = safe_asset_name(manifest["packageId"][:8])
    level_path = f"{CONTENT_ROOT}/Levels/Director_{package_folder}"
    level_subsystem.new_level(level_path)
    spawned, cameras = spawn_actors(unreal, manifest, arguments.package, warnings)
    sequence_path = build_shot_sequence(unreal, manifest, cameras, warnings)
    if sequence_path:
        warnings.append(f"Camera cuts live in {sequence_path}.")
    level_subsystem.save_current_level()

    return_dir = None
    if arguments.return_dir:
        dpkg.write_return_package(
            arguments.return_dir,
            provider=PROVIDER,
            host_version=host_version(unreal),
            connector_version=CONNECTOR_VERSION,
            source_package_id=manifest["packageId"],
            source_revision=manifest["sourceRevision"],
            changes=echo_return_changes(spawned, cameras),
            warnings=["Echo return package written immediately after import; edit the level and re-export to send changes."],
        )
        return_dir = os.path.relpath(arguments.return_dir, os.path.dirname(arguments.report)).replace(os.sep, "/")

    dpkg.write_report(
        arguments.report,
        provider=PROVIDER,
        host_version=host_version(unreal),
        connector_version=CONNECTOR_VERSION,
        package_id=manifest["packageId"],
        source_revision=manifest["sourceRevision"],
        imported_object_count=len(spawned),
        imported_camera_count=len(cameras),
        scene_path=level_path,
        return_package_dir=return_dir,
        warnings=warnings,
    )
    return 0


def run_export(unreal, arguments) -> int:
    warnings: list[str] = []
    manifest = dpkg.load_exchange_package(arguments.package, PROVIDER)
    scene = manifest["project"]["scene"]
    baselines: dict[str, tuple[str, dict]] = {}
    for entity in manifest["project"]["objects"]:
        baselines[entity["id"]] = ("object", canonical_world_transform(scene, entity["transform"]))
    for camera in manifest["project"]["cameras"]:
        baselines[camera["id"]] = ("camera", canonical_world_transform(scene, camera["transform"]))

    actor_subsystem = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    changes: list[dict] = []
    seen = 0
    for actor in actor_subsystem.get_all_level_actors():
        director_id = director_id_of_actor(actor)
        if not director_id:
            continue
        seen += 1
        canonical = canonical_from_unreal_transform(actor.get_actor_transform())
        baseline = baselines.get(director_id)
        if baseline is None:
            warnings.append(f"Actor {actor.get_actor_label()} carries unknown director_id {director_id}; skipped.")
            continue
        entity_type, baseline_transform = baseline
        moved = any(
            abs(canonical["location"][index] - baseline_transform["location"][index]) > TRANSFORM_TOLERANCE
            for index in range(3)
        ) or any(
            abs(canonical["scale"][index] - baseline_transform["scale"][index]) > TRANSFORM_TOLERANCE
            for index in range(3)
        )
        if not moved:
            dot = sum(
                canonical["rotationQuaternion"][index] * baseline_transform["rotationQuaternion"][index]
                for index in range(4)
            )
            moved = abs(abs(dot) - 1.0) > TRANSFORM_TOLERANCE
        if moved:
            changes.append(
                {
                    "kind": "transform_update",
                    "directorId": director_id,
                    "entityType": entity_type,
                    "transform": canonical,
                }
            )
    if seen == 0:
        warnings.append("No director_id-tagged actors were found in the current level.")

    dpkg.write_return_package(
        arguments.return_dir,
        provider=PROVIDER,
        host_version=host_version(unreal),
        connector_version=CONNECTOR_VERSION,
        source_package_id=manifest["packageId"],
        source_revision=manifest["sourceRevision"],
        changes=changes,
        warnings=warnings,
    )
    dpkg.write_report(
        arguments.report,
        provider=PROVIDER,
        host_version=host_version(unreal),
        connector_version=CONNECTOR_VERSION,
        package_id=manifest["packageId"],
        source_revision=manifest["sourceRevision"],
        imported_object_count=0,
        imported_camera_count=0,
        scene_path=None,
        return_package_dir=os.path.relpath(arguments.return_dir, os.path.dirname(arguments.report)).replace(
            os.sep, "/"
        ),
        warnings=warnings,
    )
    return 0


def run_health(unreal) -> int:
    if unreal is None:
        print(json.dumps({"ok": False, "provider": PROVIDER, "error": "The unreal module is unavailable."}))
        return 1
    print(
        json.dumps(
            {
                "ok": True,
                "provider": PROVIDER,
                "hostVersion": host_version(unreal),
                "connectorVersion": CONNECTOR_VERSION,
            }
        )
    )
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Director Unreal connector headless entry point.")
    parser.add_argument("--mode", required=True, choices=["health", "import", "export"])
    parser.add_argument("--package", help="Director exchange package directory.")
    parser.add_argument("--report", help="Path of the report.json receipt to write.")
    parser.add_argument("--return-dir", dest="return_dir", help="Directory for the return package.")
    arguments = parser.parse_args(argv)

    unreal = _load_unreal()
    if arguments.mode == "health":
        return run_health(unreal)
    if unreal is None:
        if arguments.report:
            dpkg.write_failure_report(arguments.report, "The unreal module is unavailable; run inside UnrealEditor-Cmd.")
        return 1
    if not arguments.package or not arguments.report:
        if arguments.report:
            dpkg.write_failure_report(arguments.report, "--package and --report are required.")
        return 2
    try:
        if arguments.mode == "import":
            return run_import(unreal, arguments)
        if not arguments.return_dir:
            dpkg.write_failure_report(arguments.report, "--return-dir is required for export.")
            return 2
        return run_export(unreal, arguments)
    except Exception as error:  # noqa: BLE001 - the report is the failure channel
        dpkg.write_failure_report(arguments.report, f"{error}\n{traceback.format_exc()}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
