import { Html, Line, TransformControls, type TransformControlsProps } from "@react-three/drei";
import { createPortal, useFrame, useLoader, useThree, type ThreeEvent } from "@react-three/fiber";
import {
  Component,
  memo,
  Suspense,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Euler, Matrix4, Quaternion, Vector3, type Group, type Object3D } from "three";
import type { TransformControls as TransformControlsImpl } from "three-stdlib";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { clone as cloneSkinnedObject } from "three/examples/jsm/utils/SkeletonUtils.js";
import type {
  DirectorAssetRef,
  DirectorCameraShot,
  DirectorCharacterMotionState,
  DirectorObject,
  DirectorSceneAnnotation,
  DirectorSceneMeasurement,
  DirectorTransform,
  GeometryPrimitiveType,
  PromptReferenceVisualStyle,
} from "../schema/directorProject";
import { getDirectorPrimitiveMetrics } from "@director/project-schema";
import { resolveDirectorPhysicalPlacements } from "../geometry/physicalPlacement";
import { getPromptReferenceVisualStyle } from "../schema/directorProject";
import { useLanguage } from "../../i18n/language";
import {
  evaluateDirectorCameraAtFrame,
  evaluateDirectorObjectAtFrame,
  getDirectorCameraAnimationFrame,
} from "../schema/directorAnimation";
import {
  VIEWPORT_CAMERA_ASPECT,
  VIEWPORT_CAMERA_FRUSTUM_DEPTH,
  VIEWPORT_CAMERA_FRUSTUM_FRAME_WIDTH,
  VIEWPORT_CAMERA_VISUAL_SCALE,
} from "../schema/cameraGeometry";
import { VIEWPORT_OBJECT_LABEL_VERTICAL_GAP } from "../schema/viewportLabels";
import { getCrowdAnchorTransform, useDirectorStore, type TransformMode } from "../store/directorStore";
import { CharacterModel } from "../runtime/CharacterModel";
import { DirectorCharacterModel } from "../runtime/DirectorCharacterModel";
import { MixamoCharacterModel } from "../runtime/MixamoCharacterModel";
import { useBlenderRuntimeStore } from "../runtime/blenderRuntimeStore";
import { getTimelineCharacterMotion } from "@director/agent-engine/character-motions";
import { getTimelineCharacterMotionBlock } from "../timeline/characterMotionBlocks";
import { getGroundedLabelY } from "../runtime/mannequin/bodyTypes";
import { getUE4GroundedLabelY } from "../runtime/ue4Mannequin/ue4MannequinRig";
import { TrajectoryViewportOverlay } from "../trajectory/TrajectoryViewportOverlay";
import {
  cloneDirectorImportedMaterials,
  DirectorImportedMaterialOverride,
  DirectorObjectPbrMaterial,
} from "./DirectorPbrMaterial";
import { isTrajectoryLocomotionActive } from "../trajectory/proceduralGait";
import {
  DIRECTOR_IMPORTED_MODEL_TARGET_MAX_SIZE,
  getImportedModelNormalization,
  getNormalizedImportedModelLocalBounds,
  getPreciseImportedModelBounds,
} from "../runtime/importedModelGeometry";
import { getVisibleObjectLocalFloorPivot, getVisibleObjectsLocalFloorPivot } from "./visualBounds";
import {
  getDirectorCharacterFrameStrideForMode,
  quantizeDirectorCharacterPlaybackFrame,
  selectDirectorViewportLabelIds,
} from "./characterViewportBudget";
import { useRafCoalescedTransformInteraction } from "../runtime/useRafCoalescedTransformInteraction";
import {
  getDirectorObjectLayerState,
  isDirectorObjectEffectivelyLocked,
  isDirectorObjectEffectivelyVisible,
} from "../schema/objectLayers";
import { getDirectorMeasurementDistance, resolveDirectorSceneAnchor } from "./sceneOverlays";
import { ArdyMotionPreviewLayer } from "./ArdyMotionPreviewLayer";
import { LivingWorldLayer } from "../world/LivingWorldLayer";
import { isDirectorSplatAssetFileName } from "../loaders/splatFormats";
import { SplatModel } from "./splat/SplatModel";
import { createDirectorStaticPrimitiveBatchPartition, StaticPrimitiveBatches } from "./StaticPrimitiveBatches";
import { useResolvedPerformanceConfig } from "../performance/performanceRuntime";
import { getPrimitiveCoplanarDepthBias, stabilizeImportedModelCoplanarDepth } from "./importedModelDepth";

export { getEffectiveGroundOpacity, getPanoramaRotationRadians } from "./panoramaMath";

const VIEWPORT_CAMERA_LINE = "#A9D8FF";
const VIEWPORT_CAMERA_LINE_OPACITY = 0.92;
const VIEWPORT_CAMERA_HIT_PADDING = 0.06;
// The helper mesh is authored with its lens and viewfinder on local +Z. This
// is a visual-model convention only: Blender/glTF/Three cameras still look
// down local -Z, and both conventions are aligned to the same world target.
const VIEWPORT_CAMERA_VISUAL_FORWARD = new Vector3(0, 0, 1);
const VIEWPORT_CAMERA_WORLD_UP = new Vector3(0, 1, 0);
/** Scratch for scene-to-world promotion in the character LOD distance reads. */
const characterLodWorldPosition = new Vector3();
const HIDE_FROM_VIEWPORT_CAPTURE_KEY = "hideFromViewportCapture";
const VIEWPORT_CAMERA_BODY_CENTER: CameraWirePoint = [0, 0, -0.52 * VIEWPORT_CAMERA_VISUAL_SCALE];
const VIEWPORT_CAMERA_BODY_SIZE: CameraWirePoint = [
  0.4 * VIEWPORT_CAMERA_VISUAL_SCALE,
  0.4 * VIEWPORT_CAMERA_VISUAL_SCALE,
  1 * VIEWPORT_CAMERA_VISUAL_SCALE,
];
const VIEWPORT_CAMERA_BODY_FRONT_Z = VIEWPORT_CAMERA_BODY_CENTER[2] + VIEWPORT_CAMERA_BODY_SIZE[2] / 2;
const VIEWPORT_CAMERA_LENS_TIP: CameraWirePoint = [0, 0, 0.2 * VIEWPORT_CAMERA_VISUAL_SCALE];
const VIEWPORT_CAMERA_TRANSFORM_CENTER: CameraWirePoint = [0, 0, 0];
const IMPORTED_MODEL_TARGET_MAX_SIZE = DIRECTOR_IMPORTED_MODEL_TARGET_MAX_SIZE;

export { getImportedModelNormalization, getPreciseImportedModelBounds } from "../runtime/importedModelGeometry";
type CameraWirePoint = [number, number, number];
type CameraWirePointLine = CameraWirePoint[];
type CameraWirePart = "body" | "lens" | "reel";
type PromptReferenceViewportItem = {
  id: string;
  label: string;
  text: string;
  style: PromptReferenceVisualStyle;
};

class SceneAssetErrorBoundary extends Component<
  {
    children: ReactNode;
    fallback: ReactNode;
  },
  {
    hasError: boolean;
  }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

const EMPTY_REFERENCE_ASSETS: DirectorAssetRef[] = [];
const EMPTY_PROMPT_REFERENCES: PromptReferenceViewportItem[] = [];
const EMPTY_SCENE_ANNOTATIONS: DirectorSceneAnnotation[] = [];
const EMPTY_SCENE_MEASUREMENTS: DirectorSceneMeasurement[] = [];

function useMeasuredVisualCenter(measurementKey: string) {
  const [measurement, setMeasurement] = useState<{
    center: CameraWirePoint;
    key: string;
  } | null>(null);
  const onCenterChange = useCallback(
    (center: CameraWirePoint) => {
      setMeasurement((current) =>
        current?.key === measurementKey &&
        current.center.every((value, index) => Math.abs(value - center[index]) < 0.0001)
          ? current
          : { center: [...center], key: measurementKey },
      );
    },
    [measurementKey],
  );
  return [measurement?.key === measurementKey ? measurement.center : null, onCenterChange] as const;
}

type CameraWireLine = {
  part: CameraWirePart;
  points: CameraWirePointLine;
};
type CameraHitArea = {
  args: CameraWirePoint;
  position: CameraWirePoint;
};

function ViewportObjectLabel({
  badge,
  children,
  position,
  translateContent = false,
}: {
  badge?: string;
  children: ReactNode;
  position: [number, number, number];
  /** Only fixed UI strings opt in; user names (characters, cameras) render verbatim. */
  translateContent?: boolean;
}) {
  const { t } = useLanguage();
  // Character and camera names are user data: the wrapping
  // data-i18n-user-content already shields them from the DOM walker, so the
  // explicit t() must not run either (a character named 角色1 stays 角色1).
  const content = translateContent && typeof children === "string" ? t(children) : children;
  return (
    <Html center pointerEvents="none" position={position} zIndexRange={[0, 1]}>
      <div className="role-label" data-i18n-user-content>
        {content}
        {badge ? <span className="role-label-agent-badge">{t(badge)}</span> : null}
      </div>
    </Html>
  );
}

type ViewportLabelLayoutRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

type ViewportLabelOffset = readonly [number, number];

const VIEWPORT_LABEL_LAYOUT_CANDIDATES: ViewportLabelOffset[] = [
  [0, 0],
  ...Array.from({ length: 5 }, (_, index) => {
    const ring = index + 1;
    const x = ring * 54;
    const y = ring * 24;
    return [
      [0, -y],
      [0, y],
      [-x, 0],
      [x, 0],
      [-x, -y],
      [x, -y],
      [-x, y],
      [x, y],
    ] as ViewportLabelOffset[];
  }).flat(),
];

function viewportLabelIntersectionArea(left: ViewportLabelLayoutRect, right: ViewportLabelLayoutRect) {
  const width = Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left));
  const height = Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
  return width * height;
}

function offsetViewportLabelRect(rect: ViewportLabelLayoutRect, [x, y]: ViewportLabelOffset) {
  return {
    ...rect,
    left: rect.left + x,
    right: rect.right + x,
    top: rect.top + y,
    bottom: rect.bottom + y,
  };
}

