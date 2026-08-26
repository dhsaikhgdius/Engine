## Outbound-only live preview sender for the Director Godot connector.
##
## Builds director-godot-live-link-v1 messages: ephemeral, sequence-numbered
## preview frames of director_id-tagged nodes that the editor plugin pushes to
## the Director Gateway's token-guarded live-link routes. The transport is
## strictly outbound to Director — Godot never opens a listening port and
## never exposes a scripting endpoint — and preview frames are never
## authoritative: durable changes still travel through the reviewed
## director-dcc-return-v1 package path, and a dropped connection simply lets
## the Gateway's idle timeout sweep the session without touching the last
## committed Director revision.
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
const DEFAULT_GATEWAY_URL := "http://127.0.0.1:8787"
const MAX_ENTITIES_PER_FRAME := 512

var session_id := ""
## Per-session secret from the hello grant; sent with every frame and bye so
## a session id leaked through the observable preview snapshot can never be
## used by another client to inject frames or end the session.
var session_token := ""
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


## Adopts the session id and per-session token from the Gateway's hello
## result. Returns false when the response does not carry a full session
## grant (both the id and the token are required to send frames).
func accept_session(result: Dictionary) -> bool:
	var granted := str(result.get("sessionId", ""))
	var token := str(result.get("sessionToken", ""))
	if granted.is_empty() or token.is_empty():
		return false
	session_id = granted
	session_token = token
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
		if entity_type != "object" and entity_type != "camera":
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
		"sessionToken": session_token,
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
		"sessionToken": session_token,
	}
	if not reason.is_empty():
		payload["reason"] = reason
	session_id = ""
	session_token = ""
	_sequence = 0
	return payload


static func _world_transform_of(node: Node3D, root: Node) -> Transform3D:
	var world := node.transform
	var current := node.get_parent()
	while current != null and current != root and current is Node3D:
		world = (current as Node3D).transform * world
		current = current.get_parent()
	return world
