import {
  AnimationClip,
  LoopOnce,
  Bone,
  Matrix3,
  Matrix4,
  Object3D,
  Quaternion,
  QuaternionKeyframeTrack,
  Vector3,
  VectorKeyframeTrack,
  type KeyframeTrack,
  type AnimationAction,
  type AnimationMixer,
} from "three";
import type { DirectorCharacterIkState, DirectorCharacterMotionState } from "../../schema/directorProject";
import type { CharacterBodyType } from "../mannequin/bodyTypes";
import {
  applyMixamoRigLayers,
  canonicalizeMixamoBoneName,
  restoreMixamoRestPose,
  type MixamoResolvedBones,
  type MixamoRestPose,
} from "./mixamoCharacterRig";
import {
  sampleDirectorCharacterLocomotionTime,
  type DirectorCharacterLocomotionRuntimeState,
} from "./mixamoLocomotionRuntime";

function isBone(object: Object3D): object is Bone {
  return "isBone" in object && object.isBone === true;
}

function indexBones(root: Object3D) {
  const result = new Map<string, Bone>();
  root.traverse((object) => {
    if (!isBone(object)) return;
    const canonical = canonicalizeMixamoBoneName(object.name);
    if (canonical && !result.has(canonical)) result.set(canonical, object);
  });
  return result;
}

function splitTrackName(name: string) {
  const separator = name.lastIndexOf(".");
  if (separator <= 0) return null;
  return { nodeName: name.slice(0, separator), property: name.slice(separator + 1) };
}

function getBonePositionInRoot(root: Object3D, bone: Bone) {
  root.updateWorldMatrix(true, true);
  return root.worldToLocal(bone.getWorldPosition(new Vector3()));
}

/**
 * Root translation is authored from the pelvis, so scale it from the pelvis
 * to the midpoint between both feet. Head height is a useful fallback for
 * partial test rigs and non-standard Mixamo exports without foot bones.
 */
function getRootTranslationReferenceLength(root: Object3D, bones: Map<string, Bone>) {
  const hips = bones.get(canonicalizeMixamoBoneName("Hips"));
  if (!hips) return 1;

  const hipsPosition = getBonePositionInRoot(root, hips);
  const leftFoot = bones.get(canonicalizeMixamoBoneName("LeftFoot"));
  const rightFoot = bones.get(canonicalizeMixamoBoneName("RightFoot"));
  const footPositions = [leftFoot, rightFoot]
    .filter((bone): bone is Bone => Boolean(bone))
    .map((bone) => getBonePositionInRoot(root, bone));
  if (footPositions.length > 0) {
    const feetMidpoint = footPositions
      .reduce((midpoint, position) => midpoint.add(position), new Vector3())
      .multiplyScalar(1 / footPositions.length);
    const legLength = hipsPosition.distanceTo(feetMidpoint);
    if (Number.isFinite(legLength) && legLength > 0.000001) return legLength;
  }

  const head = bones.get(canonicalizeMixamoBoneName("Head"));
  if (!head) return 1;
  const fallbackSpan = hipsPosition.distanceTo(getBonePositionInRoot(root, head));
  return Number.isFinite(fallbackSpan) && fallbackSpan > 0.000001 ? fallbackSpan : 1;
}

/** Return the linear (translation-free) transform from one object space to another. */
function getRelativeLinearTransform(from: Object3D, to: Object3D) {
  from.updateWorldMatrix(true, false);
  to.updateWorldMatrix(true, false);
  const relative = new Matrix4().copy(to.matrixWorld).invert().multiply(from.matrixWorld);
  return new Matrix3().setFromMatrix4(relative);
}

