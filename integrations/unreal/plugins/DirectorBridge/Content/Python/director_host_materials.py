"""Host-side material authoring for the Director Unreal connector.

Takes the pure-Python mapping produced by ``director_materials.map_material``
and authors the corresponding Unreal assets: two Director-owned parent
materials (opaque and translucent) with the parameter slots the mapping
targets, plus one MaterialInstanceConstant per Director object. Every function
receives the ``unreal`` module from the caller so this file never imports it
at module scope.
"""

from __future__ import annotations

from typing import Optional

OPAQUE_PARENT_NAME = "DirectorPbrOpaque"
TRANSLUCENT_PARENT_NAME = "DirectorPbrTranslucent"

# Engine textures used as compile-safe defaults on the texture parameters.
_DEFAULT_WHITE_TEXTURE = "/Engine/EngineResources/WhiteSquareTexture"
_DEFAULT_FLAT_NORMAL = "/Engine/EngineMaterials/FlatNormal"


def _texture_parameter(unreal, library, material, parameter_name: str, x: int, y: int, normal: bool = False):
    """One TextureSampleParameter2D with a compile-safe engine default texture."""
    sample = library.create_material_expression(material, unreal.MaterialExpressionTextureSampleParameter2D, x, y)
    sample.set_editor_property("parameter_name", parameter_name)
    default_path = _DEFAULT_FLAT_NORMAL if normal else _DEFAULT_WHITE_TEXTURE
    default_texture = unreal.load_asset(default_path)
    if default_texture is not None:
        sample.set_editor_property("texture", default_texture)
    if normal:
        sample.set_editor_property("sampler_type", unreal.MaterialSamplerType.SAMPLERTYPE_NORMAL)
    return sample


def _static_switch(unreal, library, material, switch_name: str, x: int, y: int, true_input, true_output: str,
                   false_input, false_output: str):
    """One StaticSwitchParameter (default false) choosing texture vs parameter path."""
    switch = library.create_material_expression(material, unreal.MaterialExpressionStaticSwitchParameter, x, y)
    switch.set_editor_property("parameter_name", switch_name)
    switch.set_editor_property("default_value", False)
    library.connect_material_expressions(true_input, true_output, switch, "True")
    library.connect_material_expressions(false_input, false_output, switch, "False")
    return switch


