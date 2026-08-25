## Editor plugin for the Director Godot connector.
##
## Adds a Tools menu entry with the connector health line so a human can check
## the installation. Import/export runs are driven headlessly by the Director
## Gateway through director_headless.gd; this plugin never executes
## request-supplied scripts.
@tool
extends EditorPlugin

const DirectorPackage := preload("res://addons/director_bridge/director_package.gd")


func _enter_tree() -> void:
	add_tool_menu_item("Director Bridge: 健康检查 (Health Check)", _print_health)


func _exit_tree() -> void:
	remove_tool_menu_item("Director Bridge: 健康检查 (Health Check)")


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