function retargetRotationTrack({
  track,
  sourceBone,
  targetBone,
  targetRestPose,
}: {
  track: KeyframeTrack;
  sourceBone: Bone;
  targetBone: Bone;
  targetRestPose: MixamoRestPose;
}) {
  const values = Array.from(track.values);
  if (values.length < 4 || values.length % 4 !== 0) return null;
  const targetRest = targetRestPose[targetBone.uuid]?.quaternion ?? targetBone.quaternion.toArray();
  const sourceRestInverse = sourceBone.quaternion.clone().invert();
  const targetRestQuaternion = new Quaternion(...targetRest);
  const sourceSample = new Quaternion();
  const output = new Float32Array(values.length);

  for (let index = 0; index < values.length; index += 4) {
    sourceSample.fromArray(values, index).normalize();
    const delta = sourceRestInverse.clone().multiply(sourceSample);
    targetRestQuaternion.clone().multiply(delta).normalize().toArray(output, index);
  }

  return new QuaternionKeyframeTrack(`${targetBone.name}.quaternion`, track.times, output, track.getInterpolation());
}

function retargetHipsPositionTrack({
  track,
  sourceBone,
  sourceRoot,
  targetBone,
  targetRoot,
  targetRestPose,
  scale,
  rootMotion,
}: {
  track: KeyframeTrack;
  sourceBone: Bone;
  sourceRoot: Object3D;
  targetBone: Bone;
  targetRoot: Object3D;
  targetRestPose: MixamoRestPose;
  scale: number;
  rootMotion: DirectorCharacterMotionState["rootMotion"];
}) {
  const values = Array.from(track.values);
  if (values.length < 3 || values.length % 3 !== 0) return null;
  const sourceOrigin = sourceBone.position.clone();
  const targetOrigin = targetRestPose[targetBone.uuid]?.position ?? [
    targetBone.position.x,
    targetBone.position.y,
    targetBone.position.z,
  ];
  const sourceParentToRoot = getRelativeLinearTransform(sourceBone.parent ?? sourceRoot, sourceRoot);
  const targetRootToParent = getRelativeLinearTransform(targetRoot, targetBone.parent ?? targetRoot);
  const sourceParentDelta = new Vector3();
  const directorDelta = new Vector3();
  const output = new Float32Array(values.length);

  for (let index = 0; index < values.length; index += 3) {
    sourceParentDelta
      .set(values[index] - sourceOrigin.x, values[index + 1] - sourceOrigin.y, values[index + 2] - sourceOrigin.z)
      .applyMatrix3(sourceParentToRoot);

    // Both loaded GLTF scene roots are in Director's Y-up coordinate frame.
    // Remove only world/root-planar translation for in-place locomotion; the
    // authored vertical pelvis motion must survive even when an Armature has
    // the common Mixamo +90-degree X conversion.
    directorDelta.copy(sourceParentDelta).multiplyScalar(scale);
    if (rootMotion !== "authored") {
      directorDelta.x = 0;
      directorDelta.z = 0;
    }
    directorDelta.applyMatrix3(targetRootToParent);

    output[index] = targetOrigin[0] + directorDelta.x;
    output[index + 1] = targetOrigin[1] + directorDelta.y;
    output[index + 2] = targetOrigin[2] + directorDelta.z;
  }

  return new VectorKeyframeTrack(`${targetBone.name}.position`, track.times, output, track.getInterpolation());
}

function normalizeRetargetedTrackTimes(tracks: KeyframeTrack[]) {
  const startTime = tracks.reduce((earliest, track) => {
    const first = track.times[0];
    return first === undefined || !Number.isFinite(first) ? earliest : Math.min(earliest, first);
  }, Number.POSITIVE_INFINITY);
  if (!Number.isFinite(startTime) || Math.abs(startTime) < 1e-9) return tracks;

  return tracks.map((track) => {
    const normalized = track.clone();
    normalized.times = Float32Array.from(track.times, (time) => Math.max(0, time - startTime));
    return normalized;
  });
}

/**
 * Retarget a same-family Mixamo clip without copying source bone lengths.
 * Rotations bind by canonical bone name; non-root translation/scale tracks are
 * deliberately dropped so each target character keeps its own proportions.
 */
