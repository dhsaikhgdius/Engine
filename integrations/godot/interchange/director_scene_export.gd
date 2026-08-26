## Director scene exporter for Godot 4.
##
## Exports the project's main scene (or an explicitly requested scene) into a
## portable ``director-engine-scene-v1`` package that Director's gateway can
## validate, plan, and import. The package contains:
##
## - ``manifest.json`` — scene metadata, hierarchy snapshot, cameras, lights,
##   animation clip inventory, warnings, and SHA-256 hashes for every file.
## - ``assets/scene.glb`` — renderable scene geometry exported through
##   Godot's built-in GLTFDocument. Materials, skinned meshes, and animation
##   data ride embedded inside this GLB.
##
## Godot 4 already authors in Director's convention (right-handed, Y-up,
## -Z forward, metres), so every manifest transform uses the documented
## identity map ``(x,y,z)->(x,y,z)``; rotations are intrinsic XYZ Euler
## radians extracted in that shared basis.
##
## Run headless (Director's gateway does this for ``extract_engine_scene``;
## it copies this file into ``res://addons/director_interchange/`` first):
##
##     godot --headless --path <project> \
##         --script res://addons/director_interchange/director_scene_export.gd -- \
##         --output-dir /abs/out [--scene res://scenes/main.tscn] [--zip]
##
## The optional ``--zip`` flag additionally writes
## ``director-engine-scene.zip`` next to the output directory, ready to upload
## to ``POST /api/dcc/engine-scene/uploads?provider=godot``.
##
## This script is standalone by design: it never depends on the
## ``director_bridge`` addon, so any valid Godot 4 project can export a scene
## package without installing the connector. The scene is instantiated but
## never added to the tree, so game ``_ready`` code does not run.
extends SceneTree

const EXPORTER_NAME := "director-godot-scene-export"
const EXPORTER_VERSION := "1.0.0"
const CONTRACT := "director-engine-scene-v1"
const MAX_NODES := 20_000
const MAX_CAMERAS := 512
const MAX_LIGHTS := 1_024
const MAX_CLIPS := 512
const MAX_UNSUPPORTED := 20_000
const MAX_WARNINGS := 20_000
const DEFAULT_LOOK_DISTANCE := 10.0


func _initialize() -> void:
	var arguments := _parse_arguments(OS.get_cmdline_user_args())
	var output_dir: String = arguments.get("output-dir", "")
	if output_dir.is_empty() or not output_dir.is_absolute_path():
		push_error("[director] --output-dir is required and must be an absolute path.")
		quit(2)
		return
	var exit_code := _export_scene(
		output_dir, arguments.get("scene", ""), arguments.has("zip")
	)
	quit(exit_code)


func _parse_arguments(raw: PackedStringArray) -> Dictionary:
	var arguments := {}
	var index := 0
	while index < raw.size():
		var token := raw[index]
		if token == "--zip":
			arguments["zip"] = "true"
			index += 1
		elif token.begins_with("--") and index + 1 < raw.size():
			arguments[token.trim_prefix("--")] = raw[index + 1]
			index += 2
		else:
			index += 1
	return arguments


