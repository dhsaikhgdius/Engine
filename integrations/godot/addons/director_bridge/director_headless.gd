## Fixed headless entry point for the Director Godot connector.
##
## Invoked by the Director Gateway (never with a request-supplied script) as:
##
##     godot --headless --path <project> \
##         --script res://addons/director_bridge/director_headless.gd -- \
##         --mode import --package <dir> --report <report.json> --return-dir <dir> \
##         [--animation <animation.json> --animation-sha256 <hex>]
##
## Modes:
## - health   print a JSON health line with the engine and connector version.
## - import   import a Director exchange package into a saved scene under
##            res://director/scenes/ with stable director_id metadata: object
##            payload instances (GLB), restored parent hierarchy, cameras with
##            optics, Omni/Spot/Directional lights, an ambient/hemisphere
##            WorldEnvironment term, Director PBR material overrides, tagged
##            bind-pose skeletons, externalized hashed payload textures, and —
##            when the Gateway pinned an animation bake — an AnimationPlayer/
##            AnimationLibrary keyed on the rational timebase including
##            discrete Camera3D.current storyboard camera cuts. Echoes a
##            canonical-space return package.
## - export   export a director-dcc-return-v1 package with the canonical
##            transforms of every director_id-tagged object/camera node that
##            moved relative to the exchange package baseline.
##
## Godot 4's basis (right-handed, Y-up, metres, -Z forward) matches Director's
## canonical space, so the provider-boundary conversion is the identity; it
## still runs through director_space.gd so the boundary stays explicit.
##
## Modules are referenced through `preload`, never global class_name lookup:
## a fresh project that was never opened in the editor has no global class
## cache, and the headless entry must work there.
extends SceneTree

const DirectorPackage := preload("res://addons/director_bridge/director_package.gd")
const DirectorSpace := preload("res://addons/director_bridge/director_space.gd")
const DirectorAnimation := preload("res://addons/director_bridge/director_animation.gd")
const DirectorLights := preload("res://addons/director_bridge/director_lights.gd")
const DirectorMaterials := preload("res://addons/director_bridge/director_materials.gd")
const DirectorSkeleton := preload("res://addons/director_bridge/director_skeleton.gd")

const TRANSFORM_TOLERANCE := 1e-6
const MAX_PARENT_DEPTH := 4_096


func _initialize() -> void:
	var arguments := _parse_arguments(OS.get_cmdline_user_args())
	var mode: String = arguments.get("mode", "")
	var exit_code := 1
	match mode:
		"health":
			exit_code = _run_health()
		"import":
			exit_code = _run_guarded(arguments, _run_import)
		"export":
			exit_code = _run_guarded(arguments, _run_export)
		_:
			push_error("Unknown --mode: %s" % mode)
	quit(exit_code)


func _parse_arguments(raw: PackedStringArray) -> Dictionary:
	var arguments := {}
	var index := 0
	while index < raw.size():
		var token := raw[index]
		if token.begins_with("--") and index + 1 < raw.size():
			arguments[token.trim_prefix("--")] = raw[index + 1]
			index += 2
		else:
			index += 1
	return arguments


func _host_version() -> String:
	var info := Engine.get_version_info()
	return "Godot %s.%s.%s" % [info.major, info.minor, info.patch]


func _run_health() -> int:
	print(
		JSON.stringify(
			{
				"ok": true,
				"provider": DirectorPackage.PROVIDER,
				"hostVersion": _host_version(),
				"connectorVersion": DirectorPackage.CONNECTOR_VERSION,
			}
		)
	)
	return 0


func _run_guarded(arguments: Dictionary, runner: Callable) -> int:
	var report_path: String = arguments.get("report", "")
	if not arguments.has("package") or report_path.is_empty():
		if not report_path.is_empty():
			DirectorPackage.write_failure_report(report_path, "--package and --report are required.")
		push_error("--package and --report are required.")
		return 2
	var errors: Array = []
	var manifest := DirectorPackage.load_exchange_package(arguments["package"], errors)
	if manifest.is_empty():
		DirectorPackage.write_failure_report(report_path, "; ".join(errors))
		return 1
	return runner.call(arguments, manifest)


