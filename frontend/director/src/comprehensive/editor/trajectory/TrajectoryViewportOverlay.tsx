/*
 * Viewport path overlay adaptation from Flier123/agentic-3d-director at
 * a939ec5fd84ae32fcbb3b6b6cb5865216f6d7195.
 * Copyright (c) 2026 YZ. Licensed under the MIT License.
 */

/**
 * @module TrajectoryViewportOverlay
 * @description 3D viewport overlay that renders trajectory paths, editable
 *   keyframe markers, curve handles via TransformControls, and an interactive
 *   drawing plane for freehand path creation.
 */

import { Line, TransformControls } from "@react-three/drei";
import type { ThreeEvent } from "@react-three/fiber";
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import type { Group } from "three";
import type { DirectorEntityAnimation } from "../schema/directorProject";
import { useTimelineRuntimeStore } from "../runtime/timelineRuntimeStore";
import { useRafCoalescedTransformInteraction } from "../runtime/useRafCoalescedTransformInteraction";
import { useDirectorStore } from "../store/directorStore";
import { getDirectorFrameTracks, getDirectorTrackTargetByKey } from "../timeline/frameTimeline";
import {
  createFrameTrajectoryAnimation,
  resampleTrajectoryDrawingPoints,
  sampleTrajectoryPositions,
} from "./trajectoryMath";

const PATH_ELEVATION = 0.025;
const HIDE_FROM_VIEWPORT_CAPTURE_KEY = "hideFromViewportCapture";
const sampledTrajectoryPointCache = new WeakMap<DirectorEntityAnimation, Array<[number, number, number]>>();

function getElevatedTrajectoryPoints(animation: DirectorEntityAnimation) {
  const cached = sampledTrajectoryPointCache.get(animation);
  if (cached) return cached;
  const points = sampleTrajectoryPositions(animation).map((point): [number, number, number] => [
    point[0],
    point[1] + PATH_ELEVATION,
    point[2],
  ]);
  sampledTrajectoryPointCache.set(animation, points);
  return points;
}

function PathMarker({
  color,
  position,
  selected,
  onClick,
}: {
  color: string;
  position: [number, number, number];
  selected: boolean;
  onClick?: (event: ThreeEvent<MouseEvent>) => void;
}) {
  return (
    <mesh
      onClick={onClick}
      position={[position[0], position[1] + PATH_ELEVATION, position[2]]}
      userData={{ [HIDE_FROM_VIEWPORT_CAPTURE_KEY]: true }}
    >
      <sphereGeometry args={[selected ? 0.075 : 0.052, 16, 12]} />
      <meshBasicMaterial color={color} depthTest={false} transparent opacity={selected ? 1 : 0.72} />
    </mesh>
  );
}

function EditablePathMarker({
  color,
  position,
  onPositionChange,
}: {
  color: string;
  position: [number, number, number];
  onPositionChange: (position: [number, number, number]) => void;
}) {
  const groupRef = useRef<Group>(null!);
  const commitPositionFromViewport = useCallback(() => {
    const group = groupRef.current;
    if (!group) return;
    onPositionChange([group.position.x, group.position.y - PATH_ELEVATION, group.position.z]);
  }, [onPositionChange]);
  const transformInteraction = useRafCoalescedTransformInteraction(commitPositionFromViewport);

  return (
    <>
      <group
        ref={groupRef}
        position={[position[0], position[1] + PATH_ELEVATION, position[2]]}
        userData={{ [HIDE_FROM_VIEWPORT_CAPTURE_KEY]: true }}
      >
        <mesh>
          <sphereGeometry args={[0.09, 16, 12]} />
          <meshBasicMaterial color={color} depthTest={false} transparent opacity={1} />
        </mesh>
      </group>
      <TransformControls
        mode="translate"
        object={groupRef}
        onMouseDown={transformInteraction.onMouseDown}
        onMouseUp={transformInteraction.onMouseUp}
        onObjectChange={transformInteraction.onObjectChange}
        userData={{ [HIDE_FROM_VIEWPORT_CAPTURE_KEY]: true }}
      />
    </>
  );
}

