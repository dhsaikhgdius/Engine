## Storyboard shot mapping for the Director Godot connector.
##
## Godot has no built-in shot timeline (no Sequencer/Timeline equivalent), so
## Director shot ranges are mapped onto the closest native idiom: a discrete
## `Camera3D.current` value track per cut camera inside the Director timeline
## animation. Setting `current = true` on a Camera3D makes it the active
## camera (Godot clears the previous one automatically), so playing the
## timeline animation performs the storyboard's camera cuts. Shot ranges come
## from the hash-pinned animation bake — already clamped into the playback
## window and sorted by start frame — and the exchange format itself never
## becomes `.tscn`.
##
## Shots that cannot be mapped warn-and-omit with a structured code so agents
## can act on the omission instead of parsing prose.
##
## No class_name: headless `godot --script` runs on a fresh project have no
## global class cache, so every module is referenced through `preload`.

## The shot has no camera binding in Director; there is nothing to cut to.
const OMIT_NO_CAMERA := "shot_no_camera_binding"
## The bound camera was not imported into the Godot scene.
const OMIT_CAMERA_NOT_IMPORTED := "shot_camera_not_imported"
## The bound director_id resolved to a node that is not a Camera3D.
const OMIT_NOT_A_CAMERA := "shot_target_not_camera"
## The shot starts inside the previous shot's range; the later cut wins.
const WARN_OVERLAP := "shot_overlaps_previous"


## Keys one discrete `current` cut key per mappable shot into `animation`,
## creating one value track per distinct cut camera. Returns receipt counts:
## {"shotCutTrackCount", "mappedShotCount", "shotCutKeyCount"}.
static func add_camera_cut_tracks(
	animation: Animation,
	root: Node3D,
	shots: Array,
	by_director_id: Dictionary,
	frame_start: int,
	numerator: int,
	denominator: int,
	warnings: Array
) -> Dictionary:
	var receipt := {"shotCutTrackCount": 0, "mappedShotCount": 0, "shotCutKeyCount": 0}
	if shots.is_empty():
		return receipt
	var track_by_camera := {}
	var mapped := 0
	var keys := 0
	var previous_end = null
	var previous_id := ""
	for shot in shots:
		var shot_id := str(shot.get("shotId", "?"))
		var camera_id = shot.get("cameraDirectorId")
		if camera_id == null:
			warnings.append(
				"Shot %s has no camera binding; no camera cut was keyed (warn-and-omit code: %s)."
				% [shot_id, OMIT_NO_CAMERA]
			)
			continue
		var node = by_director_id.get(camera_id)
		if node == null:
			warnings.append(
				(
					"Shot %s references camera %s which was not imported; its cut was skipped "
					+ "(warn-and-omit code: %s)."
				)
				% [shot_id, str(camera_id), OMIT_CAMERA_NOT_IMPORTED]
			)
			continue
		if not (node is Camera3D):
			warnings.append(
				(
					"Shot %s is bound to %s which is not a Camera3D; its cut was skipped "
					+ "(warn-and-omit code: %s)."
				)
				% [shot_id, str(camera_id), OMIT_NOT_A_CAMERA]
			)
			continue
		var start_frame := int(shot.get("frameStart", 0))
		if previous_end != null and start_frame <= int(previous_end):
			warnings.append(
				(
					"Shot %s starts at frame %d inside shot %s; the later cut takes over at its "
					+ "start (code: %s)."
				)
				% [shot_id, start_frame, previous_id, WARN_OVERLAP]
			)
		if not track_by_camera.has(camera_id):
			var track := animation.add_track(Animation.TYPE_VALUE)
			animation.track_set_path(
				track, NodePath("%s:current" % String(root.get_path_to(node)))
			)
			animation.value_track_set_update_mode(track, Animation.UPDATE_DISCRETE)
			track_by_camera[camera_id] = track
		var time := float((start_frame - frame_start) * denominator) / float(numerator)
		animation.track_insert_key(track_by_camera[camera_id], time, true)
		keys += 1
		mapped += 1
		previous_end = int(shot.get("frameEnd", start_frame))
		previous_id = shot_id
	receipt["shotCutTrackCount"] = track_by_camera.size()
	receipt["mappedShotCount"] = mapped
	receipt["shotCutKeyCount"] = keys
	return receipt