func _run_import(arguments: Dictionary, manifest: Dictionary) -> int:
	var warnings: Array = []
	var project: Dictionary = manifest["project"]
	var scene: Dictionary = project["scene"]
	var short_id := DirectorPackage.safe_node_name(str(manifest["packageId"]).substr(0, 8))

	var root := Node3D.new()
	root.name = "Director_%s" % short_id
	root.set_meta("director_package_id", manifest["packageId"])
	root.set_meta("director_source_revision", manifest["sourceRevision"])

	var asset_paths := {}
	for asset_entry in manifest.get("assets", []):
		asset_paths[asset_entry["assetRefId"]] = String(arguments["package"]).path_join(
			asset_entry["relativePath"]
		)
	var imported_scenes := {}

	var by_director_id := {}
	var static_worlds := {}
	var object_count := 0
	var skeleton_count := 0
	var applied_material_count := 0
	var payload_animation_players := 0
	for entity in project["objects"]:
		var instanced := [false]
		var node := _instantiate_payload(entity, asset_paths, imported_scenes, warnings, instanced)
		node.name = DirectorPackage.safe_node_name(entity["name"])
		node.set_meta("director_id", entity["id"])
		node.set_meta("director_entity_type", "object")
		var world := DirectorSpace.godot_transform_from_canonical(
			DirectorSpace.compose_world_transform(scene, entity["transform"])
		)
		node.transform = world
		static_worlds[entity["id"]] = world
		if entity.get("visible", true) == false:
			node.visible = false
		root.add_child(node)
		by_director_id[entity["id"]] = node
		object_count += 1
		if instanced[0]:
			payload_animation_players += _count_animation_players(node)
			if DirectorSkeleton.tag_skeleton(node, entity, warnings):
				skeleton_count += 1
			if entity.has("material") and typeof(entity["material"]) == TYPE_DICTIONARY:
				if DirectorMaterials.apply_director_material(
					node, entity["material"], "Object %s" % entity["id"], warnings
				):
					applied_material_count += 1
		elif entity.get("kind", "") == "character":
			DirectorSkeleton.tag_skeleton(node, entity, warnings)

	# Restore the Director parent hierarchy. World transforms were captured
	# before any reparenting, so deep chains and mirrored/negative-scale
	# parents restore exactly: local = parent_world^-1 * child_world.
	var parent_of := {}
	for entity in project["objects"]:
		var parent_id = entity.get("parentObjectId")
		if parent_id != null:
			parent_of[entity["id"]] = parent_id
	for entity in project["objects"]:
		var entity_id: String = entity["id"]
		var parent_id = parent_of.get(entity_id)
		if parent_id == null or not by_director_id.has(parent_id) or not by_director_id.has(entity_id):
			continue
		if _in_parent_cycle(entity_id, parent_of):
			warnings.append(
				"Object %s participates in a parent cycle; it stays under the scene root (warn-and-omit)."
				% entity_id
			)
			continue
		var child: Node3D = by_director_id[entity_id]
		var new_parent: Node3D = by_director_id[parent_id]
		child.get_parent().remove_child(child)
		new_parent.add_child(child)
		child.transform = (
			(static_worlds[parent_id] as Transform3D).affine_inverse()
			* (static_worlds[entity_id] as Transform3D)
		)

	var camera_count := 0
	for camera_entity in project["cameras"]:
		var camera := Camera3D.new()
		camera.name = DirectorPackage.safe_node_name(camera_entity["name"])
		camera.fov = camera_entity["fov"]
		if camera_entity.has("nearClipM"):
			camera.near = maxf(float(camera_entity["nearClipM"]), 0.001)
		if camera_entity.has("farClipM"):
			camera.far = float(camera_entity["farClipM"])
		if str(camera_entity.get("projectionType", "perspective")) == "orthographic":
			camera.projection = Camera3D.PROJECTION_ORTHOGONAL
			if camera_entity.has("orthographicScaleM"):
				camera.size = float(camera_entity["orthographicScaleM"])
		camera.set_meta("director_id", camera_entity["id"])
		camera.set_meta("director_entity_type", "camera")
		var camera_world := DirectorSpace.godot_transform_from_canonical(
			DirectorSpace.compose_world_transform(scene, camera_entity["transform"])
		)
		camera.transform = camera_world
		static_worlds[camera_entity["id"]] = camera_world
		root.add_child(camera)
		by_director_id[camera_entity["id"]] = camera
		camera_count += 1

	var light_receipt := DirectorLights.import_lights(root, scene, project.get("lights", []), warnings)

	# Storyboard shots stay on the scene root as durable metadata; the
	# animation bake additionally maps them to discrete Camera3D.current
	# camera-cut keys (director_shots.gd). Without a pinned bake there is no
	# rational timebase to key against, so the cuts warn-and-omit.
	var storyboard: Dictionary = project.get("storyboard", {})
	if not storyboard.is_empty() and not storyboard.get("shots", []).is_empty():
		root.set_meta("director_shots", storyboard["shots"])
		if not arguments.has("animation"):
			warnings.append(
				"Storyboard shots were preserved as director_shots metadata only: no animation "
				+ "bake was pinned, so no Camera3D.current cut track was keyed (warn-and-omit)."
			)

	# Key the Gateway's hash-pinned animation bake after the hierarchy is
	# final, so track paths and local-space conversion are both correct. An
	# invalid or tampered sidecar fails the job; a missing --animation argument
	# simply means the Gateway had nothing to bake.
	var animation_receipt := {}
	if arguments.has("animation"):
		var bake_errors: Array = []
		var bake := DirectorAnimation.load_bake(
			arguments["animation"],
			arguments.get("animation-sha256", ""),
			manifest["packageId"],
			manifest["sourceRevision"],
			bake_errors
		)
		if bake.is_empty():
			DirectorPackage.write_failure_report(arguments["report"], "; ".join(bake_errors))
			return 1
		animation_receipt = DirectorAnimation.build_animation(
			root, bake, by_director_id, static_worlds, warnings
		)

	var externalized_textures := DirectorMaterials.externalize_textures(root, warnings)

	_set_owner_recursive(root, root)
	var packed := PackedScene.new()
	packed.pack(root)
	DirAccess.make_dir_recursive_absolute("res://director/scenes")
	var scene_path := "res://director/scenes/director_%s.tscn" % short_id
	var save_error := ResourceSaver.save(packed, scene_path)
	if save_error != OK:
		DirectorPackage.write_failure_report(
			arguments["report"], "Saving %s failed with error %d." % [scene_path, save_error]
		)
		return 1

	var return_package_dir = null
	if arguments.has("return-dir"):
		var changes: Array = []
		for director_id in by_director_id:
			var node: Node3D = by_director_id[director_id]
			changes.append(
				{
					"kind": "transform_update",
					"directorId": director_id,
					"entityType": node.get_meta("director_entity_type"),
					"transform": DirectorSpace.canonical_from_godot_transform(
						_world_transform_of(node, root)
					),
				}
			)
		DirectorPackage.write_return_package(
			arguments["return-dir"],
			_host_version(),
			manifest["packageId"],
			manifest["sourceRevision"],
			changes,
			[
				"Echo return package written immediately after import; edit the scene and re-export to send changes.",
			]
		)
		return_package_dir = String(arguments["return-dir"]).get_file()
		if return_package_dir.is_empty():
			return_package_dir = "return"

	var transform_track_count := int(animation_receipt.get("transformTrackCount", 0))
	var shot_cut_track_count := int(animation_receipt.get("shotCutTrackCount", 0))
	var has_player := transform_track_count > 0 or shot_cut_track_count > 0
	var godot_receipt := {
		"animationPlayerPath": scene_path if has_player else null,
		"animationLibrary": animation_receipt.get("animationLibrary"),
		"displayRate": animation_receipt.get("displayRate"),
		"bakedKeyCount": int(animation_receipt.get("bakedKeyCount", 0)),
		"transformTrackCount": transform_track_count,
		"fovTrackCount": int(animation_receipt.get("fovTrackCount", 0)),
		"shotCutTrackCount": shot_cut_track_count,
		"mappedShotCount": int(animation_receipt.get("mappedShotCount", 0)),
		"payloadAnimationPlayerCount": payload_animation_players,
		"importedSkeletonCount": skeleton_count,
		"importedLightCount": int(light_receipt["importedLightCount"]),
		"worldEnvironmentAmbient": bool(light_receipt["worldEnvironmentAmbient"]),
		"omittedLightCount": int(light_receipt["omittedLightCount"]),
		"omittedLights": light_receipt.get("omittedLights", []),
		"appliedMaterialCount": applied_material_count,
		"externalizedTextureCount": externalized_textures,
	}
	DirectorPackage.write_report(
		arguments["report"],
		_host_version(),
		manifest["packageId"],
		manifest["sourceRevision"],
		object_count,
		camera_count,
		scene_path,
		return_package_dir,
		warnings,
		{"godot": godot_receipt}
	)
	return 0


