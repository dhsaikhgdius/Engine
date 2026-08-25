/**
 * Scene inspector panel: transform, background, display, atmosphere, clipping, and lighting.
 *
 * @module ScenePanel
 */

import { useEffect, useState } from "react";
import {
  clamp as clampNumber,
  replaceTupleAxis as replaceAxis,
} from "../../../../../../packages/protocol/src/primitives";
import { ImageOff, Plus } from "lucide-react";
import { Trash2 } from "lucide-react";
import {
  InspectorAxisGroup,
  InspectorColorField,
  InspectorPanel,
  InspectorRangeNumberField,
  InspectorSection,
  InspectorSelectField,
  InspectorTextField,
} from "./InspectorControls";
import { useDirectorStore } from "../store/directorStore";
import { SceneWorldSection } from "./SceneWorldSection";
import { DIRECTOR_PREVIZ_PALETTE } from "@director/project-schema";
import {
  DIRECTOR_LIGHT_TYPE_OPTIONS,
  type DirectorClippingPlane,
  type DirectorFogSettings,
  type DirectorLight,
  type DirectorLightType,
} from "../schema/directorProject";

const PANORAMA_RADIUS_MIN = 10;
const PANORAMA_RADIUS_MAX = 300;
const PANORAMA_YAW_MIN = -180;
const PANORAMA_YAW_MAX = 180;
const SCENE_SCALE_MIN = 0.1;
const SCENE_SCALE_MAX = 3;
const GROUND_HEIGHT_MIN = -5;
const GROUND_HEIGHT_MAX = 5;
const EMPTY_DIRECTOR_LIGHTS: DirectorLight[] = [];

