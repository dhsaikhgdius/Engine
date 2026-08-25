# SPDX-FileCopyrightText: 2026 OpenEnvision Authors
#
# SPDX-License-Identifier: GPL-2.0-or-later

"""Exercise the in-tree web gateway against a real Blender scene."""

from __future__ import annotations

import json
import os
import sys
import threading
import time
import uuid
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import bpy


ADDONS_CORE = Path(__file__).resolve().parents[2]
if str(ADDONS_CORE) not in sys.path:
    sys.path.insert(0, str(ADDONS_CORE))

import worldengine_studio  # noqa: E402
from worldengine_studio import blockout, director_runtime, native_session  # noqa: E402


UI_PORT = 15176
GATEWAY_PORT = 18787
SESSION_PORT = 18891


def request_json(url: str, *, body: dict | None = None, token: str | None = None) -> dict:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Content-Type": "application/json"} if data is not None else {}
    if token:
        headers["X-Director-Browser-Token"] = token
    request = Request(url, data=data, headers=headers, method="POST" if data is not None else "GET")
    try:
        with urlopen(request, timeout=5.0) as response:
            return json.loads(response.read())
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Gateway returned HTTP {error.code}: {detail}") from error


def wait_for_gateway() -> None:
    deadline = time.monotonic() + 30.0
    while time.monotonic() < deadline:
        try:
            with urlopen(f"http://127.0.0.1:{GATEWAY_PORT}/health", timeout=1.0) as response:
                if response.status == 200:
                    return
        except OSError:
            time.sleep(0.1)
    raise RuntimeError("The bundled WorldEngine gateway did not start.")


def check_session_auth() -> None:
    """A token-configured session must reject requests without the bearer token."""
    os.environ["WORLDENGINE_SESSION_TOKEN"] = "gateway-smoke-token"
    try:
        native_session.start(SESSION_PORT)
        try:
            urlopen(f"http://127.0.0.1:{SESSION_PORT}/health", timeout=5.0)
            raise AssertionError("The session served /health without the configured bearer token")
        except HTTPError as error:
            assert error.code == 401, error.code
            error.read()
        request = Request(
            f"http://127.0.0.1:{SESSION_PORT}/health",
            headers={"Authorization": "Bearer gateway-smoke-token"},
        )
        with urlopen(request, timeout=5.0) as response:
            assert response.status == 200
            assert json.loads(response.read())["ok"] is True
    finally:
        native_session.stop()
        os.environ.pop("WORLDENGINE_SESSION_TOKEN", None)


