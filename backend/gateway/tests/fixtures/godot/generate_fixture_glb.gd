## Test-fixture generator for the Godot headless roundtrip test.
##
## Builds a small scene exercising every payload feature the Director Godot
## connector must carry — a textured StandardMaterial3D box, a two-bone
## Skeleton3D with a skinned mesh in bind pose, and a payload AnimationPlayer —
## and exports it as a self-contained GLB. Run by the test harness only
## (never by the Gateway):
##
##     godot --headless --path <fixture-project> \
##         --script res://generate_fixture_glb.gd -- --output <file.glb>
extends SceneTree


func _initialize() -> void:
	var output := ""
	var raw := OS.get_cmdline_user_args()
	for index in range(raw.size() - 1):
		if raw[index] == "--output":
			output = raw[index + 1]
	if output.is_empty():
		push_error("--output <file.glb> is required.")
		quit(2)
		return

	var root := Node3D.new()
	root.name = "Fixture"

	var box := MeshInstance3D.new()
	box.name = "Box"
	var box_mesh := BoxMesh.new()
	var material := StandardMaterial3D.new()
	var image := Image.create(8, 8, false, Image.FORMAT_RGBA8)
	image.fill(Color(0.8, 0.2, 0.2))
	material.albedo_texture = ImageTexture.create_from_image(image)
	box_mesh.material = material
	box.mesh = box_mesh
	root.add_child(box)

	var skeleton := Skeleton3D.new()
	skeleton.name = "Skeleton3D"
	skeleton.add_bone("root")
	skeleton.set_bone_rest(0, Transform3D.IDENTITY)
	skeleton.add_bone("tip")
	skeleton.set_bone_parent(1, 0)
	skeleton.set_bone_rest(1, Transform3D(Basis(), Vector3(0, 1, 0)))
	skeleton.reset_bone_poses()
	root.add_child(skeleton)

	var skinned := MeshInstance3D.new()
	skinned.name = "Skinned"
	skinned.mesh = _skinned_mesh()
	skeleton.add_child(skinned)
	skinned.skeleton = NodePath("..")
	skinned.skin = skeleton.create_skin_from_rest_transforms()

	var player := AnimationPlayer.new()
	player.name = "PayloadPlayer"
	root.add_child(player)
	var animation := Animation.new()
	animation.length = 1.0
	var track := animation.add_track(Animation.TYPE_POSITION_3D)
	animation.track_set_path(track, NodePath("Box"))
	animation.position_track_insert_key(track, 0.0, Vector3.ZERO)
	animation.position_track_insert_key(track, 1.0, Vector3(0, 1, 0))
	var library := AnimationLibrary.new()
	library.add_animation(StringName("payload_move"), animation)
	player.add_animation_library(StringName(""), library)

	_set_owner_recursive(root, root)

	var document := GLTFDocument.new()
	var state := GLTFState.new()
	var append_error := document.append_from_scene(root, state)
	if append_error != OK:
		push_error("append_from_scene failed with error %d" % append_error)
		quit(1)
		return
	var write_error := document.write_to_filesystem(state, output)
	if write_error != OK:
		push_error("write_to_filesystem failed with error %d" % write_error)
		quit(1)
		return
	print("fixture-glb-written")
	quit(0)


func _skinned_mesh() -> ArrayMesh:
	var vertices := PackedVector3Array([Vector3(0, 0, 0), Vector3(1, 0, 0), Vector3(0, 1, 0)])
	var normals := PackedVector3Array([Vector3(0, 0, 1), Vector3(0, 0, 1), Vector3(0, 0, 1)])
	var bones := PackedInt32Array([0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0])
	var weights := PackedFloat32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])
	var arrays := []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = vertices
	arrays[Mesh.ARRAY_NORMAL] = normals
	arrays[Mesh.ARRAY_BONES] = bones
	arrays[Mesh.ARRAY_WEIGHTS] = weights
	var mesh := ArrayMesh.new()
	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
	return mesh


func _set_owner_recursive(node: Node, owner: Node) -> void:
	for child in node.get_children():
		child.owner = owner
		_set_owner_recursive(child, owner)
