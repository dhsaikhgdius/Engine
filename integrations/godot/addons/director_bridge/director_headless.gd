## Fixed headless entry point for the Director Godot connector.
##
## Invoked by the Director Gateway (never with a request-supplied script) as:
##
##     godot --headless --path <project> \
##         --script res://addons/director_bridge/director_headless.gd -- \
##         --mode import --package <dir> --report <report.json> --return-dir <dir>
##
## Modes:
## - health   print a JSON health line with the engine and connector version.
## - import   import a Director exchange package into a saved scene under
##            res://director/scenes/ with stable director_id metadata, then
##            echo a canonical-space return package.
## - export   export a director-dcc-return-v1 package with the canonical
##            transforms of every director_id-tagged node that moved relative
##            to the exchange package baseline.
##
## Godot 4's basis (right-handed, Y-up, metres, -Z forward) matches Director's
## canonical space, so the provider-boundary conversion is the identity; it
## still runs through DirectorSpace so the boundary stays explicit.
extends SceneTree

const TRANSFORM_TOLERANCE := 1e-6


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
	var short_id := _safe_name(str(manifest["packageId"]).substr(0, 8))

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
	var object_count := 0
	for entity in project["objects"]:
		var node := _instantiate_payload(entity, asset_paths, imported_scenes, warnings)
		node.name = _safe_name(entity["name"])
		node.set_meta("director_id", entity["id"])
		node.set_meta("director_entity_type", "object")
		node.transform = DirectorSpace.godot_transform_from_canonical(
			DirectorSpace.compose_world_transform(scene, entity["transform"])
		)
		if entity.get("visible", true) == false:
			node.visible = false
		root.add_child(node)
		by_director_id[entity["id"]] = node
		object_count += 1

	# Restore the Director parent hierarchy while keeping world transforms.
	for entity in project["objects"]:
		var parent_id = entity.get("parentObjectId")
		if parent_id != null and by_director_id.has(parent_id) and by_director_id.has(entity["id"]):
			var child: Node3D = by_director_id[entity["id"]]
			var world := child.global_transform if child.is_inside_tree() else child.transform
			child.get_parent().remove_child(child)
			by_director_id[parent_id].add_child(child)
			child.transform = (
				by_director_id[parent_id].global_transform.affine_inverse() * world
				if by_director_id[parent_id].is_inside_tree()
				else by_director_id[parent_id].transform.affine_inverse() * world
			)

	var camera_count := 0
	for camera_entity in project["cameras"]:
		var camera := Camera3D.new()
		camera.name = _safe_name(camera_entity["name"])
		camera.fov = camera_entity["fov"]
		camera.set_meta("director_id", camera_entity["id"])
		camera.set_meta("director_entity_type", "camera")
		camera.transform = DirectorSpace.godot_transform_from_canonical(
			DirectorSpace.compose_world_transform(scene, camera_entity["transform"])
		)
		root.add_child(camera)
		by_director_id[camera_entity["id"]] = camera
		camera_count += 1

	var storyboard: Dictionary = project.get("storyboard", {})
	if not storyboard.is_empty() and not storyboard.get("shots", []).is_empty():
		root.set_meta("director_shots", storyboard["shots"])
		warnings.append(
			"Godot has no built-in shot timeline; storyboard shots were preserved as "
			+ "director_shots metadata on the scene root."
		)

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
					"transform": DirectorSpace.canonical_from_godot_transform(node.transform),
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

	DirectorPackage.write_report(
		arguments["report"],
		_host_version(),
		manifest["packageId"],
		manifest["sourceRevision"],
		object_count,
		camera_count,
		scene_path,
		return_package_dir,
		warnings
	)
	return 0


func _run_export(arguments: Dictionary, manifest: Dictionary) -> int:
	var warnings: Array = []
	if not arguments.has("return-dir"):
		DirectorPackage.write_failure_report(arguments["report"], "--return-dir is required for export.")
		return 2
	var project: Dictionary = manifest["project"]
	var scene: Dictionary = project["scene"]
	var short_id := _safe_name(str(manifest["packageId"]).substr(0, 8))
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

	var changes: Array = []
	var seen := 0
	for node in _collect_tagged(root):
		seen += 1
		var director_id: String = node.get_meta("director_id")
		if not baselines.has(director_id):
			warnings.append("Node %s carries unknown director_id %s; skipped." % [node.name, director_id])
			continue
		var world := _world_transform_of(node, root)
		var canonical := DirectorSpace.canonical_from_godot_transform(world)
		var baseline: Array = baselines[director_id]
		if _moved(canonical, baseline[1]):
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
	entity: Dictionary, asset_paths: Dictionary, imported_scenes: Dictionary, warnings: Array
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
	return instance


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


func _moved(canonical: Dictionary, baseline: Dictionary) -> bool:
	for index in range(3):
		if absf(canonical["location"][index] - baseline["location"][index]) > TRANSFORM_TOLERANCE:
			return true
		if absf(canonical["scale"][index] - baseline["scale"][index]) > TRANSFORM_TOLERANCE:
			return true
	var dot := 0.0
	for index in range(4):
		dot += canonical["rotationQuaternion"][index] * baseline["rotationQuaternion"][index]
	return absf(absf(dot) - 1.0) > TRANSFORM_TOLERANCE


func _set_owner_recursive(node: Node, owner: Node) -> void:
	for child in node.get_children():
		child.owner = owner
		_set_owner_recursive(child, owner)


func _safe_name(value: String) -> String:
	var cleaned := ""
	for character in value:
		if character.is_valid_identifier() or character == "-" or character == ".":
			cleaned += character
		else:
			cleaned += "_"
	return cleaned.substr(0, 96) if not cleaned.is_empty() else "director_node"
