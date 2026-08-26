/**
 * Inspector panel for prop and model objects: transform, vehicle, material, and texture controls.
 *
 * @module PropPanel
 */

import { ArrowDownToLine, Move3D } from "lucide-react";
import { replaceTupleAxis as replaceAxis } from "../../../../../../packages/protocol/src/primitives";
import { createDefaultDirectorCarProfile } from "../../../../../../packages/protocol/src/vehicleProtocol";
import {
  InspectorAxisGroup,
  InspectorColorField,
  InspectorPanel,
  InspectorRangeNumberField,
  InspectorSection,
  InspectorSelectField,
  InspectorTextField,
  InspectorUnitNumberField,
} from "./InspectorControls";
import { useDirectorStore } from "../store/directorStore";
import {
  DIRECTOR_MATERIAL_SIDE_OPTIONS,
  DIRECTOR_MATERIAL_TEXTURE_SLOT_OPTIONS,
  type DirectorMaterialSide,
  type DirectorMaterialTextureSlot,
} from "../schema/directorProject";
import { resolveDirectorPbrMaterial } from "../schema/directorMaterial";

/**
 * Renders the prop inspector with transform, vehicle profile, PBR material, and texture controls.
 */
export function PropPanel() {
  const prop = useDirectorStore((state) => {
    const selected = state.project.objects.find((item) => item.id === state.selectedObjectId);
    const selectedAsset = selected?.assetRefId
      ? state.project.assets.find((asset) => asset.id === selected.assetRefId)
      : undefined;

    if (!selected) return undefined;
    if (selected.kind === "prop" || selected.kind === "scene") return selected;
    if (selectedAsset?.sourceType === "model") return selected;

    return undefined;
  });
  const updateObjectName = useDirectorStore((state) => state.updateObjectName);
  const updateObjectTransform = useDirectorStore((state) => state.updateObjectTransform);
  const dropObjectToGround = useDirectorStore((state) => state.dropObjectToGround);
  const updateUniformScale = useDirectorStore((state) => state.updateUniformScale);
  const updateObjectMaterial = useDirectorStore((state) => state.updateObjectMaterial);
  const setObjectVehicleProfile = useDirectorStore((state) => state.setObjectVehicleProfile);
  const updateObjectMaterialTexture = useDirectorStore((state) => state.updateObjectMaterialTexture);
  const setAssetRealWorldSize = useDirectorStore((state) => state.setAssetRealWorldSize);
  const assets = useDirectorStore((state) => state.project.assets);

  if (!prop) return null;

  const propAsset = prop.assetRefId ? assets.find((asset) => asset.id === prop.assetRefId) : undefined;
  // Generated assets keep their server-normalized metric scale (preserve).
  const showRealWorldSize =
    propAsset?.sourceType === "model" && propAsset.kind !== "character" && propAsset.modelNormalization !== "preserve";

  const material = resolveDirectorPbrMaterial(prop);
  const textureAssets = assets.filter((asset) => asset.sourceType === "image" && asset.kind !== "panorama");
  const propColor = material.baseColor;
  const usesNativeModelData = prop.nativeSource?.engine === "blender" && prop.nativeSource.provisioned !== false;
  const showMaterialControls = !prop.isCompositeParent && !usesNativeModelData;

  const objectLabel = prop.isCompositeParent ? "组合父对象" : prop.geometryType ? "几何对象" : "模型";

  return (
    <InspectorPanel title={objectLabel} ariaLabel={`${objectLabel}右侧属性面板`} className="prop-inspector">
      <InspectorTextField
        label="名称"
        ariaLabel={`${objectLabel}名称`}
        value={prop.name}
        onChange={(value) => updateObjectName(prop.id, value)}
      />

      <div aria-label="视口直接摆放提示" className="prop-direct-placement" role="note">
        <Move3D aria-hidden size={16} strokeWidth={1.8} />
        <div>
          <strong>在视口直接摆放</strong>
          <span>拖动彩色手柄移动；顶部可切换旋转与缩放。</span>
        </div>
      </div>
      <button
        aria-label="贴地放置"
        className="inspector-action-button inspector-ground-button"
        title="让资产落到当前场景地面"
        type="button"
        onClick={() => dropObjectToGround(prop.id)}
      >
        <ArrowDownToLine aria-hidden size={15} />
        <span>贴地放置</span>
      </button>

      <InspectorSection
        title="精确变换"
        className="prop-transform-section"
        collapsible
        defaultOpen={false}
        description="数值用于 Agent 与专业校准；日常摆放请直接操作视口。"
      >
        <div className="prop-transform-group">
          <InspectorAxisGroup
            label="位置"
            axes={[
              {
                axis: "X",
                ariaLabel: "模型位置 X",
                value: prop.transform.position[0],
                onChange: (value) =>
                  updateObjectTransform(prop.id, {
                    position: replaceAxis(prop.transform.position, 0, Number(value)),
                  }),
              },
              {
                axis: "Y",
                ariaLabel: "模型位置 Y",
                value: prop.transform.position[1],
                onChange: (value) =>
                  updateObjectTransform(prop.id, {
                    position: replaceAxis(prop.transform.position, 1, Number(value)),
                  }),
              },
              {
                axis: "Z",
                ariaLabel: "模型位置 Z",
                value: prop.transform.position[2],
                onChange: (value) =>
                  updateObjectTransform(prop.id, {
                    position: replaceAxis(prop.transform.position, 2, Number(value)),
                  }),
              },
            ]}
          />
          <InspectorAxisGroup
            label="旋转"
            axes={[
              {
                axis: "X",
                ariaLabel: "模型旋转 X",
                value: prop.transform.rotation[0],
                onChange: (value) =>
                  updateObjectTransform(prop.id, {
                    rotation: replaceAxis(prop.transform.rotation, 0, Number(value)),
                  }),
              },
              {
                axis: "Y",
                ariaLabel: "模型旋转 Y",
                value: prop.transform.rotation[1],
                onChange: (value) =>
                  updateObjectTransform(prop.id, {
                    rotation: replaceAxis(prop.transform.rotation, 1, Number(value)),
                  }),
              },
              {
                axis: "Z",
                ariaLabel: "模型旋转 Z",
                value: prop.transform.rotation[2],
                onChange: (value) =>
                  updateObjectTransform(prop.id, {
                    rotation: replaceAxis(prop.transform.rotation, 2, Number(value)),
                  }),
              },
            ]}
          />
          <InspectorAxisGroup
            label="缩放"
            axes={[
              {
                axis: "X",
                ariaLabel: "模型缩放 X",
                step: "0.01",
                value: prop.transform.scale[0],
                onChange: (value) =>
                  updateObjectTransform(prop.id, {
                    scale: replaceAxis(prop.transform.scale, 0, Number(value)),
                  }),
              },
              {
                axis: "Y",
                ariaLabel: "模型缩放 Y",
                step: "0.01",
                value: prop.transform.scale[1],
                onChange: (value) =>
                  updateObjectTransform(prop.id, {
                    scale: replaceAxis(prop.transform.scale, 1, Number(value)),
                  }),
              },
              {
                axis: "Z",
                ariaLabel: "模型缩放 Z",
                step: "0.01",
                value: prop.transform.scale[2],
                onChange: (value) =>
                  updateObjectTransform(prop.id, {
                    scale: replaceAxis(prop.transform.scale, 2, Number(value)),
                  }),
              },
            ]}
          />
          <InspectorRangeNumberField
            label="统一缩放"
            rangeAriaLabel="模型统一缩放滑杆"
            numberAriaLabel="模型统一缩放"
            max="3"
            min="0.2"
            step="0.01"
            value={prop.transform.scale[0]}
            onValueChange={(value) => updateUniformScale(prop.id, Number(value))}
          />
          {showRealWorldSize ? (
            <InspectorUnitNumberField
              label="真实尺寸"
              ariaLabel="模型真实尺寸（米）"
              unit="m"
              min="0.001"
              step="0.1"
              value={propAsset?.realWorldSizeM ?? ""}
              onChange={(value) => {
                const parsed = Number(value);
                setAssetRealWorldSize(propAsset!.id, value.trim() && Number.isFinite(parsed) ? parsed : null, "user");
              }}
            />
          ) : null}
        </div>
      </InspectorSection>

      {!prop.isCompositeParent ? (
        <InspectorSection
          title="载具"
          className="prop-vehicle-section"
          collapsible
          defaultOpen={Boolean(prop.vehicle)}
          description="启用后可在玩家模式中靠近并按 E 上车；驾驶只影响实时会话，不改写项目位姿。"
        >
          <div className="inspector-toggle-stack" role="group" aria-label="载具能力开关">
            <label className="inspector-toggle-row">
              <span>可驾驶载具</span>
              <input
                aria-label="可驾驶载具"
                checked={Boolean(prop.vehicle)}
                type="checkbox"
                onChange={(event) =>
                  setObjectVehicleProfile(
                    prop.id,
                    event.currentTarget.checked ? createDefaultDirectorCarProfile() : null,
                  )
                }
              />
            </label>
            {prop.vehicle ? (
              <label className="inspector-toggle-row">
                <span>允许玩家驾驶</span>
                <input
                  aria-label="允许玩家驾驶"
                  checked={prop.vehicle.drivable}
                  type="checkbox"
                  onChange={(event) =>
                    setObjectVehicleProfile(prop.id, { ...prop.vehicle!, drivable: event.currentTarget.checked })
                  }
                />
              </label>
            ) : null}
          </div>
          {prop.vehicle ? (
            <>
              <InspectorUnitNumberField
                label="质量"
                ariaLabel="载具质量（千克）"
                unit="kg"
                min="100"
                max="20000"
                step="50"
                value={prop.vehicle.massKg}
                onChange={(value) =>
                  setObjectVehicleProfile(prop.id, { ...prop.vehicle!, massKg: Number(value) || prop.vehicle!.massKg })
                }
              />
              <InspectorRangeNumberField
                label="最高速度"
                rangeAriaLabel="载具最高速度滑杆"
                numberAriaLabel="载具最高速度"
                max="400"
                min="5"
                step="1"
                value={prop.vehicle.maxSpeedKph}
                onValueChange={(value) =>
                  setObjectVehicleProfile(prop.id, { ...prop.vehicle!, maxSpeedKph: Number(value) })
                }
              />
              <InspectorRangeNumberField
                label="发动机力"
                rangeAriaLabel="载具发动机力滑杆"
                numberAriaLabel="载具发动机力"
                max="100000"
                min="500"
                step="500"
                value={prop.vehicle.engineForceN}
                onValueChange={(value) =>
                  setObjectVehicleProfile(prop.id, { ...prop.vehicle!, engineForceN: Number(value) })
                }
              />
              <InspectorRangeNumberField
                label="最大转向角"
                rangeAriaLabel="载具最大转向角滑杆"
                numberAriaLabel="载具最大转向角"
                max="60"
                min="5"
                step="1"
                value={prop.vehicle.steerMaxDeg}
                onValueChange={(value) =>
                  setObjectVehicleProfile(prop.id, { ...prop.vehicle!, steerMaxDeg: Number(value) })
                }
              />
              <InspectorRangeNumberField
                label="追车距离"
                rangeAriaLabel="追车相机距离滑杆"
                numberAriaLabel="追车相机距离"
                max="30"
                min="2"
                step="0.1"
                value={prop.vehicle.camera.chaseDistanceM}
                onValueChange={(value) =>
                  setObjectVehicleProfile(prop.id, {
                    ...prop.vehicle!,
                    camera: { ...prop.vehicle!.camera, chaseDistanceM: Number(value) },
                  })
                }
              />
              <InspectorRangeNumberField
                label="追车高度"
                rangeAriaLabel="追车相机高度滑杆"
                numberAriaLabel="追车相机高度"
                max="15"
                min="0.5"
                step="0.1"
                value={prop.vehicle.camera.chaseHeightM}
                onValueChange={(value) =>
                  setObjectVehicleProfile(prop.id, {
                    ...prop.vehicle!,
                    camera: { ...prop.vehicle!.camera, chaseHeightM: Number(value) },
                  })
                }
              />
            </>
          ) : null}
        </InspectorSection>
      ) : null}

      {showMaterialControls ? (
        <InspectorSection title="材质" className="prop-pbr-section" collapsible defaultOpen={false}>
          <InspectorColorField
            label="颜色"
            colorAriaLabel="模型颜色"
            hexAriaLabel="模型颜色 HEX"
            value={propColor}
            onColorChange={(value) => updateObjectMaterial(prop.id, { baseColor: value })}
            onHexChange={(value) => updateObjectMaterial(prop.id, { baseColor: value })}
          />
          <InspectorRangeNumberField
            label="金属度"
            rangeAriaLabel="模型金属度滑杆"
            numberAriaLabel="模型金属度"
            max="1"
            min="0"
            step="0.01"
            value={material.metalness}
            onValueChange={(value) => updateObjectMaterial(prop.id, { metalness: Number(value) })}
          />
          <InspectorRangeNumberField
            label="粗糙度"
            rangeAriaLabel="模型粗糙度滑杆"
            numberAriaLabel="模型粗糙度"
            max="1"
            min="0"
            step="0.01"
            value={material.roughness}
            onValueChange={(value) => updateObjectMaterial(prop.id, { roughness: Number(value) })}
          />
          <InspectorRangeNumberField
            label="不透明度"
            rangeAriaLabel="模型不透明度滑杆"
            numberAriaLabel="模型不透明度"
            max="1"
            min="0"
            step="0.01"
            value={material.opacity}
            onValueChange={(value) => updateObjectMaterial(prop.id, { opacity: Number(value) })}
          />
          <InspectorColorField
            label="自发光"
            colorAriaLabel="模型自发光颜色"
            hexAriaLabel="模型自发光颜色 HEX"
            value={material.emissiveColor}
            onColorChange={(value) => updateObjectMaterial(prop.id, { emissiveColor: value })}
            onHexChange={(value) => updateObjectMaterial(prop.id, { emissiveColor: value })}
          />
          <InspectorRangeNumberField
            label="自发光强度"
            rangeAriaLabel="模型自发光强度滑杆"
            numberAriaLabel="模型自发光强度"
            max="20"
            min="0"
            step="0.05"
            value={material.emissiveIntensity}
            onValueChange={(value) => updateObjectMaterial(prop.id, { emissiveIntensity: Number(value) })}
          />
          <div className="prop-material-subgroup">
            <p className="prop-subgroup-title">透射与清漆</p>
            <InspectorRangeNumberField
              label="透射"
              rangeAriaLabel="模型透射滑杆"
              numberAriaLabel="模型透射"
              max="1"
              min="0"
              step="0.01"
              value={material.transmission}
              onValueChange={(value) => updateObjectMaterial(prop.id, { transmission: Number(value) })}
            />
            <InspectorRangeNumberField
              label="折射率"
              rangeAriaLabel="模型折射率滑杆"
              numberAriaLabel="模型折射率"
              max="2.5"
              min="1"
              step="0.01"
              value={material.ior}
              onValueChange={(value) => updateObjectMaterial(prop.id, { ior: Number(value) })}
            />
            <InspectorRangeNumberField
              label="清漆"
              rangeAriaLabel="模型清漆滑杆"
              numberAriaLabel="模型清漆"
              max="1"
              min="0"
              step="0.01"
              value={material.clearcoat}
              onValueChange={(value) => updateObjectMaterial(prop.id, { clearcoat: Number(value) })}
            />
            <InspectorRangeNumberField
              label="清漆粗糙度"
              rangeAriaLabel="模型清漆粗糙度滑杆"
              numberAriaLabel="模型清漆粗糙度"
              max="1"
              min="0"
              step="0.01"
              value={material.clearcoatRoughness}
              onValueChange={(value) => updateObjectMaterial(prop.id, { clearcoatRoughness: Number(value) })}
            />
          </div>
          <InspectorSelectField
            label="渲染面"
            ariaLabel="模型材质渲染面"
            value={material.side}
            options={DIRECTOR_MATERIAL_SIDE_OPTIONS.map((option) => ({ value: option.id, label: option.label }))}
            onChange={(value) => updateObjectMaterial(prop.id, { side: value as DirectorMaterialSide })}
          />
          <div className="inspector-toggle-stack" role="group" aria-label="材质渲染开关">
            <label className="inspector-toggle-row">
              <span>线框</span>
              <input
                aria-label="模型线框材质"
                checked={material.wireframe}
                type="checkbox"
                onChange={(event) => updateObjectMaterial(prop.id, { wireframe: event.currentTarget.checked })}
              />
            </label>
            <label className="inspector-toggle-row">
              <span>平面着色</span>
              <input
                aria-label="模型平面着色"
                checked={material.flatShading}
                type="checkbox"
                onChange={(event) => updateObjectMaterial(prop.id, { flatShading: event.currentTarget.checked })}
              />
            </label>
          </div>
        </InspectorSection>
      ) : null}

      {showMaterialControls ? (
        <InspectorSection
          title="贴图"
          className="prop-texture-section"
          collapsible
          defaultOpen={false}
          description="绑定本地图片资产到各 PBR 贴图槽；未绑定的槽位使用材质数值。"
        >
          {DIRECTOR_MATERIAL_TEXTURE_SLOT_OPTIONS.map((slot) => (
            <InspectorSelectField
              key={slot.id}
              label={slot.label}
              ariaLabel={`${slot.label}资产`}
              value={material.textures[slot.id] ?? ""}
              options={[
                { value: "", label: "未绑定" },
                ...textureAssets.map((asset) => ({
                  value: asset.id,
                  label: asset.name?.trim() || asset.fileName,
                })),
              ]}
              onChange={(value) =>
                updateObjectMaterialTexture(prop.id, slot.id as DirectorMaterialTextureSlot, value || null)
              }
            />
          ))}
          <button className="inspector-action-button" type="button" onClick={() => updateObjectMaterial(prop.id, null)}>
            重置材质
          </button>
        </InspectorSection>
      ) : null}
    </InspectorPanel>
  );
}
