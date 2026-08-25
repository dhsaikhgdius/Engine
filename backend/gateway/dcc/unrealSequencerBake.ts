import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  DIRECTOR_UNREAL_SEQUENCER_BAKE_CONTRACT,
  directorTransformToCanonicalDcc,
  directorUnrealSequencerBakeSchema,
  type DirectorDccTransform,
  type DirectorUnrealBakedEntity,
  type DirectorUnrealSequencerBake,
  type DirectorUnrealTransformSample,
} from "@director/dcc-protocol";
import { directorCameraLookEuler } from "@director/dcc-interchange";
import {
  evaluateDirectorCameraAtFrame,
  evaluateDirectorObjectAtFrame,
  getDirectorCameraSensorGate,
  getDirectorCameraUsedSensorHeight,
  getDirectorTimelineFps,
  getFocalLengthFromVerticalFov,
  normalizeDirectorTimebase,
  type DirectorCameraActionTarget,
  type DirectorProject,
  type DirectorTransform,
} from "@director/project-schema";

/**
 * Total transform-sample budget for one bake. When animated entities times
 * sampled frames would exceed it, the sampler widens the frame stride and
 * records a downsampling warning instead of failing the handoff.
 */
const MAX_TOTAL_TRANSFORM_SAMPLES = 120_000;

/** Maximum baked entities; beyond this the bake truncates with a warning. */
const MAX_BAKED_ENTITIES = 2_048;

const POSITION_TOLERANCE = 1e-7;
const QUATERNION_DOT_TOLERANCE = 1e-9;

/** The bake sidecar written into a private Unreal job directory. */
export interface UnrealSequencerBakeFile {
  /** Absolute path of the written `animation.json` sidecar. */
  bakePath: string;
  /** SHA-256 of the exact bytes written, pinned through the connector argv. */
  bakeSha256: string;
  /** The validated bake manifest. */
  bake: DirectorUnrealSequencerBake;
}

function roundComponent(value: number): number {
  const rounded = Math.round(value * 1e9) / 1e9;
  // Normalize -0 so JSON output is deterministic across platforms.
  return Object.is(rounded, -0) ? 0 : rounded;
}

function roundedTransform(transform: DirectorDccTransform): DirectorDccTransform {
  return {
    location: transform.location.map(roundComponent) as [number, number, number],
    rotationQuaternion: transform.rotationQuaternion.map(roundComponent) as [number, number, number, number],
    scale: transform.scale.map(roundComponent) as [number, number, number],
  };
}

function transformsClose(left: DirectorDccTransform, right: DirectorDccTransform): boolean {
  for (let index = 0; index < 3; index += 1) {
    if (Math.abs(left.location[index]! - right.location[index]!) > POSITION_TOLERANCE) return false;
    if (Math.abs(left.scale[index]! - right.scale[index]!) > POSITION_TOLERANCE) return false;
  }
  const dot = left.rotationQuaternion.reduce((sum, value, index) => sum + value * right.rotationQuaternion[index]!, 0);
  return Math.abs(Math.abs(dot) - 1) <= QUATERNION_DOT_TOLERANCE;
}

function sceneTransformOf(project: DirectorProject): DirectorTransform {
  const scene = project.scene;
  return {
    position: [...scene.position] as [number, number, number],
    rotation: [...scene.rotation] as [number, number, number],
    scale: [scene.scale, scene.scale, scene.scale],
  };
}

