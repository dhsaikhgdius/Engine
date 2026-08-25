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

# Import-time baseline of a Director character's portable pose controls
# (JSON: control key -> value). The editable per-control values live in
# individual custom properties named POSE_CONTROL_PREFIX + control key.
POSE_CONTROLS_BASELINE_PROPERTY = "director_pose_controls"

# Prefix for the editable per-control pose custom properties, e.g.
# ``director_pose.head.yaw``. Artists edit these floats in Blender's
# Custom Properties panel; the return exporter diffs them against the baseline.
POSE_CONTROL_PREFIX = "director_pose."

# Fingerprint of descendant armature pose-bone basis matrices at import time.
# Direct pose-bone edits are detected (and warned about), never reconciled:
# only the portable director_pose.* controls round-trip to Director.
SOURCE_POSE_FINGERPRINT_PROPERTY = "director_source_pose_bones"
