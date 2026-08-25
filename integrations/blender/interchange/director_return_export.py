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

from director_signature import mesh_content_signature

try:  # Allows CI to exercise --help and pure helpers without Blender installed.
    import bpy  # type: ignore
except ModuleNotFoundError:  # pragma: no cover - real execution happens in Blender.
    bpy = None


CONTRACT = "director-dcc-return-v1"
RESULT_PREFIX = "DIRECTOR_DCC_RETURN_RESULT:"
TRANSFORM_TOLERANCE = 1e-6
SOURCE_TRANSFORM_PROPERTY = "director_source_transform"
SOURCE_MESH_SIGNATURE_PROPERTY = "director_source_mesh_signature"


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    raw = list(sys.argv if argv is None else argv)
    separator = raw.index("--") if "--" in raw else 0
    arguments = raw[separator + 1 :] if separator else raw[1:]
    parser = argparse.ArgumentParser(description="Export a Director Blender return package")
    parser.add_argument("--source-manifest", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--report", required=True)
    return parser.parse_args(arguments)


def ensure_inside(parent: Path, child: Path) -> Path:
    resolved_parent = parent.resolve()
    resolved_child = child.resolve()
    try:
        resolved_child.relative_to(resolved_parent)
    except ValueError as error:
        raise ValueError(f"Output path escaped {resolved_parent}: {resolved_child}") from error
    return resolved_child


def read_source_manifest(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("schemaVersion") != 1 or payload.get("contract") != "director-dcc-scene-v1":
        raise ValueError("Unsupported Director source DCC contract")
    if not isinstance(payload.get("packageId"), str) or not isinstance(payload.get("sourceRevision"), str):
        raise ValueError("Director source manifest is missing packageId/sourceRevision")
    return payload


def safe_file_stem(value: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-.")[:96]
    return normalized or "director-object"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def blender_transform(target: Any) -> dict[str, list[float]]:
    location, rotation, scale = target.matrix_world.decompose()
    rotation.normalize()
    return {
        "location": [float(location.x), float(location.y), float(location.z)],
        "rotationQuaternion": [float(rotation.x), float(rotation.y), float(rotation.z), float(rotation.w)],
        "scale": [float(scale.x), float(scale.y), float(scale.z)],
    }


def transforms_equal(left: dict[str, Any], right: dict[str, Any], tolerance: float = TRANSFORM_TOLERANCE) -> bool:
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
    raw = root.get(SOURCE_TRANSFORM_PROPERTY)
    if not isinstance(raw, str):
        return fallback
    try:
        value = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return fallback
    required = ("location", "rotationQuaternion", "scale")
    return value if isinstance(value, dict) and all(isinstance(value.get(key), list) for key in required) else fallback


def descendants(root: Any) -> list[Any]:
    return [root, *list(root.children_recursive)]


def descendant_meshes(root: Any) -> list[Any]:
    return [item for item in descendants(root) if item.type == "MESH"]


def unapplied_modifier_warnings(root: Any) -> list[str]:
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


def director_roots(objects: Iterable[Any]) -> list[Any]:
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
    if bpy is None:
        raise RuntimeError("director_return_export.py must run inside Blender")
    meshes_dir = ensure_inside(output_dir, output_dir / "meshes")
    meshes_dir.mkdir(parents=True, exist_ok=True)
    source_objects = {item["id"]: item for item in source.get("objects", []) if isinstance(item.get("id"), str)}
    source_cameras = {item["id"]: item for item in source.get("cameras", []) if isinstance(item.get("id"), str)}
    changes: list[dict[str, Any]] = []
    warnings: list[str] = []
    file_hashes: dict[str, str] = {}
    used_stems: set[str] = set()

    for root in director_roots(bpy.context.scene.objects):
        director_id = str(root.get("director_id"))
        source_object = source_objects.get(director_id)
        source_camera = source_cameras.get(director_id)
        current_transform = blender_transform(root)
        if source_object is None and source_camera is None:
            warnings.append(f"{root.name}: director_id {director_id!r} was not present in the source manifest; skipped.")
            continue
        if source_camera is not None:
            if not transforms_equal(current_transform, _stored_transform(root, source_camera["transform"])):
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
        if item.parent is not None or item.get("director_id") or item.name.startswith("Director_") or item.type in {"LIGHT"}:
            continue
        warnings.append(f"{item.name}: top-level Blender object has no director_id and was not included in the return package.")

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
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def main() -> int:
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
