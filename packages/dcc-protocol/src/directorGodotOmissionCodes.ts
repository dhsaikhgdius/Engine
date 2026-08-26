/**
 * The structured warn-and-omit / approximation codes shared between the
 * Director Gateway and the Godot connector.
 *
 * Both sides must emit these exact strings: the Gateway inside animation-bake
 * warnings, the connector inside its report warnings. A host-free golden test
 * (`backend/gateway/tests/dcc/godotConnectorGoldens.test.ts`) pins every code
 * verbatim against its owning source file so the two ends can never drift.
 * Codes are append-only; renaming or removing one is a breaking contract
 * change for agents that act on the codes instead of parsing prose.
 */

/** Codes the Gateway emits while building the Godot animation bake sidecar. */
export const DIRECTOR_GODOT_GATEWAY_OMISSION_CODES = Object.freeze({
  /** Rig pose keyframes (bone-level channels) are not carried by the bake. */
  poseValues: "pose_values",
  /** Character motion clips are not carried; only the root path is baked. */
  motionBlocks: "motion_blocks",
  /** Character rig state is not carried by the bake. */
  characterRig: "character_rig",
  /** A storyboard shot lies fully outside the playback window. */
  shotOutsidePlayback: "shot_outside_playback",
  /** A storyboard shot range was clamped into the playback window. */
  shotClampedToPlayback: "shot_clamped_to_playback",
  /** A storyboard shot id appears more than once; later duplicates are skipped. */
  shotDuplicateId: "shot_duplicate_id",
  /** A shot references a camera the project does not contain. */
  shotCameraNotImported: "shot_camera_not_imported",
} as const);

/** Codes the Godot connector emits inside its engine report warnings. */
export const DIRECTOR_GODOT_CONNECTOR_OMISSION_CODES = Object.freeze({
  /** The shot has no camera binding in Director; there is nothing to cut to. */
  shotNoCameraBinding: "shot_no_camera_binding",
  /** The bound camera was not imported into the Godot scene. */
  shotCameraNotImported: "shot_camera_not_imported",
  /** The bound director_id resolved to a node that is not a Camera3D. */
  shotTargetNotCamera: "shot_target_not_camera",
  /** The shot starts inside the previous shot's range; the later cut wins. */
  shotOverlapsPrevious: "shot_overlaps_previous",
  /** Godot has no runtime rect-area light node; the light cannot be represented. */
  lightRectAreaUnsupported: "light_rect_area_unsupported",
  /** A WorldEnvironment ambient term was already baked from an earlier light. */
  lightAmbientDuplicate: "light_ambient_duplicate",
  /** The ambient/hemisphere light is hidden in Director; nothing to bake. */
  lightAmbientInvisible: "light_ambient_invisible",
  /** The light type is outside the Director light vocabulary the connector knows. */
  lightTypeUnknown: "light_type_unknown",
  /** Hemisphere sky/ground gradients flatten into one constant ambient color. */
  lightHemisphereApproximated: "light_hemisphere_approximated",
  /** A custom ShaderMaterial cannot travel through the handoff. */
  materialCustomShader: "material_custom_shader",
  /** Director material channels without a StandardMaterial3D equivalent. */
  materialChannelUnsupported: "material_channel_unsupported",
} as const);

/** A structured code the Gateway emits in Godot bake warnings. */
export type DirectorGodotGatewayOmissionCode =
  (typeof DIRECTOR_GODOT_GATEWAY_OMISSION_CODES)[keyof typeof DIRECTOR_GODOT_GATEWAY_OMISSION_CODES];

/** A structured code the Godot connector emits in report warnings. */
export type DirectorGodotConnectorOmissionCode =
  (typeof DIRECTOR_GODOT_CONNECTOR_OMISSION_CODES)[keyof typeof DIRECTOR_GODOT_CONNECTOR_OMISSION_CODES];
