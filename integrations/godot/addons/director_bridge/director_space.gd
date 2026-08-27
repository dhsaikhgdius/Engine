## Coordinate conversion between Director canonical space and Godot 4.
##
## Director canonical space: right-handed, Y-up, metres, camera forward -Z.
## Godot 4 world space:      right-handed, Y-up, metres, camera forward -Z.
##
## The bases are identical, so the Director protocol pins the linear map as
## the identity `(x, y, z) -> (x, y, z)` (see
## packages/dcc-protocol/src/directorDccEngineSpace.ts). The functions exist
## so the provider boundary stays explicit and greppable, and so the world
## composition with Director's uniform scene scale lives in one place.
##
## No class_name: headless `godot --script` runs on a fresh project have no
## global class cache, so every module is referenced through `preload`.


## Identity map: canonical [x, y, z] metres -> Godot Vector3.
static func director_point_to_godot(point: Array) -> Vector3:
	return Vector3(point[0], point[1], point[2])


## Identity map: Godot Vector3 -> canonical [x, y, z] metres.
static func godot_point_to_director(point: Vector3) -> Array:
	return [point.x, point.y, point.z]


## Canonical [x, y, z, w] -> normalized Godot Quaternion (same basis).
static func director_quat_to_godot(q: Array) -> Quaternion:
	return Quaternion(q[0], q[1], q[2], q[3]).normalized()


## Godot Quaternion -> canonical [x, y, z, w], normalized for the wire.
static func godot_quat_to_director(q: Quaternion) -> Array:
	var normalized := q.normalized()
	return [normalized.x, normalized.y, normalized.z, normalized.w]


## Identity map: canonical per-axis scale -> Godot Vector3.
static func director_scale_to_godot(scale: Array) -> Vector3:
	return Vector3(scale[0], scale[1], scale[2])


## Identity map: Godot Vector3 scale -> canonical per-axis scale array.
static func godot_scale_to_director(scale: Vector3) -> Array:
	return [scale.x, scale.y, scale.z]


## Quaternion for Director's intrinsic XYZ Euler order (three.js "XYZ").
static func quat_from_euler_xyz(rx: float, ry: float, rz: float) -> Quaternion:
	var qx := Quaternion(Vector3(1, 0, 0), rx)
	var qy := Quaternion(Vector3(0, 1, 0), ry)
	var qz := Quaternion(Vector3(0, 0, 1), rz)
	return (qx * qy * qz).normalized()


## Composes the Director scene transform (uniform scale) with a world-space
## point, returning the canonical world position as a Vector3.
static func compose_world_point(scene: Dictionary, point: Array) -> Vector3:
	var scene_quat := quat_from_euler_xyz(
		scene["rotation"][0], scene["rotation"][1], scene["rotation"][2]
	)
	var scene_scale: float = scene["scale"]
	var local := Vector3(point[0], point[1], point[2])
	var rotated := scene_quat * (local * scene_scale)
	return rotated + Vector3(scene["position"][0], scene["position"][1], scene["position"][2])


## Composes the Director scene transform (uniform scale) with an entity's
## local TRS. Uniform scene scale commutes with rotation, so the world
## decomposition is exact. Returns {"location": Array, "rotation": Array,
## "scale": Array} in canonical wire form.
static func compose_world_transform(scene: Dictionary, transform: Dictionary) -> Dictionary:
	var scene_quat := quat_from_euler_xyz(
		scene["rotation"][0], scene["rotation"][1], scene["rotation"][2]
	)
	var scene_scale: float = scene["scale"]
	var local_position := Vector3(
		transform["position"][0], transform["position"][1], transform["position"][2]
	)
	var local_quat := quat_from_euler_xyz(
		transform["rotation"][0], transform["rotation"][1], transform["rotation"][2]
	)
	var rotated := scene_quat * (local_position * scene_scale)
	var world_position := rotated + Vector3(
		scene["position"][0], scene["position"][1], scene["position"][2]
	)
	var world_quat := (scene_quat * local_quat).normalized()
	return {
		"location": [world_position.x, world_position.y, world_position.z],
		"rotationQuaternion": [world_quat.x, world_quat.y, world_quat.z, world_quat.w],
		"scale": [
			transform["scale"][0] * scene_scale,
			transform["scale"][1] * scene_scale,
			transform["scale"][2] * scene_scale,
		],
	}


## Godot Transform3D for a canonical wire TRS. Composes R * S explicitly
## (Basis.scaled_local only exists in Godot 4.4+, and the connector supports
## Godot 4.2+); this also keeps negative/mirrored scale exact.
static func godot_transform_from_canonical(canonical: Dictionary) -> Transform3D:
	var basis := (
		Basis(director_quat_to_godot(canonical["rotationQuaternion"]))
		* Basis.from_scale(director_scale_to_godot(canonical["scale"]))
	)
	return Transform3D(basis, director_point_to_godot(canonical["location"]))


## Canonical wire TRS for a Godot world transform.
static func canonical_from_godot_transform(transform: Transform3D) -> Dictionary:
	var scale := transform.basis.get_scale()
	var quat := transform.basis.get_rotation_quaternion()
	return {
		"location": godot_point_to_director(transform.origin),
		"rotationQuaternion": godot_quat_to_director(quat),
		"scale": godot_scale_to_director(scale),
	}
