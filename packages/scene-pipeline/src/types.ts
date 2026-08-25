// @director/scene-pipeline — 3D scene whitebox generation pipeline types.
// Converts natural language descriptions into structured 3D scene layouts.

/**
 * A single object in the scene layout.
 * This is the output of the LLM planner — a semantic description
 * that the assembler converts into concrete Stage operations.
 */
export interface SceneObject {
  /** Unique id within the layout. */
  id: string;
  /** Human-readable label, e.g. "沙发", "茶几". */
  label: string;
  /** What kind of object this is. */
  kind: SceneObjectKind;
  /** 3D position in world space (meters). */
  position: Vec3;
  /** Euler rotation in degrees. */
  rotation: Vec3;
  /** Scale multiplier (1.0 = default size). */
  scale: Vec3;
  /** Optional color hint (hex). */
  color?: string;
  /** Optional parent object id for grouping. */
  parentId?: string;
  /** Optional description used by the LLM to explain placement. */
  description?: string;
}

export type SceneObjectKind =
  | "floor"
  | "wall"
  | "ceiling"
  | "door"
  | "window"
  | "furniture"
  | "light"
  | "prop"
  | "character"
  | "camera"
  | "custom";

/** A 3D vector with x, y, z components. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Camera placement in the scene.
 */
export interface CameraPlacement {
  /** Position in world space. */
  position: Vec3;
  /** Look-at target in world space. */
  target: Vec3;
  /** Focal length in mm. */
  focalLengthMm?: number;
  /** Optional label. */
  label?: string;
}

/**
 * Lighting configuration.
 */
export interface LightConfig {
  /** Type of light. */
  type: "ambient" | "directional" | "point" | "spot";
  /** Color (hex). */
  color?: string;
  /** Intensity (0-1 for ambient, arbitrary for others). */
  intensity?: number;
  /** Position (for point/spot lights). */
  position?: Vec3;
  /** Direction (for directional/spot lights). */
  direction?: Vec3;
}

/**
 * A complete scene layout — the output of the planning phase.
 */
export interface SceneLayout {
  /** Version of the layout schema. */
  version: 1;
  /** Human-readable scene name. */
  name: string;
  /** Brief description of the scene. */
  description?: string;
  /** Room dimensions in meters. */
  room: {
    width: number;
    depth: number;
    height: number;
  };
  /** Objects in the scene. */
  objects: SceneObject[];
  /** Camera placements. */
  cameras?: CameraPlacement[];
  /** Lighting configuration. */
  lights?: LightConfig[];
  /** Optional metadata. */
  metadata?: Record<string, unknown>;
}

/**
 * Input to the scene pipeline.
 */
export interface ScenePipelineInput {
  /** Natural language description of the desired scene. */
  prompt: string;
  /** Optional room dimensions override. */
  room?: { width: number; depth: number; height: number };
  /** Optional style guidance. */
  style?: "modern" | "classic" | "minimalist" | "industrial" | "natural";
  /** Optional camera count. */
  cameraCount?: number;
  /** Optional constraints. */
  constraints?: string[];
}

/**
 * Output from the pipeline.
 */
export interface ScenePipelineOutput {
  /** The generated layout. */
  layout: SceneLayout;
  /** The raw LLM response (for debugging). */
  rawResponse?: string;
  /** Validation issues found (if any). */
  warnings?: SceneValidationIssue[];
  /** Timing info. */
  timing: {
    planningMs: number;
    assemblyMs: number;
    validationMs: number;
    totalMs: number;
  };
}

/**
 * A validation issue found in the scene layout.
 */
export interface SceneValidationIssue {
  /** Severity level. */
  level: "warning" | "error";
  /** Object id (if applicable). */
  objectId?: string;
  /** Human-readable message. */
  message: string;
  /** Suggested fix. */
  suggestion?: string;
}

/**
 * A Stage operation — the concrete command that modifies the 3D scene.
 * These map to the existing Director Stage protocol operations.
 */
export type StageOperation =
  | { op: "addObject"; object: SceneObject }
  | { op: "removeObject"; objectId: string }
  | { op: "updateObject"; objectId: string; changes: Partial<SceneObject> }
  | { op: "setRoom"; width: number; depth: number; height: number }
  | { op: "addCamera"; camera: CameraPlacement }
  | { op: "addLight"; light: LightConfig }
  | { op: "setAmbientLight"; color: string; intensity: number };

/**
 * An assembly plan — a sequence of Stage operations that build the scene.
 */
export interface AssemblyPlan {
  /** Ordered list of operations. */
  operations: StageOperation[];
  /** Total estimated cost (for logging). */
  estimatedCost?: number;
}