func _run_export(arguments: Dictionary, manifest: Dictionary) -> int:
	var warnings: Array = []
	if not arguments.has("return-dir"):
		DirectorPackage.write_failure_report(arguments["report"], "--return-dir is required for export.")
		return 2
	var project: Dictionary = manifest["project"]
	var scene: Dictionary = project["scene"]
	var short_id := DirectorPackage.safe_node_name(str(manifest["packageId"]).substr(0, 8))
	var scene_path := "res://director/scenes/director_%s.tscn" % short_id
	if not FileAccess.file_exists(scene_path):
		DirectorPackage.write_failure_report(
			arguments["report"],
			"Director scene %s was not found; run the import first." % scene_path
		)
		return 1
	var packed: PackedScene = ResourceLoader.load(scene_path)
	var root: Node3D = packed.instantiate()

	var baselines := {}
	for entity in project["objects"]:
		baselines[entity["id"]] = ["object", DirectorSpace.compose_world_transform(scene, entity["transform"])]
	for camera_entity in project["cameras"]:
		baselines[camera_entity["id"]] = [
			"camera", DirectorSpace.compose_world_transform(scene, camera_entity["transform"])
		]

	DirectorMaterials.warn_on_custom_shaders(root, warnings)

	var changes: Array = []
	var seen := 0
	for node in _collect_tagged(root):
		# Skeleton and light nodes carry director metadata for identification,
		# but the return contract transports object/camera transforms only.
		var entity_type := str(node.get_meta("director_entity_type", "object"))
		if entity_type != "object" and entity_type != "camera":
			continue
		seen += 1
		var director_id: String = node.get_meta("director_id")
		if not baselines.has(director_id):
			warnings.append("Node %s carries unknown director_id %s; skipped." % [node.name, director_id])
			continue
		var world := _world_transform_of(node, root)
		var canonical := DirectorSpace.canonical_from_godot_transform(world)
		var baseline: Array = baselines[director_id]
		if _moved(world, baseline[1]):
			changes.append(
				{
					"kind": "transform_update",
					"directorId": director_id,
					"entityType": baseline[0],
					"transform": canonical,
				}
			)
	if seen == 0:
		warnings.append("No director_id-tagged nodes were found in %s." % scene_path)
	root.free()

	DirectorPackage.write_return_package(
		arguments["return-dir"],
		_host_version(),
		manifest["packageId"],
		manifest["sourceRevision"],
		changes,
		warnings
	)
	DirectorPackage.write_report(
		arguments["report"],
		_host_version(),
		manifest["packageId"],
		manifest["sourceRevision"],
		0,
		0,
		null,
		String(arguments["return-dir"]).get_file(),
		warnings
	)
	return 0