function playbackRange(project: DirectorProject): { frameStart: number; frameEnd: number } {
  const timeline = project.scene.timeline;
  if (timeline) {
    const frameStart = Math.round(timeline.frameStart);
    const frameEnd = Math.max(frameStart, Math.round(timeline.frameEnd));
    return { frameStart, frameEnd };
  }
  // Without a timeline, cover authored keyframes and storyboard shots.
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  const consider = (frame: number) => {
    if (!Number.isFinite(frame)) return;
    min = Math.min(min, Math.round(frame));
    max = Math.max(max, Math.round(frame));
  };
  for (const entity of [...project.objects, ...project.cameras]) {
    for (const keyframe of entity.animation?.keyframes ?? []) consider(keyframe.frame);
  }
  for (const shot of project.storyboard?.shots ?? []) {
    consider(shot.frameStart);
    consider(shot.frameEnd);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { frameStart: 0, frameEnd: 0 };
  return { frameStart: min, frameEnd: Math.max(min, max) };
}

function sampledFrames(frameStart: number, frameEnd: number, stride: number): number[] {
  const frames: number[] = [];
  for (let frame = frameStart; frame < frameEnd; frame += stride) frames.push(frame);
  frames.push(frameEnd);
  return frames;
}

function omittedChannelsOf(entity: {
  animation?: { keyframes: Array<{ poseValues?: Record<string, number> }>; motionBlocks?: unknown[] } | undefined;
  characterRig?: unknown;
}): DirectorUnrealBakedEntity["omittedChannels"] {
  const omitted: NonNullable<DirectorUnrealBakedEntity["omittedChannels"]> = [];
  if (entity.animation?.keyframes.some((keyframe) => keyframe.poseValues)) omitted.push("pose_values");
  if (entity.animation?.motionBlocks?.length) omitted.push("motion_blocks");
  if (entity.characterRig) omitted.push("character_rig");
  return omitted.length > 0 ? omitted : undefined;
}

function omissionWarnings(name: string, omitted: DirectorUnrealBakedEntity["omittedChannels"]): string[] {
  if (!omitted) return [];
  const labels: Record<NonNullable<DirectorUnrealBakedEntity["omittedChannels"]>[number], string> = {
    pose_values: "rig pose keyframes (Control-Rig-style channels)",
    motion_blocks: "character motion clips",
    character_rig: "character rig state",
  };
  return omitted.map(
    (channel) =>
      `${name}: ${labels[channel]} are not carried by the Sequencer bake; only world transforms were baked (warn-and-omit).`,
  );
}

/**
 * Sample a Director project's animation into an Unreal Sequencer bake.
 *
 * Object and camera transforms are evaluated per frame with the canonical
 * Director evaluators (easing curves, trajectories, camera path/follow
 * actions), composed with the scene transform, and stored as canonical
 * Director-space world transforms. Camera vertical-fov keys become focal
 * length samples against the camera's own filmback. Entities whose sampled
 * transforms never change and that have no authored keyframes are skipped.
 *
 * @param project - The live Director project snapshot from the exchange package.
 * @param packageId - The exchange package id this bake belongs to.
 * @param sourceRevision - The project revision the exchange package captured.
 * @returns A validated bake manifest.
 */
export function buildUnrealSequencerBake(
  project: DirectorProject,
  packageId: string,
  sourceRevision: string,
): DirectorUnrealSequencerBake {
  const warnings: string[] = [];
  const timebase = normalizeDirectorTimebase(project.scene.timeline?.timebase, project.scene.timeline?.fps ?? 24);
  const fps = getDirectorTimelineFps(project.scene.timeline, 24);
  const { frameStart, frameEnd } = playbackRange(project);
  const sceneTransform = sceneTransformOf(project);

  const frameCount = frameEnd - frameStart + 1;
  const entityCount = project.objects.length + project.cameras.length;
  let frameStride = 1;
  if (entityCount > 0 && entityCount * frameCount > MAX_TOTAL_TRANSFORM_SAMPLES) {
    frameStride = Math.ceil((entityCount * frameCount) / MAX_TOTAL_TRANSFORM_SAMPLES);
    warnings.push(
      `Animation was downsampled to every ${frameStride} frames to stay inside the ${MAX_TOTAL_TRANSFORM_SAMPLES}-sample bake budget.`,
    );
  }
  const frames = sampledFrames(frameStart, frameEnd, frameStride);

  const objectSamples = new Map<string, DirectorUnrealTransformSample[]>();
  const cameraSamples = new Map<string, DirectorUnrealTransformSample[]>();
  const cameraFovByFrame = new Map<string, Array<{ frame: number; fov: number }>>();

  for (const frame of frames) {
    const evaluatedObjects = project.objects.map((object) => evaluateDirectorObjectAtFrame(object, frame, fps));
    const actionTargets: DirectorCameraActionTarget[] = evaluatedObjects.map((object) => ({
      id: object.id,
      position: [...object.transform.position] as [number, number, number],
    }));
    for (const object of evaluatedObjects) {
      const samples = objectSamples.get(object.id) ?? [];
      samples.push({
        frame,
        transform: roundedTransform(directorTransformToCanonicalDcc(object.transform, sceneTransform)),
      });
      objectSamples.set(object.id, samples);
    }
    for (const camera of project.cameras) {
      const evaluated = evaluateDirectorCameraAtFrame(camera, frame, actionTargets);
      const lookRotation = directorCameraLookEuler({ transform: evaluated.transform, target: evaluated.target });
      const worldTransform: DirectorTransform = {
        position: [...evaluated.transform.position] as [number, number, number],
        rotation: lookRotation,
        scale: [...evaluated.transform.scale] as [number, number, number],
      };
      const samples = cameraSamples.get(camera.id) ?? [];
      samples.push({
        frame,
        transform: roundedTransform(directorTransformToCanonicalDcc(worldTransform, sceneTransform)),
      });
      cameraSamples.set(camera.id, samples);
      const fovSamples = cameraFovByFrame.get(camera.id) ?? [];
      fovSamples.push({ frame, fov: evaluated.fov });
      cameraFovByFrame.set(camera.id, fovSamples);
    }
  }

  const entities: DirectorUnrealBakedEntity[] = [];
  let truncated = 0;

  for (const object of project.objects) {
    const samples = objectSamples.get(object.id)!;
    const hasAuthoredAnimation = Boolean(object.animation?.keyframes.length) && object.animation?.enabled !== false;
    const moves = samples.some((sample) => !transformsClose(sample.transform, samples[0]!.transform));
    if (!hasAuthoredAnimation && !moves) continue;
    if (entities.length >= MAX_BAKED_ENTITIES) {
      truncated += 1;
      continue;
    }
    const omittedChannels = omittedChannelsOf(object);
    entities.push({
      directorId: object.id,
      entityType: "object",
      name: object.name,
      transformSamples: samples,
      ...(omittedChannels ? { omittedChannels } : {}),
      warnings: omissionWarnings(object.name, omittedChannels),
    });
  }

  for (const camera of project.cameras) {
    const samples = cameraSamples.get(camera.id)!;
    const fovSamples = cameraFovByFrame.get(camera.id)!;
    const hasAuthoredAnimation = Boolean(camera.animation?.keyframes.length) && camera.animation?.enabled !== false;
    const followsTarget = camera.action?.mode === "follow" && Boolean(camera.action.follow?.targetObjectId);
    const moves = samples.some((sample) => !transformsClose(sample.transform, samples[0]!.transform));
    const fovVaries = fovSamples.some((sample) => Math.abs(sample.fov - fovSamples[0]!.fov) > 1e-9);
    if (!hasAuthoredAnimation && !followsTarget && !moves && !fovVaries) continue;
    if (entities.length >= MAX_BAKED_ENTITIES) {
      truncated += 1;
      continue;
    }
    const sensorGate = getDirectorCameraSensorGate(camera.sensorFormat);
    const sensorHeightMm = getDirectorCameraUsedSensorHeight(camera.aspectRatio, camera.sensorFormat);
    const focalLengthSamples = fovVaries
      ? fovSamples.map((sample) => ({
          frame: sample.frame,
          focalLengthMm: getFocalLengthFromVerticalFov(sample.fov, camera.aspectRatio, camera.sensorFormat),
        }))
      : [
          {
            frame: samples[0]!.frame,
            focalLengthMm: getFocalLengthFromVerticalFov(fovSamples[0]!.fov, camera.aspectRatio, camera.sensorFormat),
          },
        ];
    entities.push({
      directorId: camera.id,
      entityType: "camera",
      name: camera.name,
      transformSamples: samples,
      focalLengthSamples,
      filmback: { sensorWidthMm: sensorGate.width, sensorHeightMm },
      warnings: [],
    });
  }

  if (truncated > 0) {
    warnings.push(`${truncated} animated entities were omitted beyond the ${MAX_BAKED_ENTITIES}-entity bake limit.`);
  }

  return directorUnrealSequencerBakeSchema.parse({
    contract: DIRECTOR_UNREAL_SEQUENCER_BAKE_CONTRACT,
    schemaVersion: 1,
    packageId,
    provider: "unreal",
    sourceRevision,
    coordinateSystem: {
      source: "right-handed-y-up-negative-z-forward",
      destination: "right-handed-y-up-negative-z-forward",
      unit: "meter",
      linearMap: "identity",
    },
    timebase,
    playback: { frameStart, frameEnd },
    frameStride,
    entities,
    warnings,
  });
}

/**
 * Build the Sequencer bake and write it as `animation.json` into the private
 * job directory. The returned SHA-256 covers the exact bytes on disk and is
 * passed to the connector through the fixed argument array so the connector
 * can refuse tampered or truncated sidecars.
 *
 * @param project - The live Director project snapshot.
 * @param packageId - The exchange package id (job id).
 * @param sourceRevision - The exchange package's project revision.
 * @param jobDirectory - The private job directory that already holds report/return paths.
 * @returns The written sidecar path, its SHA-256, and the manifest.
 */
export async function writeUnrealSequencerBake(
  project: DirectorProject,
  packageId: string,
  sourceRevision: string,
  jobDirectory: string,
): Promise<UnrealSequencerBakeFile> {
  const bake = buildUnrealSequencerBake(project, packageId, sourceRevision);
  const bakePath = resolve(jobDirectory, "animation.json");
  const body = `${JSON.stringify(bake, null, 2)}\n`;
  await writeFile(bakePath, body, "utf8");
  return { bakePath, bakeSha256: createHash("sha256").update(body).digest("hex"), bake };
}
