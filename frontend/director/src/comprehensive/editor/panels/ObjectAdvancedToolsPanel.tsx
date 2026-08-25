/**
 * Multi-select object tools panel with visibility, transforms, layers, annotations, and materials.
 *
 * @module ObjectAdvancedToolsPanel
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlignHorizontalDistributeCenter,
  ChevronDown,
  ChevronUp,
  Crosshair,
  Eye,
  EyeOff,
  Group,
  Lock,
  MessageSquare,
  Ruler,
  RotateCcw,
  Trash2,
  Unlock,
} from "lucide-react";
import {
  InspectorAxisGroup,
  InspectorColorField,
  InspectorPanel,
  InspectorRangeNumberField,
  InspectorSelectField,
} from "./InspectorControls";
import { useDirectorStore } from "../store/directorStore";
import { getDirectorObjectLayerId, getDirectorObjectLayers } from "../schema/objectLayers";
import "../../styles/objectAdvancedToolsPanel.css";

function ObjectAdvancedGroup({
  title,
  defaultOpen = true,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className={`object-advanced-group${open ? "" : " is-collapsed"}`}>
      <h4>
        <button
          aria-expanded={open}
          className="object-advanced-group-toggle"
          onClick={() => setOpen((current) => !current)}
          type="button"
        >
          <ChevronDown
            aria-hidden
            className={`object-advanced-group-chevron${open ? " is-open" : ""}`}
            size={14}
            strokeWidth={1.8}
          />
          <span>{title}</span>
        </button>
      </h4>
      {open ? <div className="object-advanced-group-body">{children}</div> : null}
    </section>
  );
}

function ObjectAdvancedBlock({
  title,
  children,
  headingId,
}: {
  title: string;
  children: ReactNode;
  headingId: string;
}) {
  return (
    <div aria-labelledby={headingId} className="object-advanced-block">
      <h5 className="object-advanced-block-title" id={headingId}>
        {title}
      </h5>
      {children}
    </div>
  );
}

/**
 * Renders advanced multi-object editing tools: isolation, visibility, pivot, alignment,
 * layer assignment, annotations, measurements, and batch material application.
 */