export function resolveViewportLabelOffsets(
  labels: ViewportLabelLayoutRect[],
  bounds: ViewportLabelLayoutRect,
  obstacles: ViewportLabelLayoutRect[] = [],
  previousOffsets: ViewportLabelOffset[] = [],
) {
  const occupied = [...obstacles];

  return labels.map((label, labelIndex): ViewportLabelOffset => {
    if (
      label.width <= 0 ||
      label.height <= 0 ||
      label.right < bounds.left ||
      label.left > bounds.right ||
      label.bottom < bounds.top ||
      label.top > bounds.bottom
    ) {
      return [0, 0];
    }

    const previous = previousOffsets[labelIndex] ?? ([0, 0] as const);
    const candidates = [previous, ...VIEWPORT_LABEL_LAYOUT_CANDIDATES].filter(
      ([x, y], index, all) => all.findIndex(([otherX, otherY]) => otherX === x && otherY === y) === index,
    );
    let bestOffset: ViewportLabelOffset = [0, 0];
    let bestRect = label;
    let bestScore = Number.POSITIVE_INFINITY;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const rawOffset of candidates) {
      const offset: ViewportLabelOffset = [
        Math.min(bounds.right - label.right, Math.max(bounds.left - label.left, rawOffset[0])),
        Math.min(bounds.bottom - label.bottom, Math.max(bounds.top - label.top, rawOffset[1])),
      ];
      const candidate = offsetViewportLabelRect(label, offset);
      const score = occupied.reduce((total, item) => total + viewportLabelIntersectionArea(candidate, item), 0);
      const distance = Math.hypot(offset[0], offset[1]);

      if (score < bestScore || (score === bestScore && distance < bestDistance)) {
        bestOffset = offset;
        bestRect = candidate;
        bestScore = score;
        bestDistance = distance;
      }
    }

    occupied.push(bestRect);
    return bestOffset;
  });
}

function ViewportLabelLayout() {
  const viewportCanvas = useThree((state) => state.gl?.domElement as HTMLCanvasElement | undefined);
  const elapsed = useRef(0);
  const previousOffsets = useRef(new WeakMap<HTMLElement, ViewportLabelOffset>());

  useFrame((_state, delta) => {
    elapsed.current += delta;
    const viewportRoot = viewportCanvas?.closest<HTMLElement>(".director-stage-canvas");
    if (elapsed.current < 0.08 || !viewportRoot) return;
    elapsed.current = 0;

    const labels = [...viewportRoot.querySelectorAll<HTMLElement>(".role-label")];
    if (!labels.length) return;

    const bounds = viewportRoot.getBoundingClientRect();
    const prior = labels.map((label) => previousOffsets.current.get(label) ?? ([0, 0] as const));
    const rects = labels.map((label, index) => {
      const rect = label.getBoundingClientRect();
      const [x, y] = prior[index];
      return {
        left: rect.left - x,
        top: rect.top - y,
        right: rect.right - x,
        bottom: rect.bottom - y,
        width: rect.width,
        height: rect.height,
      };
    });
    const pictureInPicture = viewportRoot.parentElement?.querySelector<HTMLElement>(".camera-picture-in-picture");
    const obstacles = pictureInPicture ? [pictureInPicture.getBoundingClientRect()] : [];
    const nextOffsets = resolveViewportLabelOffsets(rects, bounds, obstacles, prior);

    labels.forEach((label, index) => {
      const next = nextOffsets[index];
      const previous = prior[index];
      if (next[0] !== previous[0] || next[1] !== previous[1]) {
        label.style.transform = `translate(${next[0]}px, ${next[1]}px)`;
      }
      previousOffsets.current.set(label, next);
    });
  });

  return null;
}

function DirectorSceneOverlays({ objects }: { objects: DirectorObject[] }) {
  // Keep fallbacks module-stable. Returning a fresh [] from a Zustand selector
  // changes the snapshot on every read and can trigger an infinite React update
  // loop when loading legacy projects that omit these optional arrays.
  const showLabels = useDirectorStore((state) => state.project.scene.showLabels);
  const annotations = useDirectorStore((state) => state.project.scene.annotations ?? EMPTY_SCENE_ANNOTATIONS);
  const measurements = useDirectorStore((state) => state.project.scene.measurements ?? EMPTY_SCENE_MEASUREMENTS);
  const objectsById = useMemo(() => new Map(objects.map((object) => [object.id, object])), [objects]);

  return (
    <>
      {measurements.flatMap((measurement) => {
        if (!measurement.visible) return [];
        const start = resolveDirectorSceneAnchor(measurement.start, objectsById);
        const end = resolveDirectorSceneAnchor(measurement.end, objectsById);
        if (!start || !end) return [];
        const midpoint = start.map((value, index) => (value + end[index]!) / 2) as [number, number, number];
        const distance = getDirectorMeasurementDistance(start, end);
        return [
          <group key={measurement.id} name={`director-measurement-${measurement.id}`}>
            <Line color={measurement.color} lineWidth={1.5} points={[start, end]} />
            <mesh position={start}>
              <sphereGeometry args={[0.035, 12, 8]} />
              <meshBasicMaterial color={measurement.color} depthTest={false} />
            </mesh>
            <mesh position={end}>
              <sphereGeometry args={[0.035, 12, 8]} />
              <meshBasicMaterial color={measurement.color} depthTest={false} />
            </mesh>
            {showLabels ? (
              <Html center pointerEvents="none" position={midpoint} zIndexRange={[3, 4]}>
                <div
                  className="director-measurement-label"
                  data-i18n-user-content
                  style={{ borderColor: measurement.color }}
                >
                  {measurement.label ? `${measurement.label} · ` : ""}
                  {distance.toFixed(3)} m
                </div>
              </Html>
            ) : null}
          </group>,
        ];
      })}
      {annotations.flatMap((annotation) => {
        if (!annotation.visible) return [];
        const anchor = resolveDirectorSceneAnchor(annotation.anchor, objectsById);
        if (!anchor) return [];
        const labelPosition: [number, number, number] = [anchor[0], anchor[1] + 0.42, anchor[2]];
        return [
          <group key={annotation.id} name={`director-annotation-${annotation.id}`}>
            <Line color={annotation.color} lineWidth={1.25} points={[anchor, labelPosition]} />
            <mesh position={anchor}>
              <sphereGeometry args={[0.045, 12, 8]} />
              <meshBasicMaterial color={annotation.color} depthTest={false} />
            </mesh>
            {showLabels ? (
              <Html center pointerEvents="none" position={labelPosition} zIndexRange={[4, 5]}>
                <div
                  className="director-annotation-label"
                  data-i18n-user-content
                  style={{ borderColor: annotation.color }}
                >
                  {annotation.text}
                </div>
              </Html>
            ) : null}
          </group>,
        ];
      })}
    </>
  );
}

export function ViewportTransformControls({
  mode,
  object,
  onObjectChange,
  onTransformEnd,
  onTransformStart,
  translationSnap,
}: {
  mode: TransformMode;
  object: TransformControlsProps["object"];
  onObjectChange: TransformControlsProps["onObjectChange"];
  onTransformEnd?: () => void;
  onTransformStart?: () => void;
  translationSnap?: number | null;
}) {
  const controlsRef = useRef<TransformControlsImpl | null>(null);
  const viewportScene = useThree((state) => state.scene);
  const setControlsRef = useCallback((controls: TransformControlsImpl | null) => {
    controlsRef.current = controls;
    if (controls) {
      controls.userData[HIDE_FROM_VIEWPORT_CAPTURE_KEY] = true;
    }
  }, []);
  const transformInteraction = useRafCoalescedTransformInteraction(
    onObjectChange as NonNullable<TransformControlsProps["onObjectChange"]>,
  );

  const controls = (
    <TransformControls
      ref={setControlsRef}
      mode={mode}
      object={object}
      onMouseDown={() => {
        onTransformStart?.();
        transformInteraction.onMouseDown();
      }}
      onMouseUp={() => {
        transformInteraction.onMouseUp();
        onTransformEnd?.();
      }}
      onObjectChange={transformInteraction.onObjectChange}
      translationSnap={translationSnap ?? undefined}
      userData={{ [HIDE_FROM_VIEWPORT_CAPTURE_KEY]: true }}
    />
  );

  // TransformControls resolves the attached object's world transform on its
  // own. Rendering the helper below a translated/rotated/scaled scene group
  // would apply that parent transform a second time and visibly detach the
  // gizmo from the asset. Keep the helper at the Three scene root while it
  // continues to control the original nested object.
  return createPortal(controls, viewportScene);
}

export function CenteredObjectTransformControls({
  localCenter,
  mode,
  onTransformChange,
  transform,
  translationSnap,
}: {
  localCenter: readonly [number, number, number];
  mode: TransformMode;
  onTransformChange: (transform: DirectorTransform) => void;
  transform: DirectorTransform;
  translationSnap?: number | null;
}) {
  const controlTargetRef = useRef<Group>(null!);
  const controlTransform = useMemo(() => getCenteredControlTransform(transform, localCenter), [localCenter, transform]);
  const handleObjectChange = useCallback(() => {
    const controlTarget = controlTargetRef.current;
    if (!controlTarget) return;
    onTransformChange(getObjectTransformFromCenteredControl(controlTarget, localCenter));
  }, [localCenter, onTransformChange]);

  return (
    <>
      <group
        ref={controlTargetRef}
        name="director-centered-transform-pivot"
        position={controlTransform.position}
        rotation={controlTransform.rotation}
        scale={controlTransform.scale}
      />
      <ViewportTransformControls
        mode={mode}
        object={controlTargetRef}
        onObjectChange={handleObjectChange}
        translationSnap={translationSnap}
      />
    </>
  );
}

function ObjectVisualCenterProbe({
  measurementKey,
  onCenterChange,
  rootRef,
}: {
  measurementKey: string;
  onCenterChange: (center: CameraWirePoint) => void;
  rootRef: RefObject<Group>;
}) {
  useLayoutEffect(() => {
    let animationFrameId: number | null = null;
    let attempts = 0;
    let successfulMeasurements = 0;

    const measure = () => {
      const root = rootRef.current;
      // Unit tests render R3F host tags through React DOM, where the ref is an
      // HTMLElement rather than a Three.js Group.
      if (!root || typeof root.updateWorldMatrix !== "function") return;

      const center = getVisibleObjectLocalFloorPivot(root);
      attempts += 1;
      if (center) {
        onCenterChange(center);
        successfulMeasurements += 1;
      }

      // An imported asset can still be suspended when the selected object
      // first mounts. Retry until geometry appears, then measure a second
      // committed frame so skeleton and nested world matrices have settled.
      if (attempts < 600 && successfulMeasurements < 2) {
        animationFrameId = window.requestAnimationFrame(measure);
      }
    };

    measure();
    return () => {
      if (animationFrameId !== null) window.cancelAnimationFrame(animationFrameId);
    };
  }, [measurementKey, onCenterChange, rootRef]);

  return null;
}

