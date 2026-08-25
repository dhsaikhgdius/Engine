## Skeleton handling for the Director Godot connector.
##
## Skinned GLB payloads import through GLTFDocument as Skeleton3D nodes with
## Skin resources and glTF inverse-bind matrices. This module verifies that
## import, guarantees the bind pose (rest pose) after instancing, and stamps
## the skeleton root with director_id metadata so agents can find it. When a
## character payload has no usable skeleton, the connector warns and continues
## instead of failing the handoff (warn-and-omit).
##
## No class_name: headless `godot --script` runs on a fresh project have no
## global class cache, so every module is referenced through `preload`.


## Finds, verifies, and tags the skeleton of one instanced payload. Returns
## true when a usable Skeleton3D with skinned meshes was tagged.
static func tag_skeleton(instance: Node3D, entity: Dictionary, warnings: Array) -> bool:
	var skeleton := find_skeleton(instance)
	var is_character: bool = str(entity.get("kind", "")) == "character"
	var entity_id: String = str(entity.get("id", "?"))
	if skeleton == null:
		if is_character:
			warnings.append(
				(
					"Character %s payload has no Skeleton3D; the skinned import/retarget was skipped "
					+ "and the payload was placed as a static mesh (warn-and-omit)."
				)
				% entity_id
			)
		return false
	if skeleton.get_bone_count() == 0:
		warnings.append(
			"Object %s payload skeleton has no bones; the skeletal retarget failed (warn-and-omit)." % entity_id
		)
		return false
	# Guarantee the bind pose: instanced payloads must start at rest, not at
	# whatever pose the last sampled animation frame left behind.
	skeleton.reset_bone_poses()
	skeleton.set_meta("director_id", entity_id)
	skeleton.set_meta("director_entity_type", "skeleton")
	if not _has_skinned_mesh(skeleton):
		warnings.append(
			(
				"Object %s payload has a Skeleton3D but no skinned mesh bound to it; "
				+ "skin binding may have failed in the source GLB (warn-and-omit)."
			)
			% entity_id
		)
	return true


## Breadth-first search for the first Skeleton3D under `node` (inclusive).
static func find_skeleton(node: Node) -> Skeleton3D:
	var queue: Array = [node]
	while not queue.is_empty():
		var current: Node = queue.pop_front()
		if current is Skeleton3D:
			return current
		for child in current.get_children():
			queue.append(child)
	return null


static func _has_skinned_mesh(skeleton: Skeleton3D) -> bool:
	var queue: Array = [skeleton]
	while not queue.is_empty():
		var current: Node = queue.pop_front()
		if current is MeshInstance3D and (current as MeshInstance3D).skin != null:
			return true
		for child in current.get_children():
			queue.append(child)
	return false
