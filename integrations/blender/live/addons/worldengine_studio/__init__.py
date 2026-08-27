# SPDX-FileCopyrightText: 2026 OpenEnvision Authors
#
# SPDX-License-Identifier: GPL-2.0-or-later

"""WorldEngine Studio: the Blender live kernel addon for Director.

Registration deliberately excludes native UI menus (``include_ui=False``):
this addon's primary consumers are the Director gateway and coding agents
speaking the live contract over the loopback native session; the human uses
Blender's own tools on the same data. ``register_backend`` is the even
smaller registration used by ``worldengine_backend.py`` when Blender runs
headless as a pure session host (no operators at all).
"""

bl_info = {
    "name": "WorldEngine Studio",
    "author": "OpenEnvision",
    "version": (0, 1, 0),
    "blender": (4, 2, 0),
    "location": "3D View > Sidebar > WorldEngine",
    "description": "Native WorldEngine scene authoring, directing and Agent control",
    "support": "COMMUNITY",
    "category": "3D View",
}


# Standard Blender addon reload dance: on F8 / "Reload Scripts" the module
# object survives, so submodules must be reloaded explicitly and in dependency
# order (protocol/coordinates first, operators/session last).
if "bpy" in locals():
    import importlib
    from . import asset_import, asset_libraries, asset_library_http, coordinates, director_project, material_nodes, mixamo_actions, modeling, semantic_geometry

    importlib.reload(live_protocol)
    importlib.reload(coordinates)
    importlib.reload(blockout)
    importlib.reload(asset_import)
    importlib.reload(asset_library_http)
    importlib.reload(asset_libraries)
    importlib.reload(material_nodes)
    importlib.reload(mixamo_actions)
    importlib.reload(semantic_geometry)
    importlib.reload(modeling)
    importlib.reload(director_project)
    importlib.reload(director_runtime)
    importlib.reload(operators)
    importlib.reload(native_session)
    importlib.reload(preferences)
    importlib.reload(properties)
else:
    from . import asset_import, asset_libraries, asset_library_http, blockout, coordinates, director_project, director_runtime, live_protocol, material_nodes, mixamo_actions, modeling, native_session, operators, preferences, properties, semantic_geometry


def register():
    """Interactive-Blender registration: properties, operators (no UI menus), session."""
    properties.register()
    operators.register(include_ui=False)
    native_session.register()


def unregister():
    """Mirror of register(); also stops any dev services this addon launched."""
    director_runtime.stop()
    native_session.unregister()
    operators.unregister(include_ui=False)
    properties.unregister()


def register_backend():
    """Headless registration used by worldengine_backend.py: no operators at all."""
    properties.register()
    native_session.register()


def unregister_backend():
    """Mirror of register_backend() for headless shutdown."""
    director_runtime.stop()
    native_session.unregister()
    properties.unregister()