def _create_parent_material(unreal, name: str, path: str, translucent: bool):
    """Author one shared parent material with parameterized PBR channels.

    Each channel (base color, roughness, metallic, normal, emissive) exposes
    both a scalar/vector parameter and an optional texture parameter behind a
    static Use*Map switch, so per-entity material instances only set
    parameters and never edit the expression graph. The opaque and
    translucent variants exist because Unreal blend mode is a material (not
    instance) property.
    """
    asset_tools = unreal.AssetToolsHelpers.get_asset_tools()
    material = asset_tools.create_asset(name, path, unreal.Material, unreal.MaterialFactoryNew())
    library = unreal.MaterialEditingLibrary

    # Base color: BaseColorMap.rgb * BaseColor behind the UseBaseColorMap switch.
    base_color = library.create_material_expression(material, unreal.MaterialExpressionVectorParameter, -800, -300)
    base_color.set_editor_property("parameter_name", "BaseColor")
    base_color.set_editor_property("default_value", unreal.LinearColor(0.8, 0.8, 0.8, 1.0))
    base_color_map = _texture_parameter(unreal, library, material, "BaseColorMap", -800, -450)
    base_color_product = library.create_material_expression(material, unreal.MaterialExpressionMultiply, -550, -380)
    library.connect_material_expressions(base_color_map, "RGB", base_color_product, "A")
    library.connect_material_expressions(base_color, "", base_color_product, "B")
    base_color_switch = _static_switch(
        unreal, library, material, "UseBaseColorMap", -350, -320, base_color_product, "", base_color, ""
    )
    library.connect_material_property(base_color_switch, "", unreal.MaterialProperty.MP_BASE_COLOR)

    # Metallic: MetalnessMap.r * Metallic behind UseMetalnessMap.
    metallic = library.create_material_expression(material, unreal.MaterialExpressionScalarParameter, -800, -100)
    metallic.set_editor_property("parameter_name", "Metallic")
    metallic.set_editor_property("default_value", 0.0)
    metalness_map = _texture_parameter(unreal, library, material, "MetalnessMap", -800, -180)
    metallic_product = library.create_material_expression(material, unreal.MaterialExpressionMultiply, -550, -130)
    library.connect_material_expressions(metalness_map, "R", metallic_product, "A")
    library.connect_material_expressions(metallic, "", metallic_product, "B")
    metallic_switch = _static_switch(
        unreal, library, material, "UseMetalnessMap", -350, -110, metallic_product, "", metallic, ""
    )
    library.connect_material_property(metallic_switch, "", unreal.MaterialProperty.MP_METALLIC)

    # Roughness: RoughnessMap.r * Roughness behind UseRoughnessMap.
    roughness = library.create_material_expression(material, unreal.MaterialExpressionScalarParameter, -800, 0)
    roughness.set_editor_property("parameter_name", "Roughness")
    roughness.set_editor_property("default_value", 0.5)
    roughness_map = _texture_parameter(unreal, library, material, "RoughnessMap", -800, 60)
    roughness_product = library.create_material_expression(material, unreal.MaterialExpressionMultiply, -550, 20)
    library.connect_material_expressions(roughness_map, "R", roughness_product, "A")
    library.connect_material_expressions(roughness, "", roughness_product, "B")
    roughness_switch = _static_switch(
        unreal, library, material, "UseRoughnessMap", -350, 10, roughness_product, "", roughness, ""
    )
    library.connect_material_property(roughness_switch, "", unreal.MaterialProperty.MP_ROUGHNESS)

    # Normal: tangent-space NormalMap behind UseNormalMap (flat normal otherwise).
    normal_map = _texture_parameter(unreal, library, material, "NormalMap", -800, 500, normal=True)
    flat_normal = library.create_material_expression(material, unreal.MaterialExpressionConstant3Vector, -800, 620)
    flat_normal.set_editor_property("constant", unreal.LinearColor(0.0, 0.0, 1.0, 1.0))
    normal_switch = _static_switch(
        unreal, library, material, "UseNormalMap", -350, 540, normal_map, "RGB", flat_normal, ""
    )
    library.connect_material_property(normal_switch, "", unreal.MaterialProperty.MP_NORMAL)

    # Ambient occlusion: AoMap.r behind UseAoMap (unity otherwise).
    ao_map = _texture_parameter(unreal, library, material, "AoMap", -800, 740)
    ao_unity = library.create_material_expression(material, unreal.MaterialExpressionConstant, -800, 860)
    ao_unity.set_editor_property("r", 1.0)
    ao_switch = _static_switch(unreal, library, material, "UseAoMap", -350, 780, ao_map, "R", ao_unity, "")
    library.connect_material_property(ao_switch, "", unreal.MaterialProperty.MP_AMBIENT_OCCLUSION)

    # Emissive: (EmissiveColor * EmissiveIntensity), tinted by EmissiveMap.rgb
    # behind UseEmissiveMap.
    emissive_color = library.create_material_expression(material, unreal.MaterialExpressionVectorParameter, -800, 150)
    emissive_color.set_editor_property("parameter_name", "EmissiveColor")
    emissive_color.set_editor_property("default_value", unreal.LinearColor(0.0, 0.0, 0.0, 1.0))
    emissive_intensity = library.create_material_expression(material, unreal.MaterialExpressionScalarParameter, -800, 300)
    emissive_intensity.set_editor_property("parameter_name", "EmissiveIntensity")
    emissive_intensity.set_editor_property("default_value", 0.0)
    emissive_product = library.create_material_expression(material, unreal.MaterialExpressionMultiply, -550, 200)
    library.connect_material_expressions(emissive_color, "", emissive_product, "A")
    library.connect_material_expressions(emissive_intensity, "", emissive_product, "B")
    emissive_map = _texture_parameter(unreal, library, material, "EmissiveMap", -800, 380)
    emissive_texture_product = library.create_material_expression(material, unreal.MaterialExpressionMultiply, -450, 260)
    library.connect_material_expressions(emissive_map, "RGB", emissive_texture_product, "A")
    library.connect_material_expressions(emissive_product, "", emissive_texture_product, "B")
    emissive_switch = _static_switch(
        unreal, library, material, "UseEmissiveMap", -250, 220, emissive_texture_product, "", emissive_product, ""
    )
    library.connect_material_property(emissive_switch, "", unreal.MaterialProperty.MP_EMISSIVE_COLOR)

    if translucent:
        material.set_editor_property("blend_mode", unreal.BlendMode.BLEND_TRANSLUCENT)
        opacity = library.create_material_expression(material, unreal.MaterialExpressionScalarParameter, -800, 950)
        opacity.set_editor_property("parameter_name", "Opacity")
        opacity.set_editor_property("default_value", 1.0)
        opacity_map = _texture_parameter(unreal, library, material, "OpacityMap", -800, 1020)
        opacity_product = library.create_material_expression(material, unreal.MaterialExpressionMultiply, -550, 980)
        library.connect_material_expressions(opacity_map, "R", opacity_product, "A")
        library.connect_material_expressions(opacity, "", opacity_product, "B")
        opacity_switch = _static_switch(
            unreal, library, material, "UseOpacityMap", -350, 960, opacity_product, "", opacity, ""
        )
        library.connect_material_property(opacity_switch, "", unreal.MaterialProperty.MP_OPACITY)

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