function CompositeVisualCenterProbe({
  childIds,
  measurementKey,
  onCenterChange,
  parentRef,
  sceneRootRef,
}: {
  childIds: readonly string[];
  measurementKey: string;
  onCenterChange: (center: CameraWirePoint) => void;
  parentRef: RefObject<Group>;
  sceneRootRef: RefObject<Group>;
}) {
  useLayoutEffect(() => {
    let animationFrameId: number | null = null;
    let attempts = 0;
    let successfulMeasurements = 0;

    const measure = () => {
      const parent = parentRef.current;
      const sceneRoot = sceneRootRef.current;
      if (!parent || !sceneRoot || typeof parent.updateWorldMatrix !== "function") return;

      const visualRoots = childIds
        .map((childId) => sceneRoot.getObjectByName(`director-object-${childId}`))
        .filter((child): child is Object3D => Boolean(child));
      const center = getVisibleObjectsLocalFloorPivot(parent, visualRoots);
      attempts += 1;
      const allExpectedGeometryReady =
        visualRoots.length === childIds.length &&
        visualRoots.every((visualRoot) => getVisibleObjectLocalFloorPivot(visualRoot) !== null);
      const timedOut = attempts >= 600;
      if (center && (allExpectedGeometryReady || timedOut)) {
        onCenterChange(center);
        successfulMeasurements += 1;
      }

      // Imported children can still be suspended when the composite is first
      // selected. Retry until their real geometry has contributed to the
      // shared bounds, then confirm it on a second committed frame.
      if (!timedOut && successfulMeasurements < 2) {
        animationFrameId = window.requestAnimationFrame(measure);
      }
    };

    measure();
    return () => {
      if (animationFrameId !== null) window.cancelAnimationFrame(animationFrameId);
    };
  }, [childIds, measurementKey, onCenterChange, parentRef, sceneRootRef]);

  return null;
}

export function getViewportCameraQuaternion(position: [number, number, number], target: [number, number, number]) {
  const origin = new Vector3(...position);
  const direction = new Vector3(...target).sub(origin);
  if (direction.lengthSq() === 0) return new Quaternion();

  const forward = direction.normalize();
  const up = Math.abs(forward.dot(VIEWPORT_CAMERA_WORLD_UP)) > 0.999 ? new Vector3(0, 0, 1) : VIEWPORT_CAMERA_WORLD_UP;
  // Matrix4.lookAt maps local -Z to its target. The helper's modeled forward
  // is local +Z, so aim lookAt backwards to map that +Z axis onto `forward`.
  const matrix = new Matrix4().lookAt(origin, origin.clone().sub(forward), up);

  return new Quaternion().setFromRotationMatrix(matrix);
}

export function getViewportCameraOpaqueDepthRange() {
  const zValues = getViewportCameraBodyWireframeLines()
    .filter((line) => line.part !== "lens")
    .flatMap((line) => line.points)
    .map((point) => point[2]);

  return {
    minZ: Math.min(...zValues),
    maxZ: Math.max(...zValues),
  };
}

export function getViewportCameraLabelY() {
  const points = getViewportCameraBodyWireframeLines().flatMap((line) => line.points);
  const modelTopY = Math.max(...points.map((point) => point[1]));

  return modelTopY + VIEWPORT_OBJECT_LABEL_VERTICAL_GAP;
}

export function getCenteredControlTransform(
  transform: DirectorTransform,
  localCenter: readonly [number, number, number],
): DirectorTransform {
  const centerOffset = new Vector3(...localCenter)
    .multiply(new Vector3(...transform.scale))
    .applyEuler(new Euler(...transform.rotation));

  return {
    position: [
      transform.position[0] + centerOffset.x,
      transform.position[1] + centerOffset.y,
      transform.position[2] + centerOffset.z,
    ],
    rotation: [...transform.rotation],
    scale: [...transform.scale],
  };
}

export function getObjectTransformFromCenteredControl(
  control: Object3D,
  localCenter: readonly [number, number, number],
): DirectorTransform {
  const centerOffset = new Vector3(...localCenter).multiply(control.scale).applyQuaternion(control.quaternion);

  return {
    position: [
      control.position.x - centerOffset.x,
      control.position.y - centerOffset.y,
      control.position.z - centerOffset.z,
    ],
    rotation: [control.rotation.x, control.rotation.y, control.rotation.z],
    scale: [control.scale.x, control.scale.y, control.scale.z],
  };
}

function composeDirectorTransform(transform: DirectorTransform) {
  return new Matrix4().compose(
    new Vector3(...transform.position),
    new Quaternion().setFromEuler(new Euler(...transform.rotation)),
    new Vector3(...transform.scale),
  );
}

function decomposeDirectorTransform(matrix: Matrix4): DirectorTransform {
  const position = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3();
  matrix.decompose(position, rotation, scale);
  const euler = new Euler().setFromQuaternion(rotation);

  return {
    position: [position.x, position.y, position.z],
    rotation: [euler.x, euler.y, euler.z],
    scale: [scale.x, scale.y, scale.z],
  };
}

export function getMultiObjectGroupTransform(objects: readonly DirectorObject[]): DirectorTransform {
  const count = objects.length || 1;
  const position = objects.reduce(
    (center, object) => {
      center[0] += object.transform.position[0] / count;
      center[1] += object.transform.position[1] / count;
      center[2] += object.transform.position[2] / count;
      return center;
    },
    [0, 0, 0] as [number, number, number],
  );

  return { position, rotation: [0, 0, 0], scale: [1, 1, 1] };
}

export function getMultiObjectTransformUpdates(
  objects: readonly DirectorObject[],
  initialGroupTransform: DirectorTransform,
  nextGroupTransform: DirectorTransform,
) {
  const delta = composeDirectorTransform(nextGroupTransform).multiply(
    composeDirectorTransform(initialGroupTransform).invert(),
  );

  return objects.map((object) => ({
    id: object.id,
    transform: decomposeDirectorTransform(delta.clone().multiply(composeDirectorTransform(object.transform))),
  }));
}

function createBoxWireframeLines({
  center,
  size,
}: {
  center: CameraWirePoint;
  size: CameraWirePoint;
}): CameraWirePointLine[] {
  const [cx, cy, cz] = center;
  const [width, height, depth] = size;
  const x0 = cx - width / 2;
  const x1 = cx + width / 2;
  const y0 = cy - height / 2;
  const y1 = cy + height / 2;
  const z0 = cz - depth / 2;
  const z1 = cz + depth / 2;
  const corners: Record<string, CameraWirePoint> = {
    bbl: [x0, y0, z0],
    bbr: [x1, y0, z0],
    btl: [x0, y1, z0],
    btr: [x1, y1, z0],
    fbl: [x0, y0, z1],
    fbr: [x1, y0, z1],
    ftl: [x0, y1, z1],
    ftr: [x1, y1, z1],
  };

  return [
    [corners.bbl, corners.bbr],
    [corners.bbr, corners.btr],
    [corners.btr, corners.btl],
    [corners.btl, corners.bbl],
    [corners.fbl, corners.fbr],
    [corners.fbr, corners.ftr],
    [corners.ftr, corners.ftl],
    [corners.ftl, corners.fbl],
    [corners.bbl, corners.fbl],
    [corners.bbr, corners.fbr],
    [corners.btr, corners.ftr],
    [corners.btl, corners.ftl],
  ];
}

function createCircleWireframeLine({
  center,
  radius,
  segments = 32,
  plane = "xy",
}: {
  center: CameraWirePoint;
  radius: number;
  segments?: number;
  plane?: "xy" | "xz" | "yz";
}): CameraWirePointLine {
  const [cx, cy, cz] = center;
  return Array.from({ length: segments + 1 }, (_, index) => {
    const angle = (Math.PI * 2 * index) / segments;
    const a = Math.cos(angle) * radius;
    const b = Math.sin(angle) * radius;

    if (plane === "xz") return [cx + a, cy, cz + b];
    if (plane === "yz") return [cx, cy + a, cz + b];

    return [cx + a, cy + b, cz];
  });
}

function createInvertedTetrahedronLensWireframeLines(): CameraWirePointLine[] {
  const backTopLeft: CameraWirePoint = [
    -0.1 * VIEWPORT_CAMERA_VISUAL_SCALE,
    0.1 * VIEWPORT_CAMERA_VISUAL_SCALE,
    VIEWPORT_CAMERA_BODY_FRONT_Z,
  ];
  const backTopRight: CameraWirePoint = [
    0.1 * VIEWPORT_CAMERA_VISUAL_SCALE,
    0.1 * VIEWPORT_CAMERA_VISUAL_SCALE,
    VIEWPORT_CAMERA_BODY_FRONT_Z,
  ];
  const backBottomRight: CameraWirePoint = [
    0.1 * VIEWPORT_CAMERA_VISUAL_SCALE,
    -0.1 * VIEWPORT_CAMERA_VISUAL_SCALE,
    VIEWPORT_CAMERA_BODY_FRONT_Z,
  ];
  const backBottomLeft: CameraWirePoint = [
    -0.1 * VIEWPORT_CAMERA_VISUAL_SCALE,
    -0.1 * VIEWPORT_CAMERA_VISUAL_SCALE,
    VIEWPORT_CAMERA_BODY_FRONT_Z,
  ];

  const frontTopLeft: CameraWirePoint = [
    -0.25 * VIEWPORT_CAMERA_VISUAL_SCALE,
    0.2 * VIEWPORT_CAMERA_VISUAL_SCALE,
    VIEWPORT_CAMERA_LENS_TIP[2],
  ];
  const frontTopRight: CameraWirePoint = [
    0.25 * VIEWPORT_CAMERA_VISUAL_SCALE,
    0.2 * VIEWPORT_CAMERA_VISUAL_SCALE,
    VIEWPORT_CAMERA_LENS_TIP[2],
  ];
  const frontBottomRight: CameraWirePoint = [
    0.25 * VIEWPORT_CAMERA_VISUAL_SCALE,
    -0.2 * VIEWPORT_CAMERA_VISUAL_SCALE,
    VIEWPORT_CAMERA_LENS_TIP[2],
  ];
  const frontBottomLeft: CameraWirePoint = [
    -0.25 * VIEWPORT_CAMERA_VISUAL_SCALE,
    -0.2 * VIEWPORT_CAMERA_VISUAL_SCALE,
    VIEWPORT_CAMERA_LENS_TIP[2],
  ];

  return [
    [backTopLeft, backTopRight, backBottomRight, backBottomLeft, backTopLeft],
    [frontTopLeft, frontTopRight, frontBottomRight, frontBottomLeft, frontTopLeft],

    [backTopLeft, frontTopLeft],
    [backTopRight, frontTopRight],
    [backBottomRight, frontBottomRight],
    [backBottomLeft, frontBottomLeft],
  ];
}
function withCameraPart(part: CameraWirePart, lines: CameraWirePointLine[]): CameraWireLine[] {
  return lines.map((points) => ({ part, points }));
}

