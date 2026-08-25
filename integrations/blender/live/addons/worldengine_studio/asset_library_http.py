# SPDX-FileCopyrightText: 2026 OpenEnvision Authors
#
# SPDX-License-Identifier: GPL-2.0-or-later

"""HTTPS helpers for Poly Haven and Sketchfab. No Blender imports."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen
import zipfile


USER_AGENT = "WorldEngine-Studio/1 (Director)"
POLYHAVEN_API = "https://api.polyhaven.com"
SKETCHFAB_API = "https://api.sketchfab.com/v3"
MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024
JSON_TIMEOUT_S = 30.0
DOWNLOAD_TIMEOUT_S = 120.0


def assert_https_url(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.netloc:
        raise ValueError("Asset library downloads must use HTTPS")


def safe_join(root: Path, relative: str) -> Path:
    """Resolve `relative` under `root`, rejecting zip-slip and absolute paths."""
    cleaned = relative.replace("\\", "/").strip()
    if not cleaned or cleaned.startswith("/") or cleaned.startswith("../") or "/../" in f"/{cleaned}/":
        raise ValueError(f"Refusing unsafe archive path: {relative}")
    root_resolved = root.resolve()
    candidate = (root_resolved / cleaned).resolve()
    if not candidate.is_relative_to(root_resolved):
        raise ValueError(f"Archive path escapes the extract root: {relative}")
    return candidate


def filter_polyhaven_assets(assets: dict[str, Any], query: str, limit: int) -> list[dict[str, Any]]:
    needle = query.strip().lower()
    matches: list[dict[str, Any]] = []
    if not isinstance(assets, dict):
        return matches
    for asset_id, info in assets.items():
        if not isinstance(info, dict):
            continue
        name = str(info.get("name") or asset_id)
        tags = [str(tag) for tag in info.get("tags") or [] if tag is not None]
        categories = [str(category) for category in info.get("categories") or [] if category is not None]
        haystack = " ".join([str(asset_id), name, *tags, *categories]).lower()
        if needle and needle not in haystack:
            continue
        matches.append(
            {
                "id": str(asset_id),
                "name": name,
                "type": info.get("type"),
                "categories": categories,
                "tags": tags,
            }
        )
        if len(matches) >= limit:
            break
    return matches


def _headers(extra: dict[str, str] | None = None) -> dict[str, str]:
    headers = {"User-Agent": USER_AGENT}
    if extra:
        headers.update(extra)
    return headers


def _open(url: str, *, headers: dict[str, str] | None = None, timeout: float) -> Any:
    assert_https_url(url)
    request = Request(url, headers=_headers(headers))
    try:
        return urlopen(request, timeout=timeout)
    except HTTPError as error:
        body = error.read()[:800].decode("utf-8", "replace")
        raise ValueError(f"HTTP {error.code} from {url}: {body}") from error
    except URLError as error:
        raise ValueError(f"Could not reach {url}: {error.reason}") from error


def http_json(url: str, *, headers: dict[str, str] | None = None, timeout: float = JSON_TIMEOUT_S) -> Any:
    with _open(url, headers=headers, timeout=timeout) as response:
        payload = response.read()
        if len(payload) > MAX_DOWNLOAD_BYTES:
            raise ValueError("JSON response exceeds 512 MB")
    try:
        return json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(f"Expected JSON from {url}") from error


def http_download(
    url: str,
    dest: Path,
    *,
    headers: dict[str, str] | None = None,
    timeout: float = DOWNLOAD_TIMEOUT_S,
) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    total = 0
    with _open(url, headers=headers, timeout=timeout) as response, dest.open("wb") as output:
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_DOWNLOAD_BYTES:
                raise ValueError("Download exceeds 512 MB")
            output.write(chunk)
    return dest


def extract_zip(archive: Path, dest: Path) -> Path:
    dest.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as bundle:
        for info in bundle.infolist():
            name = info.filename.replace("\\", "/")
            if name.endswith("/") or info.is_dir():
                continue
            target = safe_join(dest, name)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(bundle.read(info))
    gltfs = sorted(dest.rglob("*.gltf")) + sorted(dest.rglob("*.glb"))
    if not gltfs:
        raise ValueError("Archive contains no glTF file")
    return gltfs[0]


def polyhaven_assets_url(*, asset_type: str, categories: str | None) -> str:
    params: list[tuple[str, str]] = []
    if asset_type != "all":
        params.append(("type", asset_type))
    if categories:
        params.append(("categories", categories))
    query = urlencode(params)
    return f"{POLYHAVEN_API}/assets?{query}" if query else f"{POLYHAVEN_API}/assets"


def polyhaven_files_url(asset_id: str) -> str:
    return f"{POLYHAVEN_API}/files/{asset_id}"


def sketchfab_search_url(*, query: str, count: int) -> str:
    return f"{SKETCHFAB_API}/search?{urlencode({'type': 'models', 'q': query, 'downloadable': 'true', 'count': str(count)})}"


def sketchfab_download_url(uid: str) -> str:
    return f"{SKETCHFAB_API}/models/{uid}/download"


def sketchfab_auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Token {token}"}


def sketchfab_api_token() -> str:
    env = os.environ.get("SKETCHFAB_API_TOKEN", "").strip()
    if env:
        return env
    try:
        from .preferences import get_preferences

        prefs = get_preferences()
        token = getattr(prefs, "sketchfab_api_token", "") if prefs is not None else ""
        return str(token).strip()
    except Exception:
        return ""


__all__ = (
    "DOWNLOAD_TIMEOUT_S",
    "JSON_TIMEOUT_S",
    "MAX_DOWNLOAD_BYTES",
    "POLYHAVEN_API",
    "SKETCHFAB_API",
    "USER_AGENT",
    "assert_https_url",
    "extract_zip",
    "filter_polyhaven_assets",
    "http_download",
    "http_json",
    "polyhaven_assets_url",
    "polyhaven_files_url",
    "safe_join",
    "sketchfab_api_token",
    "sketchfab_auth_headers",
    "sketchfab_download_url",
    "sketchfab_search_url",
)
