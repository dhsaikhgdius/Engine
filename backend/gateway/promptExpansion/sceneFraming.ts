import {
  DIRECTOR_DEFAULT_SUBJECT_HEIGHT_M,
  buildDirectorFramingPhrase,
  deriveDirectorShotLanguage,
} from "@director/project-schema";
import type { CameraObject, StageItem, StageScene, Vec3 } from "@director/stage-protocol";

/**
 * Measured framing language for scene prompt contexts.
 *
 * Reads each Stage camera against the humanoid it frames through the shared
 * film-language module, and renders camera track items as the plain move
 * vocabulary video models understand. Prompt expansion therefore carries the
 * real measured blocking — size, view, level, lens, distance, and move —
 * instead of a generic shot string the model would have to guess from.
 */

/**
 * Ground-plane facing yaw of a stage object from its XYZ Euler rotation.
 * Characters flipped through (π, yaw, π) resolve to the same heading as the
 * equivalent pure yaw, so view/side reads stay correct for mirrored poses.
 */
function stageObjectYawRad(rotation: readonly [number, number, number]): number {
  const [pitch, yaw] = rotation;
  return Math.atan2(Math.sin(yaw), Math.cos(yaw) * Math.cos(pitch));
}

function horizontalDistance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[2] - b[2]);
}

/**
 * The humanoid a camera is reading: the one nearest to the camera's aim
 * point on the ground plane. Null when the scene has no humanoid to frame.
 */
function resolveFramedHumanoid(scene: StageScene, aimPoint: readonly number[]) {
  let nearest: { id: string; position: Vec3; rotation: Vec3; scale: Vec3 } | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const [id, object] of Object.entries(scene.objects)) {
    if (object.kind !== "humanoid") continue;
    const distance = horizontalDistance(object.position, aimPoint);
    if (distance < nearestDistance) {
      nearest = { id, position: object.position, rotation: object.rotation, scale: object.scale };
      nearestDistance = distance;
    }
  }
  return nearest;
}

/**
 * One-line measured framing for a Stage camera, e.g.
 * "medium shot on a 50mm lens, eye level, a three-quarter front view from
 * the subject's right, 2.4m from the subject". Null when no humanoid exists
 * to read the framing against.
 */
export function stageSceneCameraFraming(scene: StageScene, camera: CameraObject): string | null {
  const aimPoint = scene.objects[camera.targetId]?.position ?? camera.position;
  const subject = resolveFramedHumanoid(scene, aimPoint);
  if (!subject) return null;
  const language = deriveDirectorShotLanguage(
    {
      position: [...camera.position] as [number, number, number],
      target: [...aimPoint] as [number, number, number],
      focalLengthMm: camera.focalLengthMm,
      aspectRatio: scene.recordAspect,
    },
    {
      position: [...subject.position] as [number, number, number],
      yawRad: stageObjectYawRad(subject.rotation),
      heightM: DIRECTOR_DEFAULT_SUBJECT_HEIGHT_M * subject.scale[1],
    },
  );
  return `${buildDirectorFramingPhrase(language)}, ${language.distanceM.toFixed(1)}m from the subject`;
}

function formatDegrees(angleDeg: number): string {
  return `${Math.round(Math.abs(angleDeg))}°`;
}

function formatMetres(units: number): string {
  return `${Math.abs(units).toFixed(1)}m`;
}

function cameraMovePhrase(item: Extract<StageItem, { kind: "cam-move" }>): string {
  const turn = item.direction === "ccw" ? "left" : "right";
  switch (item.move) {
    case "orbit": {
      const rise =
        item.heightDeltaUnits !== 0
          ? ` while ${item.heightDeltaUnits > 0 ? "rising" : "descending"} ${formatMetres(item.heightDeltaUnits)}`
          : "";
      return `orbit ${turn} ${formatDegrees(item.angleDeg)} around the subject${rise}`;
    }
    case "dolly": {
      if (item.distanceScale === 1) return "hold distance";
      const inward = item.distanceScale < 1;
      return `dolly ${inward ? "in" : "out"} to ${item.distanceScale.toFixed(2)}x the starting distance`;
    }
    case "truck":
      return `truck ${formatMetres(item.distanceScale)} across the subject line`;
    case "crane":
      return `crane ${item.heightDeltaUnits >= 0 ? "up" : "down"} ${formatMetres(item.heightDeltaUnits)}`;
    case "pan":
      return `pan ${turn} ${formatDegrees(item.angleDeg)}`;
  }
}

/**
 * A camera track item as plain move vocabulary with its timing window, e.g.
 * "orbit left 360° around the subject @0.00s+5.00s". Non-camera items keep
 * their raw kind so the timeline stays fully described.
 */
export function describeStageCameraAction(item: StageItem): string {
  const window = `@${item.startS.toFixed(2)}s+${item.durationS.toFixed(2)}s`;
  switch (item.kind) {
    case "cam-move":
      return `${cameraMovePhrase(item)} ${window}`;
    case "cam-still":
      return `hold a locked-off frame${item.focalLengthMm ? ` on a ${item.focalLengthMm}mm lens` : ""} ${window}`;
    case "cam-path":
      return `travel a ${item.points.length}-point path aiming at ${item.aim === "subject" ? "the subject" : item.aim === "travel" ? "the direction of travel" : "a locked frame"} ${window}`;
    case "cam-follow":
      return `follow ${item.objectId ? "the subject" : "nothing"} ${window}`;
    default:
      return `${item.kind} ${window}`;
  }
}
