## Light import for the Director Godot connector.
##
## Maps Director scene lights onto Godot light nodes with stable director_id
## metadata: point -> OmniLight3D, spot -> SpotLight3D, directional ->
## DirectionalLight3D. Ambient, hemisphere, and rect-area lights have no
## faithful Godot node equivalent in a saved scene and are omitted with a
## warning (warn-and-omit, never silently flattened).
##
## No class_name: headless `godot --script` runs on a fresh project have no
## global class cache, so every module is referenced through `preload`.

const DirectorPackage := preload("res://addons/director_bridge/director_package.gd")
const DirectorSpace := preload("res://addons/director_bridge/director_space.gd")

const SUPPORTED_TYPES := ["point", "spot", "directional"]


## Imports Director scene lights under `root`, stamping director_id metadata.
## Returns the number of imported light nodes; unsupported types warn-and-omit.
static func import_lights(root: Node3D, scene: Dictionary, lights: Array, warnings: Array) -> int:
	var imported := 0
	for light_entity in lights:
		var light_type: String = str(light_entity.get("type", ""))
		if light_type not in SUPPORTED_TYPES:
			warnings.append(
				(
					"Light %s has type %s; Godot's Omni/Spot/Directional import does not carry it, "
					+ "so it was omitted (warn-and-omit)."
				)
				% [str(light_entity.get("id", "?")), light_type]
			)
			continue
		var light := _make_light(light_type, light_entity, warnings)
		light.name = DirectorPackage.safe_node_name(str(light_entity.get("name", light_entity["id"])))
		light.set_meta("director_id", light_entity["id"])
		light.set_meta("director_entity_type", "light")
		light.light_color = Color.from_string(str(light_entity.get("color", "#ffffff")), Color(1, 1, 1))
		light.light_energy = float(light_entity.get("intensity", 1.0))
		if light_entity.get("castShadow", false):
			light.shadow_enabled = true
		if light_entity.get("visible", true) == false:
			light.visible = false
		light.transform = _light_transform(scene, light_entity)
		root.add_child(light)
		imported += 1
	return imported


static func _make_light(light_type: String, light_entity: Dictionary, warnings: Array) -> Light3D:
	match light_type:
		"point":
			var omni := OmniLight3D.new()
			var omni_distance := float(light_entity.get("distance", 0.0))
			omni.omni_range = omni_distance if omni_distance > 0.0 else 20.0
			if light_entity.has("decay"):
				omni.omni_attenuation = clampf(float(light_entity["decay"]), 0.0, 10.0)
			return omni
		"spot":
			var spot := SpotLight3D.new()
			var spot_distance := float(light_entity.get("distance", 0.0))
			spot.spot_range = spot_distance if spot_distance > 0.0 else 20.0
			if light_entity.has("angle"):
				spot.spot_angle = rad_to_deg(clampf(float(light_entity["angle"]), 0.001, PI / 2.0))
			var penumbra := float(light_entity.get("penumbra", 0.0))
			if penumbra > 0.0:
				# Approximate mapping: Director penumbra 0..1 -> softer cone edge.
				spot.spot_angle_attenuation = 1.0 + penumbra * 4.0
				warnings.append(
					(
						"Light %s: spot penumbra maps approximately onto Godot spot_angle_attenuation; "
						+ "the falloff shape differs from Director's preview."
					)
					% str(light_entity.get("id", "?"))
				)
			return spot
		_:
			return DirectionalLight3D.new()


static func _light_transform(scene: Dictionary, light_entity: Dictionary) -> Transform3D:
	var position_array: Array = light_entity.get("position", [0.0, 0.0, 0.0])
	var world_position := DirectorSpace.compose_world_point(scene, position_array)
	var transform := Transform3D(Basis(), world_position)
	if not light_entity.has("target"):
		return transform
	var world_target := DirectorSpace.compose_world_point(scene, light_entity["target"])
	var direction := world_target - world_position
	if direction.length() < 1e-6:
		return transform
	# Godot lights shine along local -Z; looking_at points -Z at the target.
	var up := Vector3.UP
	if absf(direction.normalized().dot(up)) > 0.999:
		up = Vector3.FORWARD
	transform.basis = Basis.looking_at(direction.normalized(), up)
	return transform
