"""Host-side material authoring for the Director Unreal connector.

Takes the pure-Python mapping produced by ``director_materials.map_material``
and authors the corresponding Unreal assets: two Director-owned parent
materials (opaque and translucent) with the parameter slots the mapping
targets, plus one MaterialInstanceConstant per Director object. Every function
receives the ``unreal`` module from the caller so this file never imports it
at module scope.
"""

from __future__ import annotations

OPAQUE_PARENT_NAME = "DirectorPbrOpaque"
TRANSLUCENT_PARENT_NAME = "DirectorPbrTranslucent"


def _create_parent_material(unreal, name: str, path: str, translucent: bool):
    asset_tools = unreal.AssetToolsHelpers.get_asset_tools()
    material = asset_tools.create_asset(name, path, unreal.Material, unreal.MaterialFactoryNew())
    library = unreal.MaterialEditingLibrary

    base_color = library.create_material_expression(material, unreal.MaterialExpressionVectorParameter, -500, -300)
    base_color.set_editor_property("parameter_name", "BaseColor")
    base_color.set_editor_property("default_value", unreal.LinearColor(0.8, 0.8, 0.8, 1.0))
    library.connect_material_property(base_color, "", unreal.MaterialProperty.MP_BASE_COLOR)

    metallic = library.create_material_expression(material, unreal.MaterialExpressionScalarParameter, -500, -100)
    metallic.set_editor_property("parameter_name", "Metallic")
    metallic.set_editor_property("default_value", 0.0)
    library.connect_material_property(metallic, "", unreal.MaterialProperty.MP_METALLIC)

    roughness = library.create_material_expression(material, unreal.MaterialExpressionScalarParameter, -500, 0)
    roughness.set_editor_property("parameter_name", "Roughness")
    roughness.set_editor_property("default_value", 0.5)
    library.connect_material_property(roughness, "", unreal.MaterialProperty.MP_ROUGHNESS)

    emissive_color = library.create_material_expression(material, unreal.MaterialExpressionVectorParameter, -700, 150)
    emissive_color.set_editor_property("parameter_name", "EmissiveColor")
    emissive_color.set_editor_property("default_value", unreal.LinearColor(0.0, 0.0, 0.0, 1.0))
    emissive_intensity = library.create_material_expression(material, unreal.MaterialExpressionScalarParameter, -700, 300)
    emissive_intensity.set_editor_property("parameter_name", "EmissiveIntensity")
    emissive_intensity.set_editor_property("default_value", 0.0)
    emissive_product = library.create_material_expression(material, unreal.MaterialExpressionMultiply, -400, 200)
    library.connect_material_expressions(emissive_color, "", emissive_product, "A")
    library.connect_material_expressions(emissive_intensity, "", emissive_product, "B")
    library.connect_material_property(emissive_product, "", unreal.MaterialProperty.MP_EMISSIVE_COLOR)

    if translucent:
        material.set_editor_property("blend_mode", unreal.BlendMode.BLEND_TRANSLUCENT)
        opacity = library.create_material_expression(material, unreal.MaterialExpressionScalarParameter, -500, 400)
        opacity.set_editor_property("parameter_name", "Opacity")
        opacity.set_editor_property("default_value", 1.0)
        library.connect_material_property(opacity, "", unreal.MaterialProperty.MP_OPACITY)

    library.recompile_material(material)
    unreal.EditorAssetLibrary.save_asset(f"{path}/{name}")
    return material


def ensure_parent_materials(unreal, content_root: str, warnings: list) -> dict:
    """Load or author the Director parent materials under ``<root>/Materials``.

    @returns ``{"opaque": Material|None, "translucent": Material|None}``.
    """
    path = f"{content_root}/Materials"
    parents = {}
    for key, name, translucent in (
        ("opaque", OPAQUE_PARENT_NAME, False),
        ("translucent", TRANSLUCENT_PARENT_NAME, True),
    ):
        asset_path = f"{path}/{name}"
        try:
            if unreal.EditorAssetLibrary.does_asset_exist(asset_path):
                parents[key] = unreal.EditorAssetLibrary.load_asset(asset_path)
            else:
                parents[key] = _create_parent_material(unreal, name, path, translucent)
        except Exception as error:  # noqa: BLE001 - a missing parent downgrades to warn-and-omit
            parents[key] = None
            warnings.append(f"Director parent material {name} is unavailable: {error}")
    return parents


def apply_material(
    unreal,
    mesh_component,
    mapped: dict,
    parents: dict,
    instance_name: str,
    instance_path: str,
    warnings: list,
) -> bool:
    """Author one MaterialInstanceConstant and assign it to every slot of the component.

    @param mapped: The pure-Python mapping from ``director_materials.map_material``.
    @param parents: The result of ``ensure_parent_materials``.
    @returns True when the instance was created and assigned.
    """
    parent = parents.get(mapped["parent"])
    if parent is None:
        warnings.append(f"Material instance {instance_name} was skipped: no {mapped['parent']} parent material.")
        return False
    library = unreal.MaterialEditingLibrary
    asset_tools = unreal.AssetToolsHelpers.get_asset_tools()
    instance = asset_tools.create_asset(
        instance_name, instance_path, unreal.MaterialInstanceConstant, unreal.MaterialInstanceConstantFactoryNew()
    )
    library.set_material_instance_parent(instance, parent)
    for parameter_name, value in mapped["scalars"].items():
        library.set_material_instance_scalar_parameter_value(instance, parameter_name, float(value))
    for parameter_name, value in mapped["vectors"].items():
        library.set_material_instance_vector_parameter_value(
            instance, parameter_name, unreal.LinearColor(value[0], value[1], value[2], value[3])
        )
    if mapped.get("twoSided"):
        try:
            overrides = instance.get_editor_property("base_property_overrides")
            overrides.set_editor_property("override_two_sided", True)
            overrides.set_editor_property("two_sided", True)
            instance.set_editor_property("base_property_overrides", overrides)
        except Exception as error:  # noqa: BLE001 - two-sided is best-effort
            warnings.append(f"Two-sided override failed on {instance_name}: {error}")
    unreal.EditorAssetLibrary.save_asset(f"{instance_path}/{instance_name}")

    slot_count = 0
    try:
        slot_count = int(mesh_component.get_num_materials())
    except Exception:  # noqa: BLE001 - some components do not expose material slots
        slot_count = 0
    if slot_count == 0:
        warnings.append(f"Material instance {instance_name} was authored but the component has no material slots.")
        return True
    for slot in range(slot_count):
        mesh_component.set_material(slot, instance)
    return True