export function getViewportCameraBodyWireframeLines(): CameraWireLine[] {
  return [
    ...withCameraPart("body", [
      ...createBoxWireframeLines({
        center: VIEWPORT_CAMERA_BODY_CENTER,
        size: VIEWPORT_CAMERA_BODY_SIZE,
      }),
    ]),
    ...withCameraPart("lens", createInvertedTetrahedronLensWireframeLines()),
    ...withCameraPart("reel", [
      createCircleWireframeLine({
        center: [0, 0.44 * VIEWPORT_CAMERA_VISUAL_SCALE, -0.78 * VIEWPORT_CAMERA_VISUAL_SCALE],
        radius: 0.21 * VIEWPORT_CAMERA_VISUAL_SCALE,
        plane: "yz",
      }),
      createCircleWireframeLine({
        center: [0, 0.44 * VIEWPORT_CAMERA_VISUAL_SCALE, -0.34 * VIEWPORT_CAMERA_VISUAL_SCALE],
        radius: 0.21 * VIEWPORT_CAMERA_VISUAL_SCALE,
        plane: "yz",
      }),
    ]),
  ];
}

export function getViewportCameraHitArea(): CameraHitArea {
  const points = getViewportCameraBodyWireframeLines().flatMap((line) => line.points);
  const minX = Math.min(...points.map((point) => point[0]));
  const maxX = Math.max(...points.map((point) => point[0]));
  const minY = Math.min(...points.map((point) => point[1]));
  const maxY = Math.max(...points.map((point) => point[1]));
  const minZ = Math.min(...points.map((point) => point[2]));
  const maxZ = Math.max(...points.map((point) => point[2]));

  return {
    args: [
      maxX - minX + VIEWPORT_CAMERA_HIT_PADDING * 2,
      maxY - minY + VIEWPORT_CAMERA_HIT_PADDING * 2,
      maxZ - minZ + VIEWPORT_CAMERA_HIT_PADDING * 2,
    ],
    position: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
  };
}

function NormalizedImportedObject({
  assets = [],
  grounded = false,
  material,
  modelNormalization = "auto",
  object,
  onCenterChange,
  onLocalBoundsChange,
  realWorldSizeM,
}: {
  assets?: DirectorAssetRef[];
  grounded?: boolean;
  material?: DirectorObject["material"];
  modelNormalization?: "auto" | "preserve";
  object: Object3D;
  onCenterChange?: (center: [number, number, number]) => void;
  onLocalBoundsChange?: (bounds: DirectorObject["localBoundsM"]) => void;
  realWorldSizeM?: number;
}) {
  const reversedDepthBuffer = useThree((state) => state.gl.capabilities.reversedDepthBuffer === true);
  const { clone, localBounds, normalization } = useMemo(() => {
    const clonedObject = object.clone(true);
    clonedObject.traverse((child) => {
      const renderable = child as Object3D & {
        isMesh?: boolean;
        castShadow?: boolean;
        receiveShadow?: boolean;
      };
      if (!renderable.isMesh) return;
      renderable.castShadow = true;
      renderable.receiveShadow = true;
    });
    if (material) cloneDirectorImportedMaterials(clonedObject);
    stabilizeImportedModelCoplanarDepth(clonedObject, reversedDepthBuffer);

    const sourceBounds = getPreciseImportedModelBounds(clonedObject);
    const normalization = getImportedModelNormalization(
      sourceBounds,
      IMPORTED_MODEL_TARGET_MAX_SIZE,
      modelNormalization,
      grounded,
      realWorldSizeM,
    );
    return {
      clone: clonedObject,
      localBounds: getNormalizedImportedModelLocalBounds(sourceBounds, normalization),
      normalization,
    };
  }, [grounded, material, modelNormalization, object, realWorldSizeM, reversedDepthBuffer]);

  useLayoutEffect(() => {
    onCenterChange?.(normalization.center);
  }, [normalization.center, onCenterChange]);

  useLayoutEffect(() => {
    if (localBounds) onLocalBoundsChange?.(localBounds);
  }, [localBounds, onLocalBoundsChange]);

  return (
    <group position={normalization.position} scale={[normalization.scale, normalization.scale, normalization.scale]}>
      {material ? <DirectorImportedMaterialOverride assets={assets} material={material} object={clone} /> : null}
      <primitive object={clone} />
    </group>
  );
}

type LoadedModelProps = {
  assets?: DirectorAssetRef[];
  grounded?: boolean;
  material?: DirectorObject["material"];
  modelNormalization?: "auto" | "preserve";
  realWorldSizeM?: number;
  url: string;
  onCenterChange?: (center: CameraWirePoint) => void;
  onLocalBoundsChange?: (bounds: DirectorObject["localBoundsM"]) => void;
};

function FbxModel({ url, ...rest }: LoadedModelProps) {
  const object = useLoader(FBXLoader, url);

  return <NormalizedImportedObject {...rest} object={object} />;
}

function ObjModel({ url, ...rest }: LoadedModelProps) {
  const object = useLoader(OBJLoader, url);

  return <NormalizedImportedObject {...rest} object={object} />;
}

function GlbModel({ url, ...rest }: LoadedModelProps) {
  const gltf = useLoader(GLTFLoader, url);
  const object = useMemo(() => cloneSkinnedObject(gltf.scene), [gltf.scene]);

  return <NormalizedImportedObject {...rest} object={object} />;
}

export const ImportedModel = memo(function ImportedModel({
  fileName,
  grounded = false,
  onLocalBoundsChange,
  ...rest
}: LoadedModelProps & { fileName: string }) {
  if (isDirectorSplatAssetFileName(fileName)) return <SplatModel fileName={fileName} grounded={grounded} {...rest} />;
  if (/\.fbx$/i.test(fileName))
    return <FbxModel grounded={grounded} onLocalBoundsChange={onLocalBoundsChange} {...rest} />;
  if (/\.obj$/i.test(fileName))
    return <ObjModel grounded={grounded} onLocalBoundsChange={onLocalBoundsChange} {...rest} />;
  if (/\.(glb|gltf)$/i.test(fileName))
    return <GlbModel grounded={grounded} onLocalBoundsChange={onLocalBoundsChange} {...rest} />;
  return null;
});

function GeometryPrimitiveModel({
  assets,
  color = "#d7e7ff",
  geometryType,
  item,
}: {
  assets: DirectorAssetRef[];
  color?: string;
  geometryType: GeometryPrimitiveType;
  item: DirectorObject;
}) {
  const reversedDepthBuffer = useThree((state) => state.gl.capabilities.reversedDepthBuffer === true);
  const material = (
    <DirectorObjectPbrMaterial
      assets={assets}
      depthBias={getPrimitiveCoplanarDepthBias(item.transform.scale, reversedDepthBuffer)}
      object={{ ...item, color }}
    />
  );
  const metrics = getDirectorPrimitiveMetrics(geometryType);

  if (geometryType === "sphere") {
    return (
      <mesh castShadow receiveShadow name="geometry-sphere" position={metrics.center}>
        <sphereGeometry args={[0.5, 32, 16]} />
        {material}
      </mesh>
    );
  }

  if (geometryType === "cylinder") {
    return (
      <mesh castShadow receiveShadow name="geometry-cylinder" position={metrics.center}>
        <cylinderGeometry args={[0.5, 0.5, 1, 32]} />
        {material}
      </mesh>
    );
  }

  if (geometryType === "torus") {
    return (
      <mesh castShadow receiveShadow name="geometry-torus" position={metrics.center} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.375, 0.125, 16, 48]} />
        {material}
      </mesh>
    );
  }

  if (geometryType === "cone") {
    return (
      <mesh castShadow receiveShadow name="geometry-cone" position={metrics.center}>
        <coneGeometry args={[0.5, 1, 32]} />
        {material}
      </mesh>
    );
  }

  if (geometryType === "pyramid") {
    return (
      <mesh castShadow receiveShadow name="geometry-pyramid" position={metrics.center}>
        <coneGeometry args={[0.5, 1, 4]} />
        {material}
      </mesh>
    );
  }

  return (
    <mesh castShadow receiveShadow name="geometry-box" position={metrics.center}>
      <boxGeometry args={[1, 1, 1]} />
      {material}
    </mesh>
  );
}

function PromptReferenceVisual({
  label,
  text,
  style,
}: {
  label: string;
  text: string;
  style: PromptReferenceVisualStyle;
}) {
  return (
    <Html center pointerEvents="none" position={[0, 1.2, 0]} zIndexRange={[2, 3]}>
      <div
        aria-label={`${label} 提示词可视化`}
        className="prompt-reference-visual"
        data-i18n-user-content
        style={{
          width: `${style.width}px`,
          height: `${style.height}px`,
          color: style.fontColor,
          fontSize: `${style.fontSize}px`,
          backgroundColor: style.backgroundColor,
          borderColor: style.borderColor,
        }}
      >
        {text}
      </div>
    </Html>
  );
}

