## Material translation for the Director Godot connector.
##
## glTF PBR materials in GLB payloads already import as StandardMaterial3D
## through GLTFDocument; this module adds the Director-side responsibilities:
## - apply Director PBR overrides (`object.material`) as StandardMaterial3D,
##   warn-and-omit channels Godot cannot carry (typed omittedMaterials);
## - externalize embedded payload textures into content-hashed
##   `res://director/textures/` resources so the saved scene references
##   relative hashed files instead of embedding image bytes;
## - warn on custom ShaderMaterials, which Director cannot translate
##   (typed `custom_shader` omittedMaterials).
##
## No class_name: headless `godot --script` runs on a fresh project have no
## global class cache, so every module is referenced through `preload`.

## BaseMaterial3D texture-slot properties externalized from GLB payloads.
const TEXTURE_SLOT_PROPERTIES := [
	"albedo_texture",
	"metallic_texture",
	"roughness_texture",
	"emission_texture",
	"normal_texture",
	"ao_texture",
	"orm_texture",
]

const TEXTURE_DIRECTORY := "res://director/textures"

## Channels Godot StandardMaterial3D cannot carry from a Director PBR override.
const OMIT_UNSUPPORTED_CHANNELS := "unsupported_channels"
## A Director material was authored but the payload has no MeshInstance3D.
const OMIT_NO_MESH_TARGET := "no_mesh_target"
## Custom ShaderMaterial stays in Godot and does not travel through the handoff.
const OMIT_CUSTOM_SHADER := "custom_shader"


## Applies a Director PBR material dictionary onto every MeshInstance3D under
## `target` as a StandardMaterial3D override. Channels without a faithful
## StandardMaterial3D equivalent warn-and-omit with a typed receipt record.
## Returns {"applied": bool, "omittedMaterials": Array}.
static func apply_director_material(
	target: Node3D, material_dict: Dictionary, entity_label: String, warnings: Array
) -> Dictionary:
	var director_id := _director_id_from_label(entity_label, target)
	var material := StandardMaterial3D.new()
	var base := Color.from_string(str(material_dict.get("baseColor", "#ffffff")), Color(1, 1, 1))
	var opacity := clampf(float(material_dict.get("opacity", 1.0)), 0.0, 1.0)
	base.a = opacity
	material.albedo_color = base
	if opacity < 1.0:
		material.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	if material_dict.has("metalness"):
		material.metallic = clampf(float(material_dict["metalness"]), 0.0, 1.0)
	if material_dict.has("roughness"):
		material.roughness = clampf(float(material_dict["roughness"]), 0.0, 1.0)
	if material_dict.has("emissiveColor") or material_dict.has("emissiveIntensity"):
		material.emission_enabled = true
		material.emission = Color.from_string(str(material_dict.get("emissiveColor", "#000000")), Color(0, 0, 0))
		material.emission_energy_multiplier = maxf(float(material_dict.get("emissiveIntensity", 1.0)), 0.0)
	if material_dict.has("clearcoat"):
		material.clearcoat_enabled = true
		material.clearcoat = clampf(float(material_dict["clearcoat"]), 0.0, 1.0)
		material.clearcoat_roughness = clampf(float(material_dict.get("clearcoatRoughness", 0.5)), 0.0, 1.0)
	match str(material_dict.get("side", "front")):
		"double":
			material.cull_mode = BaseMaterial3D.CULL_DISABLED
		"back":
			material.cull_mode = BaseMaterial3D.CULL_FRONT
		_:
			material.cull_mode = BaseMaterial3D.CULL_BACK

	var omitted_materials: Array = []
	var unsupported: Array = []
	if float(material_dict.get("transmission", 0.0)) > 0.0:
		unsupported.append("transmission")
	if material_dict.has("ior"):
		unsupported.append("ior")
	if material_dict.get("wireframe", false):
		unsupported.append("wireframe")
	if material_dict.get("flatShading", false):
		unsupported.append("flatShading")
	var textures: Dictionary = material_dict.get("textures", {})
	if not textures.is_empty():
		unsupported.append("textures (texture assets are not bundled in the exchange package)")
	if not unsupported.is_empty():
		var channel_reason := (
			"%s: Director material channels %s have no StandardMaterial3D equivalent here; omitted (warn-and-omit code: %s)."
			% [entity_label, ", ".join(unsupported), OMIT_UNSUPPORTED_CHANNELS]
		)
		_omit_material(
			omitted_materials,
			warnings,
			director_id,
			OMIT_UNSUPPORTED_CHANNELS,
			channel_reason,
		)

	var applied := false
	for mesh_instance in collect_mesh_instances(target):
		mesh_instance.material_override = material
		applied = true
	if not applied:
		var no_mesh_reason := (
			"%s: a Director material was authored but the payload has no meshes to apply it to (warn-and-omit code: %s)."
			% [entity_label, OMIT_NO_MESH_TARGET]
		)
		_omit_material(omitted_materials, warnings, director_id, OMIT_NO_MESH_TARGET, no_mesh_reason)
	return {"applied": applied, "omittedMaterials": omitted_materials}


