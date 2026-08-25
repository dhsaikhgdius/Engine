#!/usr/bin/env python3
"""Generate the redistributable StoryAI Open Mannequin GLB.

Run this script with Blender, not a system Python interpreter:

    blender --background --factory-startup --python tools/scripts/generate_open_mannequin.py \
      -- --output assets/library/models/storyai-open-mannequin.glb

The mesh, skeleton, materials, and metadata are created entirely from Blender
primitives. No third-party model geometry or texture is used.
"""

from __future__ import annotations

import argparse
from pathlib import Path
import sys

import bpy
from mathutils import Vector


MODEL_NAME = "StoryAI Open Mannequin"
MODEL_LICENSE = "MIT"


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, help="Destination .glb file")
    return parser.parse_args(argv)


def make_material() -> bpy.types.Material:
    material = bpy.data.materials.new("OpenMannequinBody")
    material.diffuse_color = (0.76, 0.80, 0.88, 1.0)
    material.metallic = 0.04
    material.roughness = 0.68
    return material


def apply_transform(obj: bpy.types.Object) -> None:
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    obj.select_set(False)


def assign_rigid_weight(obj: bpy.types.Object, bone_name: str) -> None:
    group = obj.vertex_groups.new(name=bone_name)
    group.add(range(len(obj.data.vertices)), 1.0, "REPLACE")
    obj["storyai_bone"] = bone_name


