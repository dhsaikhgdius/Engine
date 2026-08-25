## Animation keying for the Director Godot connector.
##
## The Gateway bakes Director timeline animation (easing curves, trajectories,
## camera path/follow actions) into a hash-pinned
## director-godot-animation-bake-v1 sidecar of canonical-space world-transform
## samples. This module verifies the sidecar hash and identity, converts each
## world sample into the owning node's local space (respecting the restored
## Director parent hierarchy), and keys position/rotation/scale tracks plus
## camera `fov` value tracks into an AnimationPlayer/AnimationLibrary on the
## scene root. Storyboard shot ranges carried by the bake become discrete
## `Camera3D.current` camera-cut keys in the same timeline animation (see
## director_shots.gd). Key times come from the rational timebase
## (`seconds = frame * denominator / numerator`), never from a pre-rounded
## fps float.
##
## No class_name: headless `godot --script` runs on a fresh project have no
## global class cache, so every module is referenced through `preload`.

const DirectorSpace := preload("res://addons/director_bridge/director_space.gd")
const DirectorShots := preload("res://addons/director_bridge/director_shots.gd")

const BAKE_CONTRACT := "director-godot-animation-bake-v1"
const PLAYER_NAME := "DirectorAnimationPlayer"
const LIBRARY_NAME := "director"
const ANIMATION_NAME := "timeline"


## Loads and verifies the animation bake sidecar. The SHA-256 of the file on
## disk must match the hash the Gateway pinned through the fixed argument
## array, and the bake identity must match the exchange package being
## imported. Returns {} on failure with reasons in `errors`.
static func load_bake(
	path: String,
	expected_sha256: String,
	package_id: String,
	source_revision: String,
	errors: Array
) -> Dictionary:
	if not FileAccess.file_exists(path):
		errors.append("Animation bake file is missing: %s" % path)
		return {}
	if expected_sha256.is_empty():
		errors.append("--animation requires --animation-sha256; refusing an unpinned bake sidecar.")
		return {}
	var actual := FileAccess.get_sha256(path)
	if actual != expected_sha256:
		errors.append(
			"Animation bake SHA-256 mismatch: expected %s, found %s." % [expected_sha256, actual]
		)
		return {}
	var parsed = JSON.parse_string(FileAccess.get_file_as_string(path))
	if typeof(parsed) != TYPE_DICTIONARY:
		errors.append("Animation bake is not a JSON object.")
		return {}
	var bake: Dictionary = parsed
	if bake.get("contract") != BAKE_CONTRACT:
		errors.append("Unexpected animation bake contract: %s" % str(bake.get("contract")))
		return {}
	if bake.get("provider") != "godot":
		errors.append("Animation bake targets provider %s, expected godot." % str(bake.get("provider")))
		return {}
	if bake.get("packageId") != package_id:
		errors.append("Animation bake belongs to package %s, not %s." % [str(bake.get("packageId")), package_id])
		return {}
	if bake.get("sourceRevision") != source_revision:
		errors.append("Animation bake references a different source revision.")
		return {}
	return bake


