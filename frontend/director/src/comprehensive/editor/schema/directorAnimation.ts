/**
 * Keyframe animation evaluation for Director entities: samples an entity's
 * transform (and character rig state) at an arbitrary timeline frame by
 * interpolating authored keyframes with easing/timing curves, layering
 * trajectory motion blocks and procedural gait on top, and resolving camera
 * action targets (orbit/track subjects) to world positions. Everything here
 * is a pure function of (project data, frame) — the viewport, deterministic
 * frame export, and agent-side evaluators all call the same code so poses
 * never diverge between preview and delivery.
 */
import type {
  CharacterRigState,
  DirectorAnimationInterpolation,
  DirectorAnimationKeyframe,
  DirectorAnimationTimingCurve,
  DirectorCameraShot,
  DirectorEntityAnimation,
  DirectorObject,
  DirectorTimeline,
  DirectorTransform,
} from "./directorProject";
import { getDirectorInterpolationWeight } from "./animationEasing";
import { getProceduralGaitControls, isProceduralGaitActive } from "../trajectory/proceduralGait";
import { evaluateTrajectoryTransform } from "../trajectory/trajectoryMath";
import { getDirectorTimelineFps } from "../timeline/frameRate";

type Tuple3 = [number, number, number];

export interface DirectorCameraActionTarget {
  id: string;
  position: Tuple3;
}

function findCameraActionTarget(
  targets: DirectorCameraActionTarget | DirectorCameraActionTarget[] | undefined,
  id: string | null | undefined,
) {
  if (!id || !targets) return undefined;
  return (Array.isArray(targets) ? targets : [targets]).find((target) => target.id === id);
}

export function getCameraWaypointTargetObjectId(animation: DirectorEntityAnimation | undefined, frame: number) {
  if (!animation) return null;
  const waypointTargets = compileDirectorAnimation(animation).waypointTargets;
  let low = 0;
  let high = waypointTargets.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (waypointTargets[middle].frame <= frame) low = middle + 1;
    else high = middle;
  }
  return waypointTargets[low - 1]?.value ?? null;
}

interface KeyedValue<T> {
  frame: number;
  interpolation: DirectorAnimationInterpolation;
  timingCurve?: DirectorAnimationTimingCurve;
  value: T;
}

interface DirectorAnimationEvaluationPlan {
  transform: KeyedValue<DirectorTransform>[];
  poseValuesByControl: Map<string, KeyedValue<number>[]>;
  lookTarget: KeyedValue<Tuple3>[];
  fov: KeyedValue<number>[];
  waypointTargets: Array<{ frame: number; value: string | null }>;
  firstFrame: number | null;
  lastFrame: number | null;
}

interface CachedDirectorAnimationEvaluationPlan {
  keyframes: DirectorAnimationKeyframe[];
  keyframeCount: number;
  plan: DirectorAnimationEvaluationPlan;
}

/**
 * Director store mutations replace animation objects instead of mutating them
 * in place. Keep the compiled channel representation attached to that immutable
 * identity so playback does not recollect and resort every channel every frame.
 * The keyframe reference/count checks also make array replacement and append
 * mutations rebuild rather than returning an obviously stale plan.
 */
const animationEvaluationPlanCache = new WeakMap<DirectorEntityAnimation, CachedDirectorAnimationEvaluationPlan>();

const DEFAULT_INTERPOLATION: DirectorAnimationInterpolation = "linear";

export interface DirectorTimelineFrameSample {
  frame: number;
  ended: boolean;
}

export function getDirectorTimelineFrameAtElapsedTime(
  timeline: DirectorTimeline,
  playbackStartFrame: number,
  elapsedMilliseconds: number,
): DirectorTimelineFrameSample {
  const frameStart = timeline.frameStart;
  const frameEnd = Math.max(frameStart, timeline.frameEnd);
  const frameCount = frameEnd - frameStart + 1;
  const fps = Math.max(1, getDirectorTimelineFps(timeline));
  const safeStartFrame = Math.min(frameEnd, Math.max(frameStart, playbackStartFrame));
  const elapsedFrames = Math.floor((Math.max(0, elapsedMilliseconds) * fps) / 1000);
  const requestedFrame = safeStartFrame + elapsedFrames;

  if (!timeline.loop && requestedFrame >= frameEnd) {
    return { frame: frameEnd, ended: true };
  }

  return {
    frame: timeline.loop ? frameStart + ((requestedFrame - frameStart) % frameCount) : requestedFrame,
    ended: false,
  };
}

function copyTuple(tuple: Tuple3): Tuple3 {
  return [...tuple] as Tuple3;
}

function copyTransform(transform: DirectorTransform): DirectorTransform {
  return {
    position: copyTuple(transform.position),
    rotation: copyTuple(transform.rotation),
    scale: copyTuple(transform.scale),
  };
}

function interpolateNumber(left: number, right: number, weight: number) {
  return left + (right - left) * weight;
}

function interpolateTuple(left: Tuple3, right: Tuple3, weight: number): Tuple3 {
  return left.map((value, index) => interpolateNumber(value, right[index], weight)) as Tuple3;
}