export function retargetMixamoAnimationClip({
  clip,
  sourceRoot,
  targetRoot,
  targetRestPose,
  rootMotion,
  name = clip.name,
}: {
  clip: AnimationClip;
  sourceRoot: Object3D;
  targetRoot: Object3D;
  targetRestPose: MixamoRestPose;
  rootMotion: DirectorCharacterMotionState["rootMotion"];
  name?: string;
}) {
  const sourceBones = indexBones(sourceRoot);
  const targetBones = indexBones(targetRoot);
  const sourceSpan = getRootTranslationReferenceLength(sourceRoot, sourceBones);
  const targetSpan = getRootTranslationReferenceLength(targetRoot, targetBones);
  const scale = targetSpan / sourceSpan;
  const hipsName = canonicalizeMixamoBoneName("Hips");
  const tracks: KeyframeTrack[] = [];

  clip.tracks.forEach((track) => {
    const binding = splitTrackName(track.name);
    if (!binding) return;
    const canonicalName = canonicalizeMixamoBoneName(binding.nodeName);
    const targetBone = targetBones.get(canonicalName);
    const sourceBone = sourceBones.get(canonicalName);
    if (!targetBone || !sourceBone) return;

    if (binding.property === "quaternion") {
      const retargeted = retargetRotationTrack({ track, sourceBone, targetBone, targetRestPose });
      if (retargeted) tracks.push(retargeted);
      return;
    }

    if (binding.property === "position" && canonicalName === hipsName) {
      const retargeted = retargetHipsPositionTrack({
        track,
        sourceBone,
        sourceRoot,
        targetBone,
        targetRoot,
        targetRestPose,
        scale,
        rootMotion,
      });
      if (retargeted) tracks.push(retargeted);
    }
  });

  // Mixamo FBX exports commonly begin at frame 1 (1/30 s). Carrying that
  // offset into the runtime makes every repeat hold one extra frame and makes
  // the catalog's last-first duration disagree with AnimationClip.duration.
  // Rebase without mutating the source GLB, then derive duration from the
  // normalized retained tracks.
  return new AnimationClip(name, -1, normalizeRetargetedTrackTimes(tracks)).optimize();
}

export interface DirectorCharacterMotionSample {
  active: boolean;
  timeS: number;
  effectiveWeight: number;
}

/**
 * Configure an action for frame-exact external sampling. Director implements
 * repeat and ping-pong in `sampleDirectorCharacterMotion`; Three must clamp an
 * exact duration sample instead of applying its default LoopRepeat wrap.
 */
export function configureDirectorCharacterMotionAction(action: AnimationAction) {
  action.reset().setLoop(LoopOnce, 1);
  action.clampWhenFinished = true;
  return action.play();
}

/** Frame-exact sampling shared by playback, scrubbing, and deterministic capture. */
export function sampleDirectorCharacterMotion(
  motion: DirectorCharacterMotionState,
  frame: number,
  fps: number,
  durationS: number,
): DirectorCharacterMotionSample {
  const safeFps = Math.max(1, fps);
  const safeDuration = Math.max(0.000001, durationS);
  const elapsed = ((frame - motion.startFrame) / safeFps) * motion.speed;
  if (!motion.enabled || elapsed < 0 || motion.weight <= 0) {
    return { active: false, timeS: 0, effectiveWeight: 0 };
  }

  let timeS = elapsed;
  if (motion.loop === "repeat") {
    timeS = elapsed % safeDuration;
  } else if (motion.loop === "ping-pong") {
    const phase = elapsed % (safeDuration * 2);
    timeS = phase <= safeDuration ? phase : safeDuration * 2 - phase;
  } else {
    timeS = Math.min(elapsed, safeDuration);
  }

  const fadeIn = motion.blendInS <= 0 ? 1 : Math.min(1, elapsed / motion.blendInS);
  const fadeOut =
    motion.loop !== "once" || motion.blendOutS <= 0
      ? 1
      : Math.min(1, Math.max(0, (safeDuration - elapsed) / motion.blendOutS));

  return {
    active: fadeIn > 0 && fadeOut > 0,
    timeS,
    effectiveWeight: motion.weight * fadeIn * fadeOut,
  };
}

