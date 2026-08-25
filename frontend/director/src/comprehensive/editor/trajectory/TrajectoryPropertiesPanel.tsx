/*
 * Trajectory inspector adaptation from Flier123/agentic-3d-director at
 * a939ec5fd84ae32fcbb3b6b6cb5865216f6d7195.
 * Copyright (c) 2026 YZ. Licensed under the MIT License.
 */

/**
 * @module TrajectoryPropertiesPanel
 * @description Inspector panel for editing trajectory animation properties:
 *   path presets, keyframe transforms, timing curves, spatial curve handles,
 *   and camera path actions.
 */

import { Route, Trash2 } from "lucide-react";
import { replaceTupleAxis as replaceAxis } from "../../../../../../packages/protocol/src/primitives";
import type {
  DirectorAnimationKeyframe,
  DirectorAnimationTimingCurve,
  DirectorEntityAnimation,
  DirectorTrajectoryMotion,
  DirectorTrajectoryPreset,
} from "../schema/directorProject";
import { DIRECTOR_TRAJECTORY_PRESETS } from "../schema/directorProject";
import { useTimelineRuntimeStore } from "../runtime/timelineRuntimeStore";
import { useDirectorStore } from "../store/directorStore";
import { getDirectorFrameTrackByKey, removeTransformTrack, updateAnimationKeyframe } from "../timeline/frameTimeline";
import { createFrameTrajectoryAnimation, getTrajectoryFrameBounds } from "./trajectoryMath";
import { isCameraFocusableObject } from "../schema/cameraTarget";
import { TimingCurveEditor } from "../timeline/TimingCurveEditor";
import {
  InspectorAxisGroup,
  InspectorColorField,
  InspectorPanel,
  InspectorSection,
  InspectorSelectField,
  InspectorTextField,
} from "../panels/InspectorControls";

const AXES = ["X", "Y", "Z"] as const;
const LINEAR_TIMING_FALLBACK: DirectorAnimationTimingCurve = { x1: 0, y1: 0, x2: 1, y2: 1 };
const SMOOTH_TIMING_FALLBACK: DirectorAnimationTimingCurve = { x1: 1 / 3, y1: 0, x2: 2 / 3, y2: 1 };
const TRAJECTORY_SOURCE_LABELS: Record<string, string> = {
  manual: "手动绘制",
  preset: "预设生成",
  assistant: "Agent",
  mcp: "MCP",
};

