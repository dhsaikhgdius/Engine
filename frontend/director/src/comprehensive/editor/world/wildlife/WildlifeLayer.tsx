/**
 * WildlifeLayer: three.js presentation of the pure wildlife simulation
 * (wildlifeSim.ts). Each species group renders as instanced part meshes from
 * the placeholder model library, with per-instance gait angles packed into
 * interleaved attributes so limb/wing articulation is computed in the vertex
 * shader. useFrame steps the sim to the world clock and rewrites instance
 * matrices in place — React state never touches per-agent data, and the sim's
 * determinism guarantees identical herds during scrubbing and frame export.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import {
  DoubleSide,
  DynamicDrawUsage,
  Euler,
  InstancedInterleavedBuffer,
  InstancedMesh,
  InterleavedBufferAttribute,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from "three";
import type { DirectorWorldWildlifeGroup } from "../../../../../../../packages/protocol/src/worldSystemsProtocol";
import { useDirectorStore } from "../../store/directorStore";
import type { LivingWorldFrameContext, WildlifeLayerProps } from "../livingWorldContracts";
import { buildWildlifeModel, WILDLIFE_PART_ANGLE_SLOTS, WILDLIFE_RENDER_PROFILES } from "./placeholderModels";
import {
  resolveWildlifeGaitProfile,
  wildlifeBodyLiftM,
  wildlifeBodyPitchRad,
  wildlifeGaitPhase,
  writeWildlifePartAngles,
} from "./wildlifeGait";
import {
  createWildlifePartDepthMaterial,
  createWildlifePartMaterial,
  WILDLIFE_PART_ANGLES_ATTRIBUTE_0,
  WILDLIFE_PART_ANGLES_ATTRIBUTE_1,
} from "./wildlifePartMaterial";
import {
  buildWildlifeEnvironment,
  createWildlifeSim,
  shouldRecreateWildlifeSim,
  WILDLIFE_CRUISE_SPEED_MPS,
  type WildlifeSim,
  type WildlifeSimEnvironment,
  type WildlifeWaterRect,
} from "./wildlifeSim";
import {
  lerp,
  lerpAngle,
  sampleWildlifeGroundPose,
  wildlifeTerrainLift,
  WILDLIFE_SLOPE_PROBE_HALF_SPACING_M,
  type WildlifeGroundPose,
} from "./wildlifeGrounding";
import { loadWildlifeAssetBinding, warnWildlifeAssetOnce, type WildlifeAssetBinding } from "./wildlifeAssets";
import WildlifeGltfHerd from "./WildlifeGltfHerd";

/**
 * Wildlife sub-layer: one InstancedMesh per group, matrices written from the
 * deterministic sim every frame.
 *
 * Per-frame work is a single sim.stepTo(context.worldSeconds) plus a matrix
 * compose loop over reused module-level temp objects — no allocations. The
 * two surrounding sim ticks are interpolated (linear positions, shortest-arc
 * heading lerp) so 30 Hz simulation renders smoothly at any frame rate.
 * Secondary motion is a pure function of (worldSeconds, per-agent phase, sim
 * state), so exports and scrubbing reproduce it exactly:
 * - flock/school: whole-body wing flap / tail wiggle (render profile).
 * - herd: articulated placeholder gait. The compose loop also writes 8
 *   per-part angle slots per agent (legs, head, tail; see wildlifeGait.ts)
 *   into an instanced interleaved attribute pair, and the part vertex shader
 *   (wildlifePartMaterial.ts) rotates the tagged geometry parts about their
 *   baked pivots. Still one draw call per group; grazing pitches the head
 *   part down instead of tilting the whole body.
 *
 * Terrain grounding is render-side only: the sim keeps herd agents on the
 * flat ground plane so checkpoint replay stays byte-identical regardless of
 * scene contents, and this layer snaps each rendered agent to
 * `context.sampleGroundHeight` (when present) at compose time.
 */

const TWO_PI = Math.PI * 2;

const tempMatrix = new Matrix4();
const tempPosition = new Vector3();
const tempQuaternion = new Quaternion();
const tempEuler = new Euler();
const UNIT_SCALE = new Vector3(1, 1, 1);
const tempGroundPose: WildlifeGroundPose = { groundY: 0, slopePitchRad: 0, slopeRollRad: 0, clipLiftM: 0 };

