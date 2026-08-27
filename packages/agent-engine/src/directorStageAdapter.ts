/**
 * Bidirectional adapter between the legacy Stage scene model and the
 * persisted Director project.
 *
 * The legacy `stage_*` tools (see commandEngine) operate on the compact
 * {@link StageScene}; the Director product persists the richer
 * {@link DirectorProject}. This module converts both ways so those tools can
 * keep working against a live project:
 * {@link stageSceneToDirectorProject} merges a Stage scene back into the
 * current project (only previously Stage-managed objects are replaceable;
 * unrelated Director objects survive), and
 * {@link directorProjectToStageScene} projects a Director project into a
 * Stage scene, synthesizing timeline tracks from Director animations and
 * camera actions.
 *
 * Both directions run the result through the target schema parser, so an
 * adapter bug surfaces as a validation error rather than a corrupt document.
 * Camera conversion is lossy-aware: Stage cameras store view position +
 * target, while Director cameras store the rig pivot, so positions are
 * recomputed through the shared view-snapshot math on each crossing.
 *
 * @module directorStageAdapter
 */

import type {
  DirectorAnimationKeyframe,
  DirectorCameraAction,
  DirectorCameraShot,
  DirectorEntityAnimation,
  DirectorObject,
  DirectorProject,
  DirectorTransform,
  GeometryPrimitiveType,
} from "@director/project-schema";
import type { ViewportAspectRatio } from "@director/protocol/workbench-ui";
import {
  getCameraRigPositionFromViewSnapshot,
  getCameraViewSnapshotFromShot,
  getEquivalentFullFrameFocalLength,
  getVerticalFovFromFocalLength,
} from "@director/project-schema";
import {
  createDefaultDirectorProduction,
  reconcileDirectorProduction,
} from "@director/project-schema";
import { parseDirectorProject } from "@director/project-schema";
import {
  getMannequinPosePreset,
  resolveCharacterPoseControls,
} from "@director/project-schema";
import { getDefaultMixamoCharacterAssetRef } from "@director/dcc-interchange";
import { DIRECTOR_PREVIZ_PALETTE } from "@director/project-schema";
import { parseStageScene } from "@director/stage-protocol";
import type { CameraMoveItem, StageItem, StageObject, StageScene, StageTrack, Vec3 } from "@director/stage-protocol";

const DEFAULT_COMPREHENSIVE_OBJECT_IDS = new Set(["char_default_a", "cam_object_1"]);
const DEFAULT_COMPREHENSIVE_CAMERA_IDS = new Set(["cam_1"]);
const DEFAULT_FPS = 24;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function transform(position: Vec3, rotation: Vec3, scale: Vec3): DirectorTransform {
  return {
    position: [...position] as Vec3,
    rotation: [...rotation] as Vec3,
    scale: [...scale] as Vec3,
  };
}

function frameAt(seconds: number, fps: number) {
  return Math.max(0, Math.round(seconds * fps));
}

function stageGeometry(object: StageObject): GeometryPrimitiveType | undefined {
  if (object.kind === "sphere") return "sphere";
  if (object.kind === "cube" || object.kind === "plane") return "box";
  if (object.kind === "cylinder") return "cylinder";
  if (object.kind === "cone") return "cone";
  if (object.kind === "torus") return "torus";
  if (object.kind === "pyramid") return "pyramid";
  if (object.kind !== "prop") return undefined;
  // Heuristic geometry mapping for Stage props that don't carry
  // explicit geometry metadata — keyed by propKey substring.
  if (object.propKey.includes("tree")) return "cone";
  if (object.propKey.includes("rock") || object.propKey.includes("skull")) return "sphere";
  if (object.propKey.includes("barrel") || object.propKey.includes("bottle")) return "cylinder";
  return "box";
}

function stageObjectName(object: StageObject, id: string) {
  if (object.name) return object.name;
  if (object.kind === "humanoid") return "角色";
  if (object.kind === "camera") return "机位";
  if (object.kind === "group") return "组合";
  if (object.kind === "prop") return object.propKey;
  return id;
}

