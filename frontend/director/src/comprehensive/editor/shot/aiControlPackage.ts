import type { DirectorProject } from "../schema/directorProject";
import {
  DEFAULT_DIRECTOR_SHOT_RENDER_PASSES,
  DIRECTOR_DEPTH_EXR_PATH_TEMPLATE,
  stableArtifactStringify,
  type DirectorShotPackageArtifactInput,
  type DirectorShotRenderPassId,
} from "./shotPackage";
import type { DirectorShotIr } from "./shotIr";
import {
  buildDirectorCameraTrajectory,
  type BuildDirectorCameraTrajectoryOptions,
  type DirectorCameraTrajectory,
} from "./cameraTrajectory";

/** Contract identifier for the Director AI control package format. */
export const DIRECTOR_AI_CONTROL_CONTRACT = "director-ai-control-v1" as const;

/** Provider-neutral AI control document describing one evaluated shot frame. */
export interface DirectorAiControlDocument {
  schemaVersion: 1;
  contract: typeof DIRECTOR_AI_CONTROL_CONTRACT;
  shotId: string;
  revisionFingerprint: string;
  primaryFrame: number;
  cameraId: string;
  coordinateSystem: DirectorCameraTrajectory["coordinateSystem"];
  inputs: {
    clean: string | null;
    /** Optional neutral clay render from the same evaluated camera frame. */
    clay?: string;
    /** Optional material-only base color and texture render. */
    albedo?: string;
    roughness?: string;
    metalness?: string;
    emissive?: string;
    ao?: string;
    shadow?: string;
    depth: string | null;
    /** Present only when the package was captured with the float EXR depth option. */
    depthExr?: string;
    normal: string | null;
    objectId: string | null;
    mask: string | null;
    /** Present only when the opt-in geometry lineart pass was captured. */
    lineart?: string;
    /** Present only when the opt-in semantic category pass was captured. */
    semantic?: string;
    /** Present only when the opt-in OpenPose (COCO-18) pose pass was captured. */
    pose?: string;
    /** Present only when the opt-in frame-to-frame motion field pass was captured. */
    motion?: string;
    shotIr: string;
    cameraTrajectory: string;
  };
  generationGuidance: {
    preserve: string[];
    avoid: string[];
    subjectIds: string[];
    cameraSummary: string;
  };
}

/** Result of building AI control artifacts, including the document and all sidecar files. */
export interface BuildDirectorAiControlArtifactsResult {
  /** The AI control document itself. */
  control: DirectorAiControlDocument;
  /** The camera trajectory sampled across the production range. */
  trajectory: DirectorCameraTrajectory;
  /** Artifacts to include in the shot package manifest. */
  artifacts: DirectorShotPackageArtifactInput[];
  /** Text sidecar files (ShotIR, trajectory, control JSON, README). */
  textFiles: Array<{ id: string; path: string; mimeType: string; content: string }>;
}

/** Options for building AI control artifacts. */
export interface BuildDirectorAiControlArtifactsOptions extends BuildDirectorCameraTrajectoryOptions {
  /** Which render passes to include in the control package. */
  renderPasses?: DirectorShotRenderPassId[];
  /** Advertise the float EXR depth artifact in control inputs. Off by default. */
  depthExr?: boolean;
}

function renderPassPath(pass: string, frame: number) {
  return `passes/${pass}/frame-${String(frame).padStart(6, "0")}.png`;
}

function createReadme(control: DirectorAiControlDocument) {
  return [
    "# Director AI control package",
    "",
    `Contract: ${control.contract}`,
    `Shot: ${control.shotId}`,
    `Primary frame: ${control.primaryFrame}`,
    "",
    "The PNG passes are helper-free and share one evaluated camera frame.",
    "camera/trajectory.json contains frame-native camera and lens samples in metres/degrees.",
    "metadata/shot-ir.json is the provider-neutral scene description; ai/control.json points to every control input.",
    "Use object-id for stable segmentation, mask for a binary foreground matte, and depth/normal only as data textures.",
    "",
    "Do not infer scene truth from a generated prompt. ShotIR and the camera trajectory remain canonical.",
  ].join("\n");
}

/**
 * Creates portable, provider-neutral AI sidecars around the real Stage passes.
 *
 * @param project - The Director project.
 * @param shotIr - The evaluated shot IR.
 * @param options - Optional render pass selection and depth EXR flag.
 * @returns The control document, camera trajectory, and all sidecar artifacts.
 */
