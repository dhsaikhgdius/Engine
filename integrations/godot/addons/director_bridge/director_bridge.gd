## Editor plugin for the Director Godot connector.
##
## Adds a Tools menu entry with the connector health line so a human can check
## the installation, plus an opt-in live preview toggle that streams outbound,
## sequence-numbered preview frames of the edited Director scene to the
## Director Gateway (see director_live_link.gd). The plugin never opens a
## listening port and preview frames are never authoritative. Import/export
## runs are driven headlessly by the Director Gateway through
## director_headless.gd; this plugin never executes request-supplied scripts.
@tool
extends EditorPlugin

const DirectorPackage := preload("res://addons/director_bridge/director_package.gd")
const DirectorLiveLink := preload("res://addons/director_bridge/director_live_link.gd")

const HEALTH_MENU_ITEM := "Director Bridge: 健康检查 (Health Check)"
const LIVE_MENU_ITEM := "Director Bridge: 实时预览开/关 (Toggle Live Preview)"
## Preview cadence; frames are skipped (leaving sequence gaps, which the
## Gateway allows) while a previous request is still in flight.
const LIVE_PREVIEW_INTERVAL_S := 0.1

var _live_link = null
var _live_link_timer: Timer = null
var _live_link_request: HTTPRequest = null
var _live_link_busy := false


func _enter_tree() -> void:
	add_tool_menu_item(HEALTH_MENU_ITEM, _print_health)
	add_tool_menu_item(LIVE_MENU_ITEM, _toggle_live_preview)


func _exit_tree() -> void:
	remove_tool_menu_item(HEALTH_MENU_ITEM)
	remove_tool_menu_item(LIVE_MENU_ITEM)
	_stop_live_preview("editor plugin disabled")


func _print_health() -> void:
	var info := Engine.get_version_info()
	print(
		JSON.stringify(
			{
				"ok": true,
				"provider": DirectorPackage.PROVIDER,
				"hostVersion": "Godot %s.%s.%s" % [info.major, info.minor, info.patch],
				"connectorVersion": DirectorPackage.CONNECTOR_VERSION,
			}
		)
	)


func _toggle_live_preview() -> void:
	if _live_link != null:
		_stop_live_preview("toggled off")
		return
	_live_link = DirectorLiveLink.new()
	_live_link_request = HTTPRequest.new()
	_live_link_request.timeout = 5.0
	_live_link_request.request_completed.connect(_on_live_link_response)
	add_child(_live_link_request)
	_live_link_timer = Timer.new()
	_live_link_timer.wait_time = LIVE_PREVIEW_INTERVAL_S
	_live_link_timer.timeout.connect(_on_live_preview_tick)
	add_child(_live_link_timer)
	var edited_root := EditorInterface.get_edited_scene_root()
	var scene_path := "" if edited_root == null else edited_root.scene_file_path
	_send_live_link(DirectorLiveLink.HELLO_PATH, _live_link.hello_payload(scene_path))
	print("Director Bridge: live preview connecting to %s (outbound only)." % DirectorLiveLink.gateway_url())


func _stop_live_preview(reason: String) -> void:
	if _live_link == null:
		return
	var bye := _live_link.bye_payload(reason)
	if not str(bye.get("sessionId", "")).is_empty() and not _live_link_busy:
		# Best-effort farewell; a missed bye is equivalent through the
		# Gateway's idle timeout and never leaves durable state behind.
		_send_live_link(DirectorLiveLink.BYE_PATH, bye)
	if _live_link_timer != null:
		_live_link_timer.stop()
		_live_link_timer.queue_free()
		_live_link_timer = null
	if _live_link_request != null:
		_live_link_request.queue_free()
		_live_link_request = null
	_live_link = null
	_live_link_busy = false
	print("Director Bridge: live preview stopped (%s)." % reason)


func _on_live_preview_tick() -> void:
	if _live_link == null or _live_link_busy:
		return
	var frame = _live_link.frame_payload(EditorInterface.get_edited_scene_root())
	if frame.is_empty():
		return
	_send_live_link(DirectorLiveLink.FRAME_PATH, frame)


func _send_live_link(path: String, payload: Dictionary) -> void:
	if _live_link_request == null:
		return
	var error := _live_link_request.request(
		DirectorLiveLink.gateway_url() + path,
		DirectorLiveLink.request_headers(),
		HTTPClient.METHOD_POST,
		JSON.stringify(payload)
	)
	if error != OK:
		push_warning("Director Bridge: live preview request failed to start (error %d)." % error)
		_stop_live_preview("transport error")
		return
	_live_link_busy = true


func _on_live_link_response(
	result: int, response_code: int, _headers: PackedStringArray, body: PackedByteArray
) -> void:
	_live_link_busy = false
	if _live_link == null:
		return
	if result != HTTPRequest.RESULT_SUCCESS or response_code >= 400:
		push_warning(
			"Director Bridge: live preview response %d (transport result %d); stopping preview."
			% [response_code, result]
		)
		_stop_live_preview("gateway rejected the preview stream")
		return
	if not _live_link.session_id.is_empty():
		if _live_link_timer != null and _live_link_timer.is_stopped():
			_live_link_timer.start()
		return
	var parsed = JSON.parse_string(body.get_string_from_utf8())
	if typeof(parsed) != TYPE_DICTIONARY or typeof(parsed.get("result")) != TYPE_DICTIONARY:
		push_warning("Director Bridge: live preview hello returned no session; stopping preview.")
		_stop_live_preview("hello was not granted")
		return
	if not _live_link.accept_session(parsed["result"]):
		push_warning("Director Bridge: live preview hello returned no session; stopping preview.")
		_stop_live_preview("hello was not granted")
		return
	if _live_link_timer != null:
		_live_link_timer.start()