export function TrajectoryPropertiesPanel() {
  const project = useDirectorStore((state) => state.project);
  const setObjectAnimation = useDirectorStore((state) => state.setObjectAnimation);
  const setCameraAnimation = useDirectorStore((state) => state.setCameraAnimation);
  const updateCamera = useDirectorStore((state) => state.updateCamera);
  const beginUndoBatch = useDirectorStore((state) => state.beginUndoBatch);
  const endUndoBatch = useDirectorStore((state) => state.endUndoBatch);
  const selectedTrackKey = useTimelineRuntimeStore((state) => state.selectedTrackKey);
  const selectedKeyframeIndex = useTimelineRuntimeStore((state) => state.selectedKeyframeIndex);
  const selectTrack = useTimelineRuntimeStore((state) => state.selectTrack);
  const track = getDirectorFrameTrackByKey(project, selectedTrackKey);
  const timeline = project.scene.timeline;
  const animation = track?.animation;
  if (!track || !timeline || !animation) return null;

  const fallbackIndex = animation.keyframes.findIndex((keyframe) => keyframe.transform);
  const keyframeIndex =
    selectedKeyframeIndex !== null && animation.keyframes[selectedKeyframeIndex]
      ? selectedKeyframeIndex
      : Math.max(0, fallbackIndex);
  const keyframe = animation.keyframes[keyframeIndex];
  if (!keyframe) return null;
  const transform = keyframe.transform ?? track.baseTransform;
  const camera = track.kind === "camera" ? project.cameras.find((item) => item.id === track.ownerId) : undefined;
  const pathAction = camera?.action?.mode === "path" ? camera.action.path : undefined;
  const focusableObjects = project.objects.filter(isCameraFocusableObject);
  const pathColor = animation.color ?? track.color;
  const sourceLabel = TRAJECTORY_SOURCE_LABELS[animation.source ?? "manual"] ?? "手动绘制";

  function commitAnimation(nextAnimation: DirectorEntityAnimation | undefined) {
    if (track!.ownerType === "camera") setCameraAnimation(track!.ownerId, nextAnimation);
    else setObjectAnimation(track!.ownerId, nextAnimation);
  }

  function patchAnimation(patch: Partial<DirectorEntityAnimation>) {
    commitAnimation({ ...animation!, ...patch });
  }

  function patchKeyframe(patch: Partial<DirectorAnimationKeyframe>) {
    commitAnimation(
      updateAnimationKeyframe(animation!, keyframeIndex, patch, timeline!.frameStart, timeline!.frameEnd),
    );
  }

  function patchCameraPath(patch: Partial<NonNullable<typeof pathAction>>) {
    if (!camera) return;
    const current = pathAction ?? { speed: 1, lockTarget: false, targetObjectId: null };
    updateCamera(camera.id, { action: { mode: "path", path: { ...current, ...patch } } });
  }

  function changePreset(preset: DirectorTrajectoryPreset) {
    const bounds = getTrajectoryFrameBounds(animation);
    const transformFrames = animation!.keyframes.filter((frame) => frame.transform);
    const nextAnimation = createFrameTrajectoryAnimation({
      baseTransform: track!.baseTransform,
      frameStart: bounds?.firstFrame ?? timeline!.frameStart,
      frameEnd: bounds?.lastFrame ?? timeline!.frameEnd,
      preset,
      existingAnimation: animation,
      cameraTarget: track!.cameraTarget,
      cameraFov: track!.cameraFov,
      waypoints:
        preset === "custom"
          ? transformFrames.map((frame) => ({
              frame: frame.frame,
              position: frame.transform!.position,
              rotation: frame.transform!.rotation,
              scale: frame.transform!.scale,
              lookTarget: frame.lookTarget,
              fov: frame.fov,
              interpolation: frame.interpolation,
              timingCurve: frame.timingCurve,
              curve: frame.curve,
            }))
          : undefined,
      orientToPath: animation!.orientToPath,
      motion: animation!.motion,
      source: "preset",
      color: animation!.color ?? track!.color,
    });
    commitAnimation(nextAnimation);
    selectTrack(track!.key, 0);
  }

  function updateTransformTuple(property: "position" | "rotation" | "scale", axis: 0 | 1 | 2, rawValue: string) {
    const value = Number(rawValue);
    if (!Number.isFinite(value)) return;
    patchKeyframe({
      transform: {
        ...transform,
        [property]: replaceAxis(transform[property], axis, property === "scale" ? Math.max(0.01, value) : value),
      },
    });
  }

  function updateCurveHandle(handle: "in" | "out", axis: 0 | 1 | 2, rawValue: string) {
    const value = Number(rawValue);
    if (!Number.isFinite(value)) return;
    const current = keyframe.curve?.[handle] ?? [0, 0, 0];
    patchKeyframe({
      curve: {
        ...keyframe.curve,
        [handle]: replaceAxis(current, axis, value),
      },
    });
  }

  return (
    <InspectorPanel
      title={track.kind === "camera" ? "机位" : track.kind === "character" ? "角色" : "模型"}
      ariaLabel="运动轨迹右侧属性面板"
      className="trajectory-inspector"
      tabs={[
        { label: "属性", active: false, onClick: () => selectTrack(null) },
        { label: "运动轨迹", active: true, onClick: () => undefined },
      ]}
      footer={
        <div className="trajectory-inspector-footer">
          <button
            className="trajectory-inspector-delete"
            type="button"
            onClick={() => {
              commitAnimation(removeTransformTrack(animation));
              selectTrack(null);
            }}
          >
            <Trash2 aria-hidden="true" size={14} />
            删除整条轨迹
          </button>
          <div className="trajectory-inspector-source">
            <Route aria-hidden="true" size={13} />
            <span>来源：</span>
            <span>{sourceLabel}</span>
          </div>
        </div>
      }
    >
      <InspectorSection collapsible title="路径" description="预设会重算整条路线。自由绘制保留你拖过的点。">
        <div className="inspector-toggle-stack" role="group" aria-label="路径开关">
          <label className="inspector-toggle-row">
            <span>启用轨迹</span>
            <input
              aria-label="启用轨迹"
              checked={animation.enabled !== false}
              type="checkbox"
              onChange={() => patchAnimation({ enabled: animation.enabled === false })}
            />
          </label>
          <label className="inspector-toggle-row">
            <span>沿前进方向转身</span>
            <input
              aria-label="沿轨迹自动朝向"
              checked={Boolean(animation.orientToPath)}
              type="checkbox"
              onChange={() => patchAnimation({ orientToPath: !animation.orientToPath })}
            />
          </label>
        </div>
        <InspectorSelectField
          label="轨迹预设"
          ariaLabel="轨迹预设"
          value={animation.preset ?? "custom"}
          options={DIRECTOR_TRAJECTORY_PRESETS.map((preset) => ({ value: preset.id, label: preset.label }))}
          onChange={(value) => changePreset(value as DirectorTrajectoryPreset)}
        />
        <InspectorColorField
          label="路径颜色"
          colorAriaLabel="路径颜色"
          hexAriaLabel="路径颜色 HEX"
          value={pathColor}
          onColorChange={(value) => patchAnimation({ color: value })}
          onHexChange={(value) => patchAnimation({ color: value })}
        />
        {track.kind === "character" ? (
          <>
            <InspectorSelectField
              label="移动动作"
              ariaLabel="轨迹移动动作"
              value={animation.motion ?? "none"}
              options={[
                { value: "none", label: "仅移动（保持当前姿势）" },
                { value: "slow-walk", label: "慢走（连续步态）" },
                { value: "walk", label: "行走（连续步态）" },
                { value: "jog", label: "慢跑（连续步态）" },
                { value: "sprint", label: "冲刺（连续步态）" },
                { value: "run", label: "跑动（连续步态）" },
              ]}
              onChange={(value) => patchAnimation({ motion: value as DirectorTrajectoryMotion })}
            />
            <InspectorTextField
              label="前进速度"
              ariaLabel="轨迹前进速度"
              max="4"
              min="0.1"
              step="0.1"
              type="number"
              value={animation.speed ?? 1}
              onChange={(value) => {
                const speed = Number(value);
                if (Number.isFinite(speed)) patchAnimation({ speed: Math.min(4, Math.max(0.1, speed)) });
              }}
            />
          </>
        ) : null}
        {track.kind === "camera" && pathAction ? (
          <>
            <InspectorTextField
              label="移动速度"
              ariaLabel="轨迹机位移动速度"
              max="4"
              min="0.1"
              step="0.1"
              type="number"
              value={pathAction.speed}
              onChange={(value) => {
                const speed = Number(value);
                if (Number.isFinite(speed)) patchCameraPath({ speed });
              }}
            />
            <InspectorSelectField
              label="锁定目标"
              ariaLabel="轨迹机位锁定目标"
              value={pathAction.targetObjectId ?? "none"}
              onChange={(value) => patchCameraPath({ targetObjectId: value === "none" ? null : value })}
            >
              <option value="none">不锁定</option>
              {focusableObjects.map((item) => (
                <option data-i18n-user-content key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </InspectorSelectField>
            <div className="inspector-toggle-stack" role="group" aria-label="机位注视开关">
              <label className="inspector-toggle-row">
                <span>移动时保持注视目标</span>
                <input
                  aria-label="轨迹机位保持注视目标"
                  checked={Boolean(pathAction.lockTarget && pathAction.targetObjectId)}
                  disabled={!pathAction.targetObjectId}
                  type="checkbox"
                  onChange={() => patchCameraPath({ lockTarget: !pathAction.lockTarget })}
                />
              </label>
            </div>
          </>
        ) : null}
      </InspectorSection>

      <InspectorSection collapsible title="轨迹关键帧" description="点选编号换点。插值只影响这一帧走到下一帧。">
        <div className="trajectory-keyframe-list" role="list" aria-label="轨迹关键帧">
          {animation.keyframes.map((frame, index) => (
            <button
              aria-current={index === keyframeIndex ? "true" : undefined}
              aria-label={`关键帧 ${index + 1}，第 ${frame.frame} 帧`}
              className={index === keyframeIndex ? "is-active" : ""}
              key={`${frame.frame}-${index}`}
              type="button"
              onClick={() => selectTrack(track.key, index)}
            >
              <span className="trajectory-keyframe-index">{index + 1}</span>
              <span className="trajectory-keyframe-frame">F{frame.frame}</span>
            </button>
          ))}
        </div>
        <InspectorTextField
          label="所在帧"
          ariaLabel="轨迹关键帧帧号"
          min={String(timeline.frameStart)}
          max={String(timeline.frameEnd)}
          step="1"
          type="number"
          value={keyframe.frame}
          onChange={(value) => patchKeyframe({ frame: Number(value) })}
        />
        <InspectorSelectField
          label="插值"
          ariaLabel="轨迹关键帧插值"
          value={keyframe.interpolation ?? "linear"}
          options={[
            { value: "step", label: "保持：停到下一帧" },
            { value: "linear", label: "线性：匀速过去" },
            { value: "smooth", label: "平滑：自动圆角" },
          ]}
          onChange={(value) => patchKeyframe({ interpolation: value as "step" | "linear" | "smooth" })}
        />
      </InspectorSection>

      <InspectorSection
        collapsible
        title="时间缓动"
        description={
          keyframe.interpolation === "step"
            ? "这一段是「保持」，会停在这一帧直到下一帧，所以没有快慢曲线。"
            : "只改快慢，不改路线。左下是这一帧，右上是下一帧。"
        }
      >
        <TimingCurveEditor
          disabled={keyframe.interpolation === "step"}
          fallbackValue={keyframe.interpolation === "smooth" ? SMOOTH_TIMING_FALLBACK : LINEAR_TIMING_FALLBACK}
          value={keyframe.timingCurve}
          onChange={(timingCurve: DirectorAnimationTimingCurve) =>
            patchKeyframe({
              interpolation: keyframe.interpolation === "step" ? "linear" : keyframe.interpolation,
              timingCurve,
            })
          }
          onInteractionStart={beginUndoBatch}
          onInteractionEnd={endUndoBatch}
          onReset={() => patchKeyframe({ timingCurve: undefined })}
        />
      </InspectorSection>

      {keyframe.transform ? (
        <InspectorSection
          collapsible
          title="路径弯折"
          description="空间手柄，单位米。全 0 是折线。跟上面的时间曲线不是一回事。"
        >
          <div className="trajectory-transform-group">
            <InspectorAxisGroup
              label="到达这一帧"
              axes={AXES.map((axis, index) => ({
                axis,
                ariaLabel: `轨迹入点偏移 ${axis}`,
                value: (keyframe.curve?.in ?? [0, 0, 0])[index],
                onChange: (value) => updateCurveHandle("in", index as 0 | 1 | 2, value),
              }))}
            />
            <InspectorAxisGroup
              label="离开这一帧"
              axes={AXES.map((axis, index) => ({
                axis,
                ariaLabel: `轨迹出点偏移 ${axis}`,
                value: (keyframe.curve?.out ?? [0, 0, 0])[index],
                onChange: (value) => updateCurveHandle("out", index as 0 | 1 | 2, value),
              }))}
            />
          </div>
        </InspectorSection>
      ) : null}

      <InspectorSection collapsible title="这一帧的姿态" description="物体在这一关键帧的位置、朝向和大小。">
        <div className="trajectory-transform-group">
          <InspectorAxisGroup
            label="位置"
            axes={AXES.map((axis, index) => ({
              axis,
              ariaLabel: `轨迹关键帧位置 ${axis}`,
              value: transform.position[index],
              onChange: (value) => updateTransformTuple("position", index as 0 | 1 | 2, value),
            }))}
          />
          <InspectorAxisGroup
            label="旋转"
            axes={AXES.map((axis, index) => ({
              axis,
              ariaLabel: `轨迹关键帧旋转 ${axis}`,
              value: transform.rotation[index],
              onChange: (value) => updateTransformTuple("rotation", index as 0 | 1 | 2, value),
            }))}
          />
          <InspectorAxisGroup
            label="缩放"
            axes={AXES.map((axis, index) => ({
              axis,
              ariaLabel: `轨迹关键帧缩放 ${axis}`,
              min: "0.01",
              step: "0.01",
              value: transform.scale[index],
              onChange: (value) => updateTransformTuple("scale", index as 0 | 1 | 2, value),
            }))}
          />
          {track.kind === "camera" ? (
            <InspectorAxisGroup
              label="注视目标"
              axes={AXES.map((axis, index) => ({
                axis,
                ariaLabel: `轨迹机位目标 ${axis}`,
                value: (keyframe.lookTarget ?? track.cameraTarget ?? [0, 0, 0])[index],
                onChange: (value) =>
                  patchKeyframe({
                    lookTarget: replaceAxis(
                      keyframe.lookTarget ?? track.cameraTarget ?? [0, 0, 0],
                      index as 0 | 1 | 2,
                      Number(value),
                    ),
                  }),
              }))}
            />
          ) : null}
        </div>
        {track.kind === "camera" ? (
          <InspectorTextField
            label="FOV"
            ariaLabel="轨迹机位 FOV"
            min="5"
            max="140"
            step="1"
            type="number"
            value={keyframe.fov ?? track.cameraFov ?? 50}
            onChange={(value) => patchKeyframe({ fov: Number(value) })}
          />
        ) : null}
      </InspectorSection>
    </InspectorPanel>
  );
}