function addTuple(left: Tuple3, right: Tuple3): Tuple3 {
  return [left[0] + right[0], left[1] + right[1], left[2] + right[2]];
}

function evaluateSortedKeyedValue<T>(
  keyframes: readonly KeyedValue<T>[],
  frame: number,
  interpolate: (left: T, right: T, weight: number) => T,
  copyValue?: (value: T) => T,
): T | undefined {
  if (keyframes.length === 0) return undefined;

  const readValue = (value: T) => (copyValue ? copyValue(value) : value);

  // Lower-bound lookup preserves the old stable-sort behavior: an exact frame
  // resolves to its first authored key, while interpolation starts at the last
  // duplicate key preceding the requested frame.
  let low = 0;
  let high = keyframes.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (keyframes[middle].frame < frame) low = middle + 1;
    else high = middle;
  }

  if (low < keyframes.length && keyframes[low].frame === frame) return readValue(keyframes[low].value);
  if (low === 0) return readValue(keyframes[0].value);
  if (low === keyframes.length) return readValue(keyframes[keyframes.length - 1].value);

  const left = keyframes[low - 1];
  const right = keyframes[low];
  const distance = right.frame - left.frame;
  const progress = distance <= 0 ? 0 : (frame - left.frame) / distance;
  const weight = getDirectorInterpolationWeight(left.interpolation, progress, left.timingCurve);
  return interpolate(left.value, right.value, weight);
}

function sortKeyedValues<T>(values: KeyedValue<T>[]) {
  values.sort((left, right) => left.frame - right.frame);
  return values;
}

function compileDirectorAnimation(animation: DirectorEntityAnimation): DirectorAnimationEvaluationPlan {
  const cached = animationEvaluationPlanCache.get(animation);
  if (cached && cached.keyframes === animation.keyframes && cached.keyframeCount === animation.keyframes.length) {
    return cached.plan;
  }

  const transform: KeyedValue<DirectorTransform>[] = [];
  const poseValuesByControl = new Map<string, KeyedValue<number>[]>();
  const lookTarget: KeyedValue<Tuple3>[] = [];
  const fov: KeyedValue<number>[] = [];
  const waypointTargets: Array<{ frame: number; value: string | null }> = [];
  let firstFrame: number | null = null;
  let lastFrame: number | null = null;

  animation.keyframes.forEach((keyframe) => {
    firstFrame = firstFrame === null ? keyframe.frame : Math.min(firstFrame, keyframe.frame);
    lastFrame = lastFrame === null ? keyframe.frame : Math.max(lastFrame, keyframe.frame);
    const interpolation = keyframe.interpolation ?? DEFAULT_INTERPOLATION;
    const keyedValueMetadata = {
      frame: keyframe.frame,
      interpolation,
      timingCurve: keyframe.timingCurve,
    };

    if (keyframe.transform) {
      transform.push({ ...keyedValueMetadata, value: copyTransform(keyframe.transform) });
    }
    Object.entries(keyframe.poseValues ?? {}).forEach(([controlKey, value]) => {
      const channel = poseValuesByControl.get(controlKey) ?? [];
      channel.push({ ...keyedValueMetadata, value });
      if (!poseValuesByControl.has(controlKey)) poseValuesByControl.set(controlKey, channel);
    });
    if (keyframe.lookTarget) {
      lookTarget.push({ ...keyedValueMetadata, value: copyTuple(keyframe.lookTarget) });
    }
    if (keyframe.fov !== undefined) {
      fov.push({ ...keyedValueMetadata, value: keyframe.fov });
    }
    if (keyframe.lookTargetObjectId !== undefined) {
      waypointTargets.push({ frame: keyframe.frame, value: keyframe.lookTargetObjectId });
    }
  });

  sortKeyedValues(transform);
  sortKeyedValues(lookTarget);
  sortKeyedValues(fov);
  poseValuesByControl.forEach(sortKeyedValues);
  waypointTargets.sort((left, right) => left.frame - right.frame);

  const plan = { transform, poseValuesByControl, lookTarget, fov, waypointTargets, firstFrame, lastFrame };
  animationEvaluationPlanCache.set(animation, {
    keyframes: animation.keyframes,
    keyframeCount: animation.keyframes.length,
    plan,
  });
  return plan;
}

export function evaluateTransformAnimation(
  base: DirectorTransform,
  animation: DirectorEntityAnimation | undefined,
  frame: number,
): DirectorTransform {
  if (animation?.enabled === false) return copyTransform(base);
  const trajectoryTransform = evaluateTrajectoryTransform(animation, frame);
  if (trajectoryTransform) return trajectoryTransform;

  const value = animation
    ? evaluateSortedKeyedValue(
        compileDirectorAnimation(animation).transform,
        frame,
        (left, right, weight) => ({
          position: interpolateTuple(left.position, right.position, weight),
          rotation: interpolateTuple(left.rotation, right.rotation, weight),
          scale: interpolateTuple(left.scale, right.scale, weight),
        }),
        copyTransform,
      )
    : undefined;

  return value ?? copyTransform(base);
}