def add_uv_sphere(
    name: str,
    center: tuple[float, float, float],
    scale: tuple[float, float, float],
    bone_name: str,
    material: bpy.types.Material,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_uv_sphere_add(
        segments=16,
        ring_count=10,
        location=center,
    )
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    apply_transform(obj)
    obj.data.materials.append(material)
    assign_rigid_weight(obj, bone_name)
    return obj


def add_cylinder_between(
    name: str,
    start: tuple[float, float, float],
    end: tuple[float, float, float],
    radius: float,
    bone_name: str,
    material: bpy.types.Material,
) -> bpy.types.Object:
    start_vector = Vector(start)
    end_vector = Vector(end)
    direction = end_vector - start_vector
    midpoint = (start_vector + end_vector) * 0.5

    bpy.ops.mesh.primitive_cylinder_add(
        vertices=16,
        radius=radius,
        depth=direction.length,
        location=midpoint,
    )
    obj = bpy.context.object
    obj.name = name
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = direction.to_track_quat("Z", "Y")
    apply_transform(obj)
    obj.data.materials.append(material)
    assign_rigid_weight(obj, bone_name)
    return obj


def add_rounded_box(
    name: str,
    center: tuple[float, float, float],
    dimensions: tuple[float, float, float],
    bevel: float,
    bone_name: str,
    material: bpy.types.Material,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cube_add(location=center)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = dimensions
    apply_transform(obj)

    modifier = obj.modifiers.new(name="SoftEdges", type="BEVEL")
    modifier.width = bevel
    modifier.segments = 2
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    obj.select_set(False)

    obj.data.materials.append(material)
    assign_rigid_weight(obj, bone_name)
    return obj


def create_armature() -> tuple[bpy.types.Object, dict[str, tuple[Vector, Vector]]]:
    armature_data = bpy.data.armatures.new("StoryAIOpenMannequinRig")
    armature = bpy.data.objects.new("StoryAIOpenMannequinRig", armature_data)
    bpy.context.collection.objects.link(armature)
    bpy.context.view_layer.objects.active = armature
    armature.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")

    specs: dict[str, tuple[tuple[float, float, float], tuple[float, float, float], str | None]] = {
        "Bip001_Pelvis_03": ((0.0, 0.0, 0.96), (0.0, 0.0, 1.10), None),
        "Bip001_Spine_04": ((0.0, 0.0, 1.10), (0.0, 0.0, 1.34), "Bip001_Pelvis_03"),
        "Bip001_Spine1_05": ((0.0, 0.0, 1.34), (0.0, 0.0, 1.55), "Bip001_Spine_04"),
        "Bip001_Neck_06": ((0.0, 0.0, 1.55), (0.0, 0.0, 1.67), "Bip001_Spine1_05"),
        "Bip001_Head_055": ((0.0, 0.0, 1.67), (0.0, 0.0, 1.92), "Bip001_Neck_06"),
        "Bip001_L_Clavicle_07": ((0.0, 0.0, 1.52), (0.18, 0.0, 1.52), "Bip001_Neck_06"),
        "Bip001_L_UpperArm_08": ((0.18, 0.0, 1.52), (0.49, 0.0, 1.47), "Bip001_L_Clavicle_07"),
        "Bip001_L_Forearm_09": ((0.49, 0.0, 1.47), (0.75, 0.0, 1.43), "Bip001_L_UpperArm_08"),
        "Bip001_L_Hand_010": ((0.75, 0.0, 1.43), (0.91, 0.0, 1.42), "Bip001_L_Forearm_09"),
        "Bip001_R_Clavicle_031": ((0.0, 0.0, 1.52), (-0.18, 0.0, 1.52), "Bip001_Neck_06"),
        "Bip001_R_UpperArm_032": ((-0.18, 0.0, 1.52), (-0.49, 0.0, 1.47), "Bip001_R_Clavicle_031"),
        "Bip001_R_Forearm_033": ((-0.49, 0.0, 1.47), (-0.75, 0.0, 1.43), "Bip001_R_UpperArm_032"),
        "Bip001_R_Hand_034": ((-0.75, 0.0, 1.43), (-0.91, 0.0, 1.42), "Bip001_R_Forearm_033"),
        "Bip001_L_Thigh_057": ((0.12, 0.0, 0.99), (0.12, 0.0, 0.58), "Bip001_Pelvis_03"),
        "Bip001_L_Calf_058": ((0.12, 0.0, 0.58), (0.12, 0.0, 0.18), "Bip001_L_Thigh_057"),
        "Bip001_L_Foot_059": ((0.12, 0.0, 0.18), (0.12, -0.22, 0.09), "Bip001_L_Calf_058"),
        "Bip001_R_Thigh_061": ((-0.12, 0.0, 0.99), (-0.12, 0.0, 0.58), "Bip001_Pelvis_03"),
        "Bip001_R_Calf_062": ((-0.12, 0.0, 0.58), (-0.12, 0.0, 0.18), "Bip001_R_Thigh_061"),
        "Bip001_R_Foot_063": ((-0.12, 0.0, 0.18), (-0.12, -0.22, 0.09), "Bip001_R_Calf_062"),
    }

    edit_bones: dict[str, bpy.types.EditBone] = {}
    points: dict[str, tuple[Vector, Vector]] = {}
    for name, (head, tail, parent_name) in specs.items():
        bone = armature_data.edit_bones.new(name)
        bone.head = head
        bone.tail = tail
        if parent_name:
            bone.parent = edit_bones[parent_name]
        edit_bones[name] = bone
        points[name] = (Vector(head), Vector(tail))

    bpy.ops.object.mode_set(mode="OBJECT")
    armature.data.display_type = "OCTAHEDRAL"
    armature.show_in_front = True
    armature["title"] = MODEL_NAME
    armature["license"] = MODEL_LICENSE
    armature["source"] = "Generated from Blender primitives by tools/scripts/generate_open_mannequin.py"
    armature.select_set(False)
    return armature, points


def create_body(
    armature: bpy.types.Object,
    points: dict[str, tuple[Vector, Vector]],
) -> bpy.types.Object:
    material = make_material()
    parts: list[bpy.types.Object] = []

    parts.extend(
        [
            add_rounded_box("Pelvis", (0.0, 0.0, 1.02), (0.34, 0.22, 0.24), 0.055, "Bip001_Pelvis_03", material),
            add_rounded_box("Abdomen", (0.0, 0.0, 1.22), (0.28, 0.19, 0.27), 0.055, "Bip001_Spine_04", material),
            add_rounded_box("Chest", (0.0, 0.0, 1.43), (0.45, 0.23, 0.27), 0.065, "Bip001_Spine1_05", material),
            add_cylinder_between("Neck", (0.0, 0.0, 1.54), (0.0, 0.0, 1.67), 0.065, "Bip001_Neck_06", material),
            add_uv_sphere("Head", (0.0, -0.005, 1.78), (0.13, 0.115, 0.17), "Bip001_Head_055", material),
        ]
    )

    for side, sign, names in (
        (
            "L",
            1.0,
            ("Bip001_L_Clavicle_07", "Bip001_L_UpperArm_08", "Bip001_L_Forearm_09", "Bip001_L_Hand_010"),
        ),
        (
            "R",
            -1.0,
            ("Bip001_R_Clavicle_031", "Bip001_R_UpperArm_032", "Bip001_R_Forearm_033", "Bip001_R_Hand_034"),
        ),
    ):
        clavicle, upper_arm, forearm, hand = names
        parts.extend(
            [
                add_cylinder_between(f"{side}_Clavicle", *points[clavicle], 0.045, clavicle, material),
                add_cylinder_between(f"{side}_UpperArm", *points[upper_arm], 0.073, upper_arm, material),
                add_uv_sphere(f"{side}_ElbowJoint", tuple(points[forearm][0]), (0.073, 0.073, 0.073), forearm, material),
                add_cylinder_between(f"{side}_Forearm", *points[forearm], 0.062, forearm, material),
                add_rounded_box(
                    f"{side}_Hand",
                    (sign * 0.835, -0.005, 1.425),
                    (0.18, 0.082, 0.062),
                    0.025,
                    hand,
                    material,
                ),
            ]
        )

    for side, sign, names in (
        ("L", 1.0, ("Bip001_L_Thigh_057", "Bip001_L_Calf_058", "Bip001_L_Foot_059")),
        ("R", -1.0, ("Bip001_R_Thigh_061", "Bip001_R_Calf_062", "Bip001_R_Foot_063")),
    ):
        thigh, calf, foot = names
        parts.extend(
            [
                add_cylinder_between(f"{side}_Thigh", *points[thigh], 0.105, thigh, material),
                add_uv_sphere(f"{side}_KneeJoint", tuple(points[calf][0]), (0.092, 0.092, 0.092), calf, material),
                add_cylinder_between(f"{side}_Calf", *points[calf], 0.078, calf, material),
                add_uv_sphere(f"{side}_AnkleJoint", tuple(points[foot][0]), (0.067, 0.067, 0.067), foot, material),
                add_rounded_box(
                    f"{side}_Foot",
                    (sign * 0.12, -0.13, 0.095),
                    (0.16, 0.31, 0.10),
                    0.035,
                    foot,
                    material,
                ),
            ]
        )

    bpy.ops.object.select_all(action="DESELECT")
    for part in parts:
        part.select_set(True)
    body = parts[0]
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.join()
    body.name = "StoryAIOpenMannequinBody"
    body.data.name = "StoryAIOpenMannequinMesh"

    body.data.materials.clear()
    body.data.materials.append(material)
    for polygon in body.data.polygons:
        polygon.material_index = 0

    body.parent = armature
    body.matrix_parent_inverse = armature.matrix_world.inverted()
    modifier = body.modifiers.new(name="StoryAIOpenMannequinRig", type="ARMATURE")
    modifier.object = armature
    body["title"] = MODEL_NAME
    body["license"] = MODEL_LICENSE
    body["generated_geometry"] = True
    return body


def export_glb(output_path: Path, armature: bpy.types.Object, body: bpy.types.Object) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    armature.select_set(True)
    body.select_set(True)
    bpy.context.view_layer.objects.active = body

    bpy.ops.export_scene.gltf(
        filepath=str(output_path),
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_apply=False,
        export_extras=True,
        export_animations=False,
        export_copyright="MIT License - StoryAI Open Mannequin",
    )


def main() -> None:
    args = parse_args()
    output_path = Path(args.output).expanduser().resolve()

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.unit_settings.system = "METRIC"
    bpy.context.scene.unit_settings.scale_length = 1.0

    armature, points = create_armature()
    body = create_body(armature, points)
    export_glb(output_path, armature, body)
    print(f"Generated {MODEL_NAME}: {output_path} ({output_path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