function mergeStageObject(id: string, object: StageObject, existing?: DirectorObject): DirectorObject | null {
  if (object.kind === "target") return null;
  const base = {
    id,
    name: stageObjectName(object, id),
    visible: existing?.visible ?? true,
    locked: existing?.locked ?? false,
    transform: transform(object.position, object.rotation, object.scale),
    ...(object.color ? { color: object.color } : {}),
    ...(object.parentId ? { parentObjectId: object.parentId } : {}),
    ...(existing?.referenceBindings ? { referenceBindings: existing.referenceBindings } : {}),
  };

  if (object.kind === "humanoid") {
    const defaultCharacterAsset = getDefaultMixamoCharacterAssetRef();
    const posePresetId = object.pose ?? existing?.characterRig?.posePresetId ?? "stand";
    const existingRig = existing?.characterRig;
    // When the Stage explicitly provides a new pose, replace the
    // controls wholesale; otherwise preserve the existing Director
    // rig controls so authoring adjustments survive round-trips.
    const controls =
      object.pose !== undefined && object.pose !== existingRig?.posePresetId
        ? { ...(getMannequinPosePreset(object.pose)?.controls ?? {}) }
        : { ...resolveCharacterPoseControls(existingRig ?? { rigType: "mixamo", posePresetId, controls: {} }) };
    return {
      ...existing,
      ...base,
      kind: "character",
      characterSource: "asset",
      assetRefId: existing?.assetRefId ?? defaultCharacterAsset.id,
      placementMode: existing?.placementMode ?? "grounded",
      bodyType: existing?.bodyType ?? "mannequin",
      characterRig: {
        rigType: existing?.characterRig?.rigType ?? "mixamo",
        posePresetId,
        controls,
        ...(existing?.characterRig?.ik ? { ik: existing.characterRig.ik } : {}),
        ...(existing?.characterRig?.motion ? { motion: existing.characterRig.motion } : {}),
      },
    };
  }

  if (object.kind === "camera") {
    return {
      ...existing,
      ...base,
      kind: "camera",
      linkedCameraId: existing?.linkedCameraId ?? id,
    };
  }

  if (object.kind === "group") {
    return {
      ...existing,
      ...base,
      kind: "prop",
      isCompositeParent: true,
      geometryType: undefined,
      assetRefId: undefined,
    };
  }

  return {
    ...existing,
    ...base,
    kind: "prop",
    geometryType: existing?.assetRefId ? existing.geometryType : stageGeometry(object),
    ...(existing?.assetRefId ? { assetRefId: existing.assetRefId } : {}),
  };
}

function keyframeTransform(base: DirectorTransform, position?: Vec3, rotation?: Vec3, scale?: Vec3) {
  // Clone every vector so keyframe transforms are independent of
  // the base transform and each other — no shared references.
  return {
    position: position ? ([...position] as Vec3) : clone(base.position),
    rotation: rotation ? ([...rotation] as Vec3) : clone(base.rotation),
    scale: scale ? ([...scale] as Vec3) : clone(base.scale),
  };
}

function appendPathFrames(
  frames: DirectorAnimationKeyframe[],
  points: Vec3[],
  startS: number,
  durationS: number,
  fps: number,
  base: DirectorTransform,
) {
  const denominator = Math.max(1, points.length - 1);
  points.forEach((point, index) => {
    const next = points[Math.min(points.length - 1, index + 1)] ?? point;
    // At the last point, preserve the base yaw since there is no
    // next point to derive a heading from.
    const yaw = index === points.length - 1 ? base.rotation[1] : Math.atan2(next[0] - point[0], next[2] - point[2]);
    frames.push({
      frame: frameAt(startS + (durationS * index) / denominator, fps),
      transform: keyframeTransform(base, point, [base.rotation[0], yaw, base.rotation[2]]),
    });
  });
}