function EditableCurveHandle({
  anchor,
  direction,
  offset,
  onOffsetChange,
}: {
  anchor: [number, number, number];
  direction: "in" | "out";
  offset: [number, number, number];
  onOffsetChange: (offset: [number, number, number]) => void;
}) {
  const groupRef = useRef<Group>(null!);
  const handlePosition: [number, number, number] = [
    anchor[0] + offset[0],
    anchor[1] + offset[1] + PATH_ELEVATION,
    anchor[2] + offset[2],
  ];
  const commitOffsetFromViewport = useCallback(() => {
    const group = groupRef.current;
    if (!group) return;
    onOffsetChange([
      group.position.x - anchor[0],
      group.position.y - anchor[1] - PATH_ELEVATION,
      group.position.z - anchor[2],
    ]);
  }, [anchor, onOffsetChange]);
  const transformInteraction = useRafCoalescedTransformInteraction(commitOffsetFromViewport);

  return (
    <>
      <Line
        color={direction === "in" ? "#f7bd54" : "#9ee37d"}
        depthTest={false}
        lineWidth={1.5}
        points={[[anchor[0], anchor[1] + PATH_ELEVATION, anchor[2]], handlePosition]}
        transparent
        userData={{ [HIDE_FROM_VIEWPORT_CAPTURE_KEY]: true }}
      />
      <group ref={groupRef} position={handlePosition} userData={{ [HIDE_FROM_VIEWPORT_CAPTURE_KEY]: true }}>
        <mesh>
          <sphereGeometry args={[0.06, 16, 12]} />
          <meshBasicMaterial color={direction === "in" ? "#f7bd54" : "#9ee37d"} depthTest={false} />
        </mesh>
      </group>
      <TransformControls
        mode="translate"
        object={groupRef}
        onMouseDown={transformInteraction.onMouseDown}
        onMouseUp={transformInteraction.onMouseUp}
        onObjectChange={transformInteraction.onObjectChange}
        userData={{ [HIDE_FROM_VIEWPORT_CAPTURE_KEY]: true }}
      />
    </>
  );
}