## Keys the verified bake into an AnimationPlayer under `root` and returns the
## import receipt counts. `by_director_id` maps director ids to their scene
## nodes; `static_worlds` maps every imported director id to its import-time
## world transform so samples on child entities convert into the local space
## of animated or static parents alike.
static func build_animation(
	root: Node3D,
	bake: Dictionary,
	by_director_id: Dictionary,
	static_worlds: Dictionary,
	warnings: Array
) -> Dictionary:
	var receipt := {
		"animationLibrary": null,
		"displayRate": null,
		"bakedKeyCount": 0,
		"transformTrackCount": 0,
		"fovTrackCount": 0,
		"shotCutTrackCount": 0,
		"mappedShotCount": 0,
	}
	for bake_warning in bake.get("warnings", []):
		warnings.append("animation bake: %s" % bake_warning)

	var entities: Array = bake.get("entities", [])
	var shots: Array = bake.get("shots", [])
	if entities.is_empty() and shots.is_empty():
		return receipt

	var rate: Dictionary = bake["timebase"]["rate"]
	var numerator := int(rate["numerator"])
	var denominator := int(rate["denominator"])
	var frame_start := int(bake["playback"]["frameStart"])
	var frame_end := int(bake["playback"]["frameEnd"])

	# Per-entity world transforms keyed by frame, for parent-space conversion.
	var world_samples := {}
	for entity in entities:
		var frames := {}
		for sample in entity["transformSamples"]:
			frames[int(sample["frame"])] = DirectorSpace.godot_transform_from_canonical(sample["transform"])
		world_samples[entity["directorId"]] = frames

	var animation := Animation.new()
	animation.length = maxf(_frame_time(frame_end, frame_start, numerator, denominator), 0.001)
	animation.step = float(denominator) / float(numerator)

	var baked_keys := 0
	var transform_tracks := 0
	var fov_tracks := 0

	for entity in entities:
		var director_id: String = entity["directorId"]
		var node = by_director_id.get(director_id)
		if node == null:
			warnings.append(
				"Baked entity %s has no imported node; its animation tracks were skipped (warn-and-omit)."
				% director_id
			)
			continue
		for entity_warning in entity.get("warnings", []):
			warnings.append(str(entity_warning))

		var track_path := String(root.get_path_to(node))
		var parent = node.get_parent()
		var parent_id = null
		if parent != null and parent != root and parent.has_meta("director_id"):
			parent_id = parent.get_meta("director_id")

		var position_track := animation.add_track(Animation.TYPE_POSITION_3D)
		var rotation_track := animation.add_track(Animation.TYPE_ROTATION_3D)
		var scale_track := animation.add_track(Animation.TYPE_SCALE_3D)
		animation.track_set_path(position_track, NodePath(track_path))
		animation.track_set_path(rotation_track, NodePath(track_path))
		animation.track_set_path(scale_track, NodePath(track_path))
		transform_tracks += 1

		for sample in entity["transformSamples"]:
			var frame := int(sample["frame"])
			var time := _frame_time(frame, frame_start, numerator, denominator)
			var child_world: Transform3D = DirectorSpace.godot_transform_from_canonical(sample["transform"])
			var parent_world := _parent_world_at(parent_id, frame, world_samples, static_worlds)
			var local := parent_world.affine_inverse() * child_world
			animation.position_track_insert_key(position_track, time, local.origin)
			animation.rotation_track_insert_key(rotation_track, time, local.basis.get_rotation_quaternion())
			animation.scale_track_insert_key(scale_track, time, local.basis.get_scale())
			baked_keys += 3

		var fov_samples: Array = entity.get("fovSamples", [])
		if not fov_samples.is_empty():
			var fov_track := animation.add_track(Animation.TYPE_VALUE)
			animation.track_set_path(fov_track, NodePath("%s:fov" % track_path))
			animation.value_track_set_update_mode(fov_track, Animation.UPDATE_CONTINUOUS)
			for fov_sample in fov_samples:
				var fov_time := _frame_time(int(fov_sample["frame"]), frame_start, numerator, denominator)
				animation.track_insert_key(fov_track, fov_time, float(fov_sample["fovDeg"]))
				baked_keys += 1
			fov_tracks += 1

	# Storyboard camera cuts share the timeline animation so transforms and
	# cuts play together; shot ranges were clamped into the playback window
	# by the Gateway, so every cut key lands inside the animation length.
	var shot_receipt := DirectorShots.add_camera_cut_tracks(
		animation, root, shots, by_director_id, frame_start, numerator, denominator, warnings
	)
	baked_keys += int(shot_receipt["shotCutKeyCount"])

	if transform_tracks == 0 and int(shot_receipt["shotCutTrackCount"]) == 0:
		return receipt

	var library := AnimationLibrary.new()
	library.add_animation(StringName(ANIMATION_NAME), animation)
	var player := AnimationPlayer.new()
	player.name = PLAYER_NAME
	root.add_child(player)
	player.add_animation_library(StringName(LIBRARY_NAME), library)

	receipt["animationLibrary"] = LIBRARY_NAME
	receipt["displayRate"] = "%d/%d" % [numerator, denominator]
	receipt["bakedKeyCount"] = baked_keys
	receipt["transformTrackCount"] = transform_tracks
	receipt["fovTrackCount"] = fov_tracks
	receipt["shotCutTrackCount"] = int(shot_receipt["shotCutTrackCount"])
	receipt["mappedShotCount"] = int(shot_receipt["mappedShotCount"])
	return receipt


## Rational frame-to-seconds conversion; the integer product stays exact well
## past any real timeline length, so only one float rounding happens.
static func _frame_time(frame: int, frame_start: int, numerator: int, denominator: int) -> float:
	return float((frame - frame_start) * denominator) / float(numerator)


static func _parent_world_at(
	parent_id, frame: int, world_samples: Dictionary, static_worlds: Dictionary
) -> Transform3D:
	if parent_id == null:
		return Transform3D.IDENTITY
	if world_samples.has(parent_id):
		var frames: Dictionary = world_samples[parent_id]
		if frames.has(frame):
			return frames[frame]
	if static_worlds.has(parent_id):
		return static_worlds[parent_id]
	return Transform3D.IDENTITY