def import_texture_asset(unreal, image_path: str, destination_path: str, warnings: list):
    """Import one bundled texture image through the editor's asset pipeline.

    @returns The imported ``unreal.Texture`` asset, or None (with a warning).
    """
    import os

    task = unreal.AssetImportTask()
    task.filename = image_path
    task.destination_path = destination_path
    task.automated = True
    task.replace_existing = True
    task.save = True
    unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([task])
    for object_path in list(task.imported_object_paths or []):
        asset = unreal.EditorAssetLibrary.load_asset(object_path)
        if isinstance(asset, unreal.Texture):
            return asset
    warnings.append(
        f"Texture import produced no texture asset for {os.path.basename(image_path)}; "
        "the texture parameter stays unbound (warn-and-omit)."
    )
    return None


def apply_material(
    unreal,
    mesh_component,
    mapped: dict,
    parents: dict,
    instance_name: str,
    instance_path: str,
    warnings: list,
    texture_assets: Optional[dict] = None,
) -> dict:
    """Author one MaterialInstanceConstant and assign it to every slot of the component.

    @param mapped: The pure-Python mapping from ``director_materials.map_material``.
    @param parents: The result of ``ensure_parent_materials``.
    @param texture_assets: Texture parameter name -> imported ``unreal.Texture``
        for the slots ``mapped["textures"]`` bound. Each bind also enables the
        matching ``Use<Parameter>`` static switch. ``None`` values are skipped
        (caller stamps typed ``texture_import_failed`` for those parameters).
    @returns ``{"applied": bool, "boundTextureCount": int, "failedTextureParameters": list}``.
    """
    parent = parents.get(mapped["parent"])
    if parent is None:
        warnings.append(f"Material instance {instance_name} was skipped: no {mapped['parent']} parent material.")
        return {"applied": False, "boundTextureCount": 0, "failedTextureParameters": []}
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
    bound_texture_count = 0
    failed_texture_parameters: list = []
    for parameter_name, texture in (texture_assets or {}).items():
        if texture is None:
            continue
        try:
            library.set_material_instance_texture_parameter_value(instance, parameter_name, texture)
            library.set_material_instance_static_switch_parameter_value(instance, f"Use{parameter_name}", True)
            bound_texture_count += 1
        except Exception as error:  # noqa: BLE001 - one bad texture must not sink the instance
            warnings.append(f"Texture parameter {parameter_name} failed to bind on {instance_name}: {error}")
            failed_texture_parameters.append(parameter_name)
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
        return {
            "applied": True,
            "boundTextureCount": bound_texture_count,
            "failedTextureParameters": failed_texture_parameters,
        }
    for slot in range(slot_count):
        mesh_component.set_material(slot, instance)
    return {
        "applied": True,
        "boundTextureCount": bound_texture_count,
        "failedTextureParameters": failed_texture_parameters,
    }
