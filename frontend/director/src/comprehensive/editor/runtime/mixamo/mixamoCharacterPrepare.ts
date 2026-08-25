import { type Group, type Object3D, type Bone } from "three";
import {
  applyMixamoRigLayers,
  cloneMixamoCharacterScene,
  captureMixamoRestPoseAndBones,
  normalizeMixamoCharacterLayout,
  resolveMixamoBones,
  restoreMixamoRestPose,
  type MixamoCharacterMetrics,
  type MixamoResolvedBones,
  type MixamoRestPose,
} from "./mixamoCharacterRig";

export interface PreparedMixamoCharacter {
  scene: Group;
  restPose: MixamoRestPose;
  deformBones: Bone[];
  resolvedBones: MixamoResolvedBones;
  metrics: MixamoCharacterMetrics | null;
}

const mixamoCharacterScaleCache = new Map<string, number>();

function getMixamoCharacterScaleCacheKey(url: string, targetHeightM: number) {
  return `${url}\0${targetHeightM}`;
}

/** Test hook; production code keeps a session-level scale cache per asset URL. */
export function resetMixamoCharacterScaleCache() {
  mixamoCharacterScaleCache.clear();
}

/**
 * Clones a loaded Mixamo asset, applies the default neutral pose, normalizes
 * scale/grounding once, and reuses measured scale factors for later instances.
 */
export function prepareMixamoCharacterInstance(
  source: Object3D,
  url: string,
  targetHeightM: number,
): PreparedMixamoCharacter {
  const scene = cloneMixamoCharacterScene(source) as Group;
  const { restPose, bones: deformBones } = captureMixamoRestPoseAndBones(scene);
  // The authored T-pose is published on the instance so overlay systems (the
  // ARDY motion preview) can measure bind transforms without holding a
  // reference to this component's state.
  scene.userData.directorMixamoRestPose = restPose;
  const resolvedBones = resolveMixamoBones(scene, deformBones);

  restoreMixamoRestPose(scene, restPose, { bones: deformBones, updateMatrixWorld: false });
  applyMixamoRigLayers(scene, {
    controls: {},
    restPose,
    bones: resolvedBones,
  });

  const cacheKey = getMixamoCharacterScaleCacheKey(url, targetHeightM);
  const cachedScaleFactor = mixamoCharacterScaleCache.get(cacheKey);
  const { scaleFactor, metrics } = normalizeMixamoCharacterLayout(scene, targetHeightM, cachedScaleFactor);

  if (cachedScaleFactor === undefined) {
    mixamoCharacterScaleCache.set(cacheKey, scaleFactor);
  }

  return { scene, restPose, deformBones, resolvedBones, metrics };
}

export function publishMixamoCharacterMetrics(
  metrics: MixamoCharacterMetrics,
  onLabelAnchorYChange?: (anchorY: number) => void,
  onVisualCenterChange?: (center: [number, number, number]) => void,
  onMetricsChange?: (metrics: MixamoCharacterMetrics) => void,
) {
  onLabelAnchorYChange?.(Number(metrics.labelAnchorY.toFixed(4)));
  onVisualCenterChange?.(metrics.visualCenter.map((value) => Number(value.toFixed(4))) as [number, number, number]);
  onMetricsChange?.(metrics);
}
