## Outbound-only live preview sender for the Director Godot connector.
##
## Builds director-godot-live-link-v1 messages: ephemeral, sequence-numbered
## preview frames of director_id-tagged nodes that the editor plugin pushes to
## the Director Gateway's token-guarded live-link routes. The transport is
## strictly outbound to Director — Godot never opens a listening port. An
## explicitly adopted workshop session can receive GDScript commands and
## return an engine-owned stable-ID review snapshot. A dropped connection
## simply lets the Gateway's idle timeout sweep the session.
##
## Payload construction lives here without any editor or transport
## dependencies; director_bridge.gd owns the HTTPRequest plumbing.
##
## No class_name: headless `godot --script` runs on a fresh project have no
## global class cache, so every module is referenced through `preload`.
extends RefCounted

const DirectorPackage := preload("res://addons/director_bridge/director_package.gd")
const DirectorSpace := preload("res://addons/director_bridge/director_space.gd")

const LIVE_LINK_CONTRACT := "director-godot-live-link-v1"
const HELLO_PATH := "/api/dcc/live-link/godot/hello"
const FRAME_PATH := "/api/dcc/live-link/godot/frame"
const BYE_PATH := "/api/dcc/live-link/godot/bye"
const COMMAND_RESULT_PATH := "/api/dcc/live-link/godot/command-result"
const DEFAULT_GATEWAY_URL := "http://127.0.0.1:8787"
const MAX_ENTITIES_PER_FRAME := 512

var session_id := ""
var _sequence := 0


## The Director Gateway base URL the sender pushes to (outbound only).
static func gateway_url() -> String:
	var configured := OS.get_environment("DIRECTOR_GATEWAY_URL").strip_edges()
	return configured if not configured.is_empty() else DEFAULT_GATEWAY_URL


## Request headers for the token-guarded Gateway routes. The Director gateway
## token comes from the environment; the sender never embeds credentials.
static func request_headers() -> PackedStringArray:
	var headers := PackedStringArray(["Content-Type: application/json"])
	var token := OS.get_environment("DIRECTOR_GATEWAY_TOKEN").strip_edges()
	if not token.is_empty():
		headers.append("X-Director-Browser-Token: %s" % token)
	return headers


## The hello message that negotiates a preview session.
func hello_payload(scene_path: String = "") -> Dictionary:
	var info := Engine.get_version_info()
	var payload := {
		"contract": LIVE_LINK_CONTRACT,
		"provider": DirectorPackage.PROVIDER,
		"connectorVersion": DirectorPackage.CONNECTOR_VERSION,
		"hostVersion": "Godot %s.%s.%s" % [info.major, info.minor, info.patch],
	}
	if not scene_path.is_empty():
		payload["scenePath"] = scene_path
	return payload


## Adopts the session id from the Gateway's hello result. Returns false when
## the response does not carry a session grant.
func accept_session(result: Dictionary) -> bool:
	var granted := str(result.get("sessionId", ""))
	if granted.is_empty():
		return false
	session_id = granted
	_sequence = 0
	return true


## Builds one preview frame of every director_id-tagged object/camera node
## under `root`, in canonical Director space, with the next strictly
## increasing sequence number. Returns {} when there is no session or nothing
## to preview (skipped editor ticks simply leave gaps in the sequence, which
## the Gateway allows; replays are rejected there).
func frame_payload(root: Node) -> Dictionary:
	if session_id.is_empty() or root == null:
		return {}
	var entities: Array = []
	var queue: Array = [root]
	while not queue.is_empty() and entities.size() < MAX_ENTITIES_PER_FRAME:
		var node: Node = queue.pop_front()
		for child in node.get_children():
			queue.append(child)
		if not (node is Node3D) or not node.has_meta("director_id"):
			continue
		var entity_type := str(node.get_meta("director_entity_type", "object"))
		if entity_type != "object" and entity_type != "camera" and entity_type != "light":
			continue
		var entity := {
			"directorId": str(node.get_meta("director_id")),
			"entityType": entity_type,
			"transform": DirectorSpace.canonical_from_godot_transform(
				_world_transform_of(node, root)
			),
		}
		if node is Camera3D:
			entity["fovDeg"] = (node as Camera3D).fov
		entities.append(entity)
	if entities.is_empty():
		return {}
	_sequence += 1
	return {
		"contract": LIVE_LINK_CONTRACT,
		"sessionId": session_id,
		"sequence": _sequence,
		"atMs": Time.get_ticks_msec(),
		"entities": entities,
	}


## The explicit end-of-session message; a missed bye is equivalent through
## the Gateway's idle timeout.
func bye_payload(reason: String = "") -> Dictionary:
	var payload := {
		"contract": LIVE_LINK_CONTRACT,
		"sessionId": session_id,
	}
	if not reason.is_empty():
		payload["reason"] = reason
	session_id = ""
	_sequence = 0
	return payload


## World transform relative to the edited scene root, composed manually so
## the math matches the headless exporter (Node3D chain only).
static func _world_transform_of(node: Node3D, root: Node) -> Transform3D:
	var world := node.transform
	var current := node.get_parent()
	while current != null and current != root and current is Node3D:
		world = (current as Node3D).transform * world
		current = current.get_parent()
	return world
