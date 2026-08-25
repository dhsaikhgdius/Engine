/**
 * Mixamo 绑定角色运行时组件，支持静态姿势、时间轴动画和实时运动混合。
 *
 * @module mixamo-rigged-character
 */

import { useFrame, useLoader } from "@react-three/fiber";
import {
  Component,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { AnimationMixer, type AnimationAction, type AnimationClip, type Bone, type Group, type Object3D } from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { CharacterRigState, DirectorCharacterMotionState } from "../../schema/directorProject";
import { getDirectorCharacterMotion, isDirectorLocomotionMotion } from "@director/agent-engine/character-motions";
import { resolveCharacterPoseControls } from "../../presets/mannequinPosePresets";
import type { CharacterBodyType } from "../mannequin/bodyTypes";
import { configureDirectorGLTFLoader, useDirectorGltfDocuments } from "../gltfLoader";
import {
  applyMixamoCharacterIk,
  applyMixamoRigLayers,
  disposeMixamoCharacterInstanceMaterials,
  measureMixamoCharacter,
  restoreMixamoRestPose,
  type MixamoCharacterMetrics,
  type MixamoResolvedBones,
  type MixamoRestPose,
} from "./mixamoCharacterRig";
import { prepareMixamoCharacterInstance, publishMixamoCharacterMetrics } from "./mixamoCharacterPrepare";
import {
  applyMixamoFootGrounding,
  createMixamoFootGroundingState,
  type MixamoFootGroundingState,
} from "./mixamoFootGrounding";
import {
  applyMixamoFootSlopeAlignment,
  createMixamoFootLockRigRuntime,
  updateMixamoFootLockRigRuntime,
} from "./mixamoFootLockRig";
import { MixamoFootGroundProbe } from "./mixamoFootGroundProbe";
import {
  applyMixamoCrouchPose,
  createMixamoCrouchRuntime,
  getMixamoCrouchWeight,
  isMixamoCrouchEligible,
  isMixamoCrouchSettled,
  updateMixamoCrouchWeight,
} from "./mixamoCrouch";
import {
  applyMixamoHeadLookPose,
  createMixamoHeadLookRuntime,
  isMixamoHeadLookSettled,
  updateMixamoHeadLook,
} from "./mixamoHeadLook";
import {
  applyDirectorCharacterMotionFrame,
  applyDirectorCharacterWeightedMotionFrame,
  configureDirectorCharacterMotionAction,
  retargetMixamoAnimationClip,
  sampleDirectorCharacterMotion,
  type DirectorCharacterWeightedMotionLayer,
} from "./mixamoMotion";
import {
  createDirectorLocomotionRigBlendRuntime,
  DIRECTOR_CHARACTER_EMOTE_CLIP_IDS,
  DIRECTOR_CHARACTER_LOCOMOTION_CROSSFADE_S,
  getDirectorCharacterLocomotionClipId,
  readDirectorCharacterLocomotionRuntimeState,
  resolveDirectorCharacterLocomotionTransitionDurationS,
  sampleDirectorCharacterLocomotionBlend,
  sampleDirectorCharacterLocomotionRigOwnership,
  sampleDirectorCharacterLocomotionTime,
  updateDirectorLocomotionRigBlendRuntime,
  type DirectorCharacterLocomotionMode,
} from "./mixamoLocomotionRuntime";
import {
  DIRECTOR_DIRECTIONAL_BLEND_DIRECTIONS,
  getDirectorDirectionalClipAvailability,
  getDirectorDirectionalLocomotionClipId,
  sampleDirectorDirectionalBlend,
  type DirectorDirectionalBlendResult,
  type DirectorDirectionalBlendState,
  type DirectorDirectionalLocomotionGait,
} from "./mixamoDirectionalBlend";
import { stripPhysicalRuntimeRootTranslation } from "./mixamoRuntimeRootMotion";

/** Props for the MixamoRiggedCharacter component, defining the character source, body type, rig state, and callbacks. */
export interface MixamoRiggedCharacterProps {
  source: Object3D;
  sourceKey: string;
  bodyType?: CharacterBodyType;
  rigState?: CharacterRigState;
  currentFrame?: number;
  fps?: number;
  targetHeightM: number;
  rootName: string;
  runtimeControlled?: boolean;
  onLabelAnchorYChange?: (anchorY: number) => void;
  onVisualCenterChange?: (center: [number, number, number]) => void;
  onMetricsChange?: (metrics: MixamoCharacterMetrics) => void;
}

/** Props for external consumers that load a Mixamo character from a URL rather than providing a preloaded source. */
export type MixamoCharacterSourceProps = Omit<
  MixamoRiggedCharacterProps,
  "source" | "sourceKey" | "targetHeightM" | "rootName"
> & {
  url: string;
  targetHeightM?: number;
};

type RigLayerProps = {
  bodyType?: CharacterBodyType;
  controls: Record<string, number>;
  deformBones: Bone[];
  ik: CharacterRigState["ik"];
  resolvedBones: MixamoResolvedBones;
  restPose: MixamoRestPose;
  scene: Group;
  footGrounding: MixamoFootGroundingState | null;
};

const RUNTIME_LOCOMOTION_CLIP_IDS = [
  "idle",
  ...DIRECTOR_DIRECTIONAL_BLEND_DIRECTIONS.flatMap((direction) => [
    getDirectorDirectionalLocomotionClipId("walk", direction),
    getDirectorDirectionalLocomotionClipId("run", direction),
  ]),
  "jump",
  ...DIRECTOR_CHARACTER_EMOTE_CLIP_IDS,
] as const;
const RUNTIME_LOCOMOTION_MOTIONS = RUNTIME_LOCOMOTION_CLIP_IDS.map((clipId) =>
  getDirectorCharacterMotion(clipId),
).filter((motion): motion is NonNullable<ReturnType<typeof getDirectorCharacterMotion>> => motion !== null);

class MixamoRuntimeErrorBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

function StaticMixamoRigLayer(props: RigLayerProps) {
  useLayoutEffect(() => {
    restoreMixamoRestPose(props.scene, props.restPose, {
      bones: props.deformBones,
      updateMatrixWorld: false,
    });
    applyMixamoRigLayers(props.scene, {
      bodyType: props.bodyType,
      controls: props.controls,
      ik: props.ik,
      restPose: props.restPose,
      bones: props.resolvedBones,
    });
    applyMixamoFootGrounding(props.scene, props.footGrounding, false);
  }, [
    props.bodyType,
    props.controls,
    props.deformBones,
    props.footGrounding,
    props.ik,
    props.resolvedBones,
    props.restPose,
    props.scene,
  ]);

  return null;
}

function LoadedTimelineMixamoRigLayer({
  currentFrame,
  fps,
  motion,
  motionUrl,
  ...rig
}: RigLayerProps & {
  currentFrame: number;
  fps: number;
  motion: DirectorCharacterMotionState;
  motionUrl: string;
}) {
  const sourceMotion = useLoader(GLTFLoader, motionUrl, configureDirectorGLTFLoader);
  const binding = useMemo(() => {
    const sourceClip = sourceMotion.animations[0];
    if (!sourceClip) return null;
    const clip = retargetMixamoAnimationClip({
      clip: sourceClip,
      sourceRoot: sourceMotion.scene,
      targetRoot: rig.scene,
      targetRestPose: rig.restPose,
      rootMotion: motion.rootMotion,
      name: motion.clipId,
    });
    const mixer = new AnimationMixer(rig.scene);
    const action = configureDirectorCharacterMotionAction(mixer.clipAction(clip));
    return { action, clip, mixer };
  }, [motion.clipId, motion.rootMotion, rig.restPose, rig.scene, sourceMotion.animations, sourceMotion.scene]);

  useLayoutEffect(() => {
    if (binding) configureDirectorCharacterMotionAction(binding.action);
    const { footGrounding, ...motionRig } = rig;
    applyDirectorCharacterMotionFrame({
      ...motionRig,
      action: binding?.action,
      currentFrame,
      durationS: binding?.clip.duration,
      fps,
      mixer: binding?.mixer,
      motion,
    });
    applyMixamoFootGrounding(
      rig.scene,
      footGrounding,
      motion.enabled && motion.rootMotion === "in-place" && isDirectorLocomotionMotion(motion.clipId),
    );
  }, [binding, currentFrame, fps, motion, rig]);

  useEffect(
    () => () => {
      binding?.action.stop();
      binding?.mixer.stopAllAction();
    },
    [binding],
  );

  return null;
}

function TimelineMixamoRigLayer({
  motion,
  ...props
}: RigLayerProps & { currentFrame: number; fps: number; motion: DirectorCharacterMotionState }) {
  const catalogMotion = getDirectorCharacterMotion(motion.clipId);
  if (!catalogMotion) return <StaticMixamoRigLayer {...props} />;
  return <LoadedTimelineMixamoRigLayer {...props} motion={motion} motionUrl={catalogMotion.url} />;
}

type MotionBinding = { action: AnimationAction; clip: AnimationClip };

type RuntimeBlendState = {
  phase: "steady" | "enter" | "switch" | "exit";
  mode: DirectorCharacterLocomotionMode | null;
  emoteClipId: string | null;
  timeS: number;
  weight: number;
  fromMode: DirectorCharacterLocomotionMode | null;
  fromEmoteClipId: string | null;
  fromTimeS: number;
  fromWeight: number;
  fromRigOwnershipWeight: number;
  fromNormalizedPhase: number;
  fromPlaybackRate: number;
  fromDirectionalBlend: DirectorDirectionalBlendState | null;
  fromSnapshotLayers: readonly DirectorCharacterWeightedMotionLayer[] | null;
  fromSnapshotTurnLeanDeg: number;
  elapsedS: number;
  transitionDurationS: number;
  normalizedPhase: number;
  playbackRate: number;
  clipStartedFrame: number;
  rigOwnershipWeight: number;
};

function createRuntimeBlendState(): RuntimeBlendState {
  return {
    phase: "steady",
    mode: null,
    emoteClipId: null,
    timeS: 0,
    weight: 0,
    fromMode: null,
    fromEmoteClipId: null,
    fromTimeS: 0,
    fromWeight: 0,
    fromRigOwnershipWeight: 0,
    fromNormalizedPhase: 0,
    fromPlaybackRate: 1,
    fromDirectionalBlend: null,
    fromSnapshotLayers: null,
    fromSnapshotTurnLeanDeg: 0,
    elapsedS: DIRECTOR_CHARACTER_LOCOMOTION_CROSSFADE_S,
    transitionDurationS: DIRECTOR_CHARACTER_LOCOMOTION_CROSSFADE_S,
    normalizedPhase: 0,
    playbackRate: 1,
    clipStartedFrame: -1,
    rigOwnershipWeight: 0,
  };
}

function isDirectionalGait(mode: DirectorCharacterLocomotionMode): mode is DirectorDirectionalLocomotionGait {
  return mode === "walk" || mode === "run";
}

function advanceDirectionalPhase(
  mode: DirectorDirectionalLocomotionGait,
  normalizedPhase: number,
  playbackRate: number,
  elapsedS: number,
) {
  const durationS = getDirectorCharacterMotion(mode)?.durationS ?? 1;
  return (Math.max(0, normalizedPhase) + (Math.max(0, elapsedS) * Math.max(0, playbackRate)) / durationS) % 1;
}

function LoadedRuntimeMixamoRigLayer({
  currentFrame,
  fps,
  motion,
  runtimeOwnerRef,
  ...rig
}: RigLayerProps & {
  currentFrame: number;
  fps: number;
  motion?: DirectorCharacterMotionState;
  runtimeOwnerRef: RefObject<Group>;
}) {
  const timelineMotion = motion?.clipId ? getDirectorCharacterMotion(motion.clipId) : null;
  const motionUrls = useMemo(
    () =>
      Array.from(new Set([...RUNTIME_LOCOMOTION_MOTIONS.map((item) => item.url), timelineMotion?.url].filter(Boolean))),
    [timelineMotion?.url],
  ) as string[];
  const loadedMotions = useDirectorGltfDocuments(motionUrls);
  if (!loadedMotions) return <StaticMixamoRigLayer {...rig} />;
  return (
    <BoundRuntimeMixamoRigLayer
      {...rig}
      currentFrame={currentFrame}
      fps={fps}
      loadedMotions={loadedMotions}
      motion={motion}
      motionUrls={motionUrls}
      runtimeOwnerRef={runtimeOwnerRef}
    />
  );
}

function BoundRuntimeMixamoRigLayer({
  currentFrame,
  fps,
  loadedMotions,
  motion,
  motionUrls,
  runtimeOwnerRef,
  ...rig
}: RigLayerProps & {
  currentFrame: number;
  fps: number;
  loadedMotions: Array<GLTF | null>;
  motion?: DirectorCharacterMotionState;
  motionUrls: string[];
  runtimeOwnerRef: RefObject<Group>;
}) {
  // Only these two motion fields shape the retargeted clips. Depending on the
  // whole motion object would rebuild the mixer (and reset blend/foot-lock
  // state) on every playback tweak such as speed or weight.
  const timelineClipId = motion?.clipId;
  const timelineRootMotion = motion?.rootMotion;
  const timelineMotion = timelineClipId ? getDirectorCharacterMotion(timelineClipId) : null;
  const blendStateRef = useRef<RuntimeBlendState>(createRuntimeBlendState());
  const directionalBlendRef = useRef<DirectorDirectionalBlendState>();
  const footLockRigRef = useRef(createMixamoFootLockRigRuntime());
  const crouchRuntimeRef = useRef(createMixamoCrouchRuntime());
  const headLookRuntimeRef = useRef(createMixamoHeadLookRuntime());
  const footGroundProbeRef = useRef(new MixamoFootGroundProbe());
  const rigBlendRuntimeRef = useRef(createDirectorLocomotionRigBlendRuntime());
  const lastAppliedLayersRef = useRef<readonly DirectorCharacterWeightedMotionLayer[]>([]);
  const lastTurnLeanDegRef = useRef(0);

  const binding = useMemo(() => {
    const sourceByUrl = new Map(motionUrls.map((url, index) => [url, loadedMotions[index]]));
    const mixer = new AnimationMixer(rig.scene);
    const actions: AnimationAction[] = [];
    const runtime = new Map<string, MotionBinding>();

    RUNTIME_LOCOMOTION_MOTIONS.forEach((catalogMotion) => {
      const sourceMotion = sourceByUrl.get(catalogMotion.url);
      const sourceClip = sourceMotion?.animations[0];
      if (!sourceMotion || !sourceClip) return;
      try {
        const retargetedClip = retargetMixamoAnimationClip({
          clip: sourceClip,
          sourceRoot: sourceMotion.scene,
          targetRoot: rig.scene,
          targetRestPose: rig.restPose,
          rootMotion: "in-place",
          name: `runtime-${catalogMotion.id}`,
        });
        const hips = rig.resolvedBones.body;
        const restPosition = hips ? rig.restPose[hips.uuid]?.position : undefined;
        const clip =
          catalogMotion.id === "jump" && hips && restPosition
            ? stripPhysicalRuntimeRootTranslation({
                clip: retargetedClip,
                rootBoneName: hips.name,
                restPosition,
              })
            : retargetedClip;
        const action = configureDirectorCharacterMotionAction(mixer.clipAction(clip));
        action.enabled = false;
        action.setEffectiveWeight(0);
        actions.push(action);
        runtime.set(catalogMotion.id, { action, clip });
      } catch {
        // A single unreadable clip must not take down walk/run/idle.
      }
    });

    let timeline: MotionBinding | null = null;
    if (timelineClipId && timelineRootMotion && timelineMotion) {
      const sourceMotion = sourceByUrl.get(timelineMotion.url);
      const sourceClip = sourceMotion?.animations[0];
      if (sourceMotion && sourceClip) {
        try {
          const clip = retargetMixamoAnimationClip({
            clip: sourceClip,
            sourceRoot: sourceMotion.scene,
            targetRoot: rig.scene,
            targetRestPose: rig.restPose,
            rootMotion: timelineRootMotion,
            name: `timeline-${timelineClipId}`,
          });
          const action = configureDirectorCharacterMotionAction(mixer.clipAction(clip));
          action.enabled = false;
          action.setEffectiveWeight(0);
          actions.push(action);
          timeline = { action, clip };
        } catch {
          // Timeline clip failures must not take down the roam mixer.
        }
      }
    }

    return {
      actions,
      mixer,
      runtime,
      timeline,
      directionalAvailability: {
        walk: getDirectorDirectionalClipAvailability("walk", (clipId) => runtime.has(clipId)),
        run: getDirectorDirectionalClipAvailability("run", (clipId) => runtime.has(clipId)),
      },
    };
  }, [
    loadedMotions,
    motionUrls,
    rig.resolvedBones,
    rig.restPose,
    rig.scene,
    timelineClipId,
    timelineMotion,
    timelineRootMotion,
  ]);

  const getTimelineLayer = useCallback(
    (weightScale = 1) => {
      if (!motion || !binding.timeline) return null;
      const sample = sampleDirectorCharacterMotion(motion, currentFrame, fps, binding.timeline.clip.duration);
      if (!sample.active || sample.effectiveWeight <= 0) return null;
      return {
        action: binding.timeline.action,
        durationS: binding.timeline.clip.duration,
        timeS: sample.timeS,
        weight: sample.effectiveWeight * weightScale,
      };
    },
    [binding.timeline, currentFrame, fps, motion],
  );

  const getRuntimeLayer = useCallback(
    (mode: DirectorCharacterLocomotionMode, timeS: number, weight: number, emoteClipId?: string | null) => {
      const clipKey =
        mode === "emote" && emoteClipId && binding.runtime.has(emoteClipId)
          ? emoteClipId
          : getDirectorCharacterLocomotionClipId(mode);
      const runtimeBinding = binding.runtime.get(clipKey);
      if (!runtimeBinding || weight <= 0) return null;
      return {
        action: runtimeBinding.action,
        durationS: runtimeBinding.clip.duration,
        timeS: sampleDirectorCharacterLocomotionTime({ mode, timeS: Math.max(0, timeS) }, runtimeBinding.clip.duration),
        weight,
      };
    },
    [binding.runtime],
  );

  const getDirectionalRuntimeLayers = useCallback(
    (
      gait: DirectorDirectionalLocomotionGait,
      normalizedPhase: number,
      blend: DirectorDirectionalBlendState,
      weightScale = 1,
    ) =>
      DIRECTOR_DIRECTIONAL_BLEND_DIRECTIONS.flatMap((direction) => {
        const runtimeBinding = binding.runtime.get(getDirectorDirectionalLocomotionClipId(gait, direction));
        const weight = blend.weights[direction] * blend.activity * Math.max(0, weightScale);
        if (!runtimeBinding || weight <= 0) return [];
        return [
          {
            action: runtimeBinding.action,
            durationS: runtimeBinding.clip.duration,
            timeS: Math.min(1, Math.max(0, normalizedPhase)) * runtimeBinding.clip.duration,
            weight,
          },
        ];
      }),
    [binding.runtime],
  );

  const getRuntimeModeLayers = useCallback(
    ({
      directionalBlend,
      emoteClipId,
      mode,
      normalizedPhase,
      timeS,
      weight,
      weightScale,
    }: {
      directionalBlend?: DirectorDirectionalBlendState | null;
      emoteClipId?: string | null;
      mode: DirectorCharacterLocomotionMode;
      normalizedPhase: number;
      timeS: number;
      weight: number;
      weightScale: number;
    }) => {
      if (isDirectionalGait(mode) && directionalBlend) {
        const directionalLayers = getDirectionalRuntimeLayers(mode, normalizedPhase, directionalBlend, weightScale);
        if (directionalLayers.length > 0) return directionalLayers;
      }
      const fallback = getRuntimeLayer(mode, timeS, weight * weightScale, emoteClipId);
      return fallback ? [fallback] : [];
    },
    [getDirectionalRuntimeLayers, getRuntimeLayer],
  );

  const applyLayers = useCallback(
    (layers: readonly DirectorCharacterWeightedMotionLayer[], runtimeOwnershipWeight = 0, turnLeanDeg = 0) => {
      const { footGrounding: _footGrounding, ...motionRig } = rig;
      const runtimeOwnsRig = runtimeOwnershipWeight > 0.000001;
      const runtimeRig = runtimeOwnsRig
        ? updateDirectorLocomotionRigBlendRuntime(
            rigBlendRuntimeRef.current,
            motionRig.controls,
            motionRig.ik,
            runtimeOwnershipWeight,
          )
        : null;
      if (runtimeRig && Math.abs(turnLeanDeg) > 0.0001) {
        runtimeRig.controls["body.roll"] = (runtimeRig.controls["body.roll"] ?? 0) + turnLeanDeg;
      }
      applyDirectorCharacterWeightedMotionFrame({
        ...motionRig,
        // Character roam owns the pelvis and legs. Upper-body direction and
        // hand contacts remain authored; local-space foot IK is withheld until
        // the world-space foot-lock pass owns those effectors.
        ...(runtimeRig ?? {}),
        // During roam one final IK pass merges authored hands with the
        // independent world-space foot locks. Applying hand IK here as well
        // would solve the same chains twice and amplify elbows on each frame.
        ...(runtimeOwnsRig ? { ik: undefined } : {}),
        actions: binding.actions,
        layers,
        mixer: binding.mixer,
      });
    },
    [binding.actions, binding.mixer, rig],
  );

  useLayoutEffect(() => {
    blendStateRef.current = createRuntimeBlendState();
    directionalBlendRef.current = undefined;
    footLockRigRef.current = createMixamoFootLockRigRuntime();
    crouchRuntimeRef.current = createMixamoCrouchRuntime();
    headLookRuntimeRef.current = createMixamoHeadLookRuntime();
    rigBlendRuntimeRef.current = createDirectorLocomotionRigBlendRuntime();
    lastAppliedLayersRef.current = [];
    lastTurnLeanDegRef.current = 0;
  }, [binding]);

  useLayoutEffect(() => {
    const blend = blendStateRef.current;
    if (blend.mode !== null || blend.phase !== "steady") return;
    const timelineLayer = getTimelineLayer();
    const layers = timelineLayer ? [timelineLayer] : [];
    applyLayers(layers);
    lastAppliedLayersRef.current = layers;
    lastTurnLeanDegRef.current = 0;
  }, [applyLayers, getTimelineLayer]);

  useFrame((state, delta) => {
    const runtimeState = readDirectorCharacterLocomotionRuntimeState(runtimeOwnerRef.current?.parent ?? null);
    const blend = blendStateRef.current;
    const previousDirectionalBlend = directionalBlendRef.current;
    const interruptedSnapshotLayers = blend.phase === "steady" ? null : lastAppliedLayersRef.current;
    const interruptedSnapshotTurnLeanDeg = blend.phase === "steady" ? 0 : lastTurnLeanDegRef.current;

    // The active player can mount one frame before PlayerController publishes
    // its WeakMap state. Do not repeatedly restore/skeleton-solve during that
    // gap (or after a completed exit transition). A still-fading crouch or
    // head look keeps the loop alive so its residual pose cannot freeze on
    // the rig.
    if (
      !runtimeState &&
      blend.phase === "steady" &&
      blend.mode === null &&
      getMixamoCrouchWeight(crouchRuntimeRef.current) <= 0 &&
      isMixamoHeadLookSettled(headLookRuntimeRef.current)
    ) {
      return;
    }

    const runtimeEmoteClipId = runtimeState?.mode === "emote" ? (runtimeState.emoteClipId ?? null) : null;
    if (runtimeState) {
      if (blend.mode === null) {
        blend.phase = "enter";
        blend.fromMode = null;
        blend.fromEmoteClipId = null;
        blend.fromRigOwnershipWeight = blend.rigOwnershipWeight;
        blend.fromSnapshotLayers = interruptedSnapshotLayers;
        blend.fromSnapshotTurnLeanDeg = interruptedSnapshotTurnLeanDeg;
        blend.mode = runtimeState.mode;
        blend.emoteClipId = runtimeEmoteClipId;
        blend.elapsedS = 0;
        blend.transitionDurationS = resolveDirectorCharacterLocomotionTransitionDurationS(
          runtimeState.transitionDurationS,
        );
      } else if (blend.mode !== runtimeState.mode || blend.emoteClipId !== runtimeEmoteClipId) {
        blend.phase = "switch";
        blend.fromMode = blend.mode;
        blend.fromEmoteClipId = blend.emoteClipId;
        blend.fromTimeS = blend.timeS;
        blend.fromWeight = blend.weight;
        blend.fromRigOwnershipWeight = blend.rigOwnershipWeight;
        blend.fromNormalizedPhase = blend.normalizedPhase;
        blend.fromPlaybackRate = blend.playbackRate;
        blend.fromDirectionalBlend = previousDirectionalBlend ?? null;
        blend.fromSnapshotLayers = interruptedSnapshotLayers;
        blend.fromSnapshotTurnLeanDeg = interruptedSnapshotTurnLeanDeg;
        blend.mode = runtimeState.mode;
        blend.emoteClipId = runtimeEmoteClipId;
        blend.elapsedS = 0;
        blend.transitionDurationS = resolveDirectorCharacterLocomotionTransitionDurationS(
          runtimeState.transitionDurationS,
        );
      }
    } else if (blend.mode !== null) {
      blend.phase = "exit";
      blend.fromMode = blend.mode;
      blend.fromEmoteClipId = blend.emoteClipId;
      blend.fromTimeS = blend.timeS;
      blend.fromWeight = blend.weight;
      blend.fromRigOwnershipWeight = blend.rigOwnershipWeight;
      blend.fromNormalizedPhase = blend.normalizedPhase;
      blend.fromPlaybackRate = blend.playbackRate;
      blend.fromDirectionalBlend = previousDirectionalBlend ?? null;
      blend.fromSnapshotLayers = interruptedSnapshotLayers;
      blend.fromSnapshotTurnLeanDeg = interruptedSnapshotTurnLeanDeg;
      blend.mode = null;
      blend.emoteClipId = null;
      blend.elapsedS = 0;
      blend.transitionDurationS = DIRECTOR_CHARACTER_LOCOMOTION_CROSSFADE_S;
    }

    if (
      runtimeState &&
      (runtimeState.mode === "jump" || runtimeState.mode === "emote") &&
      runtimeState.clipStartedFrame !== blend.clipStartedFrame
    ) {
      // Re-arm the restarted one-shot: a previous run may have finished and
      // paused the LoopOnce action, which would hold its clamped final pose.
      // Emotes falling back to the shared idle clip are deliberately skipped;
      // resetting idle would pop every other layer that samples it.
      const oneShotClipId =
        runtimeState.mode === "jump"
          ? "jump"
          : runtimeEmoteClipId && binding.runtime.has(runtimeEmoteClipId)
            ? runtimeEmoteClipId
            : null;
      const oneShotBinding = oneShotClipId ? binding.runtime.get(oneShotClipId) : undefined;
      if (oneShotBinding) {
        configureDirectorCharacterMotionAction(oneShotBinding.action);
        oneShotBinding.action.enabled = false;
        oneShotBinding.action.setEffectiveWeight(0);
      }
      blend.clipStartedFrame = runtimeState.clipStartedFrame;
    }

    if (blend.phase !== "steady") {
      blend.elapsedS = Math.min(
        blend.transitionDurationS,
        blend.elapsedS + Math.max(0, Math.min(delta, Math.max(blend.transitionDurationS, 0.1))),
      );
    }
    const alpha = sampleDirectorCharacterLocomotionBlend(blend.elapsedS, blend.transitionDurationS);
    const runtimeOwnershipWeight = sampleDirectorCharacterLocomotionRigOwnership({
      phase: blend.phase,
      alpha,
      runtimeWeight: runtimeState?.weight ?? 0,
      fromWeight: blend.fromRigOwnershipWeight,
      runtimeActive: Boolean(runtimeState),
    });
    blend.rigOwnershipWeight = runtimeOwnershipWeight;
    const layers: DirectorCharacterWeightedMotionLayer[] = [];
    let directionalBlend: DirectorDirectionalBlendResult | null = null;

    if (runtimeState && isDirectionalGait(runtimeState.mode)) {
      directionalBlend = sampleDirectorDirectionalBlend({
        localVelocityX: runtimeState.localVelocityX,
        localVelocityZ: runtimeState.localVelocityZ,
        angularVelocityRadS: runtimeState.angularVelocityRadS,
        locomotion: runtimeState,
        previous: previousDirectionalBlend,
        deltaS: delta,
        clipAvailability: binding.directionalAvailability[runtimeState.mode],
      });
      directionalBlendRef.current = directionalBlend;
    } else if (runtimeState) {
      directionalBlendRef.current = undefined;
    }

    if (runtimeState) {
      if (blend.phase === "enter") {
        if (blend.fromSnapshotLayers !== null) {
          blend.fromSnapshotLayers.forEach((layer) => layers.push({ ...layer, weight: layer.weight * (1 - alpha) }));
        } else {
          const timelineLayer = getTimelineLayer(1 - alpha);
          if (timelineLayer) layers.push(timelineLayer);
        }
      }
      if (blend.phase === "switch" && blend.fromMode) {
        if (blend.fromSnapshotLayers !== null) {
          blend.fromSnapshotLayers.forEach((layer) => layers.push({ ...layer, weight: layer.weight * (1 - alpha) }));
        } else {
          const fromNormalizedPhase = isDirectionalGait(blend.fromMode)
            ? advanceDirectionalPhase(blend.fromMode, blend.fromNormalizedPhase, blend.fromPlaybackRate, blend.elapsedS)
            : blend.fromNormalizedPhase;
          layers.push(
            ...getRuntimeModeLayers({
              directionalBlend: blend.fromDirectionalBlend,
              emoteClipId: blend.fromEmoteClipId,
              mode: blend.fromMode,
              normalizedPhase: fromNormalizedPhase,
              timeS: blend.fromTimeS + blend.elapsedS * blend.fromPlaybackRate,
              weight: blend.fromWeight,
              weightScale: 1 - alpha,
            }),
          );
        }
      }
      layers.push(
        ...getRuntimeModeLayers({
          directionalBlend,
          emoteClipId: runtimeEmoteClipId,
          mode: runtimeState.mode,
          normalizedPhase: runtimeState.normalizedPhase,
          timeS: runtimeState.timeS,
          weight: runtimeState.weight,
          weightScale: blend.phase === "steady" ? 1 : alpha,
        }),
      );
      blend.timeS = runtimeState.timeS;
      blend.weight = runtimeState.weight;
      blend.normalizedPhase = runtimeState.normalizedPhase;
      blend.playbackRate = runtimeState.playbackRate;
    } else if (blend.phase === "exit" && blend.fromMode) {
      if (blend.fromSnapshotLayers !== null) {
        blend.fromSnapshotLayers.forEach((layer) => layers.push({ ...layer, weight: layer.weight * (1 - alpha) }));
      } else {
        const fromNormalizedPhase = isDirectionalGait(blend.fromMode)
          ? advanceDirectionalPhase(blend.fromMode, blend.fromNormalizedPhase, blend.fromPlaybackRate, blend.elapsedS)
          : blend.fromNormalizedPhase;
        layers.push(
          ...getRuntimeModeLayers({
            directionalBlend: blend.fromDirectionalBlend,
            emoteClipId: blend.fromEmoteClipId,
            mode: blend.fromMode,
            normalizedPhase: fromNormalizedPhase,
            timeS: blend.fromTimeS + blend.elapsedS * blend.fromPlaybackRate,
            weight: blend.fromWeight,
            weightScale: 1 - alpha,
          }),
        );
      }
      const timelineLayer = getTimelineLayer(alpha);
      if (timelineLayer) layers.push(timelineLayer);
    } else {
      const timelineLayer = getTimelineLayer();
      if (timelineLayer) layers.push(timelineLayer);
    }

    const targetTurnLeanDeg = directionalBlend?.turnLeanDeg ?? 0;
    const fromTurnLeanDeg =
      blend.fromSnapshotLayers !== null
        ? blend.fromSnapshotTurnLeanDeg
        : (blend.fromDirectionalBlend?.turnLeanDeg ?? 0);
    const turnLeanDeg =
      blend.phase === "enter"
        ? targetTurnLeanDeg * alpha
        : blend.phase === "switch" || blend.phase === "exit"
          ? fromTurnLeanDeg + (targetTurnLeanDeg - fromTurnLeanDeg) * alpha
          : targetTurnLeanDeg;
    const runtimeOwnsRig = runtimeOwnershipWeight > 0.000001;
    applyLayers(layers, runtimeOwnershipWeight, turnLeanDeg);
    lastAppliedLayersRef.current = layers;
    lastTurnLeanDegRef.current = turnLeanDeg;
    // Runtime feet are grounded independently after the blended clip is
    // sampled. Reset the old whole-root correction first; retaining it would
    // make both planted feet and the camera bob when only one foot swings.
    applyMixamoFootGrounding(rig.scene, rig.footGrounding, false);
    // Procedural crouch layers over the sampled gait before the foot lock
    // samples the feet: it drops the hips, re-plants both feet with leg IK,
    // and leans the spine, so the lock still sees the unmodified trajectory.
    const crouchWeight = updateMixamoCrouchWeight(
      crouchRuntimeRef.current,
      isMixamoCrouchEligible(runtimeState),
      delta,
    );
    // Head look damps toward the published gaze every frame, even while it is
    // fading out after an emote/jump/exit stole eligibility.
    const headLookWeight = updateMixamoHeadLook(headLookRuntimeRef.current, runtimeState, delta);
    const directorSpace = runtimeOwnerRef.current?.parent;
    if (directorSpace) {
      if (crouchWeight > 0) {
        applyMixamoCrouchPose(crouchRuntimeRef.current, {
          root: rig.scene,
          directorSpace,
          bones: rig.resolvedBones,
        });
      }
      directorSpace.updateWorldMatrix(true, false);
      const groundHeightWorld = directorSpace.matrixWorld.elements[13];
      // Resolve the live viewport root from the character's actual hierarchy.
      // This keeps the probe bound to the same scene even if the R3F root is
      // remounted, and avoids a second renderer-context dependency here.
      let viewportScene: Object3D = directorSpace;
      while (viewportScene.parent) viewportScene = viewportScene.parent;
      const footGround = footGroundProbeRef.current.sample({
        sceneRoot: viewportScene,
        characterRoot: directorSpace,
        leftFoot: rig.resolvedBones.leftFoot,
        rightFoot: rig.resolvedBones.rightFoot,
        fallbackGroundHeightWorld: groundHeightWorld,
      });
      const footLockIk = updateMixamoFootLockRigRuntime(footLockRigRef.current, {
        bones: rig.resolvedBones,
        directorSpace,
        deltaS: delta,
        grounded:
          runtimeState?.grounded === true ||
          (!runtimeState && blend.phase === "exit" && blend.fromMode !== "jump" && blend.fromMode !== "fly"),
        locomotionMode: runtimeState?.mode ?? blend.fromMode ?? blend.mode,
        actionKey: runtimeState
          ? `${runtimeState.mode}:${runtimeState.mode === "jump" ? runtimeState.clipStartedFrame : 0}`
          : "runtime-exit",
        leftGroundHeightWorld: footGround.leftGroundHeightWorld,
        rightGroundHeightWorld: footGround.rightGroundHeightWorld,
        leftGroundNormalWorld: footGround.leftGroundNormalWorld,
        rightGroundNormalWorld: footGround.rightGroundNormalWorld,
        authoredIk: rig.ik,
        runtimeOwnershipWeight,
      });
      if (runtimeOwnsRig) {
        applyMixamoCharacterIk(rig.scene, rig.resolvedBones, footLockIk);
        applyMixamoFootSlopeAlignment(footLockRigRef.current, rig.resolvedBones, runtimeOwnershipWeight);
      }
      // Gaze goes last: neck/head rotations compose over the crouch lean and
      // cannot disturb the freshly solved legs, feet, or authored hand IK.
      if (headLookWeight > 0) {
        applyMixamoHeadLookPose(headLookRuntimeRef.current, {
          root: rig.scene,
          directorSpace,
          bones: rig.resolvedBones,
        });
      }
    }

    if (blend.phase !== "steady" && blend.elapsedS >= blend.transitionDurationS) {
      blend.phase = "steady";
      blend.fromMode = null;
      blend.fromEmoteClipId = null;
      blend.fromTimeS = 0;
      blend.fromWeight = 0;
      blend.fromRigOwnershipWeight = 0;
      blend.fromNormalizedPhase = 0;
      blend.fromPlaybackRate = 1;
      blend.fromDirectionalBlend = null;
      blend.fromSnapshotLayers = null;
      blend.fromSnapshotTurnLeanDeg = 0;
      if (!runtimeState && blend.mode === null) directionalBlendRef.current = undefined;
    }
    if (
      blend.phase !== "steady" ||
      !isMixamoCrouchSettled(crouchRuntimeRef.current) ||
      !isMixamoHeadLookSettled(headLookRuntimeRef.current)
    ) {
      state.invalidate();
    }
  });

  useEffect(() => {
    // React StrictMode intentionally runs effect cleanup/setup twice in
    // development. Re-arm the same cached actions on setup; uncacheRoot or
    // uncacheClip would make those action objects impossible to reactivate.
    binding.actions.forEach((action) => {
      configureDirectorCharacterMotionAction(action);
      action.enabled = false;
      action.setEffectiveWeight(0);
    });
    return () => {
      binding.actions.forEach((action) => action.stop());
      binding.mixer.stopAllAction();
    };
  }, [binding]);

  return null;
}

/**
 * 渲染一个 Mixamo 绑定角色，支持静态姿势、时间轴动画和实时运动混合。
 * 根据 runtimeControlled 和 motion 属性自动选择静态、时间轴或运行时渲染路径。
 */
export const MixamoRiggedCharacter = memo(function MixamoRiggedCharacter({
  source,
  sourceKey,
  bodyType,
  rigState,
  currentFrame = 0,
  fps = 24,
  targetHeightM,
  rootName,
  runtimeControlled = false,
  onLabelAnchorYChange,
  onVisualCenterChange,
  onMetricsChange,
}: MixamoRiggedCharacterProps) {
  const runtimeRootRef = useRef<Group>(null!);
  const prepared = useMemo(
    () => prepareMixamoCharacterInstance(source, sourceKey, targetHeightM),
    [source, sourceKey, targetHeightM],
  );
  const { scene, restPose, deformBones, resolvedBones } = prepared;
  const footGrounding = useMemo(() => createMixamoFootGroundingState(scene), [scene]);
  const resolvedControls = useMemo(() => resolveCharacterPoseControls(rigState), [rigState]);
  const rigLayerProps = useMemo<RigLayerProps>(
    () => ({
      bodyType,
      controls: resolvedControls,
      deformBones,
      footGrounding,
      ik: rigState?.ik,
      resolvedBones,
      restPose,
      scene,
    }),
    [bodyType, deformBones, footGrounding, resolvedBones, resolvedControls, restPose, rigState?.ik, scene],
  );

  useEffect(() => {
    const frameId = requestAnimationFrame(() => {
      const metrics = measureMixamoCharacter(scene) ?? prepared.metrics;
      if (!metrics) return;
      publishMixamoCharacterMetrics(metrics, onLabelAnchorYChange, onVisualCenterChange, onMetricsChange);
    });
    return () => cancelAnimationFrame(frameId);
  }, [bodyType, onLabelAnchorYChange, onMetricsChange, onVisualCenterChange, prepared.metrics, rigState, scene]);

  useEffect(() => () => disposeMixamoCharacterInstanceMaterials(scene), [scene]);

  return (
    <group ref={runtimeRootRef} name={rootName}>
      <Suspense fallback={<StaticMixamoRigLayer {...rigLayerProps} />}>
        {runtimeControlled ? (
          <MixamoRuntimeErrorBoundary fallback={<StaticMixamoRigLayer {...rigLayerProps} />}>
            <LoadedRuntimeMixamoRigLayer
              {...rigLayerProps}
              currentFrame={currentFrame}
              fps={fps}
              motion={rigState?.motion}
              runtimeOwnerRef={runtimeRootRef}
            />
          </MixamoRuntimeErrorBoundary>
        ) : rigState?.motion ? (
          <TimelineMixamoRigLayer {...rigLayerProps} currentFrame={currentFrame} fps={fps} motion={rigState.motion} />
        ) : (
          <StaticMixamoRigLayer {...rigLayerProps} />
        )}
      </Suspense>
      <primitive dispose={null} object={scene} />
    </group>
  );
});
