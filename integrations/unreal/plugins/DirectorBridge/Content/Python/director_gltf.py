"""Host-free GLB container inspection for the Unreal connector.

Reads only the 12-byte GLB header and the JSON chunk (never the binary
buffer) to decide how a payload should be imported: skinned GLBs go through
the skeletal-mesh path, everything else stays a static mesh. Pure Python (no
``unreal`` import) so the Gateway test suite can exercise it with ``python3``.
"""

from __future__ import annotations

import json
import struct
import sys

GLB_MAGIC = 0x46546C67  # "glTF"
GLB_JSON_CHUNK = 0x4E4F534A  # "JSON"
MAX_JSON_CHUNK_BYTES = 64 * 1024 * 1024


class DirectorGltfError(RuntimeError):
    """Raised when a GLB container is malformed or unsupported."""


def inspect_glb(path: str) -> dict:
    """Inspect one GLB file without decoding its binary payload.

    @param path: Absolute path of the ``.glb`` file.
    @returns A summary dict with ``skinned``, ``skinCount``, ``jointCount``,
        ``meshCount``, ``animationCount``, ``materialCount``, ``nodeCount``,
        and ``generator``.
    @raises DirectorGltfError: When the container header or JSON chunk is invalid.
    """
    with open(path, "rb") as handle:
        header = handle.read(12)
        if len(header) < 12:
            raise DirectorGltfError("GLB file is shorter than its 12-byte header.")
        magic, version, total_length = struct.unpack("<III", header)
        if magic != GLB_MAGIC:
            raise DirectorGltfError("Not a GLB container (bad magic).")
        if version != 2:
            raise DirectorGltfError(f"Unsupported GLB container version {version}.")
        chunk_header = handle.read(8)
        if len(chunk_header) < 8:
            raise DirectorGltfError("GLB file ends before the first chunk header.")
        chunk_length, chunk_type = struct.unpack("<II", chunk_header)
        if chunk_type != GLB_JSON_CHUNK:
            raise DirectorGltfError("The first GLB chunk must be the JSON chunk.")
        if chunk_length > MAX_JSON_CHUNK_BYTES:
            raise DirectorGltfError(f"GLB JSON chunk exceeds the {MAX_JSON_CHUNK_BYTES}-byte inspection bound.")
        if 12 + 8 + chunk_length > total_length:
            raise DirectorGltfError("GLB JSON chunk overruns the declared container length.")
        body = handle.read(chunk_length)
        if len(body) < chunk_length:
            raise DirectorGltfError("GLB JSON chunk is truncated.")
    try:
        document = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise DirectorGltfError(f"GLB JSON chunk is not valid JSON: {error}") from error
    if not isinstance(document, dict):
        raise DirectorGltfError("GLB JSON chunk must contain an object.")

    skins = document.get("skins") if isinstance(document.get("skins"), list) else []
    joint_count = 0
    for skin in skins:
        if isinstance(skin, dict) and isinstance(skin.get("joints"), list):
            joint_count += len(skin["joints"])

    def _count(key: str) -> int:
        value = document.get(key)
        return len(value) if isinstance(value, list) else 0

    asset = document.get("asset") if isinstance(document.get("asset"), dict) else {}
    generator = asset.get("generator")
    return {
        "skinned": len(skins) > 0,
        "skinCount": len(skins),
        "jointCount": joint_count,
        "meshCount": _count("meshes"),
        "animationCount": _count("animations"),
        "materialCount": _count("materials"),
        "nodeCount": _count("nodes"),
        "generator": generator if isinstance(generator, str) else None,
    }


def _run_cli(argv: list) -> int:
    """CLI: ``python3 director_gltf.py <file.glb>`` prints the inspection JSON."""
    if len(argv) != 1:
        print(json.dumps({"ok": False, "error": "usage: director_gltf.py <file.glb>"}))
        return 2
    try:
        print(json.dumps({"ok": True, "result": inspect_glb(argv[0])}))
        return 0
    except (OSError, DirectorGltfError) as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(_run_cli(sys.argv[1:]))
