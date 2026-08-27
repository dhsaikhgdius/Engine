# SPDX-FileCopyrightText: 2026 OpenEnvision Authors
#
# SPDX-License-Identifier: GPL-2.0-or-later

"""Per-scene WorldEngine state stored as ``scene.worldengine_studio``.

Mostly N-panel input fields (blockout dimensions, opening/light presets,
relation targets) that native operators read at execute time. The one field
with cross-process meaning is ``scene_revision``: a monotonic counter bumped
after every semantic edit, which the native session publishes so Director
clients know when to re-snapshot. Storing it on the scene (not a Python
global) makes it survive undo/redo and file load consistently with the data
it describes.
"""

import bpy
from bpy.props import BoolProperty, EnumProperty, FloatProperty, IntProperty, PointerProperty, StringProperty
from bpy.types import PropertyGroup


class WORLDENGINE_PG_scene_state(PropertyGroup):
    """N-panel operator inputs plus the cross-process scene_revision counter."""

    blockout_width: FloatProperty(
        name="Width",
        description="Width of the next room, corridor, floor, or stair flight",
        default=6.0,
        min=0.1,
        unit='LENGTH',
    )
    blockout_depth: FloatProperty(
        name="Depth",
        description="Depth of the next room or floor",
        default=5.0,
        min=0.1,
        unit='LENGTH',
    )
    blockout_height: FloatProperty(
        name="Height",
        description="Wall or corridor height",
        default=2.8,
        min=0.1,
        unit='LENGTH',
    )
    wall_thickness: FloatProperty(
        name="Wall",
        description="Blockout wall thickness",
        default=0.15,
        min=0.01,
        unit='LENGTH',
    )
    stair_steps: IntProperty(
        name="Steps",
        description="Number of stair treads",
        default=12,
        min=2,
        max=128,
    )
    opening_kind: EnumProperty(
        name="Opening",
        items=(
            ('door', "Door", "Create a floor-level door opening"),
            ('window', "Window", "Create a raised window opening"),
        ),
        default='door',
    )
    opening_width: FloatProperty(name="Width", default=0.9, min=0.1, unit='LENGTH')
    opening_height: FloatProperty(name="Height", default=2.1, min=0.1, unit='LENGTH')
    opening_sill_height: FloatProperty(name="Sill", default=0.0, min=0.0, unit='LENGTH')
    opening_offset: FloatProperty(name="Offset", default=0.0, unit='LENGTH')
    light_kind: EnumProperty(
        name="Type",
        items=(
            ('AREA', "Area", "Soft area light"),
            ('POINT', "Point", "Omnidirectional point light"),
            ('SUN', "Sun", "Directional sunlight"),
            ('SPOT', "Spot", "Focused spot light"),
        ),
        default='AREA',
    )
    light_energy: FloatProperty(name="Energy", default=1000.0, min=0.0)
    light_size: FloatProperty(name="Size", default=4.0, min=0.01, unit='LENGTH')
    collection_name: StringProperty(name="Collection", default="Blockout Set")
    relation_target: PointerProperty(
        name="Target",
        description="Native Blender parent or constraint target for the active object",
        type=bpy.types.Object,
    )
    keep_world_transform: BoolProperty(name="Keep World Transform", default=True)
    constraint_kind: EnumProperty(
        name="Constraint",
        items=(
            ('track_to', "Track To", "Aim the active object at the target"),
            ('copy_location', "Copy Location", "Copy target location"),
            ('copy_rotation', "Copy Rotation", "Copy target rotation"),
            ('copy_transforms', "Copy Transforms", "Copy target location, rotation, and scale"),
        ),
        default='track_to',
    )
    constraint_influence: FloatProperty(name="Influence", default=1.0, min=0.0, max=1.0)
    scene_revision: IntProperty(name="Scene Revision", default=0, min=0, options={'HIDDEN'})


classes = (WORLDENGINE_PG_scene_state,)


def register():
    """Register the property group and attach it to every Scene."""
    for cls in classes:
        bpy.utils.register_class(cls)
    bpy.types.Scene.worldengine_studio = PointerProperty(type=WORLDENGINE_PG_scene_state)


def unregister():
    """Detach the scene pointer and unregister the property group."""
    del bpy.types.Scene.worldengine_studio
    for cls in reversed(classes):
        bpy.utils.unregister_class(cls)