func _export_scene(output_dir: String, scene_argument: String, make_zip: bool) -> int:
	var scene_path := scene_argument
	if scene_path.is_empty():
		scene_path = str(ProjectSettings.get_setting("application/run/main_scene", ""))
	if scene_path.is_empty():
		push_error(
			"[director] No scene was requested and the project declares no main scene; "
			+ "pass --scene res://path/to/scene.tscn."
		)
		return 1
	if not scene_path.begins_with("res://"):
		scene_path = "res://" + scene_path
	var packed = ResourceLoader.load(scene_path)
	if packed == null or not (packed is PackedScene):
		push_error("[director] %s did not load as a PackedScene." % scene_path)
		return 1
	var root: Node = (packed as PackedScene).instantiate()
	if root == null:
		push_error("[director] %s could not be instantiated." % scene_path)
		return 1

	var warnings: Array = []
	var unsupported: Array = []
	var nodes: Array = []
	var cameras: Array = []
	var lights: Array = []
	var clips: Array = []
	var seen_clip_names := {}
	var materials := {}
	var total_nodes := 0
	var mesh_count := 0
	var skinned_count := 0
	var truncated := false

	var queue: Array = [root]
	while not queue.is_empty():
		var node: Node = queue.pop_front()
		total_nodes += 1
		for child in node.get_children():
			queue.append(child)
		if node is AnimationPlayer:
			_collect_animation_clips(node, clips, seen_clip_names)
		if not (node is Node3D):
			if (node is CanvasItem) and unsupported.size() < MAX_UNSUPPORTED:
				unsupported.append(
					{
						"kind": "canvas-item",
						"name": _safe_name(str(node.name), "Node"),
						"reason": "2D and UI nodes are outside the 3D engine scene contract.",
					}
				)
			continue
		var kind := _classify_node(node)
		if kind == "camera" and cameras.size() < MAX_CAMERAS:
			var camera_record := _camera_record(node as Camera3D, root, warnings, unsupported)
			if not camera_record.is_empty():
				cameras.append(camera_record)
		elif kind == "light" and lights.size() < MAX_LIGHTS:
			lights.append(_light_record(node as Light3D, root, warnings))
		elif kind == "mesh":
			mesh_count += 1
		elif kind == "skinned-mesh":
			skinned_count += 1
		if node is MeshInstance3D:
			_collect_materials(node as MeshInstance3D, materials)
		if node is WorldEnvironment and lights.size() < MAX_LIGHTS:
			var ambient := _ambient_record(node as WorldEnvironment, root, warnings)
			if not ambient.is_empty():
				lights.append(ambient)
		if nodes.size() < MAX_NODES:
			var record := {
				"sourceId": _source_id(node, root),
				"name": _safe_name(str(node.name), "Node"),
				"kind": kind,
				"transform": _transform_record(node as Node3D, root),
			}
			var parent := node.get_parent()
			if parent != null and parent is Node3D:
				record["parentSourceId"] = _source_id(parent, root)
			nodes.append(record)
		else:
			truncated = true
	if truncated:
		warnings.append(
			"Hierarchy snapshot was truncated to %d nodes; the GLB bundle keeps the full scene."
			% MAX_NODES
		)
	var node_ids := {}
	for record in nodes:
		node_ids[record["sourceId"]] = true
	for record in nodes:
		if record.has("parentSourceId") and not node_ids.has(record["parentSourceId"]):
			record.erase("parentSourceId")

	DirAccess.make_dir_recursive_absolute(output_dir)
	DirAccess.make_dir_recursive_absolute(output_dir.path_join("assets"))
	var bundle_relative := "assets/scene.glb"
	var bundle_path := output_dir.path_join("assets").path_join("scene.glb")
	var bundle_written := _export_glb(
		root, bundle_path, warnings, unsupported, mesh_count + skinned_count
	)
	if not bundle_written and (mesh_count > 0 or skinned_count > 0):
		for record in nodes:
			if record["kind"] == "mesh" or record["kind"] == "skinned-mesh":
				if unsupported.size() < MAX_UNSUPPORTED:
					unsupported.append(
						{
							"kind": record["kind"],
							"name": record["name"],
							"reason": "Geometry was not exported because the GLB bundle is unavailable.",
						}
					)
		mesh_count = 0
		skinned_count = 0
	if not clips.is_empty():
		warnings.append(
			"Animation clips are inventoried by name; skinned animation data rides inside "
			+ "the GLB bundle when GLTFDocument exports it."
		)

	var file_hashes := {}
	if bundle_written:
		file_hashes[bundle_relative] = FileAccess.get_sha256(bundle_path)

	var scene_name := _safe_name(scene_path.get_file().get_basename(), "Scene")
	var project_name := _safe_name(
		str(ProjectSettings.get_setting("application/config/name", "")), "GodotProject"
	)
	var package_id := "godot-scene-%s" % (project_name + ":" + scene_name).sha256_text().substr(0, 20)
	var version_info := Engine.get_version_info()

	var manifest := {
		"schemaVersion": 1,
		"contract": CONTRACT,
		"packageId": package_id,
		"provider": "godot",
		"exportedAt": Time.get_datetime_string_from_system(true) + "Z",
		"engineVersion": "Godot %s.%s.%s" % [
			version_info.major, version_info.minor, version_info.patch
		],
		"exporter": {"name": EXPORTER_NAME, "version": EXPORTER_VERSION},
		"source": {"projectName": project_name, "sceneName": scene_name},
		"coordinateSystem": {
			"source": "right-handed-y-up-negative-z-forward-meter",
			"destination": "right-handed-y-up-negative-z-forward",
			"unit": "meter",
			"linearMap": "(x,y,z)->(x,y,z)",
		},
		"timeline": {"frameStart": 0, "frameEnd": 0, "currentFrame": 0, "fps": 30},
		"scene": {
			"name": scene_name,
			"bundleFile": bundle_relative if bundle_written else null,
			"nodeCount": maxi(total_nodes, nodes.size()),
			"meshCount": mesh_count,
			"skinnedMeshCount": skinned_count,
			"materialCount": materials.size(),
			"animationClipCount": clips.size(),
		},
		"nodes": nodes,
		"cameras": cameras,
		"lights": lights,
		"animationClips": clips,
		"unsupported": unsupported.slice(0, MAX_UNSUPPORTED),
		"warnings": warnings.slice(0, MAX_WARNINGS),
		"fileHashes": file_hashes,
	}

	root.free()

	var manifest_path := output_dir.path_join("manifest.json")
	var manifest_file := FileAccess.open(manifest_path, FileAccess.WRITE)
	if manifest_file == null:
		push_error("[director] Could not open %s for writing." % manifest_path)
		return 1
	manifest_file.store_string(JSON.stringify(manifest, "  ", false))
	manifest_file.close()
	print("[director] Wrote %s" % manifest_path)

	if make_zip:
		var zip_path := output_dir.get_base_dir().path_join("director-engine-scene.zip")
		var zip_error := _write_zip(output_dir, zip_path)
		if zip_error != OK:
			push_error("[director] Writing %s failed with error %d." % [zip_path, zip_error])
			return 1
		print("[director] Wrote %s" % zip_path)
	return 0