type CharacterFrameRig = {
  scene: Object3D;
  restPose: MixamoRestPose;
  deformBones: Bone[];
  resolvedBones: MixamoResolvedBones;
  bodyType?: CharacterBodyType;
  controls: Record<string, number>;
  ik?: DirectorCharacterIkState;
};

export interface DirectorCharacterWeightedMotionLayer {
  action?: AnimationAction;
  durationS?: number;
  timeS: number;
  weight: number;
}

type CoalescedMotionLayer = Required<DirectorCharacterWeightedMotionLayer> & {
  referenceTimeS: number;
  weightedTimeOffsetS: number;
};

type SampledMotionLayerState = {
  action: AnimationAction;
  timeS: number;
  weight: number;
};

type SampledMotionPoseCache = {
  scene: Object3D;
  bones: Bone[];
  layers: SampledMotionLayerState[];
  pose: Float64Array;
};

const sampledMotionPoseBuffers = new WeakMap<Object3D, Float32Array>();
const sampledMotionPoseCaches = new WeakMap<AnimationMixer, SampledMotionPoseCache>();
const sampledMotionQuaternion = new Quaternion();

function getSampledMotionPoseBuffer(scene: Object3D, boneCount: number) {
  const requiredLength = boneCount * 10;
  const existing = sampledMotionPoseBuffers.get(scene);
  if (existing?.length === requiredLength) return existing;
  const buffer = new Float32Array(requiredLength);
  sampledMotionPoseBuffers.set(scene, buffer);
  return buffer;
}

function captureSampledMotionPose(bones: readonly Bone[], target?: Float64Array) {
  const requiredLength = bones.length * 10;
  const pose = target?.length === requiredLength ? target : new Float64Array(requiredLength);
  bones.forEach((bone, index) => {
    const offset = index * 10;
    bone.position.toArray(pose, offset);
    bone.quaternion.toArray(pose, offset + 3);
    bone.scale.toArray(pose, offset + 7);
  });
  return pose;
}

function applySampledMotionPose(bones: readonly Bone[], pose: Float64Array) {
  bones.forEach((bone, index) => {
    const offset = index * 10;
    bone.position.fromArray(pose, offset);
    // Replay the exact value Three wrote. Normalizing here would make an
    // identical cached sample differ slightly from its first evaluation.
    bone.quaternion.fromArray(pose, offset + 3);
    bone.scale.fromArray(pose, offset + 7);
  });
}

function isSameSampledMotionRig(cache: SampledMotionPoseCache, rig: CharacterFrameRig) {
  return (
    cache.scene === rig.scene &&
    cache.bones.length === rig.deformBones.length &&
    cache.bones.every((bone, index) => bone === rig.deformBones[index])
  );
}

function isSameSampledMotionPose(
  cache: SampledMotionPoseCache,
  rig: CharacterFrameRig,
  layers: readonly SampledMotionLayerState[],
) {
  return (
    isSameSampledMotionRig(cache, rig) &&
    cache.layers.length === layers.length &&
    cache.layers.every(
      (layer, index) =>
        layer.action === layers[index]?.action &&
        Object.is(layer.timeS, layers[index]?.timeS) &&
        Object.is(layer.weight, layers[index]?.weight),
    )
  );
}

type PropertyMixerLike = { saveOriginalState: () => void };
type AnimationMixerInternals = { _bindings?: PropertyMixerLike[] };