export function evaluatePoseValuesAnimation(
  base: Record<string, number>,
  animation: DirectorEntityAnimation | undefined,
  frame: number,
) {
  if (animation?.enabled === false) return base;
  if (!animation) return base;
  const poseValuesByControl = compileDirectorAnimation(animation).poseValuesByControl;
  if (poseValuesByControl.size === 0) return base;

  let controls: Record<string, number> | null = null;
  poseValuesByControl.forEach((keyframes, controlKey) => {
    const value = evaluateSortedKeyedValue(keyframes, frame, interpolateNumber);
    if (value === undefined || value === base[controlKey]) return;
    controls ??= { ...base };
    controls[controlKey] = value;
  });

  return controls ?? base;
}

export function evaluateDirectorObjectAtFrame(item: DirectorObject, frame: number, fps = 24): DirectorObject {
  if (!item.animation?.keyframes.length || item.animation.enabled === false) return item;

  const evaluatedControls = item.characterRig
    ? evaluatePoseValuesAnimation(item.characterRig.controls, item.animation, frame)
    : undefined;
  // Mixamo trajectory playback is backed by the packaged skeletal walk/run
  // clips resolved by getTimelineCharacterMotion. Applying the fallback gait
  // controls here as well would pose the same bones a second time on top of
  // the sampled clip, producing twisted limbs and exaggerated strides.
  const usesProceduralGait = Boolean(item.characterRig && item.characterRig.rigType !== "mixamo");
  const gaitControls =
    usesProceduralGait && isProceduralGaitActive(item.animation, frame)
      ? getProceduralGaitControls(item.animation.motion, frame, fps)
      : null;

  const characterRig: CharacterRigState | undefined = item.characterRig
    ? evaluatedControls === item.characterRig.controls && !gaitControls
      ? item.characterRig
      : {
          ...item.characterRig,
          ...(gaitControls ? { posePresetId: item.animation.motion ?? item.characterRig.posePresetId } : {}),
          controls: {
            ...evaluatedControls,
            ...gaitControls,
          },
        }
    : undefined;

  return {
    ...item,
    transform:
      evaluateTrajectoryTransform(item.animation, frame) ??
      evaluateTransformAnimation(item.transform, item.animation, frame),
    ...(characterRig ? { characterRig } : {}),
  };
}

export function evaluateDirectorCameraAtFrame(
  camera: DirectorCameraShot,
  frame: number,
  actionTargets?: DirectorCameraActionTarget | DirectorCameraActionTarget[],
): DirectorCameraShot {
  const action = camera.action;
  const follow = action?.mode === "follow" ? action.follow : undefined;
  const followTarget = findCameraActionTarget(actionTargets, follow?.targetObjectId);
  if (follow?.targetObjectId && followTarget) {
    return {
      ...camera,
      transform: {
        ...camera.transform,
        position: addTuple(followTarget.position, follow.positionOffset),
      },
      target: addTuple(followTarget.position, follow.targetOffset),
    };
  }

  if (!camera.animation?.keyframes.length || camera.animation.enabled === false) {
    return camera;
  }

  const playbackFrame = getDirectorCameraAnimationFrame(camera, frame);
  const evaluationPlan = compileDirectorAnimation(camera.animation);

  const target = evaluateSortedKeyedValue(evaluationPlan.lookTarget, playbackFrame, interpolateTuple, copyTuple);
  const fov = evaluateSortedKeyedValue(evaluationPlan.fov, playbackFrame, interpolateNumber);
  const pathTarget =
    action?.mode === "path" &&
    action.path?.lockTarget &&
    action.path.targetObjectId &&
    findCameraActionTarget(actionTargets, action.path.targetObjectId)
      ? copyTuple(findCameraActionTarget(actionTargets, action.path.targetObjectId)!.position)
      : undefined;
  const waypointTarget = findCameraActionTarget(
    actionTargets,
    getCameraWaypointTargetObjectId(camera.animation, playbackFrame),
  );

  return {
    ...camera,
    transform:
      evaluateTrajectoryTransform(camera.animation, playbackFrame) ??
      evaluateTransformAnimation(camera.transform, camera.animation, playbackFrame),
    target:
      pathTarget ??
      (waypointTarget ? copyTuple(waypointTarget.position) : undefined) ??
      target ??
      copyTuple(camera.target),
    fov: fov ?? camera.fov,
  };
}

/**
 * Resolves a timeline frame to the authored keyframe frame for a camera. Path
 * actions can play their transform track faster or slower than the timeline,
 * so viewport edits must use this same mapping to modify the pose users see.
 */
export function getDirectorCameraAnimationFrame(camera: DirectorCameraShot, frame: number) {
  const keyframes = camera.animation?.keyframes ?? [];
  if (keyframes.length === 0) return frame;

  if (camera.action?.mode !== "path") return frame;

  const { firstFrame, lastFrame } = compileDirectorAnimation(camera.animation!);
  if (firstFrame === null || lastFrame === null) return frame;
  const speed = camera.action.path?.speed ?? 1;
  return Math.min(lastFrame, Math.max(firstFrame, firstFrame + (frame - firstFrame) * speed));
}
