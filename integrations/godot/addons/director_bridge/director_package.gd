## Exchange and return package I/O for the Director Godot connector.
##
## Reads and hash-verifies director-dcc-exchange-package-v1 manifests, and
## writes director-dcc-return-v1 packages plus director-dcc-engine-report-v1
## receipts. Pure file I/O; no scene code.
##
## No class_name: headless `godot --script` runs on a fresh project have no
## global class cache, so every module is referenced through `preload`.

const EXCHANGE_CONTRACT := "director-dcc-exchange-package-v1"
const RETURN_CONTRACT := "director-dcc-return-v1"
const REPORT_CONTRACT := "director-dcc-engine-report-v1"
const PROVIDER := "godot"
const CONNECTOR_VERSION := "0.3.2"


## Loads an exchange package manifest, verifying the contract, the provider,
## and the SHA-256 hash of every referenced file. Returns {} on failure and
## stores the reason in `error`.
static func load_exchange_package(package_dir: String, error: Array) -> Dictionary:
	var manifest_path := package_dir.path_join("manifest.json")
	if not FileAccess.file_exists(manifest_path):
		error.append("Exchange package is missing manifest.json: %s" % package_dir)
		return {}
	var parsed = JSON.parse_string(FileAccess.get_file_as_string(manifest_path))
	if typeof(parsed) != TYPE_DICTIONARY:
		error.append("Exchange manifest is not a JSON object.")
		return {}
	var manifest: Dictionary = parsed
	if manifest.get("contract") != EXCHANGE_CONTRACT:
		error.append("Unexpected exchange contract: %s" % str(manifest.get("contract")))
		return {}
	if manifest.get("provider") != PROVIDER:
		error.append(
			"Exchange package targets provider %s, expected %s"
			% [str(manifest.get("provider")), PROVIDER]
		)
		return {}
	for section in ["formats", "assets"]:
		for entry in manifest.get(section, []):
			var relative_path: String = entry["relativePath"]
			if relative_path.begins_with("/") or relative_path.contains(".."):
				error.append("Package path escapes the package root: %s" % relative_path)
				return {}
			var absolute := package_dir.path_join(relative_path)
			if not FileAccess.file_exists(absolute):
				error.append("Exchange package file is missing: %s" % relative_path)
				return {}
			var actual := FileAccess.get_sha256(absolute)
			if actual != entry["sha256"]:
				error.append(
					"SHA-256 mismatch for %s: expected %s, found %s"
					% [relative_path, entry["sha256"], actual]
				)
				return {}
	return manifest


## Writes a director-dcc-return-v1 package. Changes must already be in
## Director canonical space (Godot's basis matches, so no conversion loss).
static func write_return_package(
	return_dir: String,
	host_version: String,
	source_package_id: String,
	source_revision: String,
	changes: Array,
	warnings: Array
) -> String:
	DirAccess.make_dir_recursive_absolute(return_dir)
	var manifest := {
		"schemaVersion": 1,
		"contract": RETURN_CONTRACT,
		"packageId": "%s-return-%s" % [PROVIDER, source_package_id],
		"sourcePackageId": source_package_id,
		"sourceRevision": source_revision,
		"exportedAt": Time.get_datetime_string_from_system(true) + "Z",
		"provider": PROVIDER,
		"hostVersion": host_version,
		"connectorVersion": CONNECTOR_VERSION,
		"coordinateSystem": {
			"source": "right-handed-y-up-negative-z-forward",
			"destination": "right-handed-y-up-negative-z-forward",
			"unit": "meter",
			"linearMap": "identity",
		},
		"changes": changes,
		"warnings": warnings,
		"fileHashes": {},
	}
	var manifest_path := return_dir.path_join("manifest.json")
	var handle := FileAccess.open(manifest_path, FileAccess.WRITE)
	handle.store_string(JSON.stringify(manifest, "  ") + "\n")
	handle.close()
	return manifest_path


## Writes the director-dcc-engine-report-v1 receipt the Gateway validates.
## `extra` carries schema-approved extension fields (for example the `godot`
## import receipt); it never overrides the required report fields.
static func write_report(
	report_path: String,
	host_version: String,
	package_id: String,
	source_revision: String,
	imported_object_count: int,
	imported_camera_count: int,
	scene_path,
	return_package_dir,
	warnings: Array,
	extra: Dictionary = {}
) -> void:
	DirAccess.make_dir_recursive_absolute(report_path.get_base_dir())
	var report := {
		"ok": true,
		"contract": REPORT_CONTRACT,
		"provider": PROVIDER,
		"hostVersion": host_version,
		"connectorVersion": CONNECTOR_VERSION,
		"packageId": package_id,
		"sourceRevision": source_revision,
		"importedObjectCount": imported_object_count,
		"importedCameraCount": imported_camera_count,
		"scenePath": scene_path,
		"returnPackageDir": return_package_dir,
		"warnings": warnings,
	}
	for key in extra:
		if not report.has(key):
			report[key] = extra[key]
	var handle := FileAccess.open(report_path, FileAccess.WRITE)
	handle.store_string(JSON.stringify(report, "  ") + "\n")
	handle.close()


## Writes an ok:false report so the Gateway fails the job with a reason.
static func write_failure_report(report_path: String, error: String) -> void:
	DirAccess.make_dir_recursive_absolute(report_path.get_base_dir())
	var handle := FileAccess.open(report_path, FileAccess.WRITE)
	handle.store_string(JSON.stringify({"ok": false, "error": error}, "  ") + "\n")
	handle.close()


## Sanitizes a Director entity name into a safe Godot node name.
static func safe_node_name(value: String) -> String:
	var cleaned := ""
	for character in value:
		if character.is_valid_identifier() or character == "-" or character == ".":
			cleaned += character
		else:
			cleaned += "_"
	return cleaned.substr(0, 96) if not cleaned.is_empty() else "director_node"