/**
 * Three's PropertyMixer.apply writes a bound property only when the new
 * accumulator differs from the previous frame's accumulator. Director restores
 * the rest pose before every deterministic sample, so a channel whose
 * evaluated value did not change between two samples (idle fingers during a
 * walk cycle, a held limb inside a performance) would silently keep the
 * externally restored rest transform instead of its sampled animation value.
 * Re-saving each binding's original state re-bases that change detection (and
 * the under-weight fallback blend) on the freshly restored rest pose, so every
 * animated channel is written again.
 */
function rebaseMixerOnRestoredPose(mixer: AnimationMixer) {
  const bindings = (mixer as unknown as AnimationMixerInternals)._bindings;
  if (!Array.isArray(bindings)) return;
  for (let index = 0; index < bindings.length; index += 1) {
    bindings[index]?.saveOriginalState();
  }
}

/**
 * Three's PropertyMixer compares the new accumulator with its previous
 * accumulator, not with the current bone transforms. Director restores the
 * rig before every deterministic sample, so an identical second sample can
 * otherwise be skipped by Three and leave the character in its rest pose.
 * Cache the animation-only pose and replay it for identical samples.
 */
function sampleMixerPose(rig: CharacterFrameRig, mixer: AnimationMixer, layers: readonly SampledMotionLayerState[]) {
  const cached = sampledMotionPoseCaches.get(mixer);
  if (cached && isSameSampledMotionPose(cached, rig, layers)) {
    applySampledMotionPose(rig.deformBones, cached.pose);
    return cached.pose;
  }

  rebaseMixerOnRestoredPose(mixer);
  mixer.update(0);
  const reusableCache = cached && isSameSampledMotionRig(cached, rig) ? cached : undefined;
  const pose = captureSampledMotionPose(rig.deformBones, reusableCache?.pose);
  const nextCache = reusableCache ?? {
    scene: rig.scene,
    bones: [...rig.deformBones],
    layers: [],
    pose,
  };
  nextCache.pose = pose;
  nextCache.layers.length = layers.length;
  layers.forEach((layer, index) => {
    const target = nextCache.layers[index];
    if (target) {
      target.action = layer.action;
      target.timeS = layer.timeS;
      target.weight = layer.weight;
    } else {
      nextCache.layers[index] = { ...layer };
    }
  });
  sampledMotionPoseCaches.set(mixer, nextCache);
  return pose;
}

function shortestWrappedTimeDelta(timeS: number, referenceTimeS: number, durationS: number) {
  let deltaS = timeS - referenceTimeS;
  const halfDurationS = durationS * 0.5;
  if (deltaS > halfDurationS) deltaS -= durationS;
  else if (deltaS < -halfDurationS) deltaS += durationS;
  return deltaS;
}

function wrapMotionTime(timeS: number, durationS: number) {
  if (timeS >= 0 && timeS <= durationS) return timeS;
  return ((timeS % durationS) + durationS) % durationS;
}

/**
 * A Three AnimationMixer can evaluate one AnimationAction only once per update.
 * Transition snapshots can legitimately reference the same action more than
 * once (for example fly and idle both resolve to the idle clip). Coalesce those
 * layers before assigning action weight/time so the last layer cannot overwrite
 * an earlier contribution while `effectiveWeight` still counts both.
 */
