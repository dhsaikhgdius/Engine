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
var _live_link_request_path := ""


func _enter_tree() -> void:
	add_tool_menu_item(HEALTH_MENU_ITEM, _print_health)
	add_tool_menu_item(LIVE_MENU_ITEM, _toggle_live_preview)


func _exit_tree() -> void:
	remove_tool_menu_item(HEALTH_MENU_ITEM)
	remove_tool_menu_item(LIVE_MENU_ITEM)
	_stop_live_preview("editor plugin disabled")


## Prints the same JSON health line the headless health check emits, so a
## human inside the editor can verify the install without running the CLI.
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


## Starts or stops the outbound preview stream. Starting sends a hello and
## only begins the frame timer once the Gateway grants a session (see
## _on_live_link_response); a single reused HTTPRequest keeps at most one
## request in flight.
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


## Tears down the preview session and frees the timer/request nodes.
## Idempotent so plugin disable, toggling, and error paths can all call it.
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
	_live_link_request_path = ""
	print("Director Bridge: live preview stopped (%s)." % reason)


## Timer callback: sends one preview frame unless a request is still in
## flight (skipped frames leave sequence gaps the Gateway tolerates).
func _on_live_preview_tick() -> void:
	if _live_link == null or _live_link_busy:
		return
	var frame = _live_link.frame_payload(EditorInterface.get_edited_scene_root())
	if frame.is_empty():
		return
	_send_live_link(DirectorLiveLink.FRAME_PATH, frame)


## Posts one payload to the Gateway and marks the shared request busy; a
## transport failure that cannot even start ends the preview because the
## single HTTPRequest would otherwise stay wedged.
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
	_live_link_request_path = path


## Executes one workshop-granted editor command and returns its typed
## result. capture_frame resizes the live 3D viewport texture to the
## clamped requested size; execute_code wraps the granted snippet in a
## RefCounted run(editor_interface) method — this path only exists inside
## an explicitly granted session, never during headless import/export.
func _execute_engine_command(command: Dictionary) -> Dictionary:
	var command_id := str(command.get("commandId", ""))
	var command_name := str(command.get("command", ""))
	if command_id.is_empty() or command_name.is_empty():
		return {}
	if command_name == "capture_frame":
		var viewport := EditorInterface.get_editor_viewport_3d(0)
		if viewport == null:
			return {
				"commandId": command_id,
				"command": command_name,
				"status": "failed",
				"error": "Godot editor viewport 0 is unavailable.",
			}
		var image := viewport.get_texture().get_image()
		var width := clampi(int(command.get("width", 960)), 64, 1920)
		var height := clampi(int(command.get("height", 540)), 64, 1080)
		image.resize(width, height, Image.INTERPOLATE_LANCZOS)
		return {
			"commandId": command_id,
			"command": command_name,
			"status": "completed",
			"mimeType": "image/png",
			"imageBase64": Marshalls.raw_to_base64(image.save_png_to_buffer()),
			"width": width,
			"height": height,
		}
	if command_name == "execute_code":
		var source := "extends RefCounted\nfunc run(editor_interface):\n"
		for line in str(command.get("code", "")).split("\n"):
			source += "\t%s\n" % line
		var script := GDScript.new()
		script.source_code = source
		var compile_error := script.reload()
		if compile_error != OK:
			return {
				"commandId": command_id,
				"command": command_name,
				"status": "failed",
				"error": "GDScript compilation failed with error %d." % compile_error,
			}
		var value = script.new().run(EditorInterface)
		return {
			"commandId": command_id,
			"command": command_name,
			"status": "completed",
			"output": str(value).substr(0, 131072),
		}
	return {
		"commandId": command_id,
		"command": command_name,
		"status": "failed",
		"error": "Unsupported Godot editor command: %s." % command_name,
	}


## Handles every Gateway response: accepts the session from the hello
## reply, executes at most one piggybacked engine command (its result is
## posted before the next frame), and restarts the frame timer. Any 4xx/5xx
## or transport failure stops the preview instead of retrying blindly.
func _on_live_link_response(
	result: int, response_code: int, _headers: PackedStringArray, body: PackedByteArray
) -> void:
	_live_link_busy = false
	var request_path := _live_link_request_path
	_live_link_request_path = ""
	if _live_link == null:
		return
	if result != HTTPRequest.RESULT_SUCCESS or response_code >= 400:
		push_warning(
			"Director Bridge: live preview response %d (transport result %d); stopping preview."
			% [response_code, result]
		)
		_stop_live_preview("gateway rejected the preview stream")
		return
	var parsed = JSON.parse_string(body.get_string_from_utf8())
	if typeof(parsed) != TYPE_DICTIONARY or typeof(parsed.get("result")) != TYPE_DICTIONARY:
		push_warning("Director Bridge: live preview hello returned no session; stopping preview.")
		_stop_live_preview("hello was not granted")
		return
	var response_result: Dictionary = parsed["result"]
	if _live_link.session_id.is_empty() and not _live_link.accept_session(response_result):
		push_warning("Director Bridge: live preview hello returned no session; stopping preview.")
		_stop_live_preview("hello was not granted")
		return
	if request_path != DirectorLiveLink.COMMAND_RESULT_PATH:
		var commands: Array = response_result.get("commands", [])
		if not commands.is_empty():
			var command_result := _execute_engine_command(commands[0])
			if not command_result.is_empty():
				command_result["sessionId"] = _live_link.session_id
				_send_live_link(DirectorLiveLink.COMMAND_RESULT_PATH, command_result)
				return
	if _live_link_timer != null:
		_live_link_timer.start()