## Saves every embedded payload texture (BaseMaterial3D texture slots) as a
## content-hashed `res://director/textures/<sha16>.res` resource and re-points
## the material through take_over_path, so the saved scene references relative
## hashed texture files. Returns the number of textures written.
static func externalize_textures(root: Node, warnings: Array) -> int:
	var externalized := {}
	var written := 0
	for mesh_instance in collect_mesh_instances(root):
		var candidates: Array = [mesh_instance.material_override]
		var mesh: Mesh = mesh_instance.mesh
		if mesh != null:
			for surface in range(mesh.get_surface_count()):
				candidates.append(mesh.surface_get_material(surface))
				candidates.append(mesh_instance.get_surface_override_material(surface))
		for material in candidates:
			written += _externalize_material_textures(material, externalized, warnings)
	return written


## Appends typed omittedMaterials + warnings for every custom ShaderMaterial
## found under `root`. Director translates glTF PBR / StandardMaterial3D only;
## custom shaders are preserved in the Godot scene but cannot travel through
## the handoff. Returns {"found": int, "omittedMaterials": Array}.
static func warn_on_custom_shaders(root: Node, warnings: Array) -> Dictionary:
	var seen := {}
	var found := 0
	var omitted_materials: Array = []
	for mesh_instance in collect_mesh_instances(root):
		var candidates: Array = [mesh_instance.material_override]
		var mesh: Mesh = mesh_instance.mesh
		if mesh != null:
			for surface in range(mesh.get_surface_count()):
				candidates.append(mesh.surface_get_material(surface))
				candidates.append(mesh_instance.get_surface_override_material(surface))
		for material in candidates:
			if material is ShaderMaterial and not seen.has(material.get_rid()):
				seen[material.get_rid()] = true
				found += 1
				var director_id := str(mesh_instance.get_meta("director_id", mesh_instance.name))
				var reason := (
					(
						"Node %s uses a custom ShaderMaterial; Director translates StandardMaterial3D / "
						+ "glTF PBR only, so the shader stays in Godot and does not travel back "
						+ "(warn-and-omit code: %s)."
					)
					% [mesh_instance.name, OMIT_CUSTOM_SHADER]
				)
				_omit_material(omitted_materials, warnings, director_id, OMIT_CUSTOM_SHADER, reason)
	return {"found": found, "omittedMaterials": omitted_materials}


static func collect_mesh_instances(root: Node) -> Array:
	var found: Array = []
	var queue: Array = [root]
	while not queue.is_empty():
		var node: Node = queue.pop_front()
		if node is MeshInstance3D:
			found.append(node)
		for child in node.get_children():
			queue.append(child)
	return found


static func _omit_material(
	omitted_materials: Array, warnings: Array, director_id: String, code: String, reason: String
) -> void:
	warnings.append(reason)
	omitted_materials.append({"directorId": director_id, "code": code, "reason": reason})


## Prefer the Node's director_id meta; fall back to parsing "Object <id>" labels.
static func _director_id_from_label(entity_label: String, target: Node) -> String:
	if target.has_meta("director_id"):
		return str(target.get_meta("director_id"))
	# Labels are authored as "Object <id>" by the headless importer.
	if entity_label.begins_with("Object "):
		return entity_label.substr(7).strip_edges()
	return entity_label


static func _externalize_material_textures(material, externalized: Dictionary, warnings: Array) -> int:
	if material == null or not (material is BaseMaterial3D):
		return 0
	var written := 0
	for property in TEXTURE_SLOT_PROPERTIES:
		var texture = material.get(property)
		if texture == null or not (texture is Texture2D):
			continue
		if texture.resource_path.begins_with("res://"):
			continue
		var key := (texture as Texture2D).get_rid()
		if externalized.has(key):
			continue
		var path := _save_texture(texture, warnings)
		if path.is_empty():
			continue
		externalized[key] = path
		written += 1
	return written


static func _save_texture(texture: Texture2D, warnings: Array) -> String:
	var image := texture.get_image()
	if image == null:
		warnings.append("A payload texture had no readable image data; it stays embedded (warn-and-omit).")
		return ""
	var buffer := image.save_png_to_buffer()
	var context := HashingContext.new()
	context.start(HashingContext.HASH_SHA256)
	context.update(buffer)
	var digest: String = context.finish().hex_encode()
	DirAccess.make_dir_recursive_absolute(TEXTURE_DIRECTORY)
	var path := "%s/%s.res" % [TEXTURE_DIRECTORY, digest.substr(0, 16)]
	if not FileAccess.file_exists(path):
		var error := ResourceSaver.save(texture, path)
		if error != OK:
			warnings.append("Saving payload texture %s failed with error %d; it stays embedded." % [path, error])
			return ""
	texture.take_over_path(path)
	return path