function createClippingPlaneId() {
  return `clip-plane-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function useSceneNumberField(value: number, minimum: number, maximum: number, update: (value: number) => void) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = (input: string) => {
    const parsed = Number(input);
    const next = Number.isFinite(parsed) ? clampNumber(parsed, minimum, maximum) : value;
    update(next);
    setDraft(String(next));
  };
  const change = (input: string) => {
    setDraft(input);
    const parsed = Number(input);
    if (input !== "" && Number.isFinite(parsed)) update(parsed);
  };
  return { change, commit, draft };
}

function createFogPatch(current: DirectorFogSettings | undefined, patch: Partial<DirectorFogSettings>) {
  const next = {
    enabled: false,
    mode: "linear" as const,
    color: DIRECTOR_PREVIZ_PALETTE.sky,
    near: 10,
    far: 80,
    density: 0.02,
    ...current,
    ...patch,
  };
  if (next.mode === "linear" && next.far <= next.near) {
    if (patch.near !== undefined) next.far = Math.min(500, next.near + 0.1);
    else next.near = Math.max(0, next.far - 0.1);
  }
  return next;
}

function SceneClippingPlaneConstantField({
  plane,
  onChange,
}: {
  plane: DirectorClippingPlane;
  onChange: (patch: Partial<Omit<DirectorClippingPlane, "id">>) => void;
}) {
  const field = useSceneNumberField(plane.constant, -1_000_000, 1_000_000, (constant) => onChange({ constant }));

  return (
    <InspectorTextField
      label="常量"
      ariaLabel={`${plane.name}平面常量`}
      step="0.1"
      type="number"
      value={field.draft}
      onChange={field.change}
    />
  );
}

function SceneLightEditor({
  light,
  onChange,
}: {
  light: DirectorLight;
  onChange: (patch: Partial<Omit<DirectorLight, "id">>) => void;
}) {
  const hasPosition = light.type !== "ambient";
  const hasTarget = light.type === "directional" || light.type === "spot" || light.type === "rect-area";
  const position = light.position ?? [0, 3, 0];
  const target = light.target ?? [0, 0, 0];

  return (
    <div className="scene-light-editor" aria-label={`${light.name}灯光属性`}>
      <InspectorTextField
        label="名称"
        ariaLabel="灯光名称"
        value={light.name}
        onChange={(name) => onChange({ name })}
      />
      <InspectorSelectField
        label="类型"
        ariaLabel="灯光类型"
        value={light.type}
        options={DIRECTOR_LIGHT_TYPE_OPTIONS.map((option) => ({ value: option.id, label: option.label }))}
        onChange={(value) => onChange({ type: value as DirectorLightType })}
      />
      <InspectorColorField
        label="颜色"
        colorAriaLabel="灯光颜色"
        hexAriaLabel="灯光颜色 HEX"
        value={light.color}
        onColorChange={(color) => onChange({ color })}
        onHexChange={(color) => onChange({ color })}
      />
      {light.type === "hemisphere" ? (
        <InspectorColorField
          label="地面颜色"
          colorAriaLabel="半球光地面颜色"
          hexAriaLabel="半球光地面颜色 HEX"
          value={light.groundColor ?? "#303744"}
          onColorChange={(groundColor) => onChange({ groundColor })}
          onHexChange={(groundColor) => onChange({ groundColor })}
        />
      ) : null}
      <InspectorRangeNumberField
        label="强度"
        rangeAriaLabel="灯光强度滑杆"
        numberAriaLabel="灯光强度"
        max="20"
        min="0"
        step="0.01"
        value={light.intensity}
        onValueChange={(value) => onChange({ intensity: Number(value) })}
      />
      <div className="inspector-toggle-stack" role="group" aria-label="灯光开关">
        <label className="inspector-toggle-row">
          <span>可见</span>
          <input
            aria-label="灯光可见"
            checked={light.visible}
            type="checkbox"
            onChange={(event) => onChange({ visible: event.currentTarget.checked })}
          />
        </label>
        <label className="inspector-toggle-row">
          <span>锁定</span>
          <input
            aria-label="锁定灯光"
            checked={light.locked}
            type="checkbox"
            onChange={(event) => onChange({ locked: event.currentTarget.checked })}
          />
        </label>
        {light.type === "directional" || light.type === "point" || light.type === "spot" ? (
          <label className="inspector-toggle-row">
            <span>投射阴影</span>
            <input
              aria-label="灯光投射阴影"
              checked={light.castShadow ?? true}
              type="checkbox"
              onChange={(event) => onChange({ castShadow: event.currentTarget.checked })}
            />
          </label>
        ) : null}
      </div>
      {hasPosition ? (
        <InspectorAxisGroup
          label="位置"
          axes={(["X", "Y", "Z"] as const).map((axis, index) => ({
            axis,
            ariaLabel: `灯光位置 ${axis}`,
            step: "0.1",
            value: position[index],
            onChange: (value: string) =>
              onChange({ position: replaceAxis(position, index as 0 | 1 | 2, Number(value)) }),
          }))}
        />
      ) : null}
      {hasTarget ? (
        <InspectorAxisGroup
          label="目标"
          axes={(["X", "Y", "Z"] as const).map((axis, index) => ({
            axis,
            ariaLabel: `灯光目标 ${axis}`,
            step: "0.1",
            value: target[index],
            onChange: (value: string) => onChange({ target: replaceAxis(target, index as 0 | 1 | 2, Number(value)) }),
          }))}
        />
      ) : null}
      {light.type === "point" || light.type === "spot" ? (
        <>
          <InspectorRangeNumberField
            label="作用距离"
            rangeAriaLabel="灯光作用距离滑杆"
            numberAriaLabel="灯光作用距离"
            max="500"
            min="0"
            step="0.1"
            value={light.distance ?? 0}
            onValueChange={(value) => onChange({ distance: Number(value) })}
          />
          <InspectorRangeNumberField
            label="衰减"
            rangeAriaLabel="灯光衰减滑杆"
            numberAriaLabel="灯光衰减"
            max="10"
            min="0"
            step="0.01"
            value={light.decay ?? 2}
            onValueChange={(value) => onChange({ decay: Number(value) })}
          />
        </>
      ) : null}
      {light.type === "spot" ? (
        <>
          <InspectorRangeNumberField
            label="锥角"
            rangeAriaLabel="聚光灯锥角滑杆"
            numberAriaLabel="聚光灯锥角"
            max="90"
            min="1"
            step="1"
            value={Math.round(((light.angle ?? Math.PI / 6) * 180) / Math.PI)}
            onValueChange={(value) => onChange({ angle: (Number(value) * Math.PI) / 180 })}
          />
          <InspectorRangeNumberField
            label="边缘柔和"
            rangeAriaLabel="聚光灯边缘柔和滑杆"
            numberAriaLabel="聚光灯边缘柔和"
            max="1"
            min="0"
            step="0.01"
            value={light.penumbra ?? 0.25}
            onValueChange={(value) => onChange({ penumbra: Number(value) })}
          />
        </>
      ) : null}
      {light.type === "rect-area" ? (
        <>
          <InspectorTextField
            label="宽度"
            ariaLabel="矩形面光宽度"
            min="0.01"
            step="0.1"
            type="number"
            value={light.width ?? 2}
            onChange={(value) => onChange({ width: Math.max(0.01, Number(value) || 0.01) })}
          />
          <InspectorTextField
            label="高度"
            ariaLabel="矩形面光高度"
            min="0.01"
            step="0.1"
            type="number"
            value={light.height ?? 2}
            onChange={(value) => onChange({ height: Math.max(0.01, Number(value) || 0.01) })}
          />
        </>
      ) : null}
    </div>
  );
}

/**
 * Renders the scene inspector with controls for transform, panorama, display toggles,
 * fog, environment lighting, clipping planes, and the light editor.
 */
export function ScenePanel() {
  const scene = useDirectorStore((state) => state.project.scene);
  const assets = useDirectorStore((state) => state.project.assets);
  const panoramaAssetId = useDirectorStore((state) => state.project.panoramaAssetId);
  const updateScene = useDirectorStore((state) => state.updateScene);
  const removePanoramaAsset = useDirectorStore((state) => state.removePanoramaAsset);
  const lights = useDirectorStore((state) => state.project.lights ?? EMPTY_DIRECTOR_LIGHTS);
  const addLight = useDirectorStore((state) => state.addLight);
  const updateLight = useDirectorStore((state) => state.updateLight);
  const removeLight = useDirectorStore((state) => state.removeLight);
  const [newLightType, setNewLightType] = useState<DirectorLightType>("directional");
  const [selectedLightId, setSelectedLightId] = useState<string | null>(() => lights[0]?.id ?? null);
  const selectedLight = lights.find((light) => light.id === selectedLightId) ?? lights[0];
  const clippingPlanes = scene.clippingPlanes ?? [];
  const updateClippingPlane = (id: string, patch: Partial<Omit<DirectorClippingPlane, "id">>) =>
    updateScene({
      clippingPlanes: clippingPlanes.map((plane) => (plane.id === id ? { ...plane, ...patch } : plane)),
    });
  useEffect(() => {
    if (selectedLight && selectedLight.id !== selectedLightId) setSelectedLightId(selectedLight.id);
    if (!selectedLight && selectedLightId) setSelectedLightId(null);
  }, [selectedLight, selectedLightId]);
  const panoramaAsset = assets.find((item) => item.id === panoramaAssetId);
  const sceneScaleField = useSceneNumberField(scene.scale, SCENE_SCALE_MIN, SCENE_SCALE_MAX, (scale) =>
    updateScene({ scale }),
  );
  const panoramaYawField = useSceneNumberField(scene.panoramaYaw, PANORAMA_YAW_MIN, PANORAMA_YAW_MAX, (panoramaYaw) =>
    updateScene({ panoramaYaw }),
  );
  const panoramaRadiusField = useSceneNumberField(
    scene.panoramaRadius,
    PANORAMA_RADIUS_MIN,
    PANORAMA_RADIUS_MAX,
    (panoramaRadius) => updateScene({ panoramaRadius }),
  );
  const groundHeightField = useSceneNumberField(
    scene.groundHeight,
    GROUND_HEIGHT_MIN,
    GROUND_HEIGHT_MAX,
    (groundHeight) => updateScene({ groundHeight }),
  );

  return (
    <InspectorPanel title="3D场景" ariaLabel="3D场景右侧属性面板" className="scene-inspector">
      <InspectorSection title="变换" className="scene-transform-section" collapsible>
        <div className="scene-transform-group">
          <InspectorRangeNumberField
            label="场景缩放"
            rangeAriaLabel="场景缩放滑杆"
            numberAriaLabel="场景缩放"
            max={SCENE_SCALE_MAX}
            min={SCENE_SCALE_MIN}
            step="0.01"
            value={sceneScaleField.draft}
            onValueChange={sceneScaleField.commit}
            onRangeChange={sceneScaleField.commit}
            onNumberBlur={sceneScaleField.commit}
            onNumberChange={sceneScaleField.change}
          />
          <InspectorAxisGroup
            label="场景平移"
            axes={[
              {
                axis: "X",
                ariaLabel: "场景平移 X",
                step: "0.1",
                value: scene.position[0],
                onChange: (value) => updateScene({ position: replaceAxis(scene.position, 0, Number(value)) }),
              },
              {
                axis: "Y",
                ariaLabel: "场景平移 Y",
                step: "0.1",
                value: scene.position[1],
                onChange: (value) => updateScene({ position: replaceAxis(scene.position, 1, Number(value)) }),
              },
              {
                axis: "Z",
                ariaLabel: "场景平移 Z",
                step: "0.1",
                value: scene.position[2],
                onChange: (value) => updateScene({ position: replaceAxis(scene.position, 2, Number(value)) }),
              },
            ]}
          />
          <InspectorAxisGroup
            label="场景旋转"
            axes={[
              {
                axis: "X",
                ariaLabel: "场景旋转 X",
                step: "1",
                value: scene.rotation[0],
                onChange: (value) => updateScene({ rotation: replaceAxis(scene.rotation, 0, Number(value)) }),
              },
              {
                axis: "Y",
                ariaLabel: "场景旋转 Y",
                step: "1",
                value: scene.rotation[1],
                onChange: (value) => updateScene({ rotation: replaceAxis(scene.rotation, 1, Number(value)) }),
              },
              {
                axis: "Z",
                ariaLabel: "场景旋转 Z",
                step: "1",
                value: scene.rotation[2],
                onChange: (value) => updateScene({ rotation: replaceAxis(scene.rotation, 2, Number(value)) }),
              },
            ]}
          />
        </div>
      </InspectorSection>
      <InspectorSection title="背景与全景" className="scene-background-section" collapsible>
        {panoramaAsset ? (
          <div className="panorama-thumbnail-card" aria-label="全景图缩略图卡片">
            <button
              aria-label="删除全景图"
              className="panorama-thumbnail-delete"
              type="button"
              onClick={() => removePanoramaAsset()}
            >
              <Trash2 aria-hidden="true" size={14} strokeWidth={1.9} />
            </button>
            <img
              className="panorama-thumbnail-image"
              alt={`${panoramaAsset.fileName} 全景图缩略图`}
              src={panoramaAsset.url}
            />
            <span className="panorama-thumbnail-name">{panoramaAsset.fileName}</span>
          </div>
        ) : (
          <div className="panorama-empty-card" aria-label="全景图连接状态">
            <span className="panorama-empty-icon" data-testid="panorama-empty-icon">
              <ImageOff aria-hidden="true" size={16} strokeWidth={1.8} />
            </span>
            <span>未连接全景图</span>
          </div>
        )}
        <InspectorColorField
          label="天空颜色"
          colorAriaLabel="天空颜色"
          hexAriaLabel="天空颜色 HEX"
          value={scene.backgroundColor}
          onColorChange={(value) => updateScene({ backgroundColor: value })}
          onHexChange={(value) => updateScene({ backgroundColor: value })}
        />
        <div className="scene-panorama-controls" aria-label="全景球参数">
          <InspectorRangeNumberField
            label="水平旋转"
            rangeAriaLabel="全景球水平旋转滑杆"
            numberAriaLabel="全景球水平旋转"
            max={PANORAMA_YAW_MAX}
            min={PANORAMA_YAW_MIN}
            step="1"
            value={panoramaYawField.draft}
            onValueChange={panoramaYawField.commit}
            onRangeChange={panoramaYawField.commit}
            onNumberBlur={panoramaYawField.commit}
            onNumberChange={panoramaYawField.change}
          />
          <InspectorRangeNumberField
            label="球形半径"
            rangeAriaLabel="全景球半径滑杆"
            numberAriaLabel="全景球半径"
            max={PANORAMA_RADIUS_MAX}
            min={PANORAMA_RADIUS_MIN}
            step="1"
            value={panoramaRadiusField.draft}
            onValueChange={panoramaRadiusField.commit}
            onRangeChange={panoramaRadiusField.commit}
            onNumberBlur={panoramaRadiusField.commit}
            onNumberChange={panoramaRadiusField.change}
          />
        </div>
      </InspectorSection>
      <InspectorSection title="显示与吸附" className="scene-display-section" collapsible>
        <div className="scene-switch-row" role="group" aria-label="开关项设置">
          <div className="inspector-toggle-row">
            <span>视口标签</span>
            <input
              aria-label="视口标签"
              checked={scene.showLabels}
              type="checkbox"
              onChange={(event) => updateScene({ showLabels: event.target.checked })}
            />
          </div>
          <div className="inspector-toggle-row">
            <span>网格吸附</span>
            <input
              aria-label="网格吸附"
              checked={scene.snapToGrid}
              type="checkbox"
              onChange={(event) => updateScene({ snapToGrid: event.target.checked })}
            />
          </div>
          <div className="inspector-toggle-row">
            <span>地面</span>
            <input
              aria-label="地面"
              checked={scene.showGround}
              type="checkbox"
              onChange={(event) => updateScene({ showGround: event.target.checked })}
            />
          </div>
        </div>
        {scene.showGround ? (
          <div className="scene-ground-controls">
            <InspectorRangeNumberField
              label="地面高度"
              rangeAriaLabel="地面高度滑杆"
              numberAriaLabel="地面高度"
              max={GROUND_HEIGHT_MAX}
              min={GROUND_HEIGHT_MIN}
              step="0.1"
              value={groundHeightField.draft}
              onValueChange={groundHeightField.commit}
              onRangeChange={groundHeightField.commit}
              onNumberBlur={groundHeightField.commit}
              onNumberChange={groundHeightField.change}
            />
          </div>
        ) : null}
      </InspectorSection>
      <InspectorSection title="氛围" className="scene-atmosphere-section" collapsible defaultOpen={false}>
        <div className="scene-subgroup">
          <p className="scene-subgroup-title">环境照明</p>
          <div className="inspector-toggle-stack" role="group" aria-label="环境照明开关">
            <label className="inspector-toggle-row">
              <span>启用环境照明</span>
              <input
                aria-label="启用环境照明"
                checked={scene.environment?.enabled ?? false}
                type="checkbox"
                onChange={(event) =>
                  updateScene({
                    environment: {
                      enabled: event.currentTarget.checked,
                      usePanorama: scene.environment?.usePanorama ?? true,
                      intensity: scene.environment?.intensity ?? 0.5,
                      rotation: scene.environment?.rotation ?? [0, 0, 0],
                    },
                  })
                }
              />
            </label>
            <label className="inspector-toggle-row">
              <span>使用全景图照明</span>
              <input
                aria-label="使用全景图照明"
                checked={scene.environment?.usePanorama ?? true}
                type="checkbox"
                onChange={(event) =>
                  updateScene({
                    environment: {
                      enabled: scene.environment?.enabled ?? false,
                      usePanorama: event.currentTarget.checked,
                      intensity: scene.environment?.intensity ?? 0.5,
                      rotation: scene.environment?.rotation ?? [0, 0, 0],
                    },
                  })
                }
              />
            </label>
          </div>
          <InspectorRangeNumberField
            label="环境强度"
            rangeAriaLabel="环境照明强度滑杆"
            numberAriaLabel="环境照明强度"
            max="5"
            min="0"
            step="0.01"
            value={scene.environment?.intensity ?? 0.5}
            onValueChange={(value) =>
              updateScene({
                environment: {
                  enabled: scene.environment?.enabled ?? false,
                  usePanorama: scene.environment?.usePanorama ?? true,
                  intensity: Number(value),
                  rotation: scene.environment?.rotation ?? [0, 0, 0],
                },
              })
            }
          />
          <InspectorAxisGroup
            label="环境旋转"
            axes={(["X", "Y", "Z"] as const).map((axis, index) => ({
              axis,
              ariaLabel: `环境旋转 ${axis}`,
              step: "0.01",
              value: scene.environment?.rotation[index] ?? 0,
              onChange: (value: string) =>
                updateScene({
                  environment: {
                    enabled: scene.environment?.enabled ?? false,
                    usePanorama: scene.environment?.usePanorama ?? true,
                    intensity: scene.environment?.intensity ?? 0.5,
                    rotation: replaceAxis(scene.environment?.rotation ?? [0, 0, 0], index as 0 | 1 | 2, Number(value)),
                  },
                }),
            }))}
          />
        </div>
        <div className="scene-subgroup">
          <p className="scene-subgroup-title">雾效</p>
          <div className="inspector-toggle-stack" role="group" aria-label="雾效开关">
            <label className="inspector-toggle-row">
              <span>启用雾效</span>
              <input
                aria-label="启用雾效"
                checked={scene.fog?.enabled ?? false}
                type="checkbox"
                onChange={(event) =>
                  updateScene({ fog: createFogPatch(scene.fog, { enabled: event.currentTarget.checked }) })
                }
              />
            </label>
          </div>
          <InspectorSelectField
            label="模式"
            ariaLabel="雾效模式"
            value={scene.fog?.mode ?? "linear"}
            options={[
              { value: "linear", label: "线性" },
              { value: "exponential", label: "指数" },
            ]}
            onChange={(value) =>
              updateScene({ fog: createFogPatch(scene.fog, { mode: value as "linear" | "exponential" }) })
            }
          />
          <InspectorColorField
            label="雾颜色"
            colorAriaLabel="雾颜色"
            hexAriaLabel="雾颜色 HEX"
            value={scene.fog?.color ?? scene.backgroundColor}
            onColorChange={(value) => updateScene({ fog: createFogPatch(scene.fog, { color: value }) })}
            onHexChange={(value) => updateScene({ fog: createFogPatch(scene.fog, { color: value }) })}
          />
          {(scene.fog?.mode ?? "linear") === "linear" ? (
            <>
              <InspectorRangeNumberField
                label="近端"
                rangeAriaLabel="线性雾近端滑杆"
                numberAriaLabel="线性雾近端"
                max="500"
                min="0"
                step="0.1"
                value={scene.fog?.near ?? 10}
                onValueChange={(value) => updateScene({ fog: createFogPatch(scene.fog, { near: Number(value) }) })}
              />
              <InspectorRangeNumberField
                label="远端"
                rangeAriaLabel="线性雾远端滑杆"
                numberAriaLabel="线性雾远端"
                max="1000"
                min="0.1"
                step="0.1"
                value={scene.fog?.far ?? 80}
                onValueChange={(value) => updateScene({ fog: createFogPatch(scene.fog, { far: Number(value) }) })}
              />
            </>
          ) : (
            <InspectorRangeNumberField
              label="密度"
              rangeAriaLabel="指数雾密度滑杆"
              numberAriaLabel="指数雾密度"
              max="1"
              min="0"
              step="0.001"
              value={scene.fog?.density ?? 0.02}
              onValueChange={(value) => updateScene({ fog: createFogPatch(scene.fog, { density: Number(value) }) })}
            />
          )}
        </div>
      </InspectorSection>
      <SceneWorldSection />
      <InspectorSection
        title="剖切平面"
        className="scene-clipping-section"
        collapsible
        defaultOpen={clippingPlanes.length > 0}
        description="全局剖切会进入项目、Agent 快照与最终渲染。"
      >
        {clippingPlanes.map((plane) => (
          <div className="scene-clipping-editor" key={plane.id} aria-label={`${plane.name}剖切平面`}>
            <InspectorTextField
              label="名称"
              ariaLabel={`${plane.name}名称`}
              value={plane.name}
              onChange={(name) => updateClippingPlane(plane.id, { name: name.trim() || plane.name })}
            />
            <label className="inspector-toggle-row">
              <span>启用</span>
              <input
                aria-label={`启用 ${plane.name}`}
                checked={plane.enabled}
                onChange={(event) => updateClippingPlane(plane.id, { enabled: event.currentTarget.checked })}
                type="checkbox"
              />
            </label>
            <InspectorAxisGroup
              label="法线"
              axes={(["X", "Y", "Z"] as const).map((axis, index) => ({
                axis,
                ariaLabel: `${plane.name}法线 ${axis}`,
                step: "0.1",
                value: plane.normal[index],
                onChange: (value: string) => {
                  const normal = replaceAxis(plane.normal, index as 0 | 1 | 2, Number(value));
                  if (Math.hypot(...normal) > 1e-6) updateClippingPlane(plane.id, { normal });
                },
              }))}
            />
            <SceneClippingPlaneConstantField plane={plane} onChange={(patch) => updateClippingPlane(plane.id, patch)} />
            <button
              aria-label={`删除 ${plane.name}`}
              className="inspector-action-button"
              onClick={() => updateScene({ clippingPlanes: clippingPlanes.filter((entry) => entry.id !== plane.id) })}
              type="button"
            >
              <Trash2 aria-hidden size={13} /> 删除剖切平面
            </button>
          </div>
        ))}
        <button
          aria-label="添加剖切平面"
          className="inspector-action-button"
          disabled={clippingPlanes.length >= 6}
          onClick={() =>
            updateScene({
              clippingPlanes: [
                ...clippingPlanes,
                {
                  id: createClippingPlaneId(),
                  name: `剖切平面 ${clippingPlanes.length + 1}`,
                  enabled: true,
                  normal: [1, 0, 0],
                  constant: 0,
                },
              ],
            })
          }
          type="button"
        >
          <Plus aria-hidden size={13} /> 添加剖切平面
        </button>
      </InspectorSection>
      <InspectorSection title="灯光" className="scene-lighting-section" collapsible defaultOpen={false}>
        <div className="scene-light-add-row">
          <InspectorSelectField
            label="新增类型"
            ariaLabel="新增灯光类型"
            value={newLightType}
            options={DIRECTOR_LIGHT_TYPE_OPTIONS.map((option) => ({ value: option.id, label: option.label }))}
            onChange={(value) => setNewLightType(value as DirectorLightType)}
          />
          <button
            aria-label="添加灯光"
            className="inspector-action-button"
            type="button"
            onClick={() => setSelectedLightId(addLight(newLightType))}
          >
            <Plus aria-hidden size={14} />
            添加灯光
          </button>
        </div>
        {lights.length ? (
          <InspectorSelectField
            label="当前灯光"
            ariaLabel="当前编辑灯光"
            value={selectedLight?.id ?? ""}
            options={lights.map((light) => ({ value: light.id, label: light.name }))}
            onChange={setSelectedLightId}
          />
        ) : (
          <p className="inspector-empty-state">当前场景没有灯光</p>
        )}
        {selectedLight ? (
          <SceneLightEditor light={selectedLight} onChange={(patch) => updateLight(selectedLight.id, patch)} />
        ) : null}
        {selectedLight ? (
          <button
            aria-label="删除当前灯光"
            className="inspector-action-button"
            disabled={selectedLight.locked}
            type="button"
            onClick={() => removeLight(selectedLight.id)}
          >
            <Trash2 aria-hidden size={14} />
            删除灯光
          </button>
        ) : null}
      </InspectorSection>
    </InspectorPanel>
  );
}
