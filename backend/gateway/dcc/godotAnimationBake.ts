import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  DIRECTOR_GODOT_ANIMATION_BAKE_CONTRACT,
  directorTransformToCanonicalDcc,
  directorGodotAnimationBakeSchema,
  type DirectorDccTransform,
  type DirectorGodotAnimationBake,
  type DirectorGodotBakedEntity,
  type DirectorGodotShotRange,
  type DirectorGodotTransformSample,
} from "@director/dcc-protocol";
import { directorCameraLookEuler } from "@director/dcc-interchange";
import {
  evaluateDirectorCameraAtFrame,
  evaluateDirectorObjectAtFrame,
  getDirectorTimelineFps,
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

/** Maximum storyboard shot ranges carried by one bake. */
const MAX_BAKED_SHOTS = 512;

/** Cap on the omitted pose-control / motion-clip samples carried per entity. */
const MAX_OMITTED_SAMPLES = 32;

const POSITION_TOLERANCE = 1e-7;
const QUATERNION_DOT_TOLERANCE = 1e-9;
const FOV_TOLERANCE = 1e-9;

/** The bake sidecar written into a private Godot job directory. */
export interface GodotAnimationBakeFile {
  /** Absolute path of the written `animation.json` sidecar. */
  bakePath: string;
  /** SHA-256 of the exact bytes written, pinned through the connector argv. */
  bakeSha256: string;
  /** The validated bake manifest. */
  bake: DirectorGodotAnimationBake;
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

type OmittableEntity = {
  animation?:
    | {
        keyframes: Array<{ poseValues?: Record<string, number> }>;
        motionBlocks?: Array<{ id: string; frameStart: number; frameEnd: number }>;
      }
    | undefined;
  characterRig?: unknown;
};

function omittedChannelsOf(entity: OmittableEntity): DirectorGodotBakedEntity["omittedChannels"] {
  const omitted: NonNullable<DirectorGodotBakedEntity["omittedChannels"]> = [];
  if (entity.animation?.keyframes.some((keyframe) => keyframe.poseValues)) omitted.push("pose_values");
  if (entity.animation?.motionBlocks?.length) omitted.push("motion_blocks");
  if (entity.characterRig) omitted.push("character_rig");
  return omitted.length > 0 ? omitted : undefined;
}

/**
 * Structured detail behind the `omittedChannels` claim: which pose controls
 * and motion clips were left out, so agents can act on the omission instead
 * of parsing prose. Lists are capped samples; counts stay authoritative.
 */
function omittedDetailOf(
  entity: OmittableEntity,
  omitted: DirectorGodotBakedEntity["omittedChannels"],
): DirectorGodotBakedEntity["omittedDetail"] {
  if (!omitted?.includes("pose_values") && !omitted?.includes("motion_blocks")) return undefined;
  const poseControls = new Set<string>();
  for (const keyframe of entity.animation?.keyframes ?? []) {
    for (const control of Object.keys(keyframe.poseValues ?? {})) poseControls.add(control);
  }
  const motionBlocks = entity.animation?.motionBlocks ?? [];
  return {
    poseControlCount: poseControls.size,
    poseControls: [...poseControls].sort().slice(0, MAX_OMITTED_SAMPLES),
    motionClipCount: motionBlocks.length,
    motionClips: motionBlocks.slice(0, MAX_OMITTED_SAMPLES).map((block) => ({
      id: block.id,
      frameStart: Math.round(block.frameStart),
      frameEnd: Math.round(block.frameEnd),
    })),
  };
}

function omissionWarnings(
  name: string,
  omitted: DirectorGodotBakedEntity["omittedChannels"],
  detail: DirectorGodotBakedEntity["omittedDetail"],
): string[] {
  if (!omitted) return [];
  const labels: Record<NonNullable<DirectorGodotBakedEntity["omittedChannels"]>[number], string> = {
    pose_values: "rig pose keyframes (bone-level channels)",
    motion_blocks: "character motion clips (in-place limb articulation; the root path is baked)",
    character_rig: "character rig state",
  };
  const scope: Record<NonNullable<DirectorGodotBakedEntity["omittedChannels"]>[number], string> = {
    pose_values: detail?.poseControlCount ? ` ${detail.poseControlCount} pose controls affected.` : "",
    motion_blocks: detail?.motionClipCount ? ` ${detail.motionClipCount} clips affected.` : "",
    character_rig: "",
  };
  return omitted.map(
    (channel) =>
      `${name}: ${labels[channel]} are not carried by the Godot animation bake; only world transforms were baked (warn-and-omit code: ${channel}).${scope[channel]}`,
  );
}

/**
 * Normalize storyboard shots into the bake's camera-cut ranges: rounded to
 * integer frames, clamped into the playback window, deduplicated, sorted by
 * start frame, and capped. Shots fully outside the window (or beyond the cap)
 * warn-and-omit at the Gateway; camera bindings are resolved by the connector
 * so a missing host node still gets a structured warning there.
 */
function bakedShotsOf(
  project: DirectorProject,
  frameStart: number,
  frameEnd: number,
  warnings: string[],
): DirectorGodotShotRange[] | undefined {
  const shots = project.storyboard?.shots ?? [];
  if (shots.length === 0) return undefined;
  const cameraIds = new Set(project.cameras.map((camera) => camera.id));
  const seenIds = new Set<string>();
  const ranges: DirectorGodotShotRange[] = [];
  for (const shot of shots) {
    if (seenIds.has(shot.id)) {
      warnings.push(`Shot ${shot.id} appears more than once in the storyboard; later duplicates were skipped.`);
      continue;
    }
    seenIds.add(shot.id);
    const start = Math.round(shot.frameStart);
    const end = Math.max(start, Math.round(shot.frameEnd));
    if (end < frameStart || start > frameEnd) {
      warnings.push(
        `Shot ${shot.id} (${start}-${end}) lies outside the playback window ${frameStart}-${frameEnd}; it was omitted from the camera-cut track (warn-and-omit code: shot_outside_playback).`,
      );
      continue;
    }
    const clampedStart = Math.max(start, frameStart);
    const clampedEnd = Math.min(end, frameEnd);
    if (clampedStart !== start || clampedEnd !== end) {
      warnings.push(
        `Shot ${shot.id} was clamped from ${start}-${end} into the playback window ${frameStart}-${frameEnd}.`,
      );
    }
    if (shot.cameraId && !cameraIds.has(shot.cameraId)) {
      warnings.push(
        `Shot ${shot.id} references camera ${shot.cameraId} which is not in the project; the connector will omit its cut (warn-and-omit code: shot_camera_not_imported).`,
      );
    }
    ranges.push({
      shotId: shot.id,
      title: shot.title,
      cameraDirectorId: shot.cameraId,
      frameStart: clampedStart,
      frameEnd: clampedEnd,
    });
  }
  ranges.sort((left, right) => left.frameStart - right.frameStart || left.frameEnd - right.frameEnd);
  if (ranges.length > MAX_BAKED_SHOTS) {
    warnings.push(
      `${ranges.length - MAX_BAKED_SHOTS} shots were omitted beyond the ${MAX_BAKED_SHOTS}-shot bake limit.`,
    );
    ranges.length = MAX_BAKED_SHOTS;
  }
  return ranges.length > 0 ? ranges : undefined;
}

/**
 * Sample a Director project's animation into a Godot animation bake.
 *
 * Object and camera transforms are evaluated per frame with the canonical
 * Director evaluators (easing curves, trajectories, camera path/follow
 * actions), composed with the scene transform, and stored as canonical
 * Director-space world transforms. Camera vertical-fov keys are carried as-is
 * because Godot's `Camera3D.fov` uses the same vertical-degrees convention.
 * Entities whose sampled transforms never change and that have no authored
 * keyframes are skipped. Storyboard shot ranges ride along (clamped into the
 * playback window) so the connector can key a discrete `Camera3D.current`
 * camera-cut track without a `.tscn` exchange.
 *
 * @param project - The live Director project snapshot from the exchange package.
 * @param packageId - The exchange package id this bake belongs to.
 * @param sourceRevision - The project revision the exchange package captured.
 * @returns A validated bake manifest.
 */
export function buildGodotAnimationBake(
  project: DirectorProject,
  packageId: string,
  sourceRevision: string,
): DirectorGodotAnimationBake {
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

  const objectSamples = new Map<string, DirectorGodotTransformSample[]>();
  const cameraSamples = new Map<string, DirectorGodotTransformSample[]>();
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

  const entities: DirectorGodotBakedEntity[] = [];
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
    const omittedDetail = omittedDetailOf(object, omittedChannels);
    entities.push({
      directorId: object.id,
      entityType: "object",
      name: object.name,
      transformSamples: samples,
      ...(omittedChannels ? { omittedChannels } : {}),
      ...(omittedDetail ? { omittedDetail } : {}),
      warnings: omissionWarnings(object.name, omittedChannels, omittedDetail),
    });
  }

  for (const camera of project.cameras) {
    const samples = cameraSamples.get(camera.id)!;
    const fovSamples = cameraFovByFrame.get(camera.id)!;
    const hasAuthoredAnimation = Boolean(camera.animation?.keyframes.length) && camera.animation?.enabled !== false;
    const followsTarget = camera.action?.mode === "follow" && Boolean(camera.action.follow?.targetObjectId);
    const moves = samples.some((sample) => !transformsClose(sample.transform, samples[0]!.transform));
    const fovVaries = fovSamples.some((sample) => Math.abs(sample.fov - fovSamples[0]!.fov) > FOV_TOLERANCE);
    if (!hasAuthoredAnimation && !followsTarget && !moves && !fovVaries) continue;
    if (entities.length >= MAX_BAKED_ENTITIES) {
      truncated += 1;
      continue;
    }
    const bakedFovSamples = fovVaries
      ? fovSamples.map((sample) => ({ frame: sample.frame, fovDeg: sample.fov }))
      : [{ frame: samples[0]!.frame, fovDeg: fovSamples[0]!.fov }];
    entities.push({
      directorId: camera.id,
      entityType: "camera",
      name: camera.name,
      transformSamples: samples,
      fovSamples: bakedFovSamples,
      warnings: [],
    });
  }

  if (truncated > 0) {
    warnings.push(`${truncated} animated entities were omitted beyond the ${MAX_BAKED_ENTITIES}-entity bake limit.`);
  }

  const shots = bakedShotsOf(project, frameStart, frameEnd, warnings);

  return directorGodotAnimationBakeSchema.parse({
    contract: DIRECTOR_GODOT_ANIMATION_BAKE_CONTRACT,
    schemaVersion: 1,
    packageId,
    provider: "godot",
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
    ...(shots ? { shots } : {}),
    warnings,
  });
}

/**
 * Build the animation bake and write it as `animation.json` into the private
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
export async function writeGodotAnimationBake(
  project: DirectorProject,
  packageId: string,
  sourceRevision: string,
  jobDirectory: string,
): Promise<GodotAnimationBakeFile> {
  const bake = buildGodotAnimationBake(project, packageId, sourceRevision);
  const bakePath = resolve(jobDirectory, "animation.json");
  const body = `${JSON.stringify(bake, null, 2)}\n`;
  await writeFile(bakePath, body, "utf8");
  return { bakePath, bakeSha256: createHash("sha256").update(body).digest("hex"), bake };
}
