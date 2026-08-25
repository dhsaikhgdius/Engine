"""Host-free helpers for Director exchange and return packages.

Reads and verifies ``director-dcc-exchange-package-v1`` manifests, and writes
``director-dcc-return-v1`` packages plus ``director-dcc-engine-report-v1``
receipts. No ``unreal`` import: the Gateway test-suite exercises this module
with plain ``python3``.
"""

from __future__ import annotations

import hashlib
import json
import os
from typing import Dict, List, Optional

EXCHANGE_CONTRACT = "director-dcc-exchange-package-v1"
RETURN_CONTRACT = "director-dcc-return-v1"
REPORT_CONTRACT = "director-dcc-engine-report-v1"

CANONICAL_COORDINATE_SYSTEM = {
    "source": "right-handed-y-up-negative-z-forward",
    "destination": "right-handed-y-up-negative-z-forward",
    "unit": "meter",
    "linearMap": "identity",
}


class DirectorPackageError(RuntimeError):
    """Raised when an exchange package fails validation."""


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _ensure_inside(root: str, candidate: str) -> str:
    resolved = os.path.realpath(candidate)
    resolved_root = os.path.realpath(root)
    if resolved != resolved_root and not resolved.startswith(resolved_root + os.sep):
        raise DirectorPackageError(f"Package path escapes the package root: {candidate}")
    return resolved


def load_exchange_package(package_dir: str, provider: str) -> dict:
    """Load and verify an exchange package manifest for one engine provider.

    Verifies the contract identifier, the provider, and the SHA-256 hash of
    every referenced artifact and asset before returning the parsed manifest.
    """
    package_root = os.path.realpath(package_dir)
    manifest_path = os.path.join(package_root, "manifest.json")
    if not os.path.isfile(manifest_path):
        raise DirectorPackageError(f"Exchange package is missing manifest.json: {package_dir}")
    with open(manifest_path, "r", encoding="utf-8") as handle:
        manifest = json.load(handle)
    if manifest.get("contract") != EXCHANGE_CONTRACT:
        raise DirectorPackageError(f"Unexpected exchange contract: {manifest.get('contract')!r}")
    if manifest.get("provider") != provider:
        raise DirectorPackageError(
            f"Exchange package targets provider {manifest.get('provider')!r}, expected {provider!r}"
        )
    for section in ("formats", "assets"):
        for entry in manifest.get(section, []):
            relative_path = entry["relativePath"]
            absolute = _ensure_inside(package_root, os.path.join(package_root, relative_path))
            if not os.path.isfile(absolute):
                raise DirectorPackageError(f"Exchange package file is missing: {relative_path}")
            actual = sha256_file(absolute)
            if actual != entry["sha256"]:
                raise DirectorPackageError(
                    f"SHA-256 mismatch for {relative_path}: expected {entry['sha256']}, found {actual}"
                )
    return manifest


def resolve_package_file(package_dir: str, relative_path: str) -> str:
    """Absolute, escape-checked path of one package file."""
    return _ensure_inside(os.path.realpath(package_dir), os.path.join(package_dir, relative_path))


def utc_now_iso() -> str:
    import datetime

    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def write_return_package(
    return_dir: str,
    *,
    provider: str,
    host_version: str,
    connector_version: str,
    source_package_id: str,
    source_revision: str,
    changes: List[dict],
    warnings: List[dict | str],
    mesh_files: Optional[Dict[str, str]] = None,
) -> str:
    """Write a director-dcc-return-v1 package and return the manifest path.

    ``changes`` must already be in Director canonical space (the connector
    converts at the provider boundary). ``mesh_files`` maps package-relative
    mesh paths to their absolute source files; they are copied in and hashed.
    """
    os.makedirs(return_dir, exist_ok=True)
    file_hashes: Dict[str, str] = {}
    for relative_path, source_path in (mesh_files or {}).items():
        destination = _ensure_inside(return_dir, os.path.join(return_dir, relative_path))
        os.makedirs(os.path.dirname(destination), exist_ok=True)
        with open(source_path, "rb") as source, open(destination, "wb") as target:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                target.write(chunk)
        file_hashes[relative_path] = sha256_file(destination)
    manifest = {
        "schemaVersion": 1,
        "contract": RETURN_CONTRACT,
        "packageId": f"{provider}-return-{source_package_id}",
        "sourcePackageId": source_package_id,
        "sourceRevision": source_revision,
        "exportedAt": utc_now_iso(),
        "provider": provider,
        "hostVersion": host_version,
        "connectorVersion": connector_version,
        "coordinateSystem": dict(CANONICAL_COORDINATE_SYSTEM),
        "changes": changes,
        "warnings": [str(warning) for warning in warnings],
        "fileHashes": file_hashes,
    }
    manifest_path = os.path.join(return_dir, "manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2, sort_keys=True)
        handle.write("\n")
    return manifest_path


def write_report(
    report_path: str,
    *,
    provider: str,
    host_version: str,
    connector_version: str,
    package_id: str,
    source_revision: str,
    imported_object_count: int,
    imported_camera_count: int,
    scene_path: Optional[str],
    return_package_dir: Optional[str],
    warnings: List[str],
    extras: Optional[dict] = None,
) -> None:
    """Write the director-dcc-engine-report-v1 receipt the Gateway validates.

    ``extras`` carries optional provider-specific receipt fields (for example
    the Unreal Sequencer receipt); ``None`` values are dropped so absent
    features simply omit their fields.
    """
    os.makedirs(os.path.dirname(report_path) or ".", exist_ok=True)
    report = {
        "ok": True,
        "contract": REPORT_CONTRACT,
        "provider": provider,
        "hostVersion": host_version,
        "connectorVersion": connector_version,
        "packageId": package_id,
        "sourceRevision": source_revision,
        "importedObjectCount": imported_object_count,
        "importedCameraCount": imported_camera_count,
        "scenePath": scene_path,
        "returnPackageDir": return_package_dir,
        "warnings": warnings,
    }
    for key, value in (extras or {}).items():
        if value is not None:
            report[key] = value
    with open(report_path, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2, sort_keys=True)
        handle.write("\n")


def write_failure_report(report_path: str, error: str) -> None:
    """Write an ok:false report so the Gateway fails the job with a reason."""
    os.makedirs(os.path.dirname(report_path) or ".", exist_ok=True)
    with open(report_path, "w", encoding="utf-8") as handle:
        json.dump({"ok": False, "error": error}, handle, indent=2, sort_keys=True)
        handle.write("\n")