const ObjectSceneNode = memo(function ObjectSceneNode({
  assets,
  asset,
  compositeChildren = [],
  item,
  referenceAssets = [],
  promptReferences = [],
  selected,
  showLabels,
  showPrimary = true,
  currentFrame,
  timelineMotion,
  fps,
  runtimeControlled = false,
  sceneRootRef,
  transformMode,
  transformable,
  translationSnap,
  onSelect,
}: {
  assets: DirectorAssetRef[];
  asset?: DirectorAssetRef;
  compositeChildren?: DirectorObject[];
  item: DirectorObject;
  referenceAssets?: DirectorAssetRef[];
  promptReferences?: Array<{
    id: string;
    label: string;
    text: string;
    style: PromptReferenceVisualStyle;
  }>;
  selected: boolean;
  showLabels: boolean;
  showPrimary?: boolean;
  currentFrame: number;
  timelineMotion?: DirectorCharacterMotionState | null;
  fps: number;
  runtimeControlled?: boolean;
  sceneRootRef?: RefObject<Group>;
  transformMode: TransformMode;
  transformable: boolean;
  translationSnap: number | null;
  onSelect?: (item: DirectorObject) => void;
}) {
  const groupRef = useRef<Group>(null!);
  const declarativeTransformRef = useRef(item.transform);
  const [measuredCharacterLabel, setMeasuredCharacterLabel] = useState<{
    key: string;
    y: number;
  } | null>(null);
  const [importedModelCenter, setImportedModelCenter] = useState<CameraWirePoint>([0, 0, 0]);
  const updateObjectTransform = useDirectorStore((state) => state.updateObjectTransform);
  const setObjectMeasuredLocalBounds = useDirectorStore((state) => state.setObjectMeasuredLocalBounds);
  const isImportedModel = asset?.sourceType === "model";
  const isImportedCharacter = isImportedModel && item.kind === "character" && asset?.kind === "character";
  // Viewport-visible possession state: a bound Agent drives this character.
  const agentTakeoverBadge = item.kind === "character" && item.agentBinding ? "Agent 接管" : undefined;
  const isDirectorHeroCharacterAsset = Boolean(asset?.url && /\.fbx$/i.test(asset.url));
  const characterLabelKey = `${item.id}:${asset?.id ?? ""}:${item.bodyType ?? ""}:${item.characterRig?.rigType ?? ""}`;
  const fallbackCharacterLabelY =
    item.kind === "character"
      ? (asset?.characterMetadata?.labelAnchorY ??
        (item.characterRig?.rigType === "ue4-mannequin"
          ? getUE4GroundedLabelY(item.bodyType)
          : getGroundedLabelY(item.bodyType)))
      : 1.25;
  const characterLabelY =
    measuredCharacterLabel?.key === characterLabelKey ? measuredCharacterLabel.y : fallbackCharacterLabelY;
  const visualCenterMeasurementKey = useMemo(
    () =>
      JSON.stringify({
        assetId: asset?.id ?? null,
        grounded: item.placementMode === "grounded",
        bodyType: item.bodyType ?? null,
        characterRig: item.characterRig ?? null,
        geometryType: item.geometryType ?? null,
        references: referenceAssets.map((referenceAsset) => referenceAsset.id),
        compositeChildren: compositeChildren.map((child) => ({
          assetRefId: child.assetRefId ?? null,
          bodyType: child.bodyType ?? null,
          characterRig: child.characterRig ?? null,
          geometryType: child.geometryType ?? null,
          id: child.id,
          referenceBindings: child.referenceBindings ?? null,
          visible: child.visible,
        })),
      }),
    [
      asset?.id,
      compositeChildren,
      item.bodyType,
      item.characterRig,
      item.geometryType,
      item.placementMode,
      referenceAssets,
    ],
  );
  const compositeChildIds = useMemo(() => compositeChildren.map((child) => child.id), [compositeChildren]);
  const [currentMeasuredVisualCenter, handleMeasuredVisualCenterChange] =
    useMeasuredVisualCenter(visualCenterMeasurementKey);
  const transformCenter = useMemo<CameraWirePoint>(() => {
    if (currentMeasuredVisualCenter) return currentMeasuredVisualCenter;
    if (isImportedModel) return importedModelCenter;
    return [0, 0, 0];
  }, [currentMeasuredVisualCenter, importedModelCenter, isImportedModel]);
  // The player controller owns this group imperatively during exploration.
  // Retaining the last declarative values prevents unrelated React updates
  // from snapping it back between animation frames.
  if (!runtimeControlled) declarativeTransformRef.current = item.transform;
  const declarativeTransform = declarativeTransformRef.current;
  const runtimeCharacterRigState = useMemo(() => {
    // A translating timeline path owns the locomotion base. Outside the exact
    // moving segment, preserve the authored clip verbatim so its start frame,
    // loop mode, and one-shot timing remain deterministic.
    if (!item.characterRig || !timelineMotion) return item.characterRig;
    return { ...item.characterRig, motion: timelineMotion };
  }, [item.characterRig, timelineMotion]);
  const handleCharacterLabelAnchorYChange = useCallback(
    (anchorY: number) => {
      setMeasuredCharacterLabel((current) => {
        const nextY = Number(anchorY.toFixed(4));

        if (current?.key === characterLabelKey && Math.abs(current.y - nextY) < 0.0001) {
          return current;
        }

        return {
          key: characterLabelKey,
          y: nextY,
        };
      });
    },
    [characterLabelKey],
  );
  const handleImportedModelCenterChange = useCallback((center: CameraWirePoint) => {
    setImportedModelCenter((current) =>
      current.every((value, index) => Math.abs(value - center[index]) < 0.0001) ? current : [...center],
    );
  }, []);
  const handleImportedModelBoundsChange = useCallback(
    (bounds: DirectorObject["localBoundsM"]) => setObjectMeasuredLocalBounds(item.id, bounds),
    [item.id, setObjectMeasuredLocalBounds],
  );
  const commitTransformFromViewport = useCallback(
    (transform: DirectorTransform) => updateObjectTransform(item.id, transform),
    [item.id, updateObjectTransform],
  );

  const node = (
    <group
      ref={groupRef}
      name={`director-object-${item.id}`}
      position={declarativeTransform.position}
      rotation={declarativeTransform.rotation}
      scale={declarativeTransform.scale}
      userData={{ directorObjectId: item.id, directorObjectKind: item.kind }}
      onClick={(event) => {
        event.stopPropagation();
        onSelect?.(item);
      }}
    >
      {showPrimary && isImportedCharacter && asset ? (
        <>
          <SceneAssetErrorBoundary
            key={asset.url}
            fallback={
              <CharacterModel
                bodyType={item.bodyType}
                color={item.color}
                currentFrame={currentFrame}
                fps={fps}
                onLabelAnchorYChange={handleCharacterLabelAnchorYChange}
                rigState={runtimeCharacterRigState}
                runtimeControlled={runtimeControlled}
              />
            }
          >
            <Suspense fallback={null}>
              {isDirectorHeroCharacterAsset ? (
                <DirectorCharacterModel
                  bodyType={item.bodyType}
                  currentFrame={currentFrame}
                  fps={fps}
                  onLabelAnchorYChange={handleCharacterLabelAnchorYChange}
                  onVisualCenterChange={handleImportedModelCenterChange}
                  rigState={runtimeCharacterRigState}
                  runtimeControlled={runtimeControlled}
                  targetHeightM={asset.characterMetadata?.heightM}
                  url={asset.url}
                />
              ) : (
                <MixamoCharacterModel
                  bodyType={item.bodyType}
                  currentFrame={currentFrame}
                  fps={fps}
                  onLabelAnchorYChange={handleCharacterLabelAnchorYChange}
                  onVisualCenterChange={handleImportedModelCenterChange}
                  rigState={runtimeCharacterRigState}
                  runtimeControlled={runtimeControlled}
                  targetHeightM={asset.characterMetadata?.heightM}
                  url={asset.url}
                />
              )}
            </Suspense>
          </SceneAssetErrorBoundary>
          {showLabels ? (
            <ViewportObjectLabel badge={agentTakeoverBadge} position={[0, characterLabelY, 0]}>
              {item.name}
            </ViewportObjectLabel>
          ) : null}
        </>
      ) : showPrimary && isImportedModel && asset ? (
        <SceneAssetErrorBoundary key={asset.url} fallback={null}>
          <Suspense fallback={null}>
            <ImportedModel
              assets={assets}
              fileName={asset.fileName}
              grounded={item.placementMode === "grounded"}
              material={item.material}
              modelNormalization={asset.modelNormalization}
              realWorldSizeM={asset.realWorldSizeM}
              onCenterChange={handleImportedModelCenterChange}
              onLocalBoundsChange={asset.localBoundsM ? undefined : handleImportedModelBoundsChange}
              url={asset.url}
            />
          </Suspense>
        </SceneAssetErrorBoundary>
      ) : showPrimary && item.kind === "character" ? (
        <>
          <Suspense fallback={null}>
            <CharacterModel
              bodyType={item.bodyType}
              color={item.color}
              currentFrame={currentFrame}
              fps={fps}
              onLabelAnchorYChange={handleCharacterLabelAnchorYChange}
              rigState={runtimeCharacterRigState}
              runtimeControlled={runtimeControlled}
            />
          </Suspense>
          {showLabels ? (
            <ViewportObjectLabel badge={agentTakeoverBadge} position={[0, characterLabelY, 0]}>
              {item.name}
            </ViewportObjectLabel>
          ) : null}
          {showLabels ? (
            <ViewportObjectLabel position={[0, 0.18, 0]} translateContent>
              资产绑定无效
            </ViewportObjectLabel>
          ) : null}
        </>
      ) : showPrimary && item.kind === "prop" && item.geometryType ? (
        <GeometryPrimitiveModel assets={assets} color={item.color} geometryType={item.geometryType} item={item} />
      ) : null}
      {referenceAssets.map((referenceAsset) => (
        <group key={`reference-${referenceAsset.id}`} name={`reference-binding-${item.id}-${referenceAsset.id}`}>
          <SceneAssetErrorBoundary key={referenceAsset.url} fallback={null}>
            <Suspense fallback={null}>
              <ImportedModel fileName={referenceAsset.fileName} url={referenceAsset.url} />
            </Suspense>
          </SceneAssetErrorBoundary>
        </group>
      ))}
      {promptReferences.map((prompt) => (
        <group key={`prompt-${prompt.id}`} name={`prompt-binding-${item.id}-${prompt.id}`}>
          <PromptReferenceVisual label={prompt.label} style={prompt.style} text={prompt.text} />
        </group>
      ))}
      {selected && transformable ? (
        item.isCompositeParent && compositeChildIds.length > 0 && sceneRootRef ? (
          <CompositeVisualCenterProbe
            childIds={compositeChildIds}
            measurementKey={visualCenterMeasurementKey}
            onCenterChange={handleMeasuredVisualCenterChange}
            parentRef={groupRef}
            sceneRootRef={sceneRootRef}
          />
        ) : (
          <ObjectVisualCenterProbe
            measurementKey={visualCenterMeasurementKey}
            onCenterChange={handleMeasuredVisualCenterChange}
            rootRef={groupRef}
          />
        )
      ) : null}
    </group>
  );

  if (!selected || !transformable) return node;

  return (
    <>
      {node}
      <CenteredObjectTransformControls
        localCenter={item.pivot ?? transformCenter}
        mode={transformMode}
        onTransformChange={commitTransformFromViewport}
        transform={declarativeTransform}
        translationSnap={transformMode === "translate" ? translationSnap : null}
      />
    </>
  );
});

