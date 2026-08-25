import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AnimationClip,
  AnimationMixer,
  Bone,
  Euler,
  Group,
  Quaternion,
  QuaternionKeyframeTrack,
  Vector3,
  VectorKeyframeTrack,
} from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { describe, expect, it } from "vitest";
import { localAssetIt } from "../../../../../../../packages/protocol/tests/localAssetTest";
import type { DirectorCharacterMotionState } from "../../../../../src/comprehensive/editor/schema/directorProject";
import {
  captureMixamoRestPose,
  restoreMixamoRestPose,
} from "../../../../../src/comprehensive/editor/runtime/mixamo/mixamoCharacterRig";
import {
  applyDirectorCharacterMotionFrame,
  applyDirectorCharacterWeightedMotionFrame,
  configureDirectorCharacterMotionAction,
  retargetMixamoAnimationClip,
  sampleDirectorCharacterMotion,
} from "../../../../../src/comprehensive/editor/runtime/mixamo/mixamoMotion";
import {
  collectMixamoBones,
  resolveMixamoBones,
} from "../../../../../src/comprehensive/editor/runtime/mixamo/mixamoCharacterRig";

function skeleton(prefix: string, hipsY: number, headY: number) {
  const root = new Group();
  const hips = new Bone();
  hips.name = `${prefix}Hips`;
  hips.position.set(0, hipsY, 0);
  const head = new Bone();
  head.name = `${prefix}Head`;
  head.position.set(0, headY, 0);
  hips.add(head);
  root.add(hips);
  root.updateMatrixWorld(true);
  return { root, hips, head };
}

const MOTION: DirectorCharacterMotionState = {
  clipId: "walk",
  enabled: true,
  loop: "repeat",
  speed: 1,
  weight: 1,
  startFrame: 0,
  blendInS: 0,
  blendOutS: 0,
  rootMotion: "in-place",
};

async function loadPackagedMotion(fileName: string) {
  const bytes = readFileSync(resolve(process.cwd(), "assets/library/mixamo-animations/clips", fileName));
  // Copy into the Vitest/jsdom realm so GLTFLoader's ArrayBuffer check is
  // reliable even though Node's Buffer was allocated in a different realm.
  const buffer = Uint8Array.from(bytes).buffer;
  return await new Promise<GLTF>((resolveGltf, rejectGltf) => {
    new GLTFLoader().parse(buffer, "", resolveGltf, rejectGltf);
  });
}

function animationTargetSkeleton() {
  const root = new Group();
  const hips = new Bone();
  hips.name = "Hips";
  hips.position.set(0, 1, 0);
  const spine = new Bone();
  spine.name = "Spine";
  spine.position.set(0, 0.45, 0);
  const head = new Bone();
  head.name = "Head";
  head.position.set(0, 0.85, 0);
  const leftArm = new Bone();
  leftArm.name = "LeftArm";
  leftArm.position.set(0.35, 0.55, 0);
  const rightArm = new Bone();
  rightArm.name = "RightArm";
  rightArm.position.set(-0.35, 0.55, 0);
  spine.add(head, leftArm, rightArm);
  hips.add(spine);
  root.add(hips);
  root.updateMatrixWorld(true);
  return { root, hips, leftArm };
}

