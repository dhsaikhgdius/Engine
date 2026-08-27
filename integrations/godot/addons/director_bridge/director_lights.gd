## Light import for the Director Godot connector.
##
## Maps Director scene lights onto Godot light nodes with stable director_id
## metadata: point -> OmniLight3D, spot -> SpotLight3D, directional ->
## DirectionalLight3D. Ambient and hemisphere lights have no node equivalent
## but do have a faithful home in Godot's environment: the first visible one
## is baked into a WorldEnvironment ambient-color term (hemisphere flattens
## its sky/ground gradient into one color, with a warning). Rect-area lights
## have no Godot runtime node at all and are omitted with a structured code
## (warn-and-omit, never silently flattened).
##
## No class_name: headless `godot --script` runs on a fresh project have no
## global class cache, so every module is referenced through `preload`.

const DirectorPackage := preload("res://addons/director_bridge/director_package.gd")
const DirectorSpace := preload("res://addons/director_bridge/director_space.gd")

const SUPPORTED_TYPES := ["point", "spot", "directional"]
const AMBIENT_TYPES := ["ambient", "hemisphere"]
const ENVIRONMENT_NODE_NAME := "DirectorWorldEnvironment"

## Godot has no runtime rect-area light node; the light cannot be represented.
const OMIT_RECT_AREA := "light_rect_area_unsupported"
## A WorldEnvironment ambient term was already baked from an earlier light.
const OMIT_AMBIENT_DUPLICATE := "light_ambient_duplicate"
## The ambient/hemisphere light is hidden in Director; nothing to bake.
const OMIT_AMBIENT_INVISIBLE := "light_ambient_invisible"
## The light type is outside the Director light vocabulary this connector knows.
const OMIT_UNKNOWN_TYPE := "light_type_unknown"
## Hemisphere sky/ground gradients flatten into one constant ambient color.
const WARN_HEMISPHERE_APPROXIMATED := "light_hemisphere_approximated"


## Imports Director scene lights under `root`, stamping director_id metadata.
## Returns receipt counts plus typed omittedLights records:
## {"importedLightCount", "worldEnvironmentAmbient", "omittedLightCount",
## "omittedLights": [{directorId, code, lightType, reason}, ...]}.
## Unsupported lights warn-and-omit with a structured code (never silently flattened).
static func import_lights(root: Node3D, scene: Dictionary, lights: Array, warnings: Array) -> Dictionary:
	var imported := 0
	var omitted_lights: Array = []
	var ambient_applied := false
	for light_entity in lights:
		var light_type: String = str(light_entity.get("type", ""))
		var light_id := str(light_entity.get("id", "?"))
		if light_type in AMBIENT_TYPES:
			if ambient_applied:
				_omit_light(
					omitted_lights,
					warnings,
					light_id,
					light_type,
					OMIT_AMBIENT_DUPLICATE,
					(
						"Light %s (%s): a WorldEnvironment ambient term was already baked from an "
						+ "earlier ambient/hemisphere light; Godot environments hold one ambient "
						+ "color (warn-and-omit code: %s)."
					)
					% [light_id, light_type, OMIT_AMBIENT_DUPLICATE]
				)
				continue
			if light_entity.get("visible", true) == false:
				_omit_light(
					omitted_lights,
					warnings,
					light_id,
					light_type,
					OMIT_AMBIENT_INVISIBLE,
					"Light %s (%s): the light is hidden in Director, so no ambient term was baked (warn-and-omit code: %s)."
					% [light_id, light_type, OMIT_AMBIENT_INVISIBLE]
				)
				continue
			_apply_ambient_environment(root, light_type, light_entity, warnings)
			ambient_applied = true
			continue
		if light_type == "rect-area":
			_omit_light(
				omitted_lights,
				warnings,
				light_id,
				light_type,
				OMIT_RECT_AREA,
				(
					"Light %s (rect-area): Godot has no runtime area-light node, so the light was "
					+ "omitted rather than approximated (warn-and-omit code: %s)."
				)
				% [light_id, OMIT_RECT_AREA]
			)
			continue
		if light_type not in SUPPORTED_TYPES:
			_omit_light(
				omitted_lights,
				warnings,
				light_id,
				light_type,
				OMIT_UNKNOWN_TYPE,
				"Light %s has unknown type %s; it was omitted (warn-and-omit code: %s)."
				% [light_id, light_type, OMIT_UNKNOWN_TYPE]
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
	return {
		"importedLightCount": imported,
		"worldEnvironmentAmbient": ambient_applied,
		"omittedLightCount": omitted_lights.size(),
		"omittedLights": omitted_lights,
	}


## Appends one typed omit record and the matching free-text warning (older UIs
## still scrape `warn-and-omit code:` from warnings).
static func _omit_light(
	omitted_lights: Array, warnings: Array, light_id: String, light_type: String, code: String, warning: String
) -> void:
	omitted_lights.append(
		{"directorId": light_id, "code": code, "lightType": light_type, "reason": warning}
	)
	warnings.append(warning)


## Bakes one ambient/hemisphere light into a WorldEnvironment ambient term.
## The node carries the source light's director_id so the mapping stays
## traceable; export never treats it as a transform-bearing entity.
static func _apply_ambient_environment(
	root: Node3D, light_type: String, light_entity: Dictionary, warnings: Array
) -> void:
	var color := Color.from_string(str(light_entity.get("color", "#ffffff")), Color(1, 1, 1))
	if light_type == "hemisphere":
		var ground := Color.from_string(str(light_entity.get("groundColor", "#000000")), Color(0, 0, 0))
		color = color.lerp(ground, 0.5)
		warnings.append(
			(
				"Light %s (hemisphere): Godot's environment ambient light is a single color, so the "
				+ "sky/ground gradient was flattened to their blend (approximation code: %s)."
			)
			% [str(light_entity.get("id", "?")), WARN_HEMISPHERE_APPROXIMATED]
		)
	var environment := Environment.new()
	environment.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	environment.ambient_light_color = color
	environment.ambient_light_energy = clampf(float(light_entity.get("intensity", 1.0)), 0.0, 16.0)
	var world_environment := WorldEnvironment.new()
	world_environment.name = ENVIRONMENT_NODE_NAME
	world_environment.environment = environment
	world_environment.set_meta("director_id", light_entity["id"])
	world_environment.set_meta("director_entity_type", "light")
	root.add_child(world_environment)


## Builds the typed Light3D node: Omni for point, Spot for spot (Director's
## half-angle radians converted to Godot's aperture degrees, penumbra
## approximated through spot_angle_attenuation), Directional otherwise.
## Director distance 0 means unlimited, which maps to a 20 m stage default.
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


## Places the light at its composed world position and, when a target point
## exists, aims local -Z at it (Director lights aim at targets rather than
## storing rotations); a fallback up axis avoids the looking_at singularity
## for straight-down lights.
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