function composeGroupMatrices(
  mesh: InstancedMesh,
  sim: WildlifeSim,
  group: DirectorWorldWildlifeGroup,
  context: LivingWorldFrameContext,
): void {
  const render = sim.readRenderState();
  const { prev, curr, alpha } = render;
  const profile = WILDLIFE_RENDER_PROFILES[group.species];
  const seconds = context.worldSeconds;
  const archetype = sim.archetype;
  const speedRef = Math.max(WILDLIFE_CRUISE_SPEED_MPS[group.species] * group.speedScale, 1e-3);
  const bodyOffsetY = profile.bodyOffsetYM * group.sizeScale;
  const count = Math.min(mesh.count, render.count);
  const groundSample = context.sampleGroundHeight;
  const slopeProbeHalfSpacing = WILDLIFE_SLOPE_PROBE_HALF_SPACING_M * group.sizeScale;
  // Herd articulation targets: gait angles stream into the instanced
  // interleaved angle attribute consumed by the part vertex shader.
  const gait = archetype === "herd" ? resolveWildlifeGaitProfile(group.species) : null;
  const anglesAttribute = gait
    ? (mesh.geometry.getAttribute(WILDLIFE_PART_ANGLES_ATTRIBUTE_0) as InterleavedBufferAttribute | undefined)
    : undefined;
  const angleArray = anglesAttribute ? (anglesAttribute.data.array as Float32Array) : null;
  // Butterflies fly a low band; with terrain sampling it follows local relief
  // measured against the terrain at the area centre (falling back to the flat
  // plane), so the authored band height is preserved at the centre instead of
  // double-counting a centre placed uphill.
  const butterflyLiftReferenceY =
    archetype === "flock" && group.species === "butterflies" && groundSample
      ? (groundSample(group.area.center[0], group.area.center[2]) ?? context.groundHeight)
      : null;

  for (let i = 0; i < count; i += 1) {
    const px = lerp(prev.posX[i], curr.posX[i], alpha);
    let py = lerp(prev.posY[i], curr.posY[i], alpha);
    const pz = lerp(prev.posZ[i], curr.posZ[i], alpha);
    const vx = lerp(prev.velX[i], curr.velX[i], alpha);
    const vy = lerp(prev.velY[i], curr.velY[i], alpha);
    const vz = lerp(prev.velZ[i], curr.velZ[i], alpha);
    const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
    const agentPhase = prev.phase[i];

    let yaw: number;
    let pitch = 0;
    let roll = 0;

    if (archetype === "herd") {
      // Velocity collapses to zero while grazing, so orientation comes from
      // the sim's turn-rate-limited heading instead of atan2 on noise.
      yaw = lerpAngle(prev.heading[i], curr.heading[i], alpha);
      const grazeBlend = lerp(prev.grazeBlend[i], curr.grazeBlend[i], alpha);
      if (groundSample) {
        // Sim py IS the flat plane for herds; snapping replaces it with the
        // sampled terrain height and tilts the body to the local fore/aft
        // slope. Sampling stays render-side so replayed sim state never
        // depends on scene contents (see livingWorldContracts).
        sampleWildlifeGroundPose(groundSample, px, pz, yaw, py, slopeProbeHalfSpacing, tempGroundPose);
        py = tempGroundPose.groundY + tempGroundPose.clipLiftM;
        pitch += tempGroundPose.slopePitchRad;
        roll = tempGroundPose.slopeRollRad;
      }
      py += bodyOffsetY;
      if (gait) {
        const speedFactor = Math.min(1, speed / speedRef);
        const gaitPhase = wildlifeGaitPhase(seconds, agentPhase, gait.strideHz);
        py += wildlifeBodyLiftM(gait, gaitPhase, speedFactor) * group.sizeScale;
        pitch += wildlifeBodyPitchRad(gait, gaitPhase, speedFactor);
        if (angleArray) {
          // Leg swing, head nod/graze pitch, and tail motion resolve in the
          // vertex shader from these per-agent part angles.
          writeWildlifePartAngles(angleArray, i, gait, gaitPhase, speedFactor, grazeBlend);
        }
      }
    } else {
      if (speed > 1e-4) {
        yaw = Math.atan2(vx, vz);
        const climbRatio = Math.min(Math.max(vy / speed, -1), 1);
        pitch = -Math.asin(climbRatio) * 0.7; // soften dive/climb attitude
      } else {
        yaw = agentPhase;
      }
      if (archetype === "flock") {
        // Whole-body roll oscillation fakes the wing flap cheaply.
        roll = Math.sin(seconds * TWO_PI * profile.flapHz + agentPhase) * profile.flapAmplitudeRad;
        if (butterflyLiftReferenceY !== null && groundSample) {
          py += wildlifeTerrainLift(groundSample(px, pz), butterflyLiftReferenceY);
        }
      } else {
        // Fish: tail wiggle as a small yaw oscillation.
        yaw += Math.sin(seconds * TWO_PI * profile.wiggleHz + agentPhase * 2) * profile.wiggleAmplitudeRad;
      }
    }

    tempEuler.set(pitch, yaw, roll, "YXZ");
    tempQuaternion.setFromEuler(tempEuler);
    tempPosition.set(px, py, pz);
    tempMatrix.compose(tempPosition, tempQuaternion, UNIT_SCALE);
    mesh.setMatrixAt(i, tempMatrix);
  }
  if (anglesAttribute) anglesAttribute.data.needsUpdate = true;
  mesh.instanceMatrix.needsUpdate = true;
}

