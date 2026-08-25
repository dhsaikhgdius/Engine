"""Fixed headless entry point for the Director Unreal connector.

Invoked by the Director Gateway (never with a request-supplied script) as:

    UnrealEditor-Cmd <Project>.uproject -ExecutePythonScript="director_headless.py \
        --mode import --package <dir> --report <report.json> --return-dir <dir> \
        [--animation <bake.json> --animation-sha256 <hex>]" \
        -unattended -nopause -nosplash -nullrhi -stdout

Modes:
- ``health``  print a JSON health line with the engine and connector version.
- ``import``  import a Director exchange package into a Director level with
  stable ``director_id`` actor tags, author materials, import skinned GLBs as
  skeletal meshes, key the Sequencer from the hash-pinned animation bake, then
  echo a canonical-space return package so Director can verify the round trip.
- ``export``  export a ``director-dcc-return-v1`` package containing the
  canonical-space transforms of every ``director_id``-tagged actor that moved
  relative to the exchange package baseline.
- ``live-preview``  preview-only loopback camera feed into the editor
  viewport (sequence-numbered, token-gated); never a durable scene channel.

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

import director_bake as dbake  # noqa: E402
import director_gltf as dgltf  # noqa: E402
import director_host_materials as dhostmat  # noqa: E402
import director_livelink as dlivelink  # noqa: E402
import director_materials as dmaterials  # noqa: E402
import director_package as dpkg  # noqa: E402
import director_sequencer as dsequencer  # noqa: E402
import director_space as dspace  # noqa: E402

CONNECTOR_VERSION = "0.2.0"
PROVIDER = "unreal"
DIRECTOR_TAG_PREFIX = "director_id:"
CONTENT_ROOT = "/Game/Director"
TRANSFORM_TOLERANCE = 1e-6
PREVIEW_TOKEN_ENV = "DIRECTOR_UNREAL_PREVIEW_TOKEN"
CONNECTOR_FEATURES = ["animation_bake", "sequencer_timebase", "skeletal_import", "materials", "live_preview_protocol"]


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


def canonical_camera_world_transform(scene: dict, camera: dict) -> dict:
    """Camera world transform with the look-at rotation the exporters use."""
    look_quaternion = dspace.camera_look_quaternion(
        camera["transform"]["position"], camera["target"], camera["transform"]["rotation"]
    )
    return dspace.compose_world_transform(
        scene["position"],
        scene["rotation"],
        scene["scale"],
        camera["transform"]["position"],
        look_quaternion,
        camera["transform"]["scale"],
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


def import_glb_asset(unreal, glb_path: str, destination_path: str, prefer_skeletal: bool, warnings: list[str]):
    """Import one GLB payload through the editor's asset import pipeline.

    @returns ``(asset, kind)`` where kind is ``"skeletal"``, ``"static"``, or None.
    """
    task = unreal.AssetImportTask()
    task.filename = glb_path
    task.destination_path = destination_path
    task.automated = True
    task.replace_existing = True
    task.save = True
    unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([task])
    imported = list(task.imported_object_paths or [])
    skeletal_mesh = None
    static_mesh = None
    for object_path in imported:
        asset = unreal.EditorAssetLibrary.load_asset(object_path)
        if skeletal_mesh is None and isinstance(asset, unreal.SkeletalMesh):
            skeletal_mesh = asset
        elif static_mesh is None and isinstance(asset, unreal.StaticMesh):
            static_mesh = asset
    if prefer_skeletal:
        if skeletal_mesh is not None:
            return skeletal_mesh, "skeletal"
        if static_mesh is not None:
            warnings.append(
                f"Skinned GLB {os.path.basename(glb_path)} imported as a static mesh only; "
                "the bind-pose skeleton was not produced by the import pipeline (warn-and-omit)."
            )
            return static_mesh, "static"
    if static_mesh is not None:
        return static_mesh, "static"
    if skeletal_mesh is not None:
        return skeletal_mesh, "skeletal"
    warnings.append(f"GLB import produced no mesh for {os.path.basename(glb_path)}; spawning an empty actor.")
    return None, None


def _spawn_mesh_actor(unreal, actor_subsystem, mesh, kind: str, transform):
    """Spawn the right actor class for a static or skeletal mesh and attach the asset."""
    if kind == "skeletal":
        actor = actor_subsystem.spawn_actor_from_class(
            unreal.SkeletalMeshActor, transform.translation, transform.rotation.rotator()
        )
        component = actor.skeletal_mesh_component
        try:
            component.set_skeletal_mesh_asset(mesh)
        except AttributeError:
            component.set_editor_property("skeletal_mesh_asset", mesh)
        return actor, component
    actor = actor_subsystem.spawn_actor_from_class(
        unreal.StaticMeshActor, transform.translation, transform.rotation.rotator()
    )
    actor.static_mesh_component.set_static_mesh(mesh)
    actor.static_mesh_component.set_mobility(unreal.ComponentMobility.MOVABLE)
    return actor, actor.static_mesh_component


def spawn_actors(unreal, manifest: dict, package_dir: str, warnings: list[str]):
    """Spawn tagged actors for every Director object and camera.

    @returns ``(spawned, cameras, stats)`` where stats carries
        ``importedSkeletalMeshCount`` and ``appliedMaterialCount``.
    """
    actor_subsystem = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    scene = manifest["project"]["scene"]
    assets_by_id = {}
    for asset_entry in manifest.get("assets", []):
        assets_by_id[asset_entry["assetRefId"]] = dpkg.resolve_package_file(package_dir, asset_entry["relativePath"])

    glb_inspections: dict[str, dict] = {}

    def inspect_payload(asset_ref: str, glb_path: str) -> dict:
        if asset_ref not in glb_inspections:
            try:
                glb_inspections[asset_ref] = dgltf.inspect_glb(glb_path)
            except dgltf.DirectorGltfError as error:
                warnings.append(f"GLB inspection failed for {os.path.basename(glb_path)}: {error}")
                glb_inspections[asset_ref] = {"skinned": False}
        return glb_inspections[asset_ref]

    imported_meshes: dict[str, tuple] = {}
    spawned: dict[str, object] = {}
    package_folder = safe_asset_name(manifest["packageId"][:8])
    material_parents = None
    stats = {"importedSkeletalMeshCount": 0, "appliedMaterialCount": 0}

    for entity in manifest["project"]["objects"]:
        canonical = canonical_world_transform(scene, entity["transform"])
        transform = unreal_transform_from_canonical(unreal, canonical)
        mesh = None
        mesh_kind = None
        asset_ref = entity.get("assetRefId")
        if asset_ref and asset_ref in assets_by_id and assets_by_id[asset_ref].lower().endswith(".glb"):
            glb_path = assets_by_id[asset_ref]
            inspection = inspect_payload(asset_ref, glb_path)
            prefer_skeletal = bool(inspection.get("skinned")) or entity.get("kind") == "character"
            if asset_ref not in imported_meshes:
                imported_meshes[asset_ref] = import_glb_asset(
                    unreal,
                    glb_path,
                    f"{CONTENT_ROOT}/Assets/{package_folder}",
                    prefer_skeletal and bool(inspection.get("skinned")),
                    warnings,
                )
            mesh, mesh_kind = imported_meshes[asset_ref]
            if entity.get("kind") == "character" and not inspection.get("skinned"):
                warnings.append(
                    f"Character {entity['name']} references a GLB without a skin; "
                    "it was imported without a skeleton (warn-and-omit)."
                )
        mesh_component = None
        if mesh is not None:
            actor, mesh_component = _spawn_mesh_actor(unreal, actor_subsystem, mesh, mesh_kind, transform)
            if mesh_kind == "skeletal":
                stats["importedSkeletalMeshCount"] += 1
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

        material = entity.get("material")
        if material:
            mapped = dmaterials.map_material(material, entity["name"])
            warnings.extend(mapped["warnings"])
            if mesh_component is None:
                warnings.append(
                    f"Object {entity['id']} has a Director material but no mesh component; "
                    "the material was not applied (warn-and-omit)."
                )
            else:
                if material_parents is None:
                    material_parents = dhostmat.ensure_parent_materials(unreal, CONTENT_ROOT, warnings)
                try:
                    applied = dhostmat.apply_material(
                        unreal,
                        mesh_component,
                        mapped,
                        material_parents,
                        f"MI_{safe_asset_name(entity['id'])}",
                        f"{CONTENT_ROOT}/Materials/{package_folder}",
                        warnings,
                    )
                    if applied:
                        stats["appliedMaterialCount"] += 1
                except Exception as error:  # noqa: BLE001 - material failure must not sink the import
                    warnings.append(f"Material application failed for {entity['id']}: {error}")
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
        canonical = canonical_camera_world_transform(scene, camera)
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
    return spawned, cameras, stats


def load_sequencer_bake(arguments, manifest: dict):
    """Load the hash-pinned Sequencer bake named in the fixed argument array.

    A missing ``--animation`` argument means a static import. A present but
    invalid bake is a hard failure: the Gateway pinned its hash, so any
    mismatch means truncation or tampering.
    """
    if not arguments.animation:
        return None
    bake = dbake.load_bake(
        arguments.animation,
        arguments.animation_sha256 or "",
        manifest["packageId"],
        manifest["sourceRevision"],
    )
    return bake


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
    try:
        bake = load_sequencer_bake(arguments, manifest)
    except (OSError, dbake.DirectorBakeError) as error:
        dpkg.write_failure_report(arguments.report, f"Sequencer bake validation failed: {error}")
        return 1
    level_subsystem = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)
    package_folder = safe_asset_name(manifest["packageId"][:8])
    level_path = f"{CONTENT_ROOT}/Levels/Director_{package_folder}"
    level_subsystem.new_level(level_path)
    spawned, cameras, stats = spawn_actors(unreal, manifest, arguments.package, warnings)
    if bake:
        warnings.extend(bake.get("warnings", []))
        for entity in bake["entities"]:
            warnings.extend(entity.get("warnings", []))

    sequencer_receipt = None
    try:
        sequencer_receipt = dsequencer.build_sequence(unreal, manifest, bake, spawned, cameras, CONTENT_ROOT, warnings)
    except Exception as error:  # noqa: BLE001 - sequencer failure downgrades to a static import
        warnings.append(f"Sequencer authoring was skipped: {error}")
    if sequencer_receipt:
        warnings.append(f"Sequencer tracks live in {sequencer_receipt['sequencePath']}.")
    elif not bake:
        warnings.append(
            "No Sequencer bake was provided; the import is a static snapshot "
            "(camera cuts still map when storyboard shots exist)."
        )
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
        extras={
            "sequencer": sequencer_receipt,
            "importedSkeletalMeshCount": stats["importedSkeletalMeshCount"],
            "appliedMaterialCount": stats["appliedMaterialCount"],
        },
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
        baselines[camera["id"]] = ("camera", canonical_camera_world_transform(scene, camera))

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


def _apply_preview_frame(unreal, payload: dict) -> None:
    """Move the editor viewport camera to one preview frame (no scene writes)."""
    engine = dspace.director_transform_to_unreal(payload["transform"])
    roll, pitch, yaw = dbake.unreal_quat_to_rotator(engine["rotationQuaternion"])
    editor_subsystem = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem)
    editor_subsystem.set_level_viewport_camera_info(
        unreal.Vector(*engine["location"]), unreal.Rotator(roll=roll, pitch=pitch, yaw=yaw)
    )


def run_live_preview(unreal, arguments) -> int:
    """Preview-only loopback camera feed (never the durable scene channel).

    Binds 127.0.0.1 only, requires the shared token from the
    ``DIRECTOR_UNREAL_PREVIEW_TOKEN`` environment variable, applies
    sequence-numbered ``camera_frame`` messages to the editor viewport, and
    stops on ``bye``, a protocol error, or the staleness timeout.
    """
    import socket
    import time

    token = os.environ.get(PREVIEW_TOKEN_ENV, "").strip()
    if not token:
        print(json.dumps({"ok": False, "error": f"{PREVIEW_TOKEN_ENV} is not set; refusing to listen."}))
        return 1
    session = dlivelink.PreviewSession(token, arguments.preview_timeout_ms)
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", arguments.preview_port))
    server.listen(1)
    server.settimeout(arguments.preview_timeout_ms / 1000.0)
    print(json.dumps({"ok": True, "listening": server.getsockname()[1], "protocol": dlivelink.PROTOCOL}))
    sys.stdout.flush()
    try:
        try:
            connection, _address = server.accept()
        except socket.timeout:
            print(json.dumps({"ok": False, "error": "No preview client connected before the timeout."}))
            return 1
        connection.settimeout(arguments.preview_timeout_ms / 1000.0)
        buffered = connection.makefile("r", encoding="utf-8", newline="\n")
        while True:
            now_ms = int(time.monotonic() * 1000)
            if session.is_stale(now_ms):
                break
            try:
                line = buffered.readline()
            except socket.timeout:
                break
            if not line:
                break
            verb, payload, reason = session.handle_line(line.rstrip("\n"), int(time.monotonic() * 1000))
            if verb == dlivelink.ERROR:
                print(json.dumps({"ok": False, "error": reason}))
                return 1
            if verb == dlivelink.CLOSED:
                break
            if verb == dlivelink.APPLY and payload is not None:
                _apply_preview_frame(unreal, payload)
    finally:
        server.close()
    print(json.dumps({"ok": True, "applied": session.applied_count, "dropped": session.dropped_count}))
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
                "features": CONNECTOR_FEATURES,
            }
        )
    )
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Director Unreal connector headless entry point.")
    parser.add_argument("--mode", required=True, choices=["health", "import", "export", "live-preview"])
    parser.add_argument("--package", help="Director exchange package directory.")
    parser.add_argument("--report", help="Path of the report.json receipt to write.")
    parser.add_argument("--return-dir", dest="return_dir", help="Directory for the return package.")
    parser.add_argument("--animation", help="Gateway-written Sequencer bake sidecar (animation.json).")
    parser.add_argument(
        "--animation-sha256",
        dest="animation_sha256",
        help="Gateway-pinned SHA-256 of the Sequencer bake sidecar.",
    )
    parser.add_argument(
        "--preview-port",
        dest="preview_port",
        type=int,
        default=0,
        help="Loopback port for live-preview mode (0 chooses an ephemeral port).",
    )
    parser.add_argument(
        "--preview-timeout-ms",
        dest="preview_timeout_ms",
        type=int,
        default=dlivelink.DEFAULT_STALE_TIMEOUT_MS,
        help="Disconnect timeout for live-preview mode.",
    )
    arguments = parser.parse_args(argv)

    unreal = _load_unreal()
    if arguments.mode == "health":
        return run_health(unreal)
    if unreal is None:
        if arguments.report:
            dpkg.write_failure_report(arguments.report, "The unreal module is unavailable; run inside UnrealEditor-Cmd.")
        return 1
    if arguments.mode == "live-preview":
        return run_live_preview(unreal, arguments)
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
