import { z } from "zod";
import type { DirectorCameraAspectRatio, DirectorTransform } from "@director/project-schema";
import {
  getDirectorCameraAspectValue,
  getVerticalFovFromFocalLength,
} from "@director/project-schema";
import { getGroundedLabelY } from "@director/project-schema";
import { POSE_PRESET_IDS } from "@director/project-schema";
import type { DirectorAuthoringAction } from "./directorAuthoring";
import { strictAction } from "@director/protocol/strictProtocolVariant";
import { directorCameraAspectRatioSchema as aspectRatio } from "@director/protocol/directorCameraProtocol";

const blockingId = z.string().trim().min(1).max(200);
const blockingName = z.string().trim().min(1).max(240);
const bodyType = z.enum(["mannequin", "female", "broad", "muscular", "slim", "teen", "child", "chibi"]);

/**
 * Validation schema for a compose_blocking high-level blocking intent.
 *
 * Compose_blocking arranges characters and a camera into a 3D scene layout
 * using semantic shot descriptions (angle, height, shot size, layout) instead
 * of raw transforms. The schema validates character placement, camera framing,
 * and layout presets before they are compiled into atomic authoring actions
 * by {@link buildDirectorBlockingActions}.
 */
export const directorComposeBlockingActionSchema = strictAction("compose_blocking", {
  characters: z
    .array(
      z.strictObject({
        id: blockingId,
        name: blockingName,
        body_type: bodyType.optional(),
        pose_preset_id: z.enum(POSE_PRESET_IDS).optional(),
        facing: z.enum(["camera", "away", "left", "right", "toward"]).optional(),
        color: z.string().trim().min(1).max(80).optional(),
        locked: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(12),
  layout: z.enum(["facing", "side-by-side", "line", "behind", "circle"]).optional(),
  spacing_m: z.number().finite().min(0.9).max(8).optional(),
  camera: z.strictObject({
    id: blockingId,
    object_id: blockingId,
    name: blockingName,
    angle: z.enum(["front", "three-quarter", "side", "back"]).optional(),
    height: z.enum(["low", "eye", "high", "overhead"]).optional(),
    shot: z.enum(["wide", "full", "medium"]).optional(),
    focal_length_mm: z.number().finite().min(12).max(200).optional(),
    aspect_ratio: aspectRatio.optional(),
    activate: z.boolean().optional(),
  }),
});

/** Inferred payload type for a compose_blocking action, derived from {@link directorComposeBlockingActionSchema}. */
export type DirectorComposeBlockingAction = z.infer<typeof directorComposeBlockingActionSchema>;

/** 2D ground-plane point for character placement; y is derived from ground height. */
type Point = { x: number; z: number };
/** Any atomic authoring action except compose_blocking, which is the high-level input this module compiles from. */
type ExpandedBlockingAction = Exclude<DirectorAuthoringAction, { action: "compose_blocking" }>;

// Role-based color palette for automatic character differentiation.
// Each index in the characters array receives a distinct default color;
// the palette cycles when there are more characters than colors.
const ROLE_COLORS = ["#d19a3a", "#4f8ef7", "#e0524d", "#5a9f68", "#8d6ac8", "#d07b39"];
// Azimuth angle in radians from the scene origin for each camera angle preset.
// Values are measured counter-clockwise from the front (positive Z axis).
const CAMERA_AZIMUTH = {
  front: 0,
  "three-quarter": Math.PI / 4,
  side: Math.PI / 2,
  back: Math.PI,
} as const;
// Camera Y position in meters for each height preset.
// Eye height targets the average human eye line; overhead sits high enough
// to clear the tallest character by a comfortable margin.
const CAMERA_HEIGHT = { low: 0.85, eye: 1.65, high: 3.2, overhead: 7.5 } as const;
// The fraction of the vertical field-of-view the subject occupies for each shot size.
// Values are tuned so that characters fill the frame with natural headroom
// at the default spacing and lens for each shot.
const SHOT_FILL = { wide: 0.54, full: 0.68, medium: 0.78 } as const;
// Default focal length in mm for each shot size, chosen to match
// standard cinematographic conventions (wide ~35mm, medium ~65mm).
const SHOT_LENS = { wide: 35, full: 50, medium: 65 } as const;
// Default inter-character spacing in meters for each shot size.
// Wider shots need more spacing to keep characters visually separated;
// tighter shots pull characters closer for intimacy.
const SHOT_SPACING = { wide: 1.8, full: 1.55, medium: 1.35 } as const;

function placedPoints(count: number, layout: DirectorComposeBlockingAction["layout"], spacing: number): Point[] {
  if (count <= 1) return [{ x: 0, z: 0 }];
  switch (layout) {
    case "facing":
      if (count === 2)
        return [
          { x: -spacing * 0.5, z: 0 },
          { x: spacing * 0.5, z: 0 },
        ];
      return placedPoints(count, "circle", spacing);
    case "line":
      return Array.from({ length: count }, (_, index) => ({
        x: 0,
        z: (index - (count - 1) / 2) * spacing,
      }));
    case "behind":
      return Array.from({ length: count }, (_, index) => ({
        x: (index === 0 ? 0 : index % 2 === 0 ? 0.55 : -0.55) * spacing,
        z: (index === 0 ? 0.65 : -0.45 - Math.floor((index - 1) / 2) * 0.8) * spacing,
      }));
    case "circle": {
      const radius = Math.max(1.25, (spacing * count) / (Math.PI * 2));
      return Array.from({ length: count }, (_, index) => {
        const angle = (index / count) * Math.PI * 2;
        return { x: Math.sin(angle) * radius, z: Math.cos(angle) * radius };
      });
    }
    case "side-by-side":
    default:
      return Array.from({ length: count }, (_, index) => ({
        x: (index - (count - 1) / 2) * spacing,
        z: 0,
      }));
  }
}

function nearestCharacterId(index: number, characters: DirectorComposeBlockingAction["characters"], points: Point[]) {
  let nearestId: string | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  points.forEach((point, candidateIndex) => {
    if (candidateIndex === index) return;
    const distance = Math.hypot(point.x - points[index].x, point.z - points[index].z);
    if (distance < nearestDistance) {
      nearestId = characters[candidateIndex].id;
      nearestDistance = distance;
    }
  });
  return nearestId;
}

function yawToward(from: Point, to: Point) {
  return Math.atan2(to.x - from.x, to.z - from.z);
}

function aspectValue(aspect: DirectorCameraAspectRatio) {
  return getDirectorCameraAspectValue(aspect);
}

function buildCamera(
  action: DirectorComposeBlockingAction,
  points: Point[],
): {
  position: [number, number, number];
  target: [number, number, number];
  lens: number;
  aspect: DirectorCameraAspectRatio;
} {
  const shot = action.camera.shot ?? "full";
  const angle = action.camera.angle ?? "three-quarter";
  const height = action.camera.height ?? "eye";
  const lens = action.camera.focal_length_mm ?? SHOT_LENS[shot];
  const aspect = action.camera.aspect_ratio ?? "16:9";
  const centerX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const centerZ = points.reduce((sum, point) => sum + point.z, 0) / points.length;
  const maxHeight = Math.max(...action.characters.map((character) => getGroundedLabelY(character.body_type)));
  const radius = Math.max(0.55, ...points.map((point) => Math.hypot(point.x - centerX, point.z - centerZ) + 0.55));
  const verticalFov = (getVerticalFovFromFocalLength(lens, aspect) * Math.PI) / 180;
  const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * aspectValue(aspect));
  const fill = SHOT_FILL[shot];
  const verticalDistance = maxHeight / 2 / Math.max(0.1, Math.tan(verticalFov / 2) * fill);
  const horizontalDistance = radius / Math.max(0.1, Math.tan(horizontalFov / 2) * fill);
  const distance = Math.max(3.2, verticalDistance, horizontalDistance) + radius * 0.5;
  const azimuth = CAMERA_AZIMUTH[angle];
  const targetY = maxHeight * 0.48;
  const cameraY = height === "overhead" ? Math.max(CAMERA_HEIGHT.overhead, distance * 0.92) : CAMERA_HEIGHT[height];
  return {
    position: [centerX + Math.sin(azimuth) * distance, cameraY, centerZ + Math.cos(azimuth) * distance],
    target: [centerX, targetY, centerZ],
    lens,
    aspect,
  };
}

/**
 * Compile a director-level blocking intent into the existing atomic authoring vocabulary.
 * The returned actions remain ordinary DirectorProject mutations; no parallel scene model is introduced.
 */
export function buildDirectorBlockingActions(
  action: DirectorComposeBlockingAction,
  groundHeight: number,
): ExpandedBlockingAction[] {
  const shot = action.camera.shot ?? "full";
  const layout = action.layout ?? (action.characters.length > 1 ? "side-by-side" : "side-by-side");
  const spacing = action.spacing_m ?? SHOT_SPACING[shot];
  const points = placedPoints(action.characters.length, layout, spacing);
  const camera = buildCamera(action, points);
  const cameraPoint = { x: camera.position[0], z: camera.position[2] };
  const objects: ExpandedBlockingAction[] = action.characters.map((character, index) => {
    const point = points[index];
    const facing = character.facing ?? (layout === "facing" || layout === "circle" ? "toward" : "camera");
    const targetId = facing === "toward" ? nearestCharacterId(index, action.characters, points) : null;
    const targetIndex = targetId ? action.characters.findIndex((candidate) => candidate.id === targetId) : -1;
    const baseYaw =
      facing === "toward" && targetIndex >= 0
        ? yawToward(point, points[targetIndex])
        : facing === "left"
          ? Math.PI / 2
          : facing === "right"
            ? -Math.PI / 2
            : yawToward(point, cameraPoint);
    const yaw = facing === "away" ? baseYaw + Math.PI : baseYaw;
    const transform: DirectorTransform = {
      position: [point.x, groundHeight, point.z],
      rotation: [0, yaw, 0],
      scale: [1, 1, 1],
    };
    return {
      action: "add_object",
      id: character.id,
      name: character.name,
      kind: "character",
      transform,
      body_type: character.body_type ?? "mannequin",
      pose_preset_id: character.pose_preset_id ?? "stand",
      color: character.color ?? ROLE_COLORS[index % ROLE_COLORS.length],
      placement_mode: "grounded",
      ...(targetId ? { look_target_object_id: targetId } : {}),
      ...(character.locked !== undefined ? { locked: character.locked } : {}),
    };
  });

  return [
    ...objects,
    {
      action: "add_camera",
      id: action.camera.id,
      object_id: action.camera.object_id,
      name: action.camera.name,
      position: camera.position,
      target: camera.target,
      focal_length_mm: camera.lens,
      aspect_ratio: camera.aspect,
      action_mode: "still",
      activate: action.camera.activate ?? true,
    },
  ];
}