function coalesceWeightedMotionLayers(layers: readonly DirectorCharacterWeightedMotionLayer[]) {
  const byAction = new Map<AnimationAction, CoalescedMotionLayer>();
  const coalesced: CoalescedMotionLayer[] = [];

  layers.forEach((layer) => {
    if (
      !layer.action ||
      typeof layer.durationS !== "number" ||
      !Number.isFinite(layer.durationS) ||
      layer.durationS <= 0 ||
      !Number.isFinite(layer.weight) ||
      layer.weight <= 0
    ) {
      return;
    }
    const durationS = layer.durationS;
    const weight = Math.min(1, layer.weight);
    const sourceTimeS = Number.isFinite(layer.timeS) ? Math.min(durationS, Math.max(0, layer.timeS)) : 0;
    const existing = byAction.get(layer.action);
    if (!existing) {
      const entry: CoalescedMotionLayer = {
        action: layer.action,
        durationS,
        timeS: sourceTimeS,
        weight,
        referenceTimeS: sourceTimeS,
        weightedTimeOffsetS: 0,
      };
      byAction.set(layer.action, entry);
      coalesced.push(entry);
      return;
    }

    const timeS = (sourceTimeS / durationS) * existing.durationS;
    existing.weightedTimeOffsetS +=
      shortestWrappedTimeDelta(timeS, existing.referenceTimeS, existing.durationS) * weight;
    existing.weight += weight;
    existing.timeS = wrapMotionTime(
      existing.referenceTimeS + existing.weightedTimeOffsetS / existing.weight,
      existing.durationS,
    );
  });

  return coalesced;
}

/**
 * AnimationMixer blends a partial-weight action against the transforms that
 * were present when its PropertyMixers were first activated. For Mixamo that
 * is usually the authored T-pose, not Director's lowered-arm neutral pose.
 * Sample the motion at full normalized weight, then explicitly blend it over
 * the neutral rig. This keeps zero-to-epsilon fades continuous and removes a
 * dependency on React/Suspense mount timing.
 */
function blendSampledMotionOverNeutral(rig: CharacterFrameRig, weight: number, sampledPose?: ArrayLike<number>) {
  const blendWeight = Math.min(1, Math.max(0, weight));
  if (blendWeight >= 1) return;

  const buffer = getSampledMotionPoseBuffer(rig.scene, rig.deformBones.length);
  buffer.set(sampledPose ?? captureSampledMotionPose(rig.deformBones));

  restoreMixamoRestPose(rig.scene, rig.restPose, {
    bones: rig.deformBones,
    updateMatrixWorld: false,
  });
  applyMixamoRigLayers(rig.scene, {
    bodyType: rig.bodyType,
    controls: {},
    restPose: rig.restPose,
    animated: false,
    bones: rig.resolvedBones,
  });

  rig.deformBones.forEach((bone, index) => {
    const offset = index * 10;
    bone.position.set(
      bone.position.x + (buffer[offset] - bone.position.x) * blendWeight,
      bone.position.y + (buffer[offset + 1] - bone.position.y) * blendWeight,
      bone.position.z + (buffer[offset + 2] - bone.position.z) * blendWeight,
    );
    sampledMotionQuaternion.fromArray(buffer, offset + 3).normalize();
    bone.quaternion.slerp(sampledMotionQuaternion, blendWeight).normalize();
    bone.scale.set(
      bone.scale.x + (buffer[offset + 7] - bone.scale.x) * blendWeight,
      bone.scale.y + (buffer[offset + 8] - bone.scale.y) * blendWeight,
      bone.scale.z + (buffer[offset + 9] - bone.scale.z) * blendWeight,
    );
  });
  rig.scene.updateMatrixWorld(true);
}

/**
 * Sample one persistent mixer with explicit clip weights, then apply authored
 * pose controls and IK. This is the runtime locomotion order:
 * rest pose -> blended animation actions -> pose controls -> IK.
 */