export function buildDirectorAiControlArtifacts(
  project: DirectorProject,
  shotIr: DirectorShotIr,
  options: BuildDirectorAiControlArtifactsOptions = {},
): BuildDirectorAiControlArtifactsResult {
  // Defaults mirror the default capture set; opt-in passes must be requested.
  const {
    renderPasses = DEFAULT_DIRECTOR_SHOT_RENDER_PASSES.map((pass) => pass.id),
    depthExr = false,
    ...trajectoryOptions
  } = options;
  const enabledPasses = new Set(renderPasses);
  const trajectory = buildDirectorCameraTrajectory(project, {
    cameraId: shotIr.camera.id,
    ...trajectoryOptions,
  });
  const frame = shotIr.frame;
  const control: DirectorAiControlDocument = {
    schemaVersion: 1,
    contract: DIRECTOR_AI_CONTROL_CONTRACT,
    shotId: shotIr.id,
    revisionFingerprint: shotIr.revisionFingerprint,
    primaryFrame: frame,
    cameraId: shotIr.camera.id,
    coordinateSystem: trajectory.coordinateSystem,
    inputs: {
      clean: enabledPasses.has("clean") ? renderPassPath("clean", frame) : null,
      ...(enabledPasses.has("clay") ? { clay: renderPassPath("clay", frame) } : {}),
      ...(enabledPasses.has("albedo") ? { albedo: renderPassPath("albedo", frame) } : {}),
      ...(enabledPasses.has("roughness") ? { roughness: renderPassPath("roughness", frame) } : {}),
      ...(enabledPasses.has("metalness") ? { metalness: renderPassPath("metalness", frame) } : {}),
      ...(enabledPasses.has("emissive") ? { emissive: renderPassPath("emissive", frame) } : {}),
      ...(enabledPasses.has("ao") ? { ao: renderPassPath("ao", frame) } : {}),
      ...(enabledPasses.has("shadow") ? { shadow: renderPassPath("shadow", frame) } : {}),
      depth: enabledPasses.has("depth") ? renderPassPath("depth", frame) : null,
      // Absent unless requested so default control.json bytes stay unchanged.
      ...(depthExr && enabledPasses.has("depth")
        ? { depthExr: DIRECTOR_DEPTH_EXR_PATH_TEMPLATE.replace("{frame:06}", String(frame).padStart(6, "0")) }
        : {}),
      normal: enabledPasses.has("normal") ? renderPassPath("normal", frame) : null,
      objectId: enabledPasses.has("object-id") ? renderPassPath("object-id", frame) : null,
      mask: enabledPasses.has("mask") ? renderPassPath("mask", frame) : null,
      // Absent unless requested so default control.json bytes stay unchanged.
      ...(enabledPasses.has("lineart") ? { lineart: renderPassPath("lineart", frame) } : {}),
      // Absent unless requested so default control.json bytes stay unchanged.
      ...(enabledPasses.has("semantic") ? { semantic: renderPassPath("semantic", frame) } : {}),
      ...(enabledPasses.has("pose") ? { pose: renderPassPath("pose", frame) } : {}),
      // Absent unless requested so default control.json bytes stay unchanged.
      ...(enabledPasses.has("motion") ? { motion: renderPassPath("motion", frame) } : {}),
      shotIr: "metadata/shot-ir.json",
      cameraTrajectory: "camera/trajectory.json",
    },
    generationGuidance: {
      preserve: [
        "camera framing and lens geometry",
        "subject identity and screen position",
        "depth ordering and occlusion",
        "camera trajectory timing",
      ],
      avoid: ["editor helpers", "gizmos", "labels", "geometry drift", "identity drift", "camera discontinuity"],
      subjectIds: shotIr.objects.map((object) => object.id),
      cameraSummary: `${shotIr.camera.focalLengthMm}mm ${shotIr.camera.aspectRatio}, ${shotIr.camera.actionMode}`,
    },
  };

  const textFiles = [
    {
      id: "shot-ir",
      path: "metadata/shot-ir.json",
      mimeType: "application/json",
      content: `${stableArtifactStringify(shotIr)}\n`,
    },
    {
      id: "camera-trajectory",
      path: "camera/trajectory.json",
      mimeType: "application/json",
      content: `${stableArtifactStringify(trajectory)}\n`,
    },
    {
      id: "ai-control",
      path: "ai/control.json",
      mimeType: "application/json",
      content: `${stableArtifactStringify(control)}\n`,
    },
    {
      id: "control-readme",
      path: "README.md",
      mimeType: "text/markdown",
      content: `${createReadme(control)}\n`,
    },
  ];
  return {
    control,
    trajectory,
    textFiles,
    artifacts: textFiles.map((file) => ({
      ...file,
      kind: file.id === "ai-control" || file.id === "control-readme" ? "control-package" : "metadata",
    })),
  };
}