describe("Mixamo motion retargeting", () => {
  it("keeps target proportions and strips non-root translation and scale tracks", () => {
    const source = skeleton("mixamorig:", 2, 8);
    const target = skeleton("", 4, 12);
    const clip = new AnimationClip("source", 1, [
      new VectorKeyframeTrack("mixamorig:Hips.position", [0, 1], [1, 2, 3, 3, 5, 7]),
      new QuaternionKeyframeTrack("mixamorig:Hips.quaternion", [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
      new VectorKeyframeTrack("mixamorig:Head.position", [0, 1], [0, 8, 0, 9, 9, 9]),
      new VectorKeyframeTrack("mixamorig:Head.scale", [0, 1], [1, 1, 1, 2, 2, 2]),
    ]);

    const result = retargetMixamoAnimationClip({
      clip,
      sourceRoot: source.root,
      targetRoot: target.root,
      targetRestPose: captureMixamoRestPose(target.root),
      rootMotion: "in-place",
      name: "walk",
    });

    expect(result.name).toBe("walk");
    expect(result.tracks.map((track) => track.name)).toEqual(["Hips.position", "Hips.quaternion"]);
    expect(Array.from(result.tracks[0]!.values)).toEqual([0, 4, 0, 0, 8.5, 0]);
  });

  it("preserves source-rest-relative scaled displacement only in authored root-motion mode", () => {
    const source = skeleton("mixamorig:", 2, 8);
    const target = skeleton("", 4, 12);
    const clip = new AnimationClip("source", 1, [
      new VectorKeyframeTrack("mixamorig:Hips.position", [0, 1], [1, 2, 3, 3, 5, 7]),
    ]);
    const result = retargetMixamoAnimationClip({
      clip,
      sourceRoot: source.root,
      targetRoot: target.root,
      targetRestPose: captureMixamoRestPose(target.root),
      rootMotion: "authored",
    });

    expect(Array.from(result.tracks[0]!.values)).toEqual([1.5, 4, 4.5, 4.5, 8.5, 10.5]);
  });

  it("rebases Mixamo frame-one key times to zero and derives last-minus-first duration", () => {
    const source = skeleton("mixamorig:", 2, 8);
    const target = skeleton("", 4, 12);
    const clip = new AnimationClip("frame-one-start", 1.033333, [
      new VectorKeyframeTrack("mixamorig:Hips.position", [1 / 30, 31 / 30], [0, 2, 0, 0, 2.2, 0]),
      new QuaternionKeyframeTrack("mixamorig:Hips.quaternion", [1 / 30, 31 / 30], [0, 0, 0, 1, 0, 0, 0, 1]),
    ]);

    const result = retargetMixamoAnimationClip({
      clip,
      sourceRoot: source.root,
      targetRoot: target.root,
      targetRestPose: captureMixamoRestPose(target.root),
      rootMotion: "in-place",
    });

    result.tracks.forEach((track) => expect(track.times[0]).toBe(0));
    expect(result.duration).toBeCloseTo(1, 6);
  });

  it("retargets quaternion deltas over the X Bot target rest orientation instead of copying source absolutes", () => {
    const source = skeleton("mixamorig:", 2, 8);
    const target = skeleton("", 4, 12);
    const axis = new Vector3(0, 1, 0);
    source.hips.quaternion.setFromAxisAngle(axis, 0.4);
    target.hips.quaternion.setFromAxisAngle(axis, -0.25);
    const sourceAnimated = source.hips.quaternion.clone().multiply(new Quaternion().setFromAxisAngle(axis, 0.3));
    const clip = new AnimationClip("turn", 1, [
      new QuaternionKeyframeTrack(
        "mixamorig:Hips.quaternion",
        [0, 1],
        [...sourceAnimated.toArray(), ...sourceAnimated.toArray()],
      ),
    ]);
    const targetRestPose = captureMixamoRestPose(target.root);

    const result = retargetMixamoAnimationClip({
      clip,
      sourceRoot: source.root,
      targetRoot: target.root,
      targetRestPose,
      rootMotion: "in-place",
    });
    const actual = new Quaternion().fromArray(result.tracks[0]!.values);
    const expected = target.hips.quaternion.clone().multiply(new Quaternion().setFromAxisAngle(axis, 0.3));

    expect(actual.angleTo(expected)).toBeLessThan(0.001);
    expect(actual.angleTo(sourceAnimated)).toBeGreaterThan(0.1);
  });

  it("clamps exact-duration samples to the final key instead of LoopRepeat wrapping to frame zero", () => {
    const root = new Group();
    const hips = new Bone();
    hips.name = "Hips";
    root.add(hips);
    const finalRotation = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2);
    const clip = new AnimationClip("one-shot", 1, [
      new QuaternionKeyframeTrack("Hips.quaternion", [0, 1], [0, 0, 0, 1, ...finalRotation.toArray()]),
    ]);
    const mixer = new AnimationMixer(root);
    const action = configureDirectorCharacterMotionAction(mixer.clipAction(clip));

    action.time = clip.duration;
    mixer.update(0);

    expect(hips.quaternion.angleTo(finalRotation)).toBeLessThan(0.001);
  });

  it("samples repeat, ping-pong, one-shot, and fade weights from timeline frames", () => {
    expect(sampleDirectorCharacterMotion(MOTION, 72, 24, 2)).toEqual({
      active: true,
      timeS: 1,
      effectiveWeight: 1,
    });
    expect(sampleDirectorCharacterMotion({ ...MOTION, loop: "ping-pong" }, 72, 24, 2).timeS).toBe(1);
    expect(
      sampleDirectorCharacterMotion({ ...MOTION, loop: "once", blendInS: 1, blendOutS: 1, weight: 0.8 }, 12, 24, 2),
    ).toEqual({ active: true, timeS: 0.5, effectiveWeight: 0.4 });
    expect(sampleDirectorCharacterMotion({ ...MOTION, startFrame: 10 }, 9, 24, 2).active).toBe(false);
  });

  localAssetIt(
    "loads the packaged Mixamo GLB and produces different deterministic arm poses at F0 and F8",
    async () => {
      const source = await loadPackagedMotion("wave.glb");
      const sourceClip = source.animations[0];
      const target = animationTargetSkeleton();
      const restPose = captureMixamoRestPose(target.root);
      const clip = retargetMixamoAnimationClip({
        clip: sourceClip!,
        sourceRoot: source.scene,
        targetRoot: target.root,
        targetRestPose: restPose,
        rootMotion: "in-place",
        name: "wave",
      });
      const mixer = new AnimationMixer(target.root);
      const action = mixer.clipAction(clip).play();

      const sampleArmAtFrame = (frame: number) => {
        restoreMixamoRestPose(target.root, restPose);
        const sample = sampleDirectorCharacterMotion({ ...MOTION, clipId: "wave" }, frame, 24, clip.duration);
        action.enabled = sample.active;
        action.setEffectiveWeight(sample.effectiveWeight);
        action.time = sample.timeS;
        mixer.update(0);
        return target.leftArm.quaternion.clone();
      };

      const frame0 = sampleArmAtFrame(0);
      const frame8 = sampleArmAtFrame(8);

      expect(sourceClip?.tracks.length).toBeGreaterThan(200);
      expect(clip.tracks.some((track) => track.name === "LeftArm.quaternion")).toBe(true);
      expect(Math.abs(frame0.dot(frame8))).toBeLessThan(0.9999);
    },
  );

  it("uses the production order rest -> sampled motion -> pose controls -> IK layer", () => {
    const target = animationTargetSkeleton();
    const restPose = captureMixamoRestPose(target.root);
    const animatedRotation = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.35);
    const clip = new AnimationClip("production", 1, [
      new QuaternionKeyframeTrack("LeftArm.quaternion", [0, 1], [0, 0, 0, 1, ...animatedRotation.toArray()]),
    ]);
    const mixer = new AnimationMixer(target.root);
    const action = configureDirectorCharacterMotionAction(mixer.clipAction(clip));

    applyDirectorCharacterMotionFrame({
      scene: target.root,
      restPose,
      deformBones: collectMixamoBones(target.root),
      resolvedBones: resolveMixamoBones(target.root),
      controls: { "leftShoulder.twist": 30 },
      action,
      currentFrame: 24,
      durationS: clip.duration,
      fps: 24,
      mixer,
      motion: { ...MOTION, loop: "once" },
    });

    const poseOffset = new Quaternion().setFromEuler(new Euler(0, Math.PI / 6, 0));
    const expected = animatedRotation.clone().multiply(poseOffset);
    expect(target.leftArm.quaternion.angleTo(expected)).toBeLessThan(0.001);
  });

  it("rewrites constant animation channels after the per-frame rest-pose restore", () => {
    // PropertyMixer.apply skips a scene-graph write when the newly evaluated
    // value equals the previous frame's accumulator. Director restores the
    // rest pose between samples, so a channel that holds a steady value (for
    // example fingers during a walk cycle) used to fall back to the T-pose
    // from the second sampled frame onward.
    const target = animationTargetSkeleton();
    const restPose = captureMixamoRestPose(target.root);
    const heldRotation = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.9);
    const movingRotation = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.6);
    const clip = new AnimationClip("held-channel", 1, [
      new QuaternionKeyframeTrack("LeftArm.quaternion", [0, 1], [...heldRotation.toArray(), ...heldRotation.toArray()]),
      new QuaternionKeyframeTrack("Hips.quaternion", [0, 1], [0, 0, 0, 1, ...movingRotation.toArray()]),
    ]);
    const mixer = new AnimationMixer(target.root);
    const action = configureDirectorCharacterMotionAction(mixer.clipAction(clip));
    const applyFrame = (currentFrame: number) => {
      applyDirectorCharacterMotionFrame({
        scene: target.root,
        restPose,
        deformBones: collectMixamoBones(target.root),
        resolvedBones: resolveMixamoBones(target.root),
        controls: {},
        action,
        currentFrame,
        durationS: clip.duration,
        fps: 24,
        mixer,
        motion: { ...MOTION, loop: "once" },
      });
      return target.leftArm.quaternion.clone();
    };

    const first = applyFrame(0);
    const second = applyFrame(6);
    const third = applyFrame(12);

    expect(first.angleTo(heldRotation)).toBeLessThan(0.001);
    expect(second.angleTo(heldRotation)).toBeLessThan(0.001);
    expect(third.angleTo(heldRotation)).toBeLessThan(0.001);
  });

  it("replays an identical frame after restoring the rig instead of flashing to rest pose", () => {
    const target = animationTargetSkeleton();
    const restPose = captureMixamoRestPose(target.root);
    const animatedRotation = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.7);
    const clip = new AnimationClip("same-frame", 1, [
      new QuaternionKeyframeTrack("LeftArm.quaternion", [0, 1], [0, 0, 0, 1, ...animatedRotation.toArray()]),
    ]);
    const mixer = new AnimationMixer(target.root);
    const action = configureDirectorCharacterMotionAction(mixer.clipAction(clip));
    const applyFrame = () => {
      applyDirectorCharacterMotionFrame({
        scene: target.root,
        restPose,
        deformBones: collectMixamoBones(target.root),
        resolvedBones: resolveMixamoBones(target.root),
        controls: {},
        action,
        currentFrame: 24,
        durationS: clip.duration,
        fps: 24,
        mixer,
        motion: { ...MOTION, loop: "once" },
      });
      return target.leftArm.quaternion.clone();
    };

    const first = applyFrame();
    const second = applyFrame();

    expect(first.angleTo(animatedRotation)).toBeLessThan(0.001);
    expect(second.angleTo(first)).toBeLessThan(0.000001);
    expect(second.angleTo(new Quaternion())).toBeGreaterThan(0.5);
  });

  localAssetIt("keeps a real Mixamo jump sample idempotent at the same timeline frame", async () => {
    const source = await loadPackagedMotion("jump.glb");
    const sourceClip = source.animations[0]!;
    const target = animationTargetSkeleton();
    const restPose = captureMixamoRestPose(target.root);
    const clip = retargetMixamoAnimationClip({
      clip: sourceClip,
      sourceRoot: source.scene,
      targetRoot: target.root,
      targetRestPose: restPose,
      rootMotion: "in-place",
      name: "jump",
    });
    const mixer = new AnimationMixer(target.root);
    const action = configureDirectorCharacterMotionAction(mixer.clipAction(clip));
    const applyFrame = () => {
      applyDirectorCharacterMotionFrame({
        scene: target.root,
        restPose,
        deformBones: collectMixamoBones(target.root),
        resolvedBones: resolveMixamoBones(target.root),
        controls: {},
        action,
        currentFrame: 8,
        durationS: clip.duration,
        fps: 24,
        mixer,
        motion: { ...MOTION, clipId: "jump" },
      });
      return target.hips.position.clone();
    };

    const first = applyFrame();
    const second = applyFrame();

    expect(first.distanceTo(new Vector3(0, 1, 0))).toBeGreaterThan(0.001);
    expect(second.distanceTo(first)).toBeLessThan(0.000001);
  });

  it("blends a zero-to-epsilon motion weight continuously from Director neutral instead of the T-pose", () => {
    const target = animationTargetSkeleton();
    const restPose = captureMixamoRestPose(target.root);
    const identity = new Quaternion();
    const clip = new AnimationClip("identity", 1, [
      new QuaternionKeyframeTrack("LeftArm.quaternion", [0, 1], [...identity.toArray(), ...identity.toArray()]),
    ]);
    const mixer = new AnimationMixer(target.root);
    const action = configureDirectorCharacterMotionAction(mixer.clipAction(clip));
    const applyAtWeight = (weight: number) => {
      applyDirectorCharacterMotionFrame({
        scene: target.root,
        restPose,
        deformBones: collectMixamoBones(target.root),
        resolvedBones: resolveMixamoBones(target.root),
        controls: {},
        action,
        currentFrame: 12,
        durationS: clip.duration,
        fps: 24,
        mixer,
        motion: { ...MOTION, weight },
      });
      return target.leftArm.quaternion.clone();
    };

    const neutral = applyAtWeight(0);
    const epsilon = applyAtWeight(0.001);
    expect(neutral.angleTo(epsilon)).toBeLessThan(0.005);
    expect(epsilon.angleTo(identity)).toBeGreaterThan(1);
  });

  it("samples two persistent actions as a crossfade before applying pose controls", () => {
    const target = animationTargetSkeleton();
    const restPose = captureMixamoRestPose(target.root);
    const identity = new Quaternion();
    const quarterTurn = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2);
    const idleClip = new AnimationClip("idle", 1, [
      new QuaternionKeyframeTrack("LeftArm.quaternion", [0, 1], [...identity.toArray(), ...identity.toArray()]),
    ]);
    const walkClip = new AnimationClip("walk", 1, [
      new QuaternionKeyframeTrack("LeftArm.quaternion", [0, 1], [...quarterTurn.toArray(), ...quarterTurn.toArray()]),
    ]);
    const mixer = new AnimationMixer(target.root);
    const idleAction = configureDirectorCharacterMotionAction(mixer.clipAction(idleClip));
    const walkAction = configureDirectorCharacterMotionAction(mixer.clipAction(walkClip));

    const applyFrame = (idleWeight = 0.5, walkWeight = 0.5) =>
      applyDirectorCharacterWeightedMotionFrame({
        scene: target.root,
        restPose,
        deformBones: collectMixamoBones(target.root),
        resolvedBones: resolveMixamoBones(target.root),
        controls: { "leftShoulder.twist": 30 },
        actions: [idleAction, walkAction],
        layers: [
          { action: idleAction, durationS: 1, timeS: 0.5, weight: idleWeight },
          { action: walkAction, durationS: 1, timeS: 0.5, weight: walkWeight },
        ],
        mixer,
      });

    const result = applyFrame();
    const first = target.leftArm.quaternion.clone();
    const repeatedResult = applyFrame();
    const repeated = target.leftArm.quaternion.clone();

    const blendedMotion = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 4);
    const poseOffset = new Quaternion().setFromEuler(new Euler(0, Math.PI / 6, 0));
    expect(result).toEqual({ active: true, effectiveWeight: 1 });
    expect(repeatedResult).toEqual(result);
    repeated.toArray().forEach((component, index) => expect(component).toBeCloseTo(first.toArray()[index]!, 12));
    expect(target.leftArm.quaternion.angleTo(blendedMotion.multiply(poseOffset))).toBeLessThan(0.001);

    applyFrame(0.25, 0.75);
    const transitionedMotion = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), (Math.PI * 3) / 8);
    expect(target.leftArm.quaternion.angleTo(transitionedMotion.multiply(poseOffset))).toBeLessThan(0.001);
  });

  it("coalesces duplicate references to one AnimationAction before assigning mixer weight", () => {
    const target = animationTargetSkeleton();
    const restPose = captureMixamoRestPose(target.root);
    const clip = new AnimationClip("shared-idle", 1, [
      new VectorKeyframeTrack("Hips.position", [0, 1], [0, 1, 0, 2, 1, 0]),
    ]);
    const mixer = new AnimationMixer(target.root);
    const action = configureDirectorCharacterMotionAction(mixer.clipAction(clip));

    const result = applyDirectorCharacterWeightedMotionFrame({
      scene: target.root,
      restPose,
      deformBones: collectMixamoBones(target.root),
      resolvedBones: resolveMixamoBones(target.root),
      controls: {},
      actions: [action],
      layers: [
        { action, durationS: 1, timeS: 0.5, weight: 0.5 },
        { action, durationS: 1, timeS: 0.5, weight: 0.5 },
      ],
      mixer,
    });

    expect(result).toEqual({ active: true, effectiveWeight: 1 });
    expect(action.getEffectiveWeight()).toBe(1);
    expect(action.time).toBeCloseTo(0.5, 12);
    expect(target.hips.position.x).toBeCloseTo(1, 6);

    applyDirectorCharacterWeightedMotionFrame({
      scene: target.root,
      restPose,
      deformBones: collectMixamoBones(target.root),
      resolvedBones: resolveMixamoBones(target.root),
      controls: {},
      actions: [action],
      layers: [
        { action, durationS: 1, timeS: 0.25, weight: 0.25 },
        { action, durationS: 1, timeS: 0.75, weight: 0.75 },
      ],
      mixer,
    });
    expect(action.time).toBeCloseTo(0.625, 12);
    expect(target.hips.position.x).toBeCloseTo(1.25, 6);
  });
});