export const TrajectoryViewportOverlay = memo(function TrajectoryViewportOverlay({
  groundHeight,
}: {
  groundHeight: number;
}) {
  const project = useDirectorStore((state) => state.project);
  const selectObject = useDirectorStore((state) => state.selectObject);
  const setObjectAnimation = useDirectorStore((state) => state.setObjectAnimation);
  const setCameraAnimation = useDirectorStore((state) => state.setCameraAnimation);
  const updateCamera = useDirectorStore((state) => state.updateCamera);
  const selectedTrackKey = useTimelineRuntimeStore((state) => state.selectedTrackKey);
  const selectedKeyframeIndex = useTimelineRuntimeStore((state) => state.selectedKeyframeIndex);
  const drawingTrackKey = useTimelineRuntimeStore((state) => state.drawingTrackKey);
  const drawingPoints = useTimelineRuntimeStore((state) => state.drawingPoints);
  const helpersHidden = useTimelineRuntimeStore((state) => state.helpersHidden);
  const selectTrack = useTimelineRuntimeStore((state) => state.selectTrack);
  const addDrawingPoint = useTimelineRuntimeStore((state) => state.addDrawingPoint);
  const cancelDrawing = useTimelineRuntimeStore((state) => state.cancelDrawing);
  const tracks = useMemo(() => getDirectorFrameTracks(project), [project]);

  const commitAnimation = useCallback(
    (ownerType: "object" | "camera", ownerId: string, animation: DirectorEntityAnimation) => {
      if (ownerType === "camera") setCameraAnimation(ownerId, animation);
      else setObjectAnimation(ownerId, animation);
    },
    [setCameraAnimation, setObjectAnimation],
  );

  const updatePathMarkerPosition = useCallback(
    (
      track: ReturnType<typeof getDirectorFrameTracks>[number],
      keyframeIndex: number,
      position: [number, number, number],
    ) => {
      const animation = track.animation;
      const keyframe = animation?.keyframes[keyframeIndex];
      if (!animation || !keyframe?.transform) return;
      const keyframes = animation.keyframes.map((item, index) =>
        index === keyframeIndex ? { ...item, transform: { ...item.transform!, position } } : item,
      );
      commitAnimation(track.ownerType, track.ownerId, { ...animation, keyframes });
    },
    [commitAnimation],
  );

  const updatePathCurveHandle = useCallback(
    (
      track: ReturnType<typeof getDirectorFrameTracks>[number],
      keyframeIndex: number,
      direction: "in" | "out",
      offset: [number, number, number],
    ) => {
      const animation = track.animation;
      const keyframe = animation?.keyframes[keyframeIndex];
      if (!animation || !keyframe?.transform) return;
      const keyframes = animation.keyframes.map((item, index) =>
        index === keyframeIndex ? { ...item, curve: { ...item.curve, [direction]: offset } } : item,
      );
      commitAnimation(track.ownerType, track.ownerId, { ...animation, keyframes });
    },
    [commitAnimation],
  );

  const finishDrawing = useCallback(() => {
    const runtime = useTimelineRuntimeStore.getState();
    const target = getDirectorTrackTargetByKey(project, runtime.drawingTrackKey);
    const timeline = project.scene.timeline;
    if (!target || !timeline || runtime.drawingPoints.length < 2) return;
    const customPoints = resampleTrajectoryDrawingPoints(
      runtime.drawingPoints,
      timeline.frameEnd - timeline.frameStart + 1,
    );
    const divisor = Math.max(1, customPoints.length - 1);
    const animation = createFrameTrajectoryAnimation({
      baseTransform: target.baseTransform,
      frameStart: timeline.frameStart,
      frameEnd: timeline.frameEnd,
      preset: "custom",
      existingAnimation: target.animation,
      cameraTarget: target.cameraTarget,
      cameraFov: target.cameraFov,
      orientToPath: target.kind !== "camera",
      motion: target.kind === "character" ? "walk" : "none",
      source: "manual",
      color: target.color,
      waypoints: customPoints.map((position, index) => ({
        frame: timeline.frameStart + Math.round(((timeline.frameEnd - timeline.frameStart) * index) / divisor),
        position,
      })),
    });
    commitAnimation(target.ownerType, target.ownerId, animation);
    if (target.ownerType === "camera") {
      const camera = project.cameras.find((item) => item.id === target.ownerId);
      updateCamera(target.ownerId, {
        action: {
          mode: "path",
          path: {
            speed: camera?.action?.path?.speed ?? 1,
            lockTarget: camera?.action?.path?.lockTarget ?? false,
            targetObjectId: camera?.action?.path?.targetObjectId ?? null,
          },
        },
      });
    }
    useTimelineRuntimeStore.setState({
      drawingTrackKey: null,
      drawingPoints: [],
      selectedTrackKey: target.key,
      selectedKeyframeIndex: 0,
    });
  }, [commitAnimation, project, updateCamera]);

  useEffect(() => {
    if (!drawingTrackKey) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") cancelDrawing();
      if (event.key === "Enter") finishDrawing();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [cancelDrawing, drawingTrackKey, finishDrawing]);

  if (helpersHidden) return null;

  function addPoint(event: ThreeEvent<PointerEvent>) {
    if (!drawingTrackKey) return;
    event.stopPropagation();
    addDrawingPoint([event.point.x, event.point.y, event.point.z]);
  }

  return (
    <group name="frame-trajectory-overlay" userData={{ [HIDE_FROM_VIEWPORT_CAPTURE_KEY]: true }}>
      {tracks.map((track) => {
        const animation = track.animation;
        if (!animation || animation.enabled === false || !animation.preset) return null;
        const selected = track.key === selectedTrackKey;
        const points = getElevatedTrajectoryPoints(animation);
        return (
          <group key={track.key} name={`frame-path-${track.key}`}>
            {points.length >= 2 ? (
              <Line
                color={track.color}
                depthTest={false}
                lineWidth={selected ? 3 : 1.5}
                onClick={(event) => {
                  event.stopPropagation();
                  selectObject(track.objectId);
                  selectTrack(track.key);
                }}
                opacity={selected ? 0.96 : 0.42}
                points={points}
                transparent
                userData={{ [HIDE_FROM_VIEWPORT_CAPTURE_KEY]: true }}
              />
            ) : null}
            {selected
              ? animation.keyframes.map((keyframe, keyframeIndex) => {
                  if (!keyframe.transform) return null;
                  if (keyframeIndex === selectedKeyframeIndex) {
                    return (
                      <group key={`${keyframe.frame}-${keyframeIndex}`}>
                        <EditablePathMarker
                          color={track.color}
                          position={keyframe.transform.position}
                          onPositionChange={(position) => updatePathMarkerPosition(track, keyframeIndex, position)}
                        />
                        {keyframeIndex > 0 ? (
                          <EditableCurveHandle
                            anchor={keyframe.transform.position}
                            direction="in"
                            offset={keyframe.curve?.in ?? [0, 0, 0]}
                            onOffsetChange={(offset) => updatePathCurveHandle(track, keyframeIndex, "in", offset)}
                          />
                        ) : null}
                        {keyframeIndex < animation.keyframes.length - 1 ? (
                          <EditableCurveHandle
                            anchor={keyframe.transform.position}
                            direction="out"
                            offset={keyframe.curve?.out ?? [0, 0, 0]}
                            onOffsetChange={(offset) => updatePathCurveHandle(track, keyframeIndex, "out", offset)}
                          />
                        ) : null}
                      </group>
                    );
                  }
                  return (
                    <PathMarker
                      key={`${keyframe.frame}-${keyframeIndex}`}
                      color={track.color}
                      position={keyframe.transform.position}
                      selected={false}
                      onClick={(event) => {
                        event.stopPropagation();
                        selectTrack(track.key, keyframeIndex);
                      }}
                    />
                  );
                })
              : null}
          </group>
        );
      })}

      {drawingTrackKey ? (
        <>
          {drawingPoints.length >= 2 ? (
            <Line
              color="#21d4f5"
              depthTest={false}
              lineWidth={3}
              opacity={0.95}
              points={drawingPoints.map((point) => [point[0], point[1] + PATH_ELEVATION, point[2]])}
              transparent
              userData={{ [HIDE_FROM_VIEWPORT_CAPTURE_KEY]: true }}
            />
          ) : null}
          {drawingPoints.map((point, index) => (
            <PathMarker key={`draft-${index}`} color="#21d4f5" position={point} selected />
          ))}
          <mesh
            name="trajectory-drawing-plane"
            onDoubleClick={(event) => {
              event.stopPropagation();
              finishDrawing();
            }}
            onPointerDown={addPoint}
            position={[0, groundHeight + PATH_ELEVATION, 0]}
            rotation={[-Math.PI / 2, 0, 0]}
            userData={{ [HIDE_FROM_VIEWPORT_CAPTURE_KEY]: true }}
          >
            <planeGeometry args={[400, 400]} />
            <meshBasicMaterial color="#000000" depthWrite={false} opacity={0} transparent />
          </mesh>
        </>
      ) : null}
    </group>
  );
});