func _instantiate_payload(
	entity: Dictionary,
	asset_paths: Dictionary,
	imported_scenes: Dictionary,
	warnings: Array,
	instanced: Array
) -> Node3D:
	var asset_ref = entity.get("assetRefId")
	if asset_ref == null or not asset_paths.has(asset_ref):
		if asset_ref != null:
			warnings.append(
				"Object %s references asset %s without a GLB payload; created an empty node (warn-and-omit)."
				% [entity["id"], asset_ref]
			)
		return Node3D.new()
	var source: String = asset_paths[asset_ref]
	if not source.to_lower().ends_with(".glb"):
		warnings.append(
			"Object %s asset %s is not GLB; created an empty node (warn-and-omit)."
			% [entity["id"], asset_ref]
		)
		return Node3D.new()
	if not imported_scenes.has(asset_ref):
		var document := GLTFDocument.new()
		var state := GLTFState.new()
		var load_error := document.append_from_file(source, state)
		if load_error != OK:
			warnings.append(
				"GLB payload for asset %s failed to load (error %d); created an empty node."
				% [asset_ref, load_error]
			)
			imported_scenes[asset_ref] = null
		else:
			imported_scenes[asset_ref] = document.generate_scene(state)
	var template = imported_scenes[asset_ref]
	if template == null:
		return Node3D.new()
	var instance: Node3D = template.duplicate()
	instanced[0] = true
	return instance