def main() -> None:
    worldengine_studio.register()
    try:
        assert bpy.ops.worldengine.setup_workspace() == {'FINISHED'}
        check_session_auth()
        native_session.start(SESSION_PORT)
        director_runtime.start(ui_port=UI_PORT, gateway_port=GATEWAY_PORT, session_port=SESSION_PORT)
        wait_for_gateway()

        bootstrap = request_json(
            f"http://127.0.0.1:{GATEWAY_PORT}/te-man/director/agent/bootstrap",
            body={},
        )
        result: dict[str, object] = {}

        def submit_edit() -> None:
            try:
                result["catalog"] = request_json(
                    f"http://127.0.0.1:{GATEWAY_PORT}/api/tools/blender_native",
                    token=bootstrap["browserToken"],
                    body={
                        "input": {
                            "op": "catalog",
                            "query": "subdivide",
                            "category": "mesh",
                            "limit": 20,
                        }
                    },
                )
                result["scene_before"] = request_json(
                    f"http://127.0.0.1:{GATEWAY_PORT}/api/tools/blender_native",
                    token=bootstrap["browserToken"],
                    body={"input": {"op": "scene"}},
                )
                expected_revision = result["scene_before"]["result"]["revision"]
                expected_scene_epoch = result["scene_before"]["result"]["sceneEpoch"]
                result["payload"] = request_json(
                    f"http://127.0.0.1:{GATEWAY_PORT}/api/tools/blender_native",
                    token=bootstrap["browserToken"],
                    body={
                        "input": {
                            "op": "apply",
                            "expectedSceneEpoch": expected_scene_epoch,
                            "expectedRevision": expected_revision,
                            "operations": [
                                {
                                    "op": "create_primitive",
                                    "id": "gateway-smoke-cube",
                                    "primitive": "cube",
                                    "name": "Gateway Smoke Cube",
                                    "transform": {"position": [0, 0.5, 0]},
                                    "dimensions": [1, 1, 1],
                                },
                                {
                                    "op": "set_selection",
                                    "selectedIds": ["gateway-smoke-cube"],
                                    "activeId": "gateway-smoke-cube",
                                    "mode": "OBJECT",
                                },
                                {
                                    "op": "select_mesh_elements",
                                    "id": "gateway-smoke-cube",
                                    "domain": "EDGE",
                                    "action": "ALL",
                                },
                                {
                                    "op": "invoke_operator",
                                    "operator": "mesh.subdivide",
                                    "properties": {"number_cuts": 2},
                                    "context": {
                                        "selectedIds": ["gateway-smoke-cube"],
                                        "activeId": "gateway-smoke-cube",
                                        "mode": "EDIT",
                                    },
                                },
                            ],
                        }
                    },
                )
                result["inspection"] = request_json(
                    f"http://127.0.0.1:{GATEWAY_PORT}/api/tools/blender_native",
                    token=bootstrap["browserToken"],
                    body={
                        "input": {
                            "op": "inspect",
                            "id": "gateway-smoke-cube",
                            "expectedSceneEpoch": expected_scene_epoch,
                            "expectedRevision": result["payload"]["result"]["receipt"]["revisionAfter"],
                        }
                    },
                )
                accepted = request_json(
                    f"http://127.0.0.1:{SESSION_PORT}/v1/commands",
                    body={
                        "contract": "worldengine-blender-live-v1",
                        "requestId": str(uuid.uuid4()),
                        "operations": [{"op": "export_scene_preview"}],
                    },
                )
                preview_deadline = time.monotonic() + 15.0
                preview_job = None
                while time.monotonic() < preview_deadline:
                    preview_job = request_json(
                        f"http://127.0.0.1:{SESSION_PORT}/v1/jobs/{accepted['jobId']}"
                    )
                    if preview_job["status"] in {"succeeded", "failed"}:
                        break
                    time.sleep(0.05)
                result["preview_job"] = preview_job
                with urlopen(
                    f"http://127.0.0.1:{SESSION_PORT}/v1/previews/{accepted['jobId']}.glb?consume=1",
                    timeout=10.0,
                ) as response:
                    body = response.read()
                    result["preview_binary"] = {
                        "magic": bytes(body[:4]),
                        "byteLength": len(body),
                        "sceneEpoch": response.headers["X-Blender-Scene-Epoch"],
                        "revision": int(response.headers["X-Blender-Revision"]),
                    }
                try:
                    urlopen(
                        f"http://127.0.0.1:{SESSION_PORT}/v1/previews/{accepted['jobId']}.glb",
                        timeout=5.0,
                    )
                    result["preview_after_consume"] = "served"
                except HTTPError as error:
                    error.read()
                    result["preview_after_consume"] = error.code
            except Exception as error:
                result["error"] = error

        worker = threading.Thread(target=submit_edit, name="WorldEngineGatewaySmoke", daemon=True)
        worker.start()
        deadline = time.monotonic() + 30.0
        while worker.is_alive() and time.monotonic() < deadline:
            native_session.drain_pending()
            time.sleep(0.02)
        worker.join(timeout=1.0)

        if "error" in result:
            raise result["error"]
        catalog = result.get("catalog")
        assert isinstance(catalog, dict) and catalog.get("success") is True
        catalog_result = catalog["result"]["result"]
        assert any(item["id"] == "mesh.subdivide" for item in catalog_result["operators"])
        payload = result.get("payload")
        assert isinstance(payload, dict) and payload.get("success") is True
        receipt = payload["result"]["receipt"]
        evidence = payload["result"]["evidence"]
        assert payload["result"]["sceneEpoch"] == receipt["sceneEpoch"]
        assert receipt["sceneEpoch"] == evidence["sceneEpoch"]
        assert receipt["revisionAfter"] == evidence["revision"]
        assert receipt["selection"] == {
            "mode": "EDIT",
            "activeObjectId": "gateway-smoke-cube",
            "selectedObjectIds": ["gateway-smoke-cube"],
        }
        assert "gateway-smoke-cube" in receipt["createdObjectIds"]
        assert any(item["id"] == "gateway-smoke-cube" for item in evidence["objects"])
        created = blockout.find_object("gateway-smoke-cube")
        assert created is not None and created.name == "Gateway Smoke Cube"
        inspection = result.get("inspection")
        assert isinstance(inspection, dict) and inspection.get("success") is True
        inspected_mesh = inspection["result"]["result"]["mesh"]
        assert inspected_mesh["vertices"] > 8
        assert inspected_mesh["edges"] > 12
        assert inspected_mesh["faces"] > 6
        preview_job = result.get("preview_job")
        assert isinstance(preview_job, dict) and preview_job["status"] == "succeeded", preview_job
        preview_operation = preview_job["result"]["operations"][0]
        assert "dataBase64" not in preview_operation, "GLB payload must stay detached from job JSON"
        preview_binary = result.get("preview_binary")
        assert isinstance(preview_binary, dict)
        assert preview_binary["magic"] == b"glTF"
        assert preview_binary["byteLength"] == preview_operation["byteLength"] > 0
        assert preview_binary["sceneEpoch"] == preview_operation["sceneEpoch"]
        assert preview_binary["revision"] == preview_operation["revision"]
        assert result.get("preview_after_consume") == 404
        print("WORLDENGINE_GATEWAY_SMOKE_OK")
    finally:
        director_runtime.stop()
        native_session.stop()
        worldengine_studio.unregister()


main()
