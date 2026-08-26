"""Fixed headless entry point for the Director Unreal connector.

Invoked by the Director Gateway (never with a request-supplied script) as:

    UnrealEditor-Cmd <Project>.uproject -ExecutePythonScript="director_headless.py \
        --mode import --package <dir> --report <report.json> --return-dir <dir> \
        [--animation <bake.json> --animation-sha256 <hex>]" \
        -unattended -nopause -nosplash -nullrhi -stdout

Modes:
- ``health``  print a JSON health line with the engine and connector version.
- ``import``  import a Director exchange package into a Director level with
  stable ``director_id`` actor tags, author materials (binding bundled texture
  files to the parent-material texture parameters), spawn the supported subset
  of Director lights, import skinned GLBs as skeletal meshes, key the
  Sequencer from the hash-pinned animation bake, then echo a canonical-space
  return package so Director can verify the round trip.
- ``export``  export a ``director-dcc-return-v1`` package containing the
  canonical-space transforms of every ``director_id``-tagged actor that moved
  relative to the exchange package baseline.
- ``live-preview``  preview-only loopback camera feed into the editor
  viewport (sequence-numbered, token-gated); never a durable scene channel.
- ``render``  one optional clean still (offscreen, no editor gizmos or
  labels) through a Director-tagged CineCamera, writing a
  ``director-unreal-clean-frame-v1`` receipt. Runs with ``-RenderOffscreen``
  (never ``-nullrhi``); any problem writes a skipped receipt with a reason.

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
import director_lights as dlights  # noqa: E402
import director_livelink as dlivelink  # noqa: E402
import director_materials as dmaterials  # noqa: E402
import director_package as dpkg  # noqa: E402
import director_sequencer as dsequencer  # noqa: E402
import director_space as dspace  # noqa: E402

CONNECTOR_VERSION = "0.4.2"
PROVIDER = "unreal"
DIRECTOR_TAG_PREFIX = "director_id:"
# Lights are tagged with their own prefix so the transform-echo export loop
# (objects and cameras only) never mistakes them for return-package entities.
DIRECTOR_LIGHT_TAG_PREFIX = "director_light_id:"
CONTENT_ROOT = "/Game/Director"
TRANSFORM_TOLERANCE = 1e-6
PREVIEW_TOKEN_ENV = "DIRECTOR_UNREAL_PREVIEW_TOKEN"
RENDER_POLL_SECONDS = 300.0
# Image extensions the exchange package may bundle for material textures.
TEXTURE_EXTENSIONS = (".png", ".jpg", ".jpeg", ".tga", ".exr")
CONNECTOR_FEATURES = [
    "animation_bake",
    "sequencer_timebase",
    "skeletal_import",
    "materials",
    "material_textures",
    "lights",
    "live_preview_protocol",
    "clean_frame_render",
]


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
        ``importedSkeletalMeshCount``, ``appliedMaterialCount``, and
        ``appliedTextureCount``, plus ``omittedMaterials`` / ``omittedSkeletal``
        typed warn-and-omit records.
    """
    actor_subsystem = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    scene = manifest["project"]["scene"]
    assets_by_id = {}
    for asset_entry in manifest.get("assets", []):
        assets_by_id[asset_entry["assetRefId"]] = dpkg.resolve_package_file(package_dir, asset_entry["relativePath"])
    # Bundled texture image files, keyed by asset-ref id, for material binding.
    texture_files = {
        asset_ref: path for asset_ref, path in assets_by_id.items() if path.lower().endswith(TEXTURE_EXTENSIONS)
    }

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
    imported_textures: dict[str, object] = {}
    spawned: dict[str, object] = {}
    package_folder = safe_asset_name(manifest["packageId"][:8])
    material_parents = None
    stats = {
        "importedSkeletalMeshCount": 0,
        "appliedMaterialCount": 0,
        "appliedTextureCount": 0,
        "omittedMaterials": [],
        "omittedSkeletal": [],
    }

    def texture_asset_for(asset_ref: str):
        """Import one bundled texture once and cache the result (None on failure)."""
        if asset_ref not in imported_textures:
            imported_textures[asset_ref] = dhostmat.import_texture_asset(
                unreal, texture_files[asset_ref], f"{CONTENT_ROOT}/Textures/{package_folder}", warnings
            )
        return imported_textures[asset_ref]

    for entity in manifest["project"]["objects"]:
        canonical = canonical_world_transform(scene, entity["transform"])
        transform = unreal_transform_from_canonical(unreal, canonical)
        mesh = None
        mesh_kind = None
        asset_ref = entity.get("assetRefId")
        prefer_skeletal = False
        inspection = None
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
            if prefer_skeletal and mesh_kind == "static":
                reason = (
                    f"Object {entity['id']}: skinned GLB imported as a static mesh only; "
                    "the bind-pose skeleton was not produced by the import pipeline (warn-and-omit)."
                )
                stats["omittedSkeletal"].append(
                    {"directorId": entity["id"], "code": "skeleton_unavailable", "reason": reason}
                )
            if entity.get("kind") == "character" and not inspection.get("skinned"):
                reason = (
                    f"Character {entity['name']} references a GLB without a skin; "
                    "it was imported without a skeleton (warn-and-omit)."
                )
                warnings.append(reason)
                stats["omittedSkeletal"].append(
                    {"directorId": entity["id"], "code": "character_unskinned", "reason": reason}
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
                reason = (
                    f"Object {entity['id']} references asset {entity.get('assetRefId')} that is not a GLB payload; "
                    "spawned as an empty actor (warn-and-omit)."
                )
                warnings.append(reason)
                stats["omittedSkeletal"].append(
                    {"directorId": entity["id"], "code": "empty_actor", "reason": reason}
                )
        actor.set_actor_transform(transform, False, False)
        actor.set_actor_label(entity["name"])
        actor.tags = [unreal.Name(f"{DIRECTOR_TAG_PREFIX}{entity['id']}")]
        actor.set_folder_path(unreal.Name(f"Director/{package_folder}"))
        if not entity.get("visible", True):
            actor.set_actor_hidden_in_game(True)

        material = entity.get("material")
        if material:
            mapped = dmaterials.map_material(material, entity["name"], texture_files)
            warnings.extend(mapped["warnings"])
            if mapped.get("omitted"):
                channels = ", ".join(mapped["omitted"])
                reason = (
                    f"Object {entity['id']}: Director material channels {channels} have no faithful "
                    f"Director parent mapping; omitted (warn-and-omit code: unsupported_channels)."
                )
                # Channel prose already landed via mapped["warnings"]; keep the typed
                # record as the Agent-facing honesty surface.
                stats["omittedMaterials"].append(
                    {
                        "directorId": entity["id"],
                        "code": "unsupported_channels",
                        "reason": reason,
                    }
                )
            if mesh_component is None:
                reason = (
                    f"Object {entity['id']} has a Director material but no mesh component; "
                    "the material was not applied (warn-and-omit code: no_mesh_target)."
                )
                warnings.append(reason)
                stats["omittedMaterials"].append(
                    {"directorId": entity["id"], "code": "no_mesh_target", "reason": reason}
                )
            else:
                if material_parents is None:
                    material_parents = dhostmat.ensure_parent_materials(unreal, CONTENT_ROOT, warnings)
                try:
                    texture_assets = {
                        parameter: texture_asset_for(asset_ref)
                        for parameter, asset_ref in mapped.get("textures", {}).items()
                    }
                    applied = dhostmat.apply_material(
                        unreal,
                        mesh_component,
                        mapped,
                        material_parents,
                        f"MI_{safe_asset_name(entity['id'])}",
                        f"{CONTENT_ROOT}/Materials/{package_folder}",
                        warnings,
                        texture_assets,
                    )
                    if applied["applied"]:
                        stats["appliedMaterialCount"] += 1
                    else:
                        parent_kind = mapped.get("parent", "opaque")
                        reason = (
                            f"Object {entity['id']}: Material instance was skipped because the "
                            f"{parent_kind} Director parent material is unavailable "
                            "(warn-and-omit code: parent_unavailable)."
                        )
                        warnings.append(reason)
                        stats["omittedMaterials"].append(
                            {
                                "directorId": entity["id"],
                                "code": "parent_unavailable",
                                "reason": reason,
                            }
                        )
                    stats["appliedTextureCount"] += applied["boundTextureCount"]
                except Exception as error:  # noqa: BLE001 - material failure must not sink the import
                    reason = (
                        f"Material application failed for {entity['id']}: {error} "
                        "(warn-and-omit code: apply_failed)."
                    )
                    warnings.append(reason)
                    stats["omittedMaterials"].append(
                        {"directorId": entity["id"], "code": "apply_failed", "reason": reason}
                    )
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


def _apply_light_component_settings(unreal, actor, spec: dict, warnings: list[str]) -> None:
    """Best-effort light component settings; each failure warns instead of sinking the import."""
    component = actor.light_component
    try:
        component.set_intensity(float(spec["intensity"]))
        if spec["intensityUnit"] == "candela":
            component.set_editor_property("intensity_units", unreal.LightUnits.CANDELAS)
        elif spec["intensityUnit"] == "nits":
            component.set_editor_property("intensity_units", unreal.LightUnits.NITS)
    except Exception as error:  # noqa: BLE001
        warnings.append(f"Light {spec['name']}: intensity could not be applied: {error}")
    color = spec.get("colorLinear")
    if color is not None:
        try:
            component.set_light_color(unreal.LinearColor(color[0], color[1], color[2], 1.0))
        except Exception as error:  # noqa: BLE001
            warnings.append(f"Light {spec['name']}: color could not be applied: {error}")
    try:
        component.set_cast_shadows(bool(spec.get("castShadow", False)))
    except Exception as error:  # noqa: BLE001
        warnings.append(f"Light {spec['name']}: shadow flag could not be applied: {error}")
    if spec.get("attenuationRadiusCm") is not None:
        try:
            component.set_attenuation_radius(float(spec["attenuationRadiusCm"]))
        except Exception as error:  # noqa: BLE001
            warnings.append(f"Light {spec['name']}: attenuation radius could not be applied: {error}")
    if spec.get("outerConeAngleDeg") is not None:
        try:
            component.set_outer_cone_angle(float(spec["outerConeAngleDeg"]))
            component.set_inner_cone_angle(float(spec["innerConeAngleDeg"]))
        except Exception as error:  # noqa: BLE001
            warnings.append(f"Light {spec['name']}: cone angles could not be applied: {error}")
    if spec.get("sourceWidthCm") is not None:
        try:
            component.set_editor_property("source_width", float(spec["sourceWidthCm"]))
            component.set_editor_property("source_height", float(spec["sourceHeightCm"]))
        except Exception as error:  # noqa: BLE001
            warnings.append(f"Light {spec['name']}: rect size could not be applied: {error}")


def spawn_lights(unreal, manifest: dict, warnings: list[str]):
    """Spawn the supported subset of Director lights as tagged Unreal light actors.

    Uses the pure ``director_lights`` mapping: directional, point, spot, and
    rect-area lights spawn; ambient and hemisphere lights become structured
    omit records. Lights carry ``director_light_id`` tags (never
    ``director_id``) so the return-package export loop ignores them.

    @returns ``(imported_light_count, omitted_records)``.
    """
    mapping = dlights.map_lights(manifest["project"]["scene"], manifest["project"].get("lights"))
    warnings.extend(mapping["warnings"])
    actor_subsystem = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    package_folder = safe_asset_name(manifest["packageId"][:8])
    imported = 0
    for spec in mapping["lights"]:
        light_class = getattr(unreal, spec["unrealClass"], None)
        if light_class is None:
            warnings.append(
                f"Light {spec['name']}: this Unreal build has no {spec['unrealClass']} class (warn-and-omit)."
            )
            mapping["omitted"].append(
                {
                    "directorId": spec["directorId"],
                    "lightType": spec["lightType"],
                    "reason": f"The {spec['unrealClass']} actor class is unavailable in this Unreal build.",
                }
            )
            continue
        transform = unreal_transform_from_canonical(unreal, spec["transform"])
        actor = actor_subsystem.spawn_actor_from_class(light_class, transform.translation, transform.rotation.rotator())
        actor.set_actor_transform(transform, False, False)
        actor.set_actor_label(spec["name"])
        actor.tags = [unreal.Name(f"{DIRECTOR_LIGHT_TAG_PREFIX}{spec['directorId']}")]
        actor.set_folder_path(unreal.Name(f"Director/{package_folder}/Lights"))
        if spec.get("hidden"):
            actor.set_actor_hidden_in_game(True)
        _apply_light_component_settings(unreal, actor, spec, warnings)
        imported += 1
    return imported, mapping["omitted"]


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
    imported_light_count, omitted_lights = spawn_lights(unreal, manifest, warnings)
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

    # Structured warn-and-omit echo: pose/rig channels the verified bake could
    # not carry are reported as data, never silently flattened into prose. The
    # per-channel details (control names, reasons) are echoed when the
    # Gateway-written sidecar carries them.
    omitted_animation_channels = []
    for entity in bake["entities"] if bake else []:
        if not entity.get("omittedChannels"):
            continue
        record = {
            "directorId": entity["directorId"],
            "entityType": entity["entityType"],
            "channels": entity["omittedChannels"],
        }
        if entity.get("omittedChannelDetails"):
            record["details"] = entity["omittedChannelDetails"]
        omitted_animation_channels.append(record)

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
            "appliedTextureCount": stats["appliedTextureCount"],
            "omittedMaterialCount": len(stats["omittedMaterials"]) or None,
            "omittedMaterials": stats["omittedMaterials"] or None,
            "omittedSkeletalCount": len(stats["omittedSkeletal"]) or None,
            "omittedSkeletal": stats["omittedSkeletal"] or None,
            "importedLightCount": imported_light_count,
            "omittedLightCount": len(omitted_lights) or None,
            "omittedLights": omitted_lights or None,
            "omittedAnimationChannels": omitted_animation_channels or None,
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


def _find_render_camera(unreal, requested_director_id):
    """Locate the Director-tagged CineCamera the clean frame renders through.

    @returns ``(actor, director_id, error)``; with a requested id the match is
        exact, otherwise the first tagged CineCamera wins.
    """
    actor_subsystem = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    fallback = None
    fallback_id = None
    for actor in actor_subsystem.get_all_level_actors():
        if not isinstance(actor, unreal.CineCameraActor):
            continue
        director_id = director_id_of_actor(actor)
        if not director_id:
            continue
        if requested_director_id and director_id == requested_director_id:
            return actor, director_id, None
        if fallback is None:
            fallback = actor
            fallback_id = director_id
    if requested_director_id:
        return None, None, f"Camera {requested_director_id} was not found among director_id-tagged CineCameras."
    if fallback is None:
        return None, None, "The level contains no director_id-tagged CineCamera to render through."
    return fallback, fallback_id, None


def run_render(unreal, arguments) -> int:
    """Render one clean still and write the ``director-unreal-clean-frame-v1`` receipt.

    The frame is rendered through ``take_high_res_screenshot`` while the editor
    runs with ``-RenderOffscreen``: no editor viewport widgets, gizmos, actor
    labels, or helper overlays are ever composited into the image. The
    screenshot task completes asynchronously, so this mode is driven by a
    slate post-tick callback and quits the editor itself when the receipt is
    written. Every failure path writes a skipped receipt with a reason; the
    clean frame is optional by contract and never fails the handoff.
    """
    import time

    warnings: list[str] = []

    def skip(reason: str) -> int:
        dpkg.write_clean_frame_receipt(arguments.report, skip_reason=reason, warnings=warnings)
        return 1

    try:
        manifest = dpkg.load_exchange_package(arguments.package, PROVIDER)
    except dpkg.DirectorPackageError as error:
        return skip(f"Exchange package validation failed: {error}")
    if not arguments.render_output:
        return skip("--render-output is required for render mode.")

    package_folder = safe_asset_name(manifest["packageId"][:8])
    level_path = f"{CONTENT_ROOT}/Levels/Director_{package_folder}"
    level_subsystem = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)
    if not level_subsystem.load_level(level_path):
        return skip(f"Level {level_path} was not found; run the import job before requesting a clean frame.")

    camera_actor, camera_director_id, camera_error = _find_render_camera(unreal, arguments.render_camera)
    if camera_error:
        return skip(camera_error)

    frame = arguments.render_frame if arguments.render_frame is not None else 0
    if arguments.render_frame is not None:
        # Scrub the authored Director sequence so the still represents the
        # requested timeline frame; a missing sequence renders the static import.
        sequence_asset_path = f"{CONTENT_ROOT}/Sequences/{package_folder}/DirectorShots"
        try:
            sequence = unreal.EditorAssetLibrary.load_asset(sequence_asset_path)
            if sequence:
                unreal.LevelSequenceEditorBlueprintLibrary.open_level_sequence(sequence)
                unreal.LevelSequenceEditorBlueprintLibrary.set_current_time(int(arguments.render_frame))
            else:
                warnings.append(
                    f"No Director sequence at {sequence_asset_path}; the clean frame shows the static import."
                )
        except Exception as error:  # noqa: BLE001 - scrubbing is best-effort for a still
            warnings.append(f"Sequence scrubbing failed ({error}); the clean frame shows the static import.")

    width = max(16, int(arguments.render_width))
    height = max(16, int(arguments.render_height))
    task = unreal.AutomationLibrary.take_high_res_screenshot(
        width, height, arguments.render_output, camera=camera_actor
    )
    deadline = time.monotonic() + RENDER_POLL_SECONDS
    state = {"handle": None}

    def finish(reason_or_none):
        if state["handle"] is not None:
            unreal.unregister_slate_post_tick_callback(state["handle"])
            state["handle"] = None
        if reason_or_none:
            dpkg.write_clean_frame_receipt(arguments.report, skip_reason=reason_or_none, warnings=warnings)
        else:
            dpkg.write_clean_frame_receipt(
                arguments.report,
                package_id=manifest["packageId"],
                source_revision=manifest["sourceRevision"],
                level_path=level_path,
                camera_director_id=camera_director_id,
                frame=int(frame),
                width=width,
                height=height,
                image_path=os.path.relpath(arguments.render_output, os.path.dirname(arguments.report)).replace(
                    os.sep, "/"
                ),
                image_sha256=dpkg.sha256_file(arguments.render_output),
                host_version=host_version(unreal),
                warnings=warnings,
            )
        unreal.SystemLibrary.quit_editor()

    def on_tick(_delta_seconds):
        try:
            if task.is_task_done():
                if os.path.isfile(arguments.render_output):
                    finish(None)
                else:
                    finish("The screenshot task finished without producing an image file.")
            elif time.monotonic() > deadline:
                finish(f"The screenshot task did not finish within {int(RENDER_POLL_SECONDS)} seconds.")
        except Exception as error:  # noqa: BLE001 - the receipt is the failure channel
            finish(f"Clean-frame polling failed: {error}")

    state["handle"] = unreal.register_slate_post_tick_callback(on_tick)
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
    parser.add_argument("--mode", required=True, choices=["health", "import", "export", "live-preview", "render"])
    parser.add_argument("--package", help="Director exchange package directory.")
    parser.add_argument("--report", help="Path of the report.json receipt to write.")
    parser.add_argument("--return-dir", dest="return_dir", help="Directory for the return package.")
    parser.add_argument("--animation", help="Gateway-written Sequencer bake sidecar (animation.json).")
    parser.add_argument("--render-output", dest="render_output", help="Absolute PNG path for the clean frame.")
    parser.add_argument("--render-camera", dest="render_camera", help="Director camera id to render through.")
    parser.add_argument("--render-frame", dest="render_frame", type=int, help="Director timeline frame to scrub to.")
    parser.add_argument("--render-width", dest="render_width", type=int, default=1920)
    parser.add_argument("--render-height", dest="render_height", type=int, default=1080)
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
            if arguments.mode == "render":
                dpkg.write_clean_frame_receipt(arguments.report, skip_reason="--package and --report are required.")
            else:
                dpkg.write_failure_report(arguments.report, "--package and --report are required.")
        return 2
    if arguments.mode == "render":
        try:
            return run_render(unreal, arguments)
        except Exception as error:  # noqa: BLE001 - the skipped receipt is the failure channel
            dpkg.write_clean_frame_receipt(arguments.report, skip_reason=f"Clean-frame render failed: {error}")
            return 1
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
