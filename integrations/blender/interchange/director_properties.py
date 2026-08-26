"""Shared Blender custom-property names for the Director round trip.

``director_bridge.py`` stamps these properties into the .blend when importing
a Director scene package, and ``director_return_export.py`` reads them back to
diff artist edits against the import-time baseline. Keeping the names in one
module prevents the two scripts from drifting apart. Renaming any property
invalidates every previously stamped .blend, so treat these as a contract.
"""

from __future__ import annotations

# Evaluated world transform of a Director-tracked root at import time.
SOURCE_TRANSFORM_PROPERTY = "director_source_transform"

# Asset-space mesh-content fingerprint of a Director-tracked root at import time.
SOURCE_MESH_SIGNATURE_PROPERTY = "director_source_mesh_signature"

# The Director camera's authoritative look-at target (JSON [x, y, z]).
CAMERA_TARGET_PROPERTY = "director_camera_target"

# Evaluated camera optics baseline stamped after returning to currentFrame
# (JSON: focalLengthMm, apertureFStop, focusDistanceM, nearClipM, farClipM,
# sensorWidthMm, sensorHeightMm, and optionally sensorFormat).
SOURCE_CAMERA_OPTICS_PROPERTY = "director_source_camera_optics"

# Import-time baseline of a Director light (JSON: type, position, target?,
# color, intensity, energy, wattsPerIntensity).
SOURCE_LIGHT_PROPERTY = "director_source_light"

# Import-time animation baseline of a Director-tracked root (JSON:
# {"fingerprint": sha256 of every fcurve/NLA/driver stanza, "sample":
# extract_transform_animation result}). Objects stamp fingerprint + sample;
# cameras stamp the fingerprint only (including lens data curves) because
# camera animation does not round-trip.
SOURCE_ANIMATION_PROPERTY = "director_source_animation"

# Import-time baseline of a Director character's portable pose controls
# (JSON: control key -> value). The editable per-control values live in
# individual custom properties named POSE_CONTROL_PREFIX + control key.
POSE_CONTROLS_BASELINE_PROPERTY = "director_pose_controls"

# Prefix for the editable per-control pose custom properties, e.g.
# ``director_pose.head.yaw``. Artists edit these floats in Blender's
# Custom Properties panel; the return exporter diffs them against the baseline.
POSE_CONTROL_PREFIX = "director_pose."

# Fingerprint of descendant armature pose-bone basis matrices at import time.
# When it differs on return, mapped bones reconcile through the stamped bone
# map below; everything else stays warn-and-omit.
SOURCE_POSE_FINGERPRINT_PROPERTY = "director_source_pose_bones"

# Director bone-role map of the character armature stamped at import time
# (JSON: {"armature": name, "bones": {role: bone name}}). Only bones in this
# map reconcile direct pose edits back into portable director_pose.* controls.
POSE_BONE_MAP_PROPERTY = "director_pose_bone_map"

# Per-role pose-bone baseline captured at import time (JSON: role ->
# {"rotation": [w,x,y,z], "location": [x,y,z], "scale": [x,y,z]} from
# matrix_basis). The return exporter diffs live bones against this baseline.
POSE_BONE_BASELINE_PROPERTY = "director_pose_bone_baseline"

# Fingerprint restricted to pose bones OUTSIDE the stamped bone map. When it
# changes, the return exporter warns that unmapped bone edits were omitted.
SOURCE_UNMAPPED_POSE_FINGERPRINT_PROPERTY = "director_source_unmapped_pose_bones"