function CrowdTransformRig({
  crowdId,
  objects,
  sceneRootRef,
  selected,
  transformMode,
  transformable,
  translationSnap,
}: {
  crowdId: string;
  objects: DirectorObject[];
  sceneRootRef: RefObject<Group>;
  selected: boolean;
  transformMode: TransformMode;
  transformable: boolean;
  translationSnap: number | null;
}) {
  const groupRef = useRef<Group>(null!);
  const updateCrowdTransform = useDirectorStore((state) => state.updateCrowdTransform);
  const crowdAnchor = useMemo(() => getCrowdAnchorTransform(objects, crowdId), [objects, crowdId]);
  const crowdMembers = useMemo(
    () => objects.filter((item) => item.kind === "character" && item.crowdId === crowdId && item.visible),
    [crowdId, objects],
  );
  const crowdMemberIds = useMemo(() => crowdMembers.map((item) => item.id), [crowdMembers]);
  const visualCenterMeasurementKey = useMemo(
    () =>
      JSON.stringify(
        crowdMembers.map((item) => ({
          bodyType: item.bodyType ?? null,
          characterRig: item.characterRig ?? null,
          id: item.id,
          visible: item.visible,
        })),
      ),
    [crowdMembers],
  );
  const [measuredVisualCenter, handleMeasuredVisualCenterChange] = useMeasuredVisualCenter(visualCenterMeasurementKey);
  const transformCenter = measuredVisualCenter ?? ([0, 0, 0] as const);
  const commitCrowdTransformFromViewport = useCallback(
    (transform: DirectorTransform) => updateCrowdTransform(crowdId, transform),
    [crowdId, updateCrowdTransform],
  );

  if (!selected || !transformable || !crowdAnchor) return null;

  return (
    <>
      <group ref={groupRef} position={crowdAnchor.position} rotation={crowdAnchor.rotation} scale={crowdAnchor.scale} />
      <CompositeVisualCenterProbe
        childIds={crowdMemberIds}
        measurementKey={visualCenterMeasurementKey}
        onCenterChange={handleMeasuredVisualCenterChange}
        parentRef={groupRef}
        sceneRootRef={sceneRootRef}
      />
      <CenteredObjectTransformControls
        localCenter={transformCenter}
        mode={transformMode}
        onTransformChange={commitCrowdTransformFromViewport}
        transform={crowdAnchor}
        translationSnap={transformMode === "translate" ? translationSnap : null}
      />
    </>
  );
}

function MultiObjectTransformRig({
  objects,
  transformMode,
  translationSnap,
}: {
  objects: DirectorObject[];
  transformMode: TransformMode;
  translationSnap: number | null;
}) {
  const groupRef = useRef<Group>(null!);
  const draggingRef = useRef(false);
  const dragSnapshotRef = useRef<{
    groupTransform: DirectorTransform;
    objects: DirectorObject[];
  } | null>(null);
  const updateObjectTransforms = useDirectorStore((state) => state.updateObjectTransforms);
  const groupTransform = useMemo(() => getMultiObjectGroupTransform(objects), [objects]);

  useLayoutEffect(() => {
    const group = groupRef.current;
    if (!group || draggingRef.current || typeof group.position?.set !== "function") return;
    group.position.set(...groupTransform.position);
    group.rotation.set(...groupTransform.rotation);
    group.scale.set(...groupTransform.scale);
    group.updateMatrixWorld(true);
  }, [groupTransform]);

  const handleTransformStart = useCallback(() => {
    const group = groupRef.current;
    if (!group) return;
    draggingRef.current = true;
    dragSnapshotRef.current = {
      groupTransform: getObjectTransformFromCenteredControl(group, [0, 0, 0]),
      objects: objects.map((object) => ({
        ...object,
        transform: {
          position: [...object.transform.position],
          rotation: [...object.transform.rotation],
          scale: [...object.transform.scale],
        },
      })),
    };
  }, [objects]);

  const handleObjectChange = useCallback(() => {
    const group = groupRef.current;
    const snapshot = dragSnapshotRef.current;
    if (!group || !snapshot) return;
    updateObjectTransforms(
      getMultiObjectTransformUpdates(
        snapshot.objects,
        snapshot.groupTransform,
        getObjectTransformFromCenteredControl(group, [0, 0, 0]),
      ),
    );
  }, [updateObjectTransforms]);

  const handleTransformEnd = useCallback(() => {
    draggingRef.current = false;
    dragSnapshotRef.current = null;
    const group = groupRef.current;
    if (!group) return;
    group.rotation.set(0, 0, 0);
    group.scale.set(1, 1, 1);
    group.updateMatrixWorld(true);
  }, []);

  return (
    <>
      <group ref={groupRef} name="director-multi-object-transform-pivot" />
      <ViewportTransformControls
        mode={transformMode}
        object={groupRef}
        onObjectChange={handleObjectChange}
        onTransformEnd={handleTransformEnd}
        onTransformStart={handleTransformStart}
        translationSnap={transformMode === "translate" ? translationSnap : null}
      />
    </>
  );
}

export function getViewportCameraFrustumLines(
  _camera?: DirectorCameraShot,
): Array<[[number, number, number], [number, number, number]]> {
  const frameDepth = VIEWPORT_CAMERA_FRUSTUM_DEPTH;
  const halfWidth = VIEWPORT_CAMERA_FRUSTUM_FRAME_WIDTH / 2;
  const halfHeight = VIEWPORT_CAMERA_FRUSTUM_FRAME_WIDTH / VIEWPORT_CAMERA_ASPECT / 2;
  const topLeft: [number, number, number] = [-halfWidth, halfHeight, frameDepth];
  const topRight: [number, number, number] = [halfWidth, halfHeight, frameDepth];
  const bottomRight: [number, number, number] = [halfWidth, -halfHeight, frameDepth];
  const bottomLeft: [number, number, number] = [-halfWidth, -halfHeight, frameDepth];

  return [
    [VIEWPORT_CAMERA_TRANSFORM_CENTER, topLeft],
    [VIEWPORT_CAMERA_TRANSFORM_CENTER, topRight],
    [VIEWPORT_CAMERA_TRANSFORM_CENTER, bottomRight],
    [VIEWPORT_CAMERA_TRANSFORM_CENTER, bottomLeft],
    [topLeft, topRight],
    [topRight, bottomRight],
    [bottomRight, bottomLeft],
    [bottomLeft, topLeft],
  ];
}

function appendWireframeSegments(target: CameraWirePoint[], points: CameraWirePointLine) {
  for (let index = 1; index < points.length; index += 1) {
    target.push(points[index - 1]!, points[index]!);
  }
}

/**
 * Drei's segmented line keeps the exact helper silhouette while issuing one
 * draw call per camera instead of one draw call for every body edge, reel,
 * lens edge, and frustum ray.
 */
export function getViewportCameraWireframeSegments(_camera?: DirectorCameraShot) {
  const segments: CameraWirePoint[] = [];
  getViewportCameraBodyWireframeLines().forEach((line) => appendWireframeSegments(segments, line.points));
  getViewportCameraFrustumLines(_camera).forEach((line) => appendWireframeSegments(segments, line));
  return segments;
}

const ViewportCameraRig = memo(function ViewportCameraRig({
  camera,
  sourceCamera,
  currentFrame,
  object,
  selected,
  showLabel,
  transformMode,
  transformable,
  translationSnap,
}: {
  /** The evaluated pose shown in the viewport at `currentFrame`. */
  camera: DirectorCameraShot;
  /** The authored shot, retained so a drag can update its active keyframe. */
  sourceCamera: DirectorCameraShot;
  currentFrame: number;
  object?: DirectorObject;
  selected: boolean;
  showLabel: boolean;
  transformMode: TransformMode;
  transformable: boolean;
  translationSnap: number | null;
}) {
  const groupRef = useRef<Group>(null!);
  const selectObject = useDirectorStore((state) => state.selectObject);
  const updateCamera = useDirectorStore((state) => state.updateCamera);
  const setCameraAnimation = useDirectorStore((state) => state.setCameraAnimation);
  const wireframeSegments = useMemo(() => getViewportCameraWireframeSegments(), []);
  const cameraHitArea = useMemo(() => getViewportCameraHitArea(), []);
  const cameraLabelY = useMemo(() => getViewportCameraLabelY(), []);
  const cameraQuaternion = useMemo(
    () => getViewportCameraQuaternion(camera.transform.position, camera.target),
    [camera.target, camera.transform.position],
  );

  useLayoutEffect(() => {
    groupRef.current?.quaternion?.copy?.(cameraQuaternion);
  }, [cameraQuaternion]);

  function commitCameraTransformFromViewport() {
    const group = groupRef.current;
    if (!group) return;

    const position: [number, number, number] = [group.position.x, group.position.y, group.position.z];
    const forward = VIEWPORT_CAMERA_VISUAL_FORWARD.clone().applyQuaternion(group.quaternion).normalize();
    const currentDistance = new Vector3(...camera.target).distanceTo(group.position);
    const nextTarget = group.position.clone().add(forward.multiplyScalar(Math.max(currentDistance, 0.1)));

    const transform = {
      position,
      rotation: [group.rotation.x, group.rotation.y, group.rotation.z] as [number, number, number],
      scale: [group.scale.x, group.scale.y, group.scale.z] as [number, number, number],
    };
    const target: [number, number, number] = [nextTarget.x, nextTarget.y, nextTarget.z];
    const animation = sourceCamera.animation;

    if (animation?.enabled !== false && animation?.keyframes.length) {
      // An animated camera represents the pose at the playhead, not its static
      // base transform. Persist this drag into that authored frame so the rig
      // stays exactly where it was dropped instead of snapping back on render.
      const frame = getDirectorCameraAnimationFrame(sourceCamera, currentFrame);
      const existingKeyframe = animation.keyframes.find((keyframe) => keyframe.frame === frame);
      setCameraAnimation(camera.id, {
        ...animation,
        keyframes: [
          ...animation.keyframes.filter((keyframe) => keyframe.frame !== frame),
          {
            ...existingKeyframe,
            frame,
            interpolation: existingKeyframe?.interpolation ?? "smooth",
            transform,
            lookTarget: target,
            fov: camera.fov,
          },
        ].sort((left, right) => left.frame - right.frame),
      });
      return;
    }

    updateCamera(camera.id, { transform, target });
  }

  function selectCameraFromViewport(event: ThreeEvent<MouseEvent>) {
    event.stopPropagation();
    selectObject(object?.id ?? null);
  }

  const node = (
    <group
      ref={groupRef}
      position={camera.transform.position}
      quaternion={cameraQuaternion}
      scale={camera.transform.scale}
      userData={{ [HIDE_FROM_VIEWPORT_CAPTURE_KEY]: true }}
      onClick={selectCameraFromViewport}
    >
      {showLabel ? <ViewportObjectLabel position={[0, cameraLabelY, 0]}>{camera.name}</ViewportObjectLabel> : null}

      <mesh name={`${camera.id}-hit-area`} onClick={selectCameraFromViewport} position={cameraHitArea.position}>
        <boxGeometry args={cameraHitArea.args} />
        <meshBasicMaterial visible={false} />
      </mesh>

      <Line
        color={VIEWPORT_CAMERA_LINE}
        lineWidth={1}
        name={`${camera.id}-wireframe`}
        onClick={selectCameraFromViewport}
        opacity={VIEWPORT_CAMERA_LINE_OPACITY}
        points={wireframeSegments}
        segments
        transparent
      />
    </group>
  );

  if (!selected || !transformable) return node;

  return (
    <>
      {node}
      <ViewportTransformControls
        mode={transformMode}
        object={groupRef}
        onObjectChange={commitCameraTransformFromViewport}
        translationSnap={transformMode === "translate" ? translationSnap : null}
      />
    </>
  );
});