function WildlifeGroupInstances({
  group,
  context,
  sim,
}: {
  group: DirectorWorldWildlifeGroup;
  context: LivingWorldFrameContext;
  sim: WildlifeSim;
}) {
  const isHerd = sim.archetype === "herd";

  const geometry = useMemo(
    () => buildWildlifeModel(group.species, group.sizeScale).geometry,
    [group.sizeScale, group.species],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);

  const material = useMemo(
    () =>
      isHerd
        ? // Part-articulated shader material; closed boxes render front-side.
          createWildlifePartMaterial(WILDLIFE_RENDER_PROFILES[group.species].tintHex)
        : new MeshStandardMaterial({
            color: WILDLIFE_RENDER_PROFILES[group.species].tintHex,
            roughness: 0.9,
            metalness: 0,
            side: DoubleSide, // wing/fin planes are single triangles
          }),
    [group.species, isHerd],
  );
  useEffect(() => () => material.dispose(), [material]);

  const mesh = useMemo(() => {
    const instanced = new InstancedMesh(geometry, material, group.count);
    instanced.frustumCulled = false; // agents roam; per-instance culling is not worth it
    instanced.instanceMatrix.setUsage(DynamicDrawUsage);
    instanced.castShadow = true;
    instanced.receiveShadow = false;
    if (isHerd) {
      // Per-instance part angles (8 slots as 2 × vec4), streamed every frame
      // by composeGroupMatrices. One interleaved buffer keeps it one upload.
      const angles = new InstancedInterleavedBuffer(
        new Float32Array(group.count * WILDLIFE_PART_ANGLE_SLOTS),
        WILDLIFE_PART_ANGLE_SLOTS,
        1,
      );
      angles.setUsage(DynamicDrawUsage);
      geometry.setAttribute(WILDLIFE_PART_ANGLES_ATTRIBUTE_0, new InterleavedBufferAttribute(angles, 4, 0));
      geometry.setAttribute(WILDLIFE_PART_ANGLES_ATTRIBUTE_1, new InterleavedBufferAttribute(angles, 4, 4));
      // Without a matching depth material, animated legs would cast the
      // rigid bind pose into the shadow map.
      instanced.customDepthMaterial = createWildlifePartDepthMaterial();
    }
    return instanced;
  }, [geometry, group.count, isHerd, material]);
  // InstancedMesh.dispose releases the instanceMatrix GPU buffer via the
  // renderer's dispose listener; geometry/material are disposed by the
  // effects above when their memo keys (species/sizeScale) change.
  useEffect(
    () => () => {
      mesh.customDepthMaterial?.dispose();
      mesh.dispose?.();
    },
    [mesh],
  );

  // Skip recompose when nothing observable changed (paused playhead with a
  // frozen ambient clock) to avoid redundant instanceMatrix uploads.
  const lastComposeRef = useRef<{ mesh: InstancedMesh; sim: WildlifeSim; seconds: number } | null>(null);

  useFrame(() => {
    const last = lastComposeRef.current;
    if (last && last.mesh === mesh && last.sim === sim && last.seconds === context.worldSeconds) return;
    sim.stepTo(context.worldSeconds);
    composeGroupMatrices(mesh, sim, group, context);
    lastComposeRef.current = { mesh, sim, seconds: context.worldSeconds };
  });

  return <primitive object={mesh} dispose={null} />;
}