export function applyDirectorCharacterWeightedMotionFrame({
  actions,
  layers,
  mixer,
  ...rig
}: CharacterFrameRig & {
  actions: readonly AnimationAction[];
  layers: readonly DirectorCharacterWeightedMotionLayer[];
  mixer: AnimationMixer;
}) {
  restoreMixamoRestPose(rig.scene, rig.restPose, {
    bones: rig.deformBones,
    updateMatrixWorld: false,
  });

  actions.forEach((action) => {
    action.enabled = false;
    action.setEffectiveWeight(0);
  });

  const activeLayers = coalesceWeightedMotionLayers(layers);
  const effectiveWeight = activeLayers.reduce((total, layer) => total + layer.weight, 0);
  activeLayers.forEach((layer) => {
    layer.action.enabled = true;
    layer.action.setEffectiveWeight(layer.weight / effectiveWeight);
    layer.action.time = Math.min(layer.durationS, Math.max(0, layer.timeS));
  });

  if (effectiveWeight > 0) {
    const sampledPose = sampleMixerPose(
      rig,
      mixer,
      activeLayers.map((layer) => ({
        action: layer.action,
        timeS: layer.action.time,
        weight: layer.weight / effectiveWeight,
      })),
    );
    blendSampledMotionOverNeutral(rig, effectiveWeight, sampledPose);
  }

  applyMixamoRigLayers(rig.scene, {
    bodyType: rig.bodyType,
    controls: rig.controls,
    ik: rig.ik,
    restPose: rig.restPose,
    animated: effectiveWeight > 0,
    bones: rig.resolvedBones,
  });

  return { active: effectiveWeight > 0, effectiveWeight: Math.min(1, effectiveWeight) };
}

function applySampledMixamoFrame({
  action,
  active,
  durationS,
  effectiveWeight,
  mixer,
  timeS,
  ...rig
}: CharacterFrameRig & {
  action?: AnimationAction;
  active: boolean;
  durationS?: number;
  effectiveWeight: number;
  mixer?: AnimationMixer;
  timeS: number;
}) {
  restoreMixamoRestPose(rig.scene, rig.restPose, {
    bones: rig.deformBones,
    updateMatrixWorld: false,
  });

  const hasMotion = Boolean(active && action && mixer && durationS && durationS > 0);
  if (action) {
    action.enabled = hasMotion;
    action.setEffectiveWeight(hasMotion ? 1 : 0);
    if (hasMotion && mixer) {
      action.time = timeS;
      const sampledPose = sampleMixerPose(rig, mixer, [{ action, timeS, weight: 1 }]);
      blendSampledMotionOverNeutral(rig, effectiveWeight, sampledPose);
    }
  }

  applyMixamoRigLayers(rig.scene, {
    bodyType: rig.bodyType,
    controls: rig.controls,
    ik: rig.ik,
    restPose: rig.restPose,
    animated: hasMotion,
    bones: rig.resolvedBones,
  });
}

/** Production timeline path: rest pose -> retargeted clip -> pose controls -> IK. */
export function applyDirectorCharacterMotionFrame({
  action,
  currentFrame,
  durationS,
  fps,
  mixer,
  motion,
  ...rig
}: CharacterFrameRig & {
  action?: AnimationAction;
  currentFrame: number;
  durationS?: number;
  fps: number;
  mixer?: AnimationMixer;
  motion: DirectorCharacterMotionState;
}) {
  const sample = sampleDirectorCharacterMotion(motion, currentFrame, fps, durationS ?? 0);
  applySampledMixamoFrame({
    ...rig,
    action,
    active: sample.active,
    durationS,
    effectiveWeight: sample.effectiveWeight,
    mixer,
    timeS: sample.timeS,
  });
  return sample;
}

/** Play-mode path using the ephemeral locomotion contract on the owning object. */
export function applyDirectorCharacterRuntimeFrame({
  action,
  durationS,
  mixer,
  runtimeState,
  ...rig
}: CharacterFrameRig & {
  action?: AnimationAction;
  durationS?: number;
  mixer?: AnimationMixer;
  runtimeState: DirectorCharacterLocomotionRuntimeState;
}) {
  const timeS = sampleDirectorCharacterLocomotionTime(runtimeState, durationS ?? 0);
  applySampledMixamoFrame({
    ...rig,
    action,
    active: runtimeState.weight > 0,
    durationS,
    effectiveWeight: runtimeState.weight,
    mixer,
    timeS,
  });
  return { active: runtimeState.weight > 0, effectiveWeight: runtimeState.weight, timeS };
}