/**
 * Single source of truth for which object a camera's action tracks. The
 * target-index memo and the per-frame camera evaluation must agree on this,
 * otherwise a camera could reference an object the index never collected.
 */
function getCameraActionTargetObjectId(camera: DirectorCameraShot): string | null {
  if (camera.action?.mode === "follow") return camera.action.follow?.targetObjectId ?? null;
  if (camera.action?.mode === "path" && camera.action.path?.lockTarget) {
    return camera.action.path.targetObjectId ?? null;
  }
  return null;
}

export function SceneRoot({
  children,
  currentFrame,
  interactionEnabled = true,
  isPlaying = false,
  onRootChange,
  showCameraRigs = true,
  showViewportOverlays = true,
  suppressedAnimationObjectId,
  runtimeTransformOwnerId,
}: {
  children?: ReactNode;
  currentFrame?: number;
  interactionEnabled?: boolean;
  isPlaying?: boolean;
  onRootChange?: (root: Group | null) => void;
  /** Camera helpers are hidden while piloting from the active lens. */
  showCameraRigs?: boolean;
  /** Screen-space labels are hidden when one Canvas is rendered through multiple scissor cameras. */
  showViewportOverlays?: boolean;
  /** The active player owns its transform while character exploration is running. */
  suppressedAnimationObjectId?: string;
  /** Keep React from reapplying a stale transform to the runtime-controlled actor. */
  runtimeTransformOwnerId?: string;
} = {}) {
  const sceneRootRef = useRef<Group>(null!);
  const setSceneRootRef = useCallback(
    (root: Group | null) => {
      sceneRootRef.current = root as Group;
      onRootChange?.(root);
    },
    [onRootChange],
  );
  const scene = useDirectorStore((state) => state.project.scene);
  const assets = useDirectorStore((state) => state.project.assets);
  const objects = useDirectorStore((state) => state.project.objects);
  const cameras = useDirectorStore((state) => state.project.cameras);
  const viewMode = useDirectorStore((state) => state.viewMode);
  const selectedObjectId = useDirectorStore((state) => state.selectedObjectId);
  const selectedObjectIds = useDirectorStore((state) => state.selectedObjectIds);
  const selectedCrowdId = useDirectorStore((state) => state.selectedCrowdId);
  const blenderPreviewActive = useBlenderRuntimeStore((state) => state.previewActive);
  const transformMode = useDirectorStore((state) => state.transformMode);
  const selectObject = useDirectorStore((state) => state.selectObject);
  const selectCrowd = useDirectorStore((state) => state.selectCrowd);
  const performanceConfig = useResolvedPerformanceConfig();
  const characterLabelBudget = performanceConfig.characterLabelBudget;
  const playbackFrame = currentFrame ?? scene.timeline?.currentFrame ?? 0;
  const stableEvaluatedObjectsRef = useRef<DirectorObject[]>([]);
  const evaluatedObjects = useMemo(() => {
    const frameObjects = objects.map((item) =>
      item.id === suppressedAnimationObjectId
        ? item
        : evaluateDirectorObjectAtFrame(item, playbackFrame, scene.timeline?.fps ?? 24),
    );
    const next = resolveDirectorPhysicalPlacements(frameObjects, scene.groundHeight, scene.showGround);
    // Non-animated objects evaluate back to their original references, so a
    // static scene yields an element-wise identical array on every playback
    // frame. Reusing the previous array reference then lets every downstream
    // [evaluatedObjects] memo skip while the playhead advances.
    const previous = stableEvaluatedObjectsRef.current;
    if (previous.length === next.length && previous.every((item, index) => item === next[index])) {
      return previous;
    }
    stableEvaluatedObjectsRef.current = next;
    return next;
  }, [objects, playbackFrame, scene.groundHeight, scene.showGround, scene.timeline?.fps, suppressedAnimationObjectId]);
  const cameraActionTargets = useMemo(() => {
    // Only the objects actually tracked by a camera action (typically 0-2)
    // need an entry; indexing the whole scene per frame is wasted work.
    const referencedIds = new Set<string>();
    cameras.forEach((camera) => {
      const targetId = getCameraActionTargetObjectId(camera);
      if (targetId) referencedIds.add(targetId);
    });
    return new Map(
      evaluatedObjects
        .filter((item) => referencedIds.has(item.id))
        .map((item) => [item.id, { id: item.id, position: item.transform.position }]),
    );
  }, [cameras, evaluatedObjects]);
  const evaluatedCameras = useMemo(
    () =>
      cameras.map((camera) => {
        const targetId = getCameraActionTargetObjectId(camera);
        return evaluateDirectorCameraAtFrame(
          camera,
          playbackFrame,
          targetId ? cameraActionTargets.get(targetId) : undefined,
        );
      }),
    [cameraActionTargets, cameras, playbackFrame],
  );
  const translationSnap = scene.snapToGrid ? 1 : null;
  const assetsById = useMemo(() => new Map(assets.map((item) => [item.id, item])), [assets]);
  const compositeChildrenByParentId = useMemo(() => {
    const result = new Map<string, DirectorObject[]>();

    objects.forEach((item) => {
      if (!item.parentObjectId) return;
      const primaryAsset = item.assetRefId ? assetsById.get(item.assetRefId) : undefined;
      const hasVisiblePrimaryGeometry =
        isDirectorObjectEffectivelyVisible(scene, item) &&
        (item.kind === "character" || Boolean(item.geometryType) || primaryAsset?.sourceType === "model");
      const hasVisibleReferenceGeometry = (item.referenceBindings ?? []).some(
        (binding) =>
          binding.kind === "asset3d" && binding.showInViewport && assetsById.get(binding.ref)?.sourceType === "model",
      );
      if (!hasVisiblePrimaryGeometry && !hasVisibleReferenceGeometry) return;
      const children = result.get(item.parentObjectId) ?? [];
      children.push(item);
      result.set(item.parentObjectId, children);
    });

    return result;
  }, [assetsById, objects, scene]);
  const visibleReferenceAssetsByObjectId = useMemo(() => {
    const result = new Map<string, DirectorAssetRef[]>();

    objects.forEach((item) => {
      const visibleAssets = (item.referenceBindings ?? [])
        .filter((binding) => binding.kind === "asset3d" && binding.showInViewport)
        .map((binding) => assetsById.get(binding.ref))
        .filter((asset): asset is DirectorAssetRef => Boolean(asset && asset.sourceType === "model"));

      if (visibleAssets.length) result.set(item.id, visibleAssets);
    });

    return result;
  }, [assetsById, objects]);
  const visiblePromptReferencesByObjectId = useMemo(() => {
    const result = new Map<
      string,
      Array<{
        id: string;
        label: string;
        text: string;
        style: PromptReferenceVisualStyle;
      }>
    >();

    objects.forEach((item) => {
      const visiblePrompts = (item.referenceBindings ?? [])
        .filter((binding) => binding.kind === "prompt" && binding.showInViewport && binding.ref.trim())
        .map((binding) => ({
          id: binding.id,
          label: binding.label,
          text: binding.ref,
          style: getPromptReferenceVisualStyle(binding.promptVisual),
        }));

      if (visiblePrompts.length) result.set(item.id, visiblePrompts);
    });

    return result;
  }, [objects]);
  const cameraObjectsByCameraId = useMemo(() => {
    return new Map(
      objects
        .filter((item) => item.kind === "camera" && item.linkedCameraId)
        .map((item) => [item.linkedCameraId as string, item]),
    );
  }, [objects]);
  const crowdLocksById = useMemo(() => {
    const result = new Map<string, boolean>();
    const crowdMembers = objects.filter((item) => item.kind === "character" && item.crowdId);

    crowdMembers.forEach((item) => {
      const crowdId = item.crowdId as string;
      result.set(crowdId, (result.get(crowdId) ?? false) || isDirectorObjectEffectivelyLocked(scene, item));
    });

    return result;
  }, [objects, scene]);
  const animatedCrowdIds = useMemo(
    () =>
      new Set(
        objects
          .filter((item) => item.crowdId && item.animation?.enabled !== false && item.animation?.keyframes.length)
          .map((item) => item.crowdId as string),
      ),
    [objects],
  );
  const hasMultiObjectSelection = !selectedCrowdId && selectedObjectIds.length > 1;
  const multiSelectedObjects = useMemo(() => {
    if (!hasMultiObjectSelection) return [];
    const selectedIds = new Set(selectedObjectIds);

    return evaluatedObjects.filter((item) => {
      if (!selectedIds.has(item.id) || !isDirectorObjectEffectivelyVisible(scene, item)) return false;
      if (item.parentObjectId && selectedIds.has(item.parentObjectId)) return false;
      if (isDirectorObjectEffectivelyLocked(scene, item)) return false;
      if (item.animation?.enabled !== false && item.animation?.keyframes.length) return false;
      if (item.kind !== "camera" || !item.linkedCameraId) return true;
      const camera = cameras.find((candidate) => candidate.id === item.linkedCameraId);
      return !(camera?.animation?.enabled !== false && camera?.animation?.keyframes.length);
    });
  }, [cameras, evaluatedObjects, hasMultiObjectSelection, scene, selectedObjectIds]);

  const viewportCamera = useThree((state) => state.camera);
  /**
   * Scene-space object position promoted through the live scene-root matrix,
   * measured against the render camera. Reads mutable three state on purpose:
   * the value only steers quality budgets, never document data, so a
   * one-frame-stale matrix is harmless. null (no camera/root yet) always
   * resolves to full quality.
   */
  const measureCameraDistanceM = useCallback(
    (item: DirectorObject) => {
      const root = sceneRootRef.current;
      if (!viewportCamera || !root) return null;
      characterLodWorldPosition
        .set(item.transform.position[0], item.transform.position[1], item.transform.position[2])
        .applyMatrix4(root.matrixWorld);
      return characterLodWorldPosition.distanceTo(viewportCamera.position);
    },
    [viewportCamera],
  );
  /**
   * getTimelineCharacterMotionBlock builds a fresh object per call, which
   * would defeat the ObjectSceneNode memo on every playback frame. Reusing
   * the previous result while its inputs are unchanged gives far characters a
   * stable motion identity across their whole LOD stride window.
   */
  const timelineMotionCacheRef = useRef(
    new Map<
      string,
      {
        animation: DirectorObject["animation"];
        fps: number;
        frame: number;
        motion: DirectorCharacterMotionState | null;
      }
    >(),
  );
  const characterLabelBudgetIds = useMemo(() => {
    if (!showViewportOverlays || !scene.showLabels) return null;
    if (characterLabelBudget === null) return null;
    const candidates = evaluatedObjects.filter(
      (item) => item.kind === "character" && isDirectorObjectEffectivelyVisible(scene, item),
    );
    if (candidates.length <= characterLabelBudget) return null;
    const alwaysLabeledIds = new Set(selectedObjectIds);
    if (selectedObjectId) alwaysLabeledIds.add(selectedObjectId);
    if (selectedCrowdId) {
      for (const item of candidates) {
        if (item.crowdId === selectedCrowdId) alwaysLabeledIds.add(item.id);
      }
    }
    return selectDirectorViewportLabelIds(
      candidates.map((item) => ({ id: item.id, distanceM: measureCameraDistanceM(item) })),
      alwaysLabeledIds,
      characterLabelBudget,
    );
  }, [
    characterLabelBudget,
    evaluatedObjects,
    measureCameraDistanceM,
    scene,
    selectedCrowdId,
    selectedObjectId,
    selectedObjectIds,
    showViewportOverlays,
  ]);

  const renderableObjects = useMemo(
    () =>
      evaluatedObjects
        .filter((item) => item.kind !== "camera")
        .filter((item) => {
          if (!item.nativeSource || item.nativeSource.provisioned === false) return true;
          // Mixamo (and other packaged character GLBs) keep their real materials.
          // The Blender preview mesh is an unskinned snapshot and often renders black.
          if (item.kind === "character" && item.assetRefId) return true;
          return !blenderPreviewActive && Boolean(item.assetRefId);
        })
        .filter((item) => {
          const layerVisible = getDirectorObjectLayerState(scene, item).visible;
          return (
            layerVisible &&
            (item.visible ||
              (visibleReferenceAssetsByObjectId.get(item.id)?.length ?? 0) > 0 ||
              (visiblePromptReferencesByObjectId.get(item.id)?.length ?? 0) > 0)
          );
        }),
    [
      evaluatedObjects,
      scene,
      visiblePromptReferencesByObjectId,
      visibleReferenceAssetsByObjectId,
      blenderPreviewActive,
    ],
  );
  const primitiveBatchExcludedIds = useMemo(() => {
    const result = new Set(selectedObjectIds);
    if (selectedObjectId) result.add(selectedObjectId);
    if (suppressedAnimationObjectId) result.add(suppressedAnimationObjectId);
    if (runtimeTransformOwnerId) result.add(runtimeTransformOwnerId);
    return result;
  }, [runtimeTransformOwnerId, selectedObjectId, selectedObjectIds, suppressedAnimationObjectId]);
  const staticPrimitiveBatchPartition = useMemo(
    () => createDirectorStaticPrimitiveBatchPartition(renderableObjects, primitiveBatchExcludedIds, true),
    [primitiveBatchExcludedIds, renderableObjects],
  );

  const handleObjectSelect = useCallback(
    (item: DirectorObject) => {
      if (!interactionEnabled) return;
      // The viewport behaves like Blender's object mode: clicking a visible
      // modeled part selects its composition parent. A child becomes directly
      // transformable only after it is deliberately selected from the outliner.
      if (item.parentObjectId) {
        const compositeParent = objects.find(
          (candidate) => candidate.id === item.parentObjectId && candidate.isCompositeParent,
        );
        if (compositeParent) {
          selectObject(compositeParent.id);
          return;
        }
      }
      if (item.kind === "character" && item.crowdId) {
        selectCrowd(item.crowdId);
        return;
      }

      selectObject(item.id);
    },
    [interactionEnabled, objects, selectCrowd, selectObject],
  );

  return (
    <group
      ref={setSceneRootRef}
      position={scene.position}
      rotation={scene.rotation}
      scale={[scene.scale, scene.scale, scene.scale]}
    >
      <ViewportLabelLayout />
      {children}
      <ArdyMotionPreviewLayer />
      <LivingWorldLayer
        evaluatedObjects={evaluatedObjects}
        fps={scene.timeline?.fps ?? 24}
        frame={playbackFrame}
        isPlaying={isPlaying}
      />
      <TrajectoryViewportOverlay groundHeight={scene.groundHeight} />
      {showViewportOverlays ? <DirectorSceneOverlays objects={evaluatedObjects} /> : null}
      <StaticPrimitiveBatches batches={staticPrimitiveBatchPartition.batches} onSelect={handleObjectSelect} />
      {renderableObjects
        .filter((item) => !staticPrimitiveBatchPartition.batchedObjectIds.has(item.id))
        .map((item) => {
          const asset = item.assetRefId ? assetsById.get(item.assetRefId) : undefined;
          const referenceAssets = visibleReferenceAssetsByObjectId.get(item.id) ?? EMPTY_REFERENCE_ASSETS;
          const promptReferences = visiblePromptReferencesByObjectId.get(item.id) ?? EMPTY_PROMPT_REFERENCES;
          const timelineFps = scene.timeline?.fps ?? 24;
          // Distance LOD only coarsens live playback: paused scrubbing and
          // deterministic frame captures keep exact sampling, and the active
          // player plus the current selection always pose at full rate. The
          // object transform itself still interpolates every frame, so far
          // characters keep moving smoothly while re-posing on the stride.
          const lodExempt =
            !isPlaying ||
            item.kind !== "character" ||
            item.id === suppressedAnimationObjectId ||
            item.id === runtimeTransformOwnerId ||
            item.id === selectedObjectId ||
            selectedObjectIds.includes(item.id) ||
            (item.crowdId != null && item.crowdId === selectedCrowdId);
          const frameStride = lodExempt
            ? 1
            : getDirectorCharacterFrameStrideForMode(
                measureCameraDistanceM(item),
                performanceConfig.characterAnimationSampling,
              );
          const characterFrame = quantizeDirectorCharacterPlaybackFrame(playbackFrame, frameStride);
          const timelineMotionCache = timelineMotionCacheRef.current;
          const cachedMotion = timelineMotionCache.get(item.id);
          let timelineMotion: DirectorCharacterMotionState | null;
          if (
            cachedMotion &&
            cachedMotion.animation === item.animation &&
            cachedMotion.frame === characterFrame &&
            cachedMotion.fps === timelineFps
          ) {
            timelineMotion = cachedMotion.motion;
          } else {
            timelineMotion =
              getTimelineCharacterMotionBlock(item.animation, characterFrame, timelineFps) ??
              (isTrajectoryLocomotionActive(item.animation, characterFrame)
                ? getTimelineCharacterMotion(item.animation)
                : null);
            // Entries are tiny; the cap only guards very long sessions that
            // churn through thousands of distinct object ids.
            if (timelineMotionCache.size > 4_096) timelineMotionCache.clear();
            timelineMotionCache.set(item.id, {
              animation: item.animation,
              fps: timelineFps,
              frame: characterFrame,
              motion: timelineMotion,
            });
          }
          const skeletalPlaybackFrame =
            item.kind === "character" && (item.characterRig?.motion?.enabled || Boolean(timelineMotion))
              ? characterFrame
              : 0;

          return (
            <ObjectSceneNode
              key={item.id}
              asset={asset}
              assets={assets}
              currentFrame={skeletalPlaybackFrame}
              timelineMotion={timelineMotion}
              fps={scene.timeline?.fps ?? 24}
              compositeChildren={compositeChildrenByParentId.get(item.id)}
              item={item}
              referenceAssets={referenceAssets}
              promptReferences={promptReferences}
              selected={!hasMultiObjectSelection && !item.crowdId && item.id === selectedObjectId}
              showLabels={
                showViewportOverlays &&
                scene.showLabels &&
                (item.kind !== "character" || characterLabelBudgetIds === null || characterLabelBudgetIds.has(item.id))
              }
              showPrimary={item.visible}
              runtimeControlled={item.id === runtimeTransformOwnerId}
              sceneRootRef={sceneRootRef}
              transformMode={transformMode}
              // Animation playback evaluates a derived transform. Editing that
              // derived object would write the static base transform and appear
              // to snap back on the next frame, so animated entities stay
              // selectable/inspectable but their viewport gizmo is disabled.
              transformable={
                interactionEnabled &&
                !isDirectorObjectEffectivelyLocked(scene, item) &&
                !isPlaying &&
                !(item.animation?.enabled !== false && item.animation?.keyframes.length)
              }
              translationSnap={translationSnap}
              onSelect={handleObjectSelect}
            />
          );
        })}
      {hasMultiObjectSelection && interactionEnabled && !isPlaying && multiSelectedObjects.length ? (
        <MultiObjectTransformRig
          objects={multiSelectedObjects}
          transformMode={transformMode}
          translationSnap={translationSnap}
        />
      ) : null}
      {selectedCrowdId ? (
        <CrowdTransformRig
          key={selectedCrowdId}
          crowdId={selectedCrowdId}
          objects={evaluatedObjects}
          sceneRootRef={sceneRootRef}
          selected
          transformMode={transformMode}
          transformable={
            interactionEnabled &&
            !isPlaying &&
            !(crowdLocksById.get(selectedCrowdId) ?? false) &&
            !animatedCrowdIds.has(selectedCrowdId)
          }
          translationSnap={translationSnap}
        />
      ) : null}
      {viewMode === "director" && showCameraRigs
        ? evaluatedCameras
            .map((camera) => ({
              camera,
              object: cameraObjectsByCameraId.get(camera.id),
            }))
            .filter(({ object }) => (object ? isDirectorObjectEffectivelyVisible(scene, object) : true))
            .map(({ camera, object }) => {
              const sourceCamera = cameras.find((candidate) => candidate.id === camera.id) ?? camera;
              return (
                <ViewportCameraRig
                  key={camera.id}
                  camera={camera}
                  currentFrame={
                    sourceCamera.animation?.enabled !== false && sourceCamera.animation?.keyframes.length
                      ? playbackFrame
                      : 0
                  }
                  sourceCamera={sourceCamera}
                  object={object}
                  selected={!hasMultiObjectSelection && object?.id === selectedObjectId}
                  showLabel={showViewportOverlays && scene.showLabels}
                  transformMode={transformMode}
                  transformable={Boolean(
                    interactionEnabled && object && !isDirectorObjectEffectivelyLocked(scene, object) && !isPlaying,
                  )}
                  translationSnap={translationSnap}
                />
              );
            })
        : null}
    </group>
  );
}
