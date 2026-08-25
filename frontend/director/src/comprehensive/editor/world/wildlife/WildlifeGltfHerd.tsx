import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { AnimationMixer, Group, type AnimationAction, type Object3D } from "three";
import { clone as cloneSkinnedObject } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { DirectorWorldWildlifeGroup } from "../../../../../../../packages/protocol/src/worldSystemsProtocol";
import type { LivingWorldFrameContext } from "../livingWorldContracts";
import type { WildlifeSim } from "./wildlifeSim";
import {
  computeWildlifeModelNormalization,
  resolveWildlifePlaceholderHeightM,
  selectWildlifeClipIndex,
  wildlifeMixerTimeSeconds,
  type WildlifeAssetBinding,
} from "./wildlifeAssets";
import {
  lerp,
  lerpAngle,
  sampleWildlifeGroundPose,
  WILDLIFE_SLOPE_PROBE_HALF_SPACING_M,
  type WildlifeGroundPose,
} from "./wildlifeGrounding";

/**
 * Per-agent glTF herd rendering (herd archetypes only; herd counts are small,
 * typically <= 24, so one SkeletonUtils clone per agent is affordable where
 * flocks/schools need instancing and therefore keep placeholders).
 *
 * Every agent transform comes from the same interpolated sim state as the
 * instanced path, and animation is driven deterministically: the mixer is
 * never advanced by frame delta — `mixer.setTime(absolute)` makes the skeleton
 * pose a pure function of (worldSeconds, agent phase), so scrubbing and
 * out-of-order export reproduce identical frames.
 *
 * P1 simplifications (documented trade-offs):
 * - Behavior clip changes hard-switch (stop/play) instead of crossfading.
 * - No walk-bob or whole-body graze pitch: gait bounce and head-down poses
 *   belong to the model's clips; only the terrain slope tilts the body.
 */

interface WildlifeGltfAgent {
  container: Group;
  mixer: AnimationMixer;
  actions: AnimationAction[];
  currentActionIndex: number;
}

const scratchGroundPose: WildlifeGroundPose = { groundY: 0, slopePitchRad: 0 };

function buildAgents(binding: WildlifeAssetBinding, group: DirectorWorldWildlifeGroup): WildlifeGltfAgent[] {
  const targetHeight = resolveWildlifePlaceholderHeightM(group.species) * group.sizeScale;
  const normalization = computeWildlifeModelNormalization(binding.bboxMinY, binding.bboxHeight, targetHeight);
  const agents: WildlifeGltfAgent[] = [];
  for (let index = 0; index < group.count; index += 1) {
    // SkeletonUtils.clone shares geometry/materials with the cached prototype
    // and clones only the node/bone graph, so N agents cost N skeletons, not
    // N meshes.
    const model = cloneSkinnedObject(binding.scene);
    model.scale.setScalar(normalization.scale);
    model.position.y = normalization.offsetY;
    model.traverse((child: Object3D) => {
      if ((child as Object3D & { isMesh?: boolean }).isMesh) {
        child.castShadow = true;
        child.receiveShadow = false;
      }
    });
    const container = new Group();
    // The living-world- marker keeps agents out of the terrain probe's
    // raycasts (they are also under the living-world-wildlife layer group).
    container.name = `living-world-wildlife-agent-${group.id}-${index}`;
    container.rotation.order = "YXZ";
    container.add(model);
    const mixer = new AnimationMixer(model);
    agents.push({
      container,
      mixer,
      actions: binding.clips.map((clip) => mixer.clipAction(clip)),
      currentActionIndex: -1,
    });
  }
  return agents;
}

export default function WildlifeGltfHerd({
  group,
  context,
  sim,
  binding,
}: {
  group: DirectorWorldWildlifeGroup;
  context: LivingWorldFrameContext;
  sim: WildlifeSim;
  binding: WildlifeAssetBinding;
}) {
  const agents = useMemo(
    () => buildAgents(binding, group),
    // Only count/size/species/id shape the clones; area/speed changes flow
    // through the sim without rebuilding them.
    [binding, group],
  );

  useEffect(
    () => () => {
      // Release mixer bindings; shared geometry/materials belong to the
      // module-level asset cache and are intentionally not disposed here.
      for (const agent of agents) {
        agent.mixer.stopAllAction();
        agent.mixer.uncacheRoot(agent.mixer.getRoot() as Object3D);
      }
    },
    [agents],
  );

  const lastComposeRef = useRef<{ agents: WildlifeGltfAgent[]; sim: WildlifeSim; seconds: number } | null>(null);

  useFrame(() => {
    const last = lastComposeRef.current;
    if (last && last.agents === agents && last.sim === sim && last.seconds === context.worldSeconds) return;
    sim.stepTo(context.worldSeconds);
    const render = sim.readRenderState();
    const { prev, curr, alpha } = render;
    const sample = context.sampleGroundHeight;
    const probeHalfSpacing = WILDLIFE_SLOPE_PROBE_HALF_SPACING_M * group.sizeScale;
    const count = Math.min(agents.length, render.count);

    for (let i = 0; i < count; i += 1) {
      const agent = agents[i];
      const px = lerp(prev.posX[i], curr.posX[i], alpha);
      const py = lerp(prev.posY[i], curr.posY[i], alpha);
      const pz = lerp(prev.posZ[i], curr.posZ[i], alpha);
      const yaw = lerpAngle(prev.heading[i], curr.heading[i], alpha);
      const grazeBlend = lerp(prev.grazeBlend[i], curr.grazeBlend[i], alpha);

      // Terrain snapping stays render-side: the sim's py is the flat plane
      // (checkpoint-replayed state must not depend on scene contents).
      let groundY = py;
      let slopePitch = 0;
      if (sample) {
        sampleWildlifeGroundPose(sample, px, pz, yaw, py, probeHalfSpacing, scratchGroundPose);
        groundY = scratchGroundPose.groundY;
        slopePitch = scratchGroundPose.slopePitchRad;
      }
      agent.container.position.set(px, groundY, pz);
      agent.container.rotation.set(slopePitch, yaw, 0);

      if (agent.actions.length > 0) {
        // grazeBlend is the sim's smoothed 0..1 head-down blend; past the
        // midpoint the agent reads as grazing. Hard clip switch (no
        // crossfade) is the accepted P1 behavior.
        const moving = grazeBlend < 0.5;
        const desired = selectWildlifeClipIndex(binding.clipNames, moving);
        if (desired !== agent.currentActionIndex && desired >= 0) {
          if (agent.currentActionIndex >= 0) agent.actions[agent.currentActionIndex].stop();
          agent.actions[desired].play();
          agent.currentActionIndex = desired;
        }
        agent.mixer.setTime(wildlifeMixerTimeSeconds(context.worldSeconds, prev.phase[i], group.speedScale));
      }
    }
    lastComposeRef.current = { agents, sim, seconds: context.worldSeconds };
  });

  return (
    <group>
      {agents.map((agent) => (
        <primitive key={agent.container.name} object={agent.container} dispose={null} />
      ))}
    </group>
  );
}