func _count_animation_players(root: Node) -> int:
	var count := 0
	var queue: Array = [root]
	while not queue.is_empty():
		var node: Node = queue.pop_front()
		if node is AnimationPlayer:
			count += 1
		for child in node.get_children():
			queue.append(child)
	return count


func _in_parent_cycle(start_id: String, parent_of: Dictionary) -> bool:
	var current = parent_of.get(start_id)
	var depth := 0
	while current != null and depth < MAX_PARENT_DEPTH:
		if current == start_id:
			return true
		current = parent_of.get(current)
		depth += 1
	return depth >= MAX_PARENT_DEPTH


func _collect_tagged(root: Node) -> Array:
	var found: Array = []
	var queue: Array = [root]
	while not queue.is_empty():
		var node: Node = queue.pop_front()
		if node is Node3D and node.has_meta("director_id"):
			found.append(node)
		for child in node.get_children():
			queue.append(child)
	return found


func _world_transform_of(node: Node3D, root: Node) -> Transform3D:
	var world := node.transform
	var current := node.get_parent()
	while current != null and current != root and current is Node3D:
		world = (current as Node3D).transform * world
		current = current.get_parent()
	return world


## Matrix-level drift check. Mirrored (negative-determinant) transforms
## decompose ambiguously — Godot spreads the determinant sign across the scale
## axes differently from a direct TRS composition — so drift is measured on the
## composed Transform3D, never on decomposed location/quaternion/scale parts.
func _moved(world: Transform3D, baseline_canonical: Dictionary) -> bool:
	var baseline := DirectorSpace.godot_transform_from_canonical(baseline_canonical)
	for column in range(3):
		for row in range(3):
			if absf(world.basis[column][row] - baseline.basis[column][row]) > TRANSFORM_TOLERANCE:
				return true
	for axis in range(3):
		if absf(world.origin[axis] - baseline.origin[axis]) > TRANSFORM_TOLERANCE:
			return true
	return false


func _set_owner_recursive(node: Node, owner: Node) -> void:
	for child in node.get_children():
		child.owner = owner
		_set_owner_recursive(child, owner)