function appendCameraMoveFrames(
  frames: DirectorAnimationKeyframe[],
  item: CameraMoveItem,
  scene: StageScene,
  fps: number,
  base: DirectorTransform,
  target: Vec3,
) {
  const subject = item.subjectId ? scene.objects[item.subjectId]?.position : undefined;
  const lookTarget = subject ? ([...subject] as Vec3) : ([...target] as Vec3);
  const offset: Vec3 = [
    base.position[0] - lookTarget[0],
    base.position[1] - lookTarget[1],
    base.position[2] - lookTarget[2],
  ];
  // Orbit needs enough samples for smooth arc rendering (~22.5° per
  // sample); other moves are linear and only need start/end frames.
  const samples = item.move === "orbit" ? Math.max(8, Math.ceil(Math.abs(item.angleDeg) / 22.5)) : 2;
  for (let index = 0; index <= samples; index += 1) {
    const progress = index / samples;
    let position = [...base.position] as Vec3;
    let nextTarget = [...lookTarget] as Vec3;
    if (item.move === "orbit") {
      const direction = item.direction === "ccw" ? 1 : -1;
      const angle = ((item.angleDeg * Math.PI) / 180) * progress * direction;
      position = [
        lookTarget[0] + offset[0] * Math.cos(angle) - offset[2] * Math.sin(angle),
        base.position[1] + item.heightDeltaUnits * progress,
        lookTarget[2] + offset[0] * Math.sin(angle) + offset[2] * Math.cos(angle),
      ];
    } else if (item.move === "dolly") {
      position = [
        lookTarget[0] + offset[0] * (1 + (item.distanceScale - 1) * progress),
        lookTarget[1] + offset[1] * (1 + (item.distanceScale - 1) * progress),
        lookTarget[2] + offset[2] * (1 + (item.distanceScale - 1) * progress),
      ];
    } else if (item.move === "truck") {
      const length = Math.hypot(offset[0], offset[2]) || 1;
      position = [
        base.position[0] + (offset[2] / length) * item.distanceScale * progress,
        base.position[1],
        base.position[2] - (offset[0] / length) * item.distanceScale * progress,
      ];
    } else if (item.move === "crane") {
      position = [base.position[0], base.position[1] + item.heightDeltaUnits * progress, base.position[2]];
    } else if (item.move === "pan") {
      const angle = ((item.angleDeg * Math.PI) / 180) * progress * (item.direction === "ccw" ? 1 : -1);
      nextTarget = [
        base.position[0] +
          (lookTarget[0] - base.position[0]) * Math.cos(angle) -
          (lookTarget[2] - base.position[2]) * Math.sin(angle),
        lookTarget[1],
        base.position[2] +
          (lookTarget[0] - base.position[0]) * Math.sin(angle) +
          (lookTarget[2] - base.position[2]) * Math.cos(angle),
      ];
    }
    frames.push({
      frame: frameAt(item.startS + item.durationS * progress, fps),
      transform: keyframeTransform(base, position),
      lookTarget: nextTarget,
      ...(item.focalLengthMm ? { fov: getVerticalFovFromFocalLength(item.focalLengthMm, scene.recordAspect) } : {}),
    });
  }
}

