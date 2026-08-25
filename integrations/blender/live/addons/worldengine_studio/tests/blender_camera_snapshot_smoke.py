# SPDX-FileCopyrightText: 2026 OpenEnvision Authors
#
# SPDX-License-Identifier: GPL-2.0-or-later

"""Run with: blender --background --factory-startup --python blender_camera_snapshot_smoke.py"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import bpy


ADDONS_CORE = Path(__file__).resolve().parents[2]
if str(ADDONS_CORE) not in sys.path:
    sys.path.insert(0, str(ADDONS_CORE))

import worldengine_studio  # noqa: E402
from worldengine_studio import blockout, live_protocol, native_session, operators  # noqa: E402


def execute(operation):
    batch = live_protocol.parse_live_batch(
        json.dumps(
            {
                "contract": live_protocol.CONTRACT,
                "requestId": f"camera-smoke-{operation['op']}",
                "expectedSceneEpoch": native_session.scene_epoch_value(),
                "operations": [operation],
            }
        )
    )
    return operators.execute_live_operation(batch["operations"][0])


def main():
    worldengine_studio.register()
    scene = bpy.context.scene
    camera_data = bpy.data.cameras.new("Camera optics smoke")
    camera_data.type = 'ORTHO'
    camera_data.lens = 52.0
    camera_data.sensor_fit = 'VERTICAL'
    camera_data.sensor_width = 36.0
    camera_data.sensor_height = 24.0
    camera_data.shift_x = 0.12
    camera_data.shift_y = -0.08
    camera_data.clip_start = 0.05
    camera_data.clip_end = 750.0
    camera_data.ortho_scale = 6.0
    camera = bpy.data.objects.new("Camera optics smoke", camera_data)
    scene.collection.objects.link(camera)
    camera[blockout.ID_PROPERTY] = "camera-optics-smoke"
    scene.camera = camera

    execute(
        {
            "op": "set_camera_data",
            "id": "camera-optics-smoke",
            "projectionType": "PERSPECTIVE",
            "focalLengthMm": 65,
            "sensorFit": "HORIZONTAL",
            "sensorWidthMm": 40,
            "sensorHeightMm": 22,
            "shiftX": 0.2,
            "shiftY": -0.1,
            "clipStart": 0.2,
            "clipEnd": 1200,
            "orthographicScale": 9,
        }
    )
    execute(
        {
            "op": "create_light",
            "id": "light-data-smoke",
            "kind": "area",
            "position": [4, 6, 4],
            "target": [0, 1, 0],
        }
    )
    execute(
        {
            "op": "set_light_data",
            "id": "light-data-smoke",
            "kind": "spot",
            "color": [0.8, 0.6, 0.4],
            "energy": 1500,
            "size": 0.25,
        }
    )

    director_root = bpy.data.objects.new("Director linked root", None)
    director_root["director_id"] = "director-object-a"
    scene.collection.objects.link(director_root)
    mesh_data = bpy.data.meshes.new("Director linked mesh data")
    mesh = bpy.data.objects.new("Director linked mesh", mesh_data)
    mesh.parent = director_root
    scene.collection.objects.link(mesh)

    snapshot = blockout.snapshot_live_scene(scene)
    result = next(item for item in snapshot["cameras"] if item["active"])
    assert result["projectionType"] == "PERSPECTIVE"
    assert abs(result["focalLengthMm"] - 65.0) < 1e-6
    assert result["sensorFit"] == "HORIZONTAL"
    assert abs(result["sensorWidthMm"] - 40.0) < 1e-6
    assert abs(result["sensorHeightMm"] - 22.0) < 1e-6
    assert abs(result["shiftX"] - 0.2) < 1e-6
    assert abs(result["shiftY"] + 0.1) < 1e-6
    assert abs(result["clipStart"] - 0.2) < 1e-6
    assert abs(result["clipEnd"] - 1200.0) < 1e-6
    assert abs(result["orthographicScale"] - 9.0) < 1e-6
    light = next(item for item in snapshot["lights"] if item["id"] == "light-data-smoke")
    assert light["kind"] == "spot"
    assert all(abs(actual - expected) < 1e-6 for actual, expected in zip(light["color"], [0.8, 0.6, 0.4]))
    assert abs(light["energy"] - 1500.0) < 1e-6
    assert abs(light["size"] - 0.25) < 1e-6
    linked_mesh = next(item for item in snapshot["objects"] if item["name"] == "Director linked mesh")
    assert linked_mesh["directorId"] == "director-object-a"


if __name__ == "__main__":
    main()