## Godot's basis matches Director's, so world transforms convert identically;
## rotation is the intrinsic XYZ Euler extraction both other exporters use.
## Transform inheritance intentionally stops at non-Node3D ancestors, matching
## how Godot itself roots Node3D branches under plain nodes.
func _world_transform_of(node: Node3D, root: Node) -> Transform3D:
	var world := node.transform
	var current := node.get_parent()
	while current != null and current != root and current is Node3D:
		world = (current as Node3D).transform * world
		current = current.get_parent()
	return world


func _transform_record(node: Node3D, root: Node) -> Dictionary:
	var world := _world_transform_of(node, root)
	var euler := world.basis.orthonormalized().get_euler(EULER_ORDER_XYZ)
	var scale := world.basis.get_scale()
	return {
		"position": [world.origin.x, world.origin.y, world.origin.z],
		"rotation": [euler.x, euler.y, euler.z],
		"scale": [scale.x, scale.y, scale.z],
	}


func _classify_node(node: Node) -> String:
	if node is Camera3D:
		return "camera"
	if node is Light3D:
		return "light"
	if node is MeshInstance3D:
		var mesh_instance := node as MeshInstance3D
		var skeleton = mesh_instance.get_node_or_null(mesh_instance.skeleton)
		if mesh_instance.skin != null or skeleton is Skeleton3D:
			return "skinned-mesh"
		return "mesh"
	if node.get_child_count() > 0:
		return "group"
	return "other"


## Scene-tree paths are unique among siblings by the scene format, so the
## path from the exported root is a stable source id across exports.
func _source_id(node: Node, root: Node) -> String:
	if node == root:
		return _safe_name(str(root.name), "Node").substr(0, 240)
	return str(root.get_path_to(node)).substr(0, 240)