function animationFromTrack(
  track: StageTrack,
  scene: StageScene,
  fps: number,
  base: DirectorTransform,
  target: Vec3,
): DirectorEntityAnimation | undefined {
  const frames: DirectorAnimationKeyframe[] = [];
  let motion: DirectorEntityAnimation["motion"] = "none";
  for (const item of track.items) {
    if (item.kind === "transform") {
      for (const key of item.keys) {
        frames.push({
          frame: frameAt(item.startS + key.tS, fps),
          transform: keyframeTransform(base, key.position, key.rotation, key.scale),
        });
      }
    } else if (item.kind === "path") {
      appendPathFrames(frames, item.points, item.startS, item.durationS, fps, base);
      motion = item.gait === "walk" ? "walk" : "run";
    } else if (item.kind === "cam-path") {
      appendPathFrames(frames, item.points, item.startS, item.durationS, fps, base);
    } else if (item.kind === "cam-move") {
      appendCameraMoveFrames(frames, item, scene, fps, base, target);
    } else if (item.kind === "cam-still") {
      const fov = item.focalLengthMm
        ? getVerticalFovFromFocalLength(item.focalLengthMm, scene.recordAspect)
        : undefined;
      frames.push(
        {
          frame: frameAt(item.startS, fps),
          transform: clone(base),
          lookTarget: clone(target),
          ...(fov ? { fov } : {}),
        },
        {
          frame: frameAt(item.startS + item.durationS, fps),
          transform: clone(base),
          lookTarget: clone(target),
          ...(fov ? { fov } : {}),
        },
      );
    }
  }
  if (!frames.length) return undefined;
  // Sort by frame and deduplicate on frame number so the last
  // keyframe at each frame wins (later items override earlier).
  const byFrame = new Map<number, DirectorAnimationKeyframe>();
  frames.sort((left, right) => left.frame - right.frame).forEach((frame) => byFrame.set(frame.frame, frame));
  return {
    version: 1,
    enabled: true,
    keyframes: [...byFrame.values()],
    preset: "custom",
    orientToPath: true,
    motion,
    source: "mcp",
  };
}

