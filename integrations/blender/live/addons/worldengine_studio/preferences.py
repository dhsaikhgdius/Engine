# SPDX-FileCopyrightText: 2026 OpenEnvision Authors
#
# SPDX-License-Identifier: GPL-2.0-or-later

"""Addon preferences: the ports and URLs wiring Blender to Director.

Defaults mirror the repository dev setup (UI :5175, gateway :8787, native
session :8791) so a stock `npm run dev` connects with zero configuration.
The Sketchfab token lives here (or in SKETCHFAB_API_TOKEN) because it is a
per-user credential, not project state.
"""

import bpy
from bpy.props import IntProperty, StringProperty
from bpy.types import AddonPreferences


class WORLDENGINE_AP_preferences(AddonPreferences):
    """User-editable connection settings shown in Blender's addon preferences."""

    bl_idname = __package__

    director_url: StringProperty(
        name="Director URL",
        description="WorldEngine Director workspace opened by the Studio panel",
        default="http://127.0.0.1:5175/?workspace=stage&host=blender",
    )
    gateway_url: StringProperty(
        name="Gateway URL",
        description="Local WorldEngine service used for validated scene exchange",
        default="http://127.0.0.1:8787",
    )
    director_ui_port: IntProperty(name="Director UI Port", default=5175, min=1024, max=65535)
    gateway_port: IntProperty(name="Gateway Port", default=8787, min=1024, max=65535)
    session_port: IntProperty(
        name="Native Session Port",
        description="Loopback port used by the in-process Blender scene session",
        default=8791,
        min=1024,
        max=65535,
    )
    sketchfab_api_token: StringProperty(
        name="Sketchfab API Token",
        description="Used by sketchfab_search and sketchfab_import when SKETCHFAB_API_TOKEN is unset",
        default="",
        subtype="PASSWORD",
    )

    def draw(self, _context):
        """Standard single-column property layout for the preferences panel."""
        layout = self.layout
        layout.use_property_split = True
        layout.use_property_decorate = False
        layout.prop(self, "director_url")
        layout.prop(self, "gateway_url")
        layout.prop(self, "director_ui_port")
        layout.prop(self, "gateway_port")
        layout.prop(self, "session_port")
        layout.prop(self, "sketchfab_api_token")


classes = (WORLDENGINE_AP_preferences,)


def get_preferences(context=None):
    """Preferences for this addon, or None when it is not registered as an
    addon (e.g. imported directly by the headless backend script)."""
    context = context or bpy.context
    addon = context.preferences.addons.get(__package__)
    return addon.preferences if addon else None


def register():
    """Register the preferences class with Blender."""
    for cls in classes:
        bpy.utils.register_class(cls)


def unregister():
    """Unregister the preferences class in reverse order."""
    for cls in reversed(classes):
        bpy.utils.unregister_class(cls)