func _camera_record(
	camera: Camera3D, root: Node, warnings: Array, unsupported: Array
) -> Dictionary:
	var name := _safe_name(str(camera.name), "Camera")
	if camera.projection != Camera3D.PROJECTION_PERSPECTIVE:
		if unsupported.size() < MAX_UNSUPPORTED:
			unsupported.append(
				{
					"kind": "camera",
					"name": name,
					"reason": "Orthographic and frustum cameras do not map to Director's perspective camera model.",
				}
			)
		return {}
	var world := _world_transform_of(camera, root)
	var basis := world.basis.orthonormalized()
	var forward := -basis.z
	var aspect := _project_aspect_ratio()
	var vertical_fov := clampf(camera.fov, 0.1, 179.0)
	if camera.keep_aspect == Camera3D.KEEP_WIDTH:
		vertical_fov = clampf(
			rad_to_deg(2.0 * atan(tan(deg_to_rad(camera.fov) / 2.0) / maxf(aspect, 0.0001))),
			0.1,
			179.0
		)
	var record := {
		"sourceId": _source_id(camera, root),
		"name": name,
	}
	var focus_distance := 0.0
	if camera.attributes != null and camera.attributes is CameraAttributesPhysical:
		var physical := camera.attributes as CameraAttributesPhysical
		record["apertureFStop"] = clampf(physical.exposure_aperture, 0.1, 256.0)
		if physical.frustum_focus_distance > 0.01:
			focus_distance = physical.frustum_focus_distance
			record["focusDistanceM"] = clampf(focus_distance, 0.01, 1_000_000.0)
	else:
		warnings.append(
			"Camera %s carries no physical camera attributes; sensor and aperture use Director defaults."
			% name
		)
	var look_distance := focus_distance if focus_distance > 0.01 else DEFAULT_LOOK_DISTANCE
	var position := world.origin
	record["position"] = [position.x, position.y, position.z]
	record["lookTarget"] = [
		position.x + forward.x * look_distance,
		position.y + forward.y * look_distance,
		position.z + forward.z * look_distance,
	]
	record["verticalFovDegrees"] = vertical_fov
	record["nearClipM"] = clampf(camera.near, 0.0001, 100_000.0)
	record["farClipM"] = clampf(maxf(camera.far, camera.near * 2.0), 0.001, 10_000_000.0)
	record["renderAspectRatio"] = clampf(aspect, 0.1, 20.0)
	return record


func _project_aspect_ratio() -> float:
	var width := float(ProjectSettings.get_setting("display/window/size/viewport_width", 1152))
	var height := float(ProjectSettings.get_setting("display/window/size/viewport_height", 648))
	if width <= 0.0 or height <= 0.0:
		return 16.0 / 9.0
	return width / height


func _light_record(light: Light3D, root: Node, warnings: Array) -> Dictionary:
	var name := _safe_name(str(light.name), "Light")
	var world := _world_transform_of(light, root)
	var position := world.origin
	var forward := -world.basis.orthonormalized().z
	var target := [
		position.x + forward.x * DEFAULT_LOOK_DISTANCE,
		position.y + forward.y * DEFAULT_LOOK_DISTANCE,
		position.z + forward.z * DEFAULT_LOOK_DISTANCE,
	]
	var record := {
		"sourceId": _source_id(light, root),
		"name": name,
		"color": "#" + light.light_color.to_html(false),
		# Godot's unitless light_energy (~1.0 for a typical light) maps directly
		# onto Director's unitless scale, clamped to the manifest range.
		"intensity": clampf(light.light_energy, 0.0, 100.0),
		"castShadow": light.shadow_enabled,
		"position": [position.x, position.y, position.z],
	}
	if light is DirectionalLight3D:
		record["type"] = "directional"
		record["target"] = target
		return record
	if light is SpotLight3D:
		var spot := light as SpotLight3D
		record["type"] = "spot"
		record["target"] = target
		# Godot's spot_angle is the half-aperture from the axis; Director's
		# angleDegrees is the full cone angle.
		record["angleDegrees"] = clampf(spot.spot_angle * 2.0, 0.1, 179.0)
		if spot.spot_range > 0.0:
			record["rangeM"] = clampf(spot.spot_range, 0.001, 1_000_000.0)
		warnings.append(
			"Spot light %s: Godot's angular attenuation curve has no Director penumbra equivalent; the cone edge uses Director defaults."
			% name
		)
		return record
	record["type"] = "point"
	if light is OmniLight3D:
		var omni := light as OmniLight3D
		if omni.omni_range > 0.0:
			record["rangeM"] = clampf(omni.omni_range, 0.001, 1_000_000.0)
	return record