export function ObjectAdvancedToolsPanel() {
  const [advancedStatus, setAdvancedStatus] = useState("");
  const [advancedAxis, setAdvancedAxis] = useState<"x" | "y" | "z">("x");
  const [alignMode, setAlignMode] = useState<"min" | "center" | "max">("center");
  const [layerDraft, setLayerDraft] = useState("default");
  const [pivotDraft, setPivotDraft] = useState<[number, number, number]>([0, 0, 0]);
  const [annotationDraft, setAnnotationDraft] = useState("");
  const [annotationColor, setAnnotationColor] = useState("#f6c453");
  const [measurementLabel, setMeasurementLabel] = useState("");
  const [materialColor, setMaterialColor] = useState("#d7e7ff");
  const [materialRoughness, setMaterialRoughness] = useState(0.65);
  const [materialMetalness, setMaterialMetalness] = useState(0);

  const scene = useDirectorStore((state) => state.project.scene);
  const objects = useDirectorStore((state) => state.project.objects);
  const selectedObjectId = useDirectorStore((state) => state.selectedObjectId);
  const selectedObjectIds = useDirectorStore((state) => state.selectedObjectIds);
  const createCompositeObject = useDirectorStore((state) => state.createCompositeObject);
  const batchUpdateObjects = useDirectorStore((state) => state.batchUpdateObjects);
  const resetObjectTransforms = useDirectorStore((state) => state.resetObjectTransforms);
  const alignObjects = useDirectorStore((state) => state.alignObjects);
  const distributeObjects = useDirectorStore((state) => state.distributeObjects);
  const isolateObjects = useDirectorStore((state) => state.isolateObjects);
  const showAllObjects = useDirectorStore((state) => state.showAllObjects);
  const setObjectPivot = useDirectorStore((state) => state.setObjectPivot);
  const addSceneAnnotation = useDirectorStore((state) => state.addSceneAnnotation);
  const updateSceneAnnotation = useDirectorStore((state) => state.updateSceneAnnotation);
  const removeSceneAnnotation = useDirectorStore((state) => state.removeSceneAnnotation);
  const addSceneMeasurement = useDirectorStore((state) => state.addSceneMeasurement);
  const updateSceneMeasurement = useDirectorStore((state) => state.updateSceneMeasurement);
  const removeSceneMeasurement = useDirectorStore((state) => state.removeSceneMeasurement);
  const setObjectLayerState = useDirectorStore((state) => state.setObjectLayerState);
  const moveObjectLayer = useDirectorStore((state) => state.moveObjectLayer);

  const effectiveSelectedObjectIds = useMemo(
    () => (selectedObjectIds.length ? selectedObjectIds : selectedObjectId ? [selectedObjectId] : []),
    [selectedObjectId, selectedObjectIds],
  );
  const objectLayers = useMemo(() => getDirectorObjectLayers(scene, objects), [objects, scene]);
  const selectedPivotObject = useMemo(
    () => objects.find((object) => object.id === effectiveSelectedObjectIds[0]) ?? null,
    [effectiveSelectedObjectIds, objects],
  );

  useEffect(() => {
    setPivotDraft(selectedPivotObject?.pivot ? [...selectedPivotObject.pivot] : [0, 0, 0]);
  }, [selectedPivotObject?.id, selectedPivotObject?.pivot]);

  return (
    <InspectorPanel
      ariaLabel="多选属性面板"
      className="object-advanced-tools-panel"
      title={`已选 ${effectiveSelectedObjectIds.length} 个对象`}
    >
      {advancedStatus ? (
        <p className="object-advanced-status" role="status">
          {advancedStatus}
        </p>
      ) : null}

      <div className="object-advanced-tool-body">
        <ObjectAdvancedGroup title="选择与可见性">
          <div className="object-advanced-action-cluster">
            <button
              disabled={!effectiveSelectedObjectIds.length}
              onClick={() => {
                const count = resetObjectTransforms(effectiveSelectedObjectIds);
                setAdvancedStatus(count ? `已重置 ${count} 个对象变换` : "没有可重置的未锁定对象");
              }}
              type="button"
            >
              <RotateCcw aria-hidden size={13} /> 重置变换
            </button>
            <button
              disabled={!effectiveSelectedObjectIds.length}
              onClick={() => {
                const count = isolateObjects(effectiveSelectedObjectIds);
                setAdvancedStatus(count ? `已隔离选择，改变 ${count} 个可见状态` : "选择已经隔离");
              }}
              type="button"
            >
              <EyeOff aria-hidden size={13} /> 隔离
            </button>
            <button
              onClick={() => {
                const count = showAllObjects();
                setAdvancedStatus(count ? `已显示 ${count} 个对象` : "所有对象均已显示");
              }}
              type="button"
            >
              <Eye aria-hidden size={13} /> 全部显示
            </button>
            <button
              disabled={effectiveSelectedObjectIds.length < 2}
              onClick={() => {
                const id = createCompositeObject(effectiveSelectedObjectIds, "组合对象");
                setAdvancedStatus(id ? `已创建组合 ${id}` : "无法创建组合");
              }}
              type="button"
            >
              <Group aria-hidden size={13} /> 组合
            </button>
          </div>
        </ObjectAdvancedGroup>

        <ObjectAdvancedGroup title="变换">
          {effectiveSelectedObjectIds.length === 1 ? (
            <ObjectAdvancedBlock headingId="object-advanced-pivot-heading" title="对象枢轴">
              <div className="object-advanced-channel object-advanced-pivot-grid">
                <InspectorAxisGroup
                  label="枢轴"
                  axes={(["X", "Y", "Z"] as const).map((axis, index) => ({
                    axis,
                    ariaLabel: `对象枢轴 ${axis}`,
                    step: "0.01",
                    value: pivotDraft[index],
                    onChange: (value: string) => {
                      const nextValue = Number(value);
                      setPivotDraft(
                        (current) =>
                          current.map((entry, currentIndex) => (currentIndex === index ? nextValue : entry)) as [
                            number,
                            number,
                            number,
                          ],
                      );
                    },
                  }))}
                />
                <div className="object-advanced-button-row">
                  <button
                    disabled={selectedPivotObject?.kind === "camera"}
                    onClick={() => {
                      const changed = setObjectPivot(effectiveSelectedObjectIds[0]!, pivotDraft);
                      setAdvancedStatus(changed ? "已更新对象枢轴" : "对象枢轴没有变化或对象已锁定");
                    }}
                    type="button"
                  >
                    <Crosshair aria-hidden size={12} /> 应用枢轴
                  </button>
                  <button
                    disabled={selectedPivotObject?.kind === "camera"}
                    onClick={() => {
                      const changed = setObjectPivot(effectiveSelectedObjectIds[0]!, null);
                      setAdvancedStatus(changed ? "已重置对象枢轴" : "对象枢轴已经位于原点");
                    }}
                    type="button"
                  >
                    重置枢轴
                  </button>
                </div>
              </div>
            </ObjectAdvancedBlock>
          ) : null}

          <ObjectAdvancedBlock headingId="object-advanced-align-heading" title="对齐与分布">
            <div className="object-advanced-channel">
              <InspectorSelectField
                label="轴"
                ariaLabel="高级编辑轴"
                value={advancedAxis}
                options={[
                  { value: "x", label: "X" },
                  { value: "y", label: "Y" },
                  { value: "z", label: "Z" },
                ]}
                onChange={(value) => setAdvancedAxis(value as "x" | "y" | "z")}
              />
              <InspectorSelectField
                label="对齐"
                ariaLabel="对象对齐模式"
                value={alignMode}
                options={[
                  { value: "min", label: "最小" },
                  { value: "center", label: "中心" },
                  { value: "max", label: "最大" },
                ]}
                onChange={(value) => setAlignMode(value as "min" | "center" | "max")}
              />
              <div className="object-advanced-button-row">
                <button
                  disabled={effectiveSelectedObjectIds.length < 2}
                  onClick={() => {
                    const count = alignObjects(effectiveSelectedObjectIds, advancedAxis, alignMode);
                    setAdvancedStatus(count ? `已对齐 ${count} 个对象` : "至少需要 2 个未锁定对象");
                  }}
                  type="button"
                >
                  对齐
                </button>
                <button
                  disabled={effectiveSelectedObjectIds.length < 3}
                  onClick={() => {
                    const count = distributeObjects(effectiveSelectedObjectIds, advancedAxis);
                    setAdvancedStatus(count ? `已均匀分布 ${count} 个对象` : "至少需要 3 个未锁定对象");
                  }}
                  type="button"
                >
                  <AlignHorizontalDistributeCenter aria-hidden size={11} /> 均匀分布
                </button>
              </div>
            </div>
          </ObjectAdvancedBlock>
        </ObjectAdvancedGroup>

        <ObjectAdvancedGroup defaultOpen={false} title="图层">
          <div className="object-advanced-layer-editor">
            <label className="object-advanced-layer-input">
              <span>层名称</span>
              <input
                aria-label="对象层名称"
                maxLength={80}
                onChange={(event) => setLayerDraft(event.target.value)}
                value={layerDraft}
              />
            </label>
            <div className="object-advanced-layer-actions">
              <button
                disabled={!effectiveSelectedObjectIds.length || !layerDraft.trim()}
                onClick={() => {
                  const count = batchUpdateObjects(effectiveSelectedObjectIds, { layer: layerDraft.trim() });
                  setAdvancedStatus(count ? `已把 ${count} 个对象设为 ${layerDraft.trim()} 层` : "没有可更新的对象");
                }}
                type="button"
              >
                应用层
              </button>
              <button
                disabled={!effectiveSelectedObjectIds.length}
                onClick={() => {
                  const count = batchUpdateObjects(effectiveSelectedObjectIds, { layer: null });
                  setAdvancedStatus(count ? `已清除 ${count} 个对象的层` : "没有可更新的对象");
                }}
                type="button"
              >
                清除层
              </button>
            </div>
            <div className="object-advanced-layer-list" aria-label="对象图层列表">
              {objectLayers.map((layer, index) => {
                const count = objects.filter((object) => getDirectorObjectLayerId(object) === layer.id).length;
                return (
                  <div className="object-advanced-layer-row" key={layer.id}>
                    <span data-i18n-user-content>{layer.id}</span>
                    <small>{count}</small>
                    <button
                      aria-label={`${layer.visible ? "隐藏" : "显示"}图层 ${layer.id}`}
                      onClick={() => setObjectLayerState(layer.id, { visible: !layer.visible })}
                      type="button"
                    >
                      {layer.visible ? <Eye aria-hidden size={12} /> : <EyeOff aria-hidden size={12} />}
                    </button>
                    <button
                      aria-label={`${layer.locked ? "解锁" : "锁定"}图层 ${layer.id}`}
                      onClick={() => setObjectLayerState(layer.id, { locked: !layer.locked })}
                      type="button"
                    >
                      {layer.locked ? <Lock aria-hidden size={12} /> : <Unlock aria-hidden size={12} />}
                    </button>
                    <button
                      aria-label={`上移图层 ${layer.id}`}
                      disabled={index === 0}
                      onClick={() => moveObjectLayer(layer.id, "up")}
                      type="button"
                    >
                      <ChevronUp aria-hidden size={12} />
                    </button>
                    <button
                      aria-label={`下移图层 ${layer.id}`}
                      disabled={index === objectLayers.length - 1}
                      onClick={() => moveObjectLayer(layer.id, "down")}
                      type="button"
                    >
                      <ChevronDown aria-hidden size={12} />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </ObjectAdvancedGroup>

        <ObjectAdvancedGroup defaultOpen={false} title="标注与测量">
          <ObjectAdvancedBlock headingId="object-advanced-annotation-heading" title="标注">
            <div className="object-advanced-overlay-editor">
              <label>
                <span>文字</span>
                <textarea
                  aria-label="标注文字"
                  maxLength={10_000}
                  onChange={(event) => setAnnotationDraft(event.currentTarget.value)}
                  rows={2}
                  value={annotationDraft}
                />
              </label>
              <label>
                <span>颜色</span>
                <input
                  aria-label="标注颜色"
                  onChange={(event) => setAnnotationColor(event.currentTarget.value)}
                  type="color"
                  value={annotationColor}
                />
              </label>
              <button
                disabled={effectiveSelectedObjectIds.length !== 1 || !annotationDraft.trim()}
                onClick={() => {
                  const id = addSceneAnnotation({
                    text: annotationDraft,
                    anchor: { objectId: effectiveSelectedObjectIds[0]!, position: [0, 1, 0] },
                    color: annotationColor,
                  });
                  if (id) setAnnotationDraft("");
                  setAdvancedStatus(id ? `已添加标注 ${id}` : "请选择一个有效对象并输入标注");
                }}
                type="button"
              >
                <MessageSquare aria-hidden size={12} /> 添加到对象
              </button>
            </div>
            <div className="object-advanced-overlay-list" aria-label="场景标注列表">
              {(scene.annotations ?? []).map((annotation) => (
                <div key={annotation.id}>
                  <span data-i18n-user-content>{annotation.text}</span>
                  <button
                    aria-label={`${annotation.visible ? "隐藏" : "显示"}标注 ${annotation.id}`}
                    onClick={() => updateSceneAnnotation(annotation.id, { visible: !annotation.visible })}
                    type="button"
                  >
                    {annotation.visible ? <Eye aria-hidden size={11} /> : <EyeOff aria-hidden size={11} />}
                  </button>
                  <button
                    aria-label={`删除标注 ${annotation.id}`}
                    onClick={() => removeSceneAnnotation(annotation.id)}
                    type="button"
                  >
                    <Trash2 aria-hidden size={11} />
                  </button>
                </div>
              ))}
            </div>
          </ObjectAdvancedBlock>

          <ObjectAdvancedBlock headingId="object-advanced-measurement-heading" title="测量">
            <div className="object-advanced-overlay-editor">
              <label>
                <span>名称</span>
                <input
                  aria-label="测量名称"
                  maxLength={500}
                  onChange={(event) => setMeasurementLabel(event.currentTarget.value)}
                  value={measurementLabel}
                />
              </label>
              <button
                disabled={effectiveSelectedObjectIds.length !== 2}
                onClick={() => {
                  const id = addSceneMeasurement({
                    start: { objectId: effectiveSelectedObjectIds[0]!, position: [0, 0, 0] },
                    end: { objectId: effectiveSelectedObjectIds[1]!, position: [0, 0, 0] },
                    label: measurementLabel,
                  });
                  if (id) setMeasurementLabel("");
                  setAdvancedStatus(id ? `已添加测量 ${id}` : "请选择两个有效对象");
                }}
                type="button"
              >
                <Ruler aria-hidden size={12} /> 测量两个对象
              </button>
            </div>
            <div className="object-advanced-overlay-list" aria-label="场景测量列表">
              {(scene.measurements ?? []).map((measurement) => (
                <div key={measurement.id}>
                  <span data-i18n-user-content>{measurement.label || measurement.id}</span>
                  <button
                    aria-label={`${measurement.visible ? "隐藏" : "显示"}测量 ${measurement.id}`}
                    onClick={() => updateSceneMeasurement(measurement.id, { visible: !measurement.visible })}
                    type="button"
                  >
                    {measurement.visible ? <Eye aria-hidden size={11} /> : <EyeOff aria-hidden size={11} />}
                  </button>
                  <button
                    aria-label={`删除测量 ${measurement.id}`}
                    onClick={() => removeSceneMeasurement(measurement.id)}
                    type="button"
                  >
                    <Trash2 aria-hidden size={11} />
                  </button>
                </div>
              ))}
            </div>
          </ObjectAdvancedBlock>
        </ObjectAdvancedGroup>

        <ObjectAdvancedGroup defaultOpen={false} title="材质">
          <div className="object-advanced-material" aria-label="批量材质">
            <InspectorColorField
              label="颜色"
              colorAriaLabel="批量材质颜色"
              hexAriaLabel="批量材质颜色 HEX"
              value={materialColor}
              onColorChange={setMaterialColor}
              onHexChange={setMaterialColor}
            />
            <InspectorRangeNumberField
              label="粗糙度"
              rangeAriaLabel="批量材质粗糙度滑杆"
              numberAriaLabel="批量材质粗糙度"
              max="1"
              min="0"
              step="0.01"
              value={materialRoughness}
              onValueChange={(value) => setMaterialRoughness(Number(value))}
            />
            <InspectorRangeNumberField
              label="金属度"
              rangeAriaLabel="批量材质金属度滑杆"
              numberAriaLabel="批量材质金属度"
              max="1"
              min="0"
              step="0.01"
              value={materialMetalness}
              onValueChange={(value) => setMaterialMetalness(Number(value))}
            />
            <button
              disabled={!effectiveSelectedObjectIds.length}
              onClick={() => {
                const count = batchUpdateObjects(effectiveSelectedObjectIds, {
                  material: { baseColor: materialColor, roughness: materialRoughness, metalness: materialMetalness },
                });
                setAdvancedStatus(count ? `已批量更新 ${count} 个对象材质` : "没有可更新的对象");
              }}
              type="button"
            >
              应用材质
            </button>
          </div>
        </ObjectAdvancedGroup>
      </div>
    </InspectorPanel>
  );
}