function subtract(left: Vec3, right: Vec3): Vec3 {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function cameraActionFromTrack(
  track: StageTrack,
  scene: StageScene,
  camera: DirectorCameraShot,
): DirectorCameraAction | undefined {
  const item = track.items.find((candidate) => candidate.kind.startsWith("cam-"));
  if (!item) return undefined;

  if (item.kind === "cam-follow") {
    const target = item.objectId ? scene.objects[item.objectId] : undefined;
    if (!target) {
      return {
        mode: "follow",
        follow: { targetObjectId: null, positionOffset: [0, 0, 0], targetOffset: [0, 0, 0] },
      };
    }
    return {
      mode: "follow",
      follow: {
        targetObjectId: item.objectId,
        positionOffset: subtract(camera.transform.position, target.position),
        targetOffset: subtract(camera.target, target.position),
      },
    };
  }

  if (item.kind === "cam-path") {
    const lockTarget = item.aim === "locked" || item.aim === "subject";
    return {
      mode: "path",
      path: {
        speed: 1,
        lockTarget,
        targetObjectId: lockTarget ? item.subjectId : null,
      },
    };
  }

  if (item.kind === "cam-still") return { mode: "still" };
  return { mode: "transform" };
}

/** Identity pass-through: the Stage aspect ratio is directly compatible with Director's viewport aspect ratio. */
export function stageAspectToDirectorAspect(aspect: StageScene["recordAspect"]): ViewportAspectRatio {
  return aspect;
}

function directorAspectToStageAspect(aspect: ViewportAspectRatio): StageScene["recordAspect"] {
  if (aspect === "9:16" || aspect === "1:1" || aspect === "4:3" || aspect === "1.85:1" || aspect === "2.39:1")
    return aspect;
  return "16:9";
}

/**
 * Converts a Stage scene into a Director project, merging with the current
 * Director state so that objects and cameras not present in the Stage are
 * retained unless they were previously Stage-managed.
 *
 * Objects present in the Stage are mapped to Director objects (characters,
 * cameras, props, groups). Camera rig positions are computed from the target
 * and FOV so the Director camera transform reflects the rig pivot rather
 * than the view position. Animation tracks and camera actions are extracted
 * from the Stage show timeline.
 *
 * A fresh white-box scene (only cameras and targets, no timeline items)
 * resets the storyboard, animation, and playhead to a clean slate rather
 * than retaining the prior Director project's timeline.
 *
 * @param scene - The Stage scene to convert.
 * @param current - The existing Director project to merge into.
 * @param previousStageObjectIds - Object ids managed by a prior Stage sync;
 *   these are eligible for replacement.
 * @returns A parsed and validated Director project.
 */
export function stageSceneToDirectorProject(
  scene: StageScene,
  current: DirectorProject,
  previousStageObjectIds: ReadonlySet<string> = new Set(),
): DirectorProject {
  current = parseDirectorProject(current);
  // Detect whether the current production block is the auto-generated
  // default so we can regenerate it for the merged project instead of
  // carrying forward stale production metadata.
  const hadCompatibilityProduction =
    current.production !== undefined &&
    JSON.stringify(current.production) === JSON.stringify(createDefaultDirectorProduction(current));
  const currentObjects = new Map(current.objects.map((object) => [object.id, object]));
  const mappedObjects: DirectorObject[] = [];
  const mappedCameras: DirectorCameraShot[] = [];
  const mappedObjectIds = new Set<string>();
  const mappedCameraIds = new Set<string>();

  for (const [id, stageObject] of Object.entries(scene.objects)) {
    const nextObject = mergeStageObject(id, stageObject, currentObjects.get(id));
    if (!nextObject) continue;
    mappedObjectIds.add(id);
    mappedObjects.push(nextObject);
    if (stageObject.kind !== "camera") continue;
    const existingShot = current.cameras.find((camera) => camera.id === nextObject.linkedCameraId || camera.id === id);
    const shotId = nextObject.linkedCameraId ?? existingShot?.id ?? id;
    const targetObject = scene.objects[stageObject.targetId];
    const target = targetObject?.position ?? existingShot?.target ?? [0, 1.2, 0];
    const cameraFov = getVerticalFovFromFocalLength(stageObject.focalLengthMm, scene.recordAspect);
    const rigPosition = getCameraRigPositionFromViewSnapshot({
      fov: cameraFov,
      position: [...stageObject.position] as Vec3,
      target: [...target] as Vec3,
    });
    nextObject.transform.position = rigPosition;
    mappedCameraIds.add(shotId);
    mappedCameras.push({
      ...existingShot,
      id: shotId,
      name: stageObjectName(stageObject, id),
      fov: cameraFov,
      focalLengthMm: stageObject.focalLengthMm,
      sensorFormat: "fullFrame",
      aspectRatio: scene.recordAspect,
      transform: transform(rigPosition, stageObject.rotation, stageObject.scale),
      targetMode: "manual",
      target: [...target] as Vec3,
      lastCaptureUrl: existingShot?.lastCaptureUrl ?? null,
      captures: existingShot?.captures ?? [],
    });
  }

  const retainedObjects = current.objects.filter(
    (object) =>
      !mappedObjectIds.has(object.id) &&
      !previousStageObjectIds.has(object.id) &&
      !DEFAULT_COMPREHENSIVE_OBJECT_IDS.has(object.id),
  );
  const retainedCameras = current.cameras.filter((camera) => {
    if (mappedCameraIds.has(camera.id) || DEFAULT_COMPREHENSIVE_CAMERA_IDS.has(camera.id)) return false;
    const linkedObject = current.objects.find((object) => object.linkedCameraId === camera.id);
    return !linkedObject || !previousStageObjectIds.has(linkedObject.id);
  });
  let objects = [...mappedObjects, ...retainedObjects];
  let cameras = [...mappedCameras, ...retainedCameras];
  const fps = current.scene.timeline?.fps ?? DEFAULT_FPS;
  // A stage reset keeps one usable camera, but deliberately contains no
  // renderable objects or timeline items. Treat that state as a fresh
  // white-box document rather than retaining the prior Director storyboard,
  // animation tracks, and playhead range in the bottom timeline UI.
  const isFreshWhiteboxScene =
    Object.values(scene.objects).every((object) => object.kind === "camera" || object.kind === "target") &&
    !scene.show.tracks.some((track) => track.items.length > 0);
  let maximumFrame = isFreshWhiteboxScene ? fps * 10 : (current.scene.timeline?.frameEnd ?? fps * 10);

  for (const track of scene.show.tracks) {
    const object = objects.find((candidate) => candidate.id === track.characterId);
    if (!object) continue;
    const camera =
      object.kind === "camera" ? cameras.find((candidate) => candidate.id === object.linkedCameraId) : undefined;
    const animation = animationFromTrack(
      track,
      scene,
      fps,
      camera?.transform ?? object.transform,
      camera?.target ?? [0, 1.2, 0],
    );
    const cameraAction = camera ? cameraActionFromTrack(track, scene, camera) : undefined;
    for (const item of track.items) {
      maximumFrame = Math.max(maximumFrame, frameAt(item.startS + item.durationS, fps));
      if (item.kind === "clip" && object.kind === "character") {
        objects = objects.map((candidate) =>
          candidate.id === object.id
            ? {
                ...candidate,
                characterRig: candidate.characterRig
                  ? {
                      ...candidate.characterRig,
                      posePresetId: item.clip,
                      controls: { ...(getMannequinPosePreset(item.clip)?.controls ?? {}) },
                    }
                  : candidate.characterRig,
              }
            : candidate,
        );
      }
    }
    if (!animation && !cameraAction) continue;
    if (camera) {
      cameras = cameras.map((candidate) =>
        candidate.id === camera.id
          ? {
              ...candidate,
              ...(animation ? { animation } : {}),
              action: cameraAction ?? (animation ? { mode: "transform" } : candidate.action),
            }
          : candidate,
      );
    } else {
      objects = objects.map((candidate) => (candidate.id === object.id ? { ...candidate, animation } : candidate));
    }
  }

  if (isFreshWhiteboxScene) {
    objects = objects.map((object) => (mappedObjectIds.has(object.id) ? { ...object, animation: undefined } : object));
    cameras = cameras.map((camera) =>
      mappedCameraIds.has(camera.id) ? { ...camera, animation: undefined, action: { mode: "still" } } : camera,
    );
  }

  const cameraIds = new Set(cameras.map((camera) => camera.id));
  const defaultCharacterAsset = getDefaultMixamoCharacterAssetRef();
  const requiresDefaultCharacterAsset = objects.some(
    (object) => object.kind === "character" && object.assetRefId === defaultCharacterAsset.id,
  );
  const projectWithoutProduction: DirectorProject = {
    ...current,
    assets:
      requiresDefaultCharacterAsset && !current.assets.some((asset) => asset.id === defaultCharacterAsset.id)
        ? [defaultCharacterAsset, ...current.assets]
        : current.assets,
    scene: {
      ...current.scene,
      backgroundColor: DIRECTOR_PREVIZ_PALETTE.sky,
      showGround: true,
      groundOpacity: 0,
      timeline: {
        version: 1,
        fps,
        frameStart: isFreshWhiteboxScene ? 0 : (current.scene.timeline?.frameStart ?? 0),
        frameEnd: maximumFrame,
        currentFrame: isFreshWhiteboxScene ? 0 : Math.min(current.scene.timeline?.currentFrame ?? 0, maximumFrame),
        loop: isFreshWhiteboxScene ? false : (current.scene.timeline?.loop ?? true),
      },
    },
    objects,
    cameras,
    storyboard: isFreshWhiteboxScene
      ? {
          version: 1,
          title: scene.show.name || "未命名分镜",
          logline: "从空白白膜开始安排镜头与动作。",
          shots: [],
        }
      : current.storyboard,
    activeCameraId:
      current.activeCameraId && cameraIds.has(current.activeCameraId)
        ? current.activeCameraId
        : (cameras[0]?.id ?? null),
  };
  delete projectWithoutProduction.production;
  const production =
    isFreshWhiteboxScene || hadCompatibilityProduction || !current.production
      ? createDefaultDirectorProduction(projectWithoutProduction)
      : reconcileDirectorProduction(projectWithoutProduction, current.production);
  const project: DirectorProject = {
    ...projectWithoutProduction,
    ...(production ? { production } : {}),
  };
  return parseDirectorProject(project);
}

function stageObjectFromDirector(
  object: DirectorObject,
  project: DirectorProject,
  previous?: StageObject,
): { object: StageObject; target?: [string, StageObject] } | null {
  const base = {
    name: object.name,
    position: clone(object.transform.position),
    rotation: clone(object.transform.rotation),
    scale: clone(object.transform.scale),
    ...(object.color ? { color: object.color } : {}),
    ...(object.parentObjectId ? { parentId: object.parentObjectId } : {}),
  };
  if (object.kind === "character") {
    return {
      object: {
        ...base,
        kind: "humanoid",
        animation: previous?.kind === "humanoid" ? previous.animation : { clip: "idle", playing: false },
        ...(object.characterRig?.posePresetId ? { pose: object.characterRig.posePresetId } : {}),
      },
    };
  }
  if (object.kind === "camera") {
    const camera = project.cameras.find((candidate) => candidate.id === object.linkedCameraId);
    if (!camera) return null;
    const view = getCameraViewSnapshotFromShot(camera);
    // Reuse the previous target id so the Stage target object
    // survives round-trips; generate a stable synthetic id
    // for first-time conversions.
    const targetId = previous?.kind === "camera" ? previous.targetId : `${object.id}:target`;
    return {
      object: {
        ...base,
        position: clone(view.position),
        kind: "camera",
        targetId,
        focalLengthMm: getEquivalentFullFrameFocalLength(camera),
        shake: previous?.kind === "camera" ? previous.shake : "off",
      },
      target: [
        targetId,
        {
          kind: "target",
          name: `${camera.name}目标`,
          position: clone(camera.target),
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
      ],
    };
  }
  if (object.kind !== "prop") return null;
  if (object.isCompositeParent) return { object: { ...base, kind: "group" } };
  if (object.assetRefId) {
    return {
      object: {
        ...base,
        kind: "prop",
        propKey: previous?.kind === "prop" ? previous.propKey : "imported-asset",
      },
    };
  }
  return {
    object: {
      ...base,
      kind:
        object.geometryType === "sphere"
          ? "sphere"
          : object.geometryType === "cylinder"
            ? "cylinder"
            : object.geometryType === "cone"
              ? "cone"
              : object.geometryType === "torus"
                ? "torus"
                : object.geometryType === "pyramid"
                  ? "pyramid"
                  : "cube",
    },
  };
}

function trackFromAnimation(objectId: string, animation: DirectorEntityAnimation, fps: number): StageTrack {
  const ordered = [...animation.keyframes].sort((left, right) => left.frame - right.frame);
  const startFrame = ordered[0]?.frame ?? 0;
  const keys = ordered.flatMap((keyframe) =>
    keyframe.transform
      ? [
          {
            tS: (keyframe.frame - startFrame) / fps,
            position: clone(keyframe.transform.position),
            rotation: clone(keyframe.transform.rotation),
            scale: clone(keyframe.transform.scale),
          },
        ]
      : [],
  );
  return {
    id: `director-track:${objectId}`,
    characterId: objectId,
    items: keys.length
      ? [
          {
            id: `director-animation:${objectId}`,
            kind: "transform",
            startS: startFrame / fps,
            durationS: Math.max(1 / fps, ((ordered.at(-1)?.frame ?? startFrame + 1) - startFrame) / fps),
            keys,
          },
        ]
      : [],
  };
}

function trackFromCameraAction(cameraObjectId: string, camera: DirectorCameraShot, fps: number): StageTrack {
  const animationTrack = camera.animation ? trackFromAnimation(cameraObjectId, camera.animation, fps) : null;
  const action = camera.action?.mode ?? (camera.animation?.keyframes.length ? "transform" : "still");
  const cameraKeyframes = camera.animation?.keyframes ?? [];
  const firstFrame = cameraKeyframes.reduce(
    (minimum, keyframe) => Math.min(minimum, keyframe.frame),
    Number.POSITIVE_INFINITY,
  );
  const lastFrame = cameraKeyframes.reduce((maximum, keyframe) => Math.max(maximum, keyframe.frame), 0);
  const startS = Number.isFinite(firstFrame) ? firstFrame / fps : 0;
  const durationS = Number.isFinite(firstFrame) ? Math.max(1 / fps, (lastFrame - firstFrame) / fps) : 5;
  const base = { id: `director-camera-action:${cameraObjectId}`, startS, durationS };
  const points =
    camera.animation?.keyframes
      .filter((keyframe) => keyframe.transform)
      .map((keyframe) => clone(keyframe.transform!.position)) ?? [];
  const actionItem: StageItem =
    action === "follow"
      ? {
          ...base,
          kind: "cam-follow",
          objectId: camera.action?.follow?.targetObjectId ?? null,
        }
      : action === "path"
        ? {
            ...base,
            kind: "cam-path",
            points: points.length >= 2 ? points : [clone(camera.transform.position), clone(camera.transform.position)],
            speedUnitsPerS: Math.max(0.1, camera.action?.path?.speed ?? 1),
            aim: camera.action?.path?.lockTarget
              ? camera.action.path.targetObjectId
                ? "subject"
                : "locked"
              : "travel",
            subjectId: camera.action?.path?.targetObjectId ?? null,
          }
        : action === "still"
          ? { ...base, kind: "cam-still" }
          : { ...base, kind: "cam-transform" };
  return {
    id: `director-track:${cameraObjectId}`,
    characterId: cameraObjectId,
    items: [actionItem, ...(animationTrack?.items ?? [])],
  };
}

/**
 * Converts a Director project back into a Stage scene for round-trip
 * synchronization.
 *
 * Director objects are mapped to Stage objects (humanoids, cameras, props,
 * groups), camera view positions are derived from the Director camera shot
 * (rig position → view position), and animation tracks plus camera actions
 * are reconstructed from Director entity animations. Existing Stage tracks
 * for objects that still exist are preserved; new tracks are appended for
 * objects that have animations but no existing track.
 *
 * @param project - The Director project to convert.
 * @param base - The previous Stage scene used as a merge base for preserving
 *   existing track and object state.
 * @param aspect - The target viewport aspect ratio for the output scene.
 * @returns A parsed and validated Stage scene.
 * @throws When the assembled scene fails Stage schema validation.
 */
export function directorProjectToStageScene(
  project: DirectorProject,
  base: StageScene,
  aspect: ViewportAspectRatio,
): StageScene {
  project = parseDirectorProject(project);
  const objects: StageScene["objects"] = {};
  for (const directorObject of project.objects) {
    const converted = stageObjectFromDirector(directorObject, project, base.objects[directorObject.id]);
    if (!converted) continue;
    objects[directorObject.id] = converted.object;
    if (converted.target) objects[converted.target[0]] = converted.target[1];
  }

  const availableIds = new Set(Object.keys(objects));
  const tracks = base.show.tracks.filter((track) => availableIds.has(track.characterId)).map((track) => clone(track));
  const existingTrackOwners = new Set(tracks.map((track) => track.characterId));
  const fps = project.scene.timeline?.fps ?? DEFAULT_FPS;
  for (const object of project.objects) {
    const camera =
      object.kind === "camera"
        ? project.cameras.find((candidate) => candidate.id === object.linkedCameraId)
        : undefined;
    const animation = camera ? camera.animation : object.animation;
    if (existingTrackOwners.has(object.id)) continue;
    if (camera) {
      tracks.push(trackFromCameraAction(object.id, camera, fps));
    } else if (animation) {
      tracks.push(trackFromAnimation(object.id, animation, fps));
    }
  }

  const stage = {
    objects,
    show: {
      name: project.storyboard?.title || base.show.name || "Director 制作",
      tracks,
    },
    recordAspect: directorAspectToStageAspect(aspect),
  } satisfies StageScene;
  const parsed = parseStageScene(stage);
  if (!parsed.success) throw new Error(parsed.error);
  return parsed.scene;
}

/**
 * Returns the set of object ids that are managed by the Stage in a given
 * scene — every object except targets (which are derived from camera
 * look-at points).
 *
 * @param scene - The Stage scene to inspect.
 * @returns A set of Stage-managed object ids.
 */
export function stageManagedDirectorObjectIds(scene: StageScene) {
  return new Set(
    Object.entries(scene.objects)
      .filter(([, object]) => object.kind !== "target")
      .map(([id]) => id),
  );
}