func _ambient_record(environment_node: WorldEnvironment, root: Node, warnings: Array) -> Dictionary:
	var environment := environment_node.environment
	if environment == null:
		return {}
	if environment.ambient_light_source == Environment.AMBIENT_SOURCE_COLOR:
		warnings.append("Flat ambient environment lighting was mapped to a Director ambient light.")
		return {
			"sourceId": _source_id(environment_node, root),
			"name": _safe_name(str(environment_node.name), "Environment Ambient"),
			"type": "ambient",
			"color": "#" + environment.ambient_light_color.to_html(false),
			"intensity": clampf(environment.ambient_light_energy, 0.0, 100.0),
		}
	warnings.append(
		"Ambient light source %d (background/sky) is not mapped to a Director light."
		% environment.ambient_light_source
	)
	return {}


func _collect_materials(mesh_instance: MeshInstance3D, materials: Dictionary) -> void:
	if mesh_instance.mesh == null:
		return
	for surface in range(mesh_instance.mesh.get_surface_count()):
		var material := mesh_instance.get_active_material(surface)
		if material != null:
			materials[material.get_instance_id()] = true


func _collect_animation_clips(player: AnimationPlayer, clips: Array, seen: Dictionary) -> void:
	for clip_name in player.get_animation_list():
		if clips.size() >= MAX_CLIPS:
			return
		var safe_clip_name := _safe_name(str(clip_name), "Clip")
		if seen.has(safe_clip_name):
			continue
		seen[safe_clip_name] = true
		var animation := player.get_animation(clip_name)
		var clip := {"name": safe_clip_name}
		if animation != null:
			clip["durationSeconds"] = clampf(animation.length, 0.0, 1_000_000.0)
		clips.append(clip)


func _export_glb(
	root: Node, bundle_path: String, warnings: Array, unsupported: Array, renderable_count: int
) -> bool:
	if renderable_count == 0:
		return false
	var document := GLTFDocument.new()
	var state := GLTFState.new()
	var append_error := document.append_from_scene(root, state)
	if append_error != OK:
		unsupported.append(
			{
				"kind": "geometry",
				"name": "scene",
				"reason": "GLTFDocument.append_from_scene failed with error %d; geometry was skipped." % append_error,
			}
		)
		return false
	var write_error := document.write_to_filesystem(state, bundle_path)
	if write_error != OK:
		unsupported.append(
			{
				"kind": "geometry",
				"name": "scene",
				"reason": "GLTFDocument.write_to_filesystem failed with error %d; geometry was skipped." % write_error,
			}
		)
		return false
	warnings.append(
		"Scene geometry, materials, skinned meshes, and animation data are embedded in "
		+ "assets/scene.glb by GLTFDocument."
	)
	return true


func _write_zip(source_dir: String, zip_path: String) -> Error:
	var packer := ZIPPacker.new()
	var open_error := packer.open(zip_path, ZIPPacker.APPEND_CREATE)
	if open_error != OK:
		return open_error
	var zip_error := _zip_directory(packer, source_dir, "")
	packer.close()
	return zip_error


func _zip_directory(packer: ZIPPacker, directory: String, prefix: String) -> Error:
	var access := DirAccess.open(directory)
	if access == null:
		return ERR_CANT_OPEN
	for file_name in access.get_files():
		var entry := prefix + file_name
		var bytes := FileAccess.get_file_as_bytes(directory.path_join(file_name))
		var start_error := packer.start_file(entry)
		if start_error != OK:
			return start_error
		packer.write_file(bytes)
		packer.close_file()
	for child in access.get_directories():
		var child_error := _zip_directory(
			packer, directory.path_join(child), prefix + child + "/"
		)
		if child_error != OK:
			return child_error
	return OK


func _safe_name(value: String, fallback: String) -> String:
	var trimmed := value.strip_edges()
	if trimmed.is_empty():
		return fallback
	return trimmed.substr(0, 240)