function WildlifeGroup({
  group,
  context,
  environment,
}: {
  group: DirectorWorldWildlifeGroup;
  context: LivingWorldFrameContext;
  environment: WildlifeSimEnvironment;
}) {
  // Sim identity follows the simulation-relevant config (count, species,
  // area, speedScale, seeds, ground, environment). Any change discards the
  // sim and replays fresh, keeping state a pure function of (config, time).
  const simRef = useRef<WildlifeSim | null>(null);
  if (
    !simRef.current ||
    shouldRecreateWildlifeSim(simRef.current, group, context.seed, context.groundHeight, environment)
  ) {
    simRef.current = createWildlifeSim(group, context.seed, context.groundHeight, environment);
  }
  const sim = simRef.current;

  // group.assetId binding: herd archetypes swap the placeholder InstancedMesh
  // for per-agent glTF clones. Flock/school groups with an assetId stay on
  // placeholders (instanced skinned rendering is out of scope for P1).
  const wantsModel = sim.archetype === "herd" && typeof group.assetId === "string";
  const asset = useDirectorStore((state) =>
    wantsModel ? state.project.assets.find((entry) => entry.id === group.assetId) : undefined,
  );
  const [binding, setBinding] = useState<WildlifeAssetBinding | null>(null);

  useEffect(() => {
    if (!wantsModel || !group.assetId) {
      setBinding(null);
      return;
    }
    if (!asset) {
      warnWildlifeAssetOnce(group.assetId, `wildlife group "${group.id}" references missing asset "${group.assetId}"`);
      setBinding(null);
      return;
    }
    let cancelled = false;
    // Loader failures resolve to null (warned once inside the cache); the
    // placeholder path below keeps rendering, so a broken asset never blanks
    // or crashes the layer.
    void loadWildlifeAssetBinding(asset.id, asset.url).then((loaded) => {
      if (!cancelled) setBinding(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [asset, group.assetId, group.id, wantsModel]);

  if (binding && wantsModel) {
    return <WildlifeGltfHerd group={group} context={context} sim={sim} binding={binding} />;
  }
  return <WildlifeGroupInstances group={group} context={context} sim={sim} />;
}

export default function WildlifeLayer({ context, groups }: WildlifeLayerProps) {
  // Authored water rectangles (basins only) for school confinement; the
  // union recomputes only when the water collection itself changes.
  const waterBodies = useDirectorStore((state) => state.project.world?.waterBodies);
  const waterRects = useMemo<WildlifeWaterRect[]>(
    () =>
      (waterBodies ?? [])
        .filter((body) => body.visible && !body.river)
        .map((body) => ({
          centerX: body.surface.center[0],
          centerZ: body.surface.center[2],
          sizeX: body.surface.sizeX,
          sizeZ: body.surface.sizeZ,
          rotationDegrees: body.surface.rotationDegrees,
        })),
    [waterBodies],
  );
  const environments = useMemo(() => {
    const byId = new Map<string, WildlifeSimEnvironment>();
    for (const group of groups) {
      byId.set(group.id, buildWildlifeEnvironment(context.settings, group, groups, waterRects));
    }
    return byId;
  }, [context.settings, groups, waterRects]);

  return (
    <group name="living-world-wildlife">
      {groups.map((group) => (
        <WildlifeGroup
          key={group.id}
          group={group}
          context={context}
          environment={environments.get(group.id) ?? { settings: context.settings }}
        />
      ))}
    </group>
  );
}
