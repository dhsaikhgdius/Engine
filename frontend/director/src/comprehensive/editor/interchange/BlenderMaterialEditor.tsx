/**
 * Blender 材质编辑器，用于在活动网格上创建、编辑材质参数和节点图，以及 UV 投影。
 *
 * @module blender-material-editor
 */

import { useEffect, useMemo, useState } from "react";
import type {
  BlenderAgentOperation,
  BlenderEffectReceipt,
  BlenderMaterialGraph,
  BlenderObjectInspection,
} from "../../../../../../packages/protocol/src/blenderLiveProtocol";
import { useLanguage } from "../../i18n/language";
import {
  blenderAssignMaterialOperation,
  blenderProjectUvOperation,
  type BlenderMaterialFaceScope,
  type BlenderUvProjectionMethod,
} from "../api/blenderLiveClient";
import { hexToLinearRgb, linearRgbToHex } from "./blenderColorSpace";
import { BlenderMaterialNodesEditor } from "./BlenderMaterialNodesEditor";

const NEW_MATERIAL = "__new_material__";

type MaterialState = {
  alpha: number;
  color: string;
  metallic: number;
  roughness: number;
};

interface BlenderMaterialEditorProps {
  activeMeshId: string;
  busy: boolean;
  inspection: BlenderObjectInspection | null;
  mode: "material" | "uv";
  onApply: (
    label: string,
    operations: BlenderAgentOperation[],
    preferredMeshId?: string,
  ) => Promise<BlenderEffectReceipt | null>;
}

const defaultMaterial: MaterialState = {
  alpha: 1,
  color: "#b8c0cc",
  metallic: 0,
  roughness: 0.55,
};

function clampUnit(value: number) {
  return Math.min(1, Math.max(0, value));
}

function materialStateFromGraph(graph: BlenderMaterialGraph | undefined): MaterialState | null {
  const principled = graph?.nodes.find((node) => node.nodeType === "PRINCIPLED_BSDF");
  if (!principled) return null;
  const inputValue = (socketRef: string) =>
    principled.inputs.find((socket) => socket.socketRef === socketRef)?.defaultValue;
  const baseColor = inputValue("Base Color");
  const roughness = inputValue("Roughness");
  const metallic = inputValue("Metallic");
  const alpha = inputValue("Alpha");
  return {
    alpha: typeof alpha === "number" ? alpha : defaultMaterial.alpha,
    color:
      Array.isArray(baseColor) && baseColor.length >= 3
        ? linearRgbToHex([Number(baseColor[0]), Number(baseColor[1]), Number(baseColor[2])])
        : defaultMaterial.color,
    metallic: typeof metallic === "number" ? metallic : defaultMaterial.metallic,
    roughness: typeof roughness === "number" ? roughness : defaultMaterial.roughness,
  };
}

/**
 * 材质编辑器，根据 mode 切换材质编辑（基础颜色、粗糙度、金属度、不透明度）或 UV 投影面板。
 * @param activeMeshId - 当前活动网格的 ID。
 * @param busy - 是否正在执行操作。
 * @param inspection - 当前对象的检查数据。
 * @param mode - 面板模式：material 或 uv。
 * @param onApply - 应用操作的回调。
 */
export function BlenderMaterialEditor({
  activeMeshId,
  busy,
  inspection,
  mode,
  onApply,
}: BlenderMaterialEditorProps) {
  const { t } = useLanguage();
  const materialNames = useMemo(
    () =>
      Array.from(
        new Set([
          ...(inspection?.materialSlots.flatMap((slot) =>
            [slot.resolvedMaterial, slot.dataMaterial].filter((name): name is string => Boolean(name)),
          ) ?? []),
          ...(inspection?.materialGraphs.map((entry) => entry.materialName) ?? []),
        ]),
      ),
    [inspection],
  );
  const [materialChoice, setMaterialChoice] = useState(NEW_MATERIAL);
  const [materialName, setMaterialName] = useState("Director Material");
  const [material, setMaterial] = useState<MaterialState>(defaultMaterial);
  const [faceScope, setFaceScope] = useState<BlenderMaterialFaceScope>("PRESERVE");
  const [uvMethod, setUvMethod] = useState<BlenderUvProjectionMethod>("SMART");
  const activeUvLayer = inspection?.mesh?.uvLayerDetails.find((layer) => layer.active);
  const [uvLayerName, setUvLayerName] = useState("UVMap");
  const [replaceExistingUv, setReplaceExistingUv] = useState(false);
  const creatingMaterial = materialChoice === NEW_MATERIAL;
  const resolvedMaterialName = creatingMaterial ? materialName.trim() : materialChoice;
  const normalizedUvLayerName = uvLayerName.trim();
  const uvLayerExists = inspection?.mesh?.uvLayers.includes(normalizedUvLayerName) ?? false;

  useEffect(() => {
    const firstMaterial = materialNames[0];
    setMaterialChoice((current) => (materialNames.includes(current) ? current : (firstMaterial ?? NEW_MATERIAL)));
    setMaterialName((current) =>
      materialNames.includes(current) ? current : (firstMaterial ?? `${inspection?.name || "Director"} Material`),
    );
  }, [inspection?.id, inspection?.name, materialNames]);

  useEffect(() => {
    if (materialChoice === NEW_MATERIAL) {
      setMaterial(defaultMaterial);
      return;
    }
    const graphState = materialStateFromGraph(
      inspection?.materialGraphs.find((entry) => entry.materialName === materialChoice),
    );
    if (graphState) setMaterial(graphState);
  }, [inspection, materialChoice]);

  useEffect(() => {
    setUvLayerName(activeUvLayer?.name ?? inspection?.mesh?.uvLayers[0] ?? "UVMap");
  }, [activeUvLayer?.name, inspection?.id, inspection?.mesh?.uvLayers]);

  useEffect(() => {
    setFaceScope("PRESERVE");
    setReplaceExistingUv(false);
  }, [inspection?.id]);

  function numberField(field: "alpha" | "roughness" | "metallic", label: string) {
    return (
      <label>
        <span>{label}</span>
        <input
          max={1}
          min={0}
          onChange={(event) => {
            const value = Number(event.currentTarget.value);
            setMaterial((current) => ({
              ...current,
              [field]: clampUnit(value),
            }));
          }}
          step={0.05}
          type="number"
          value={material[field]}
        />
      </label>
    );
  }

  async function applyMaterial() {
    const receipt = await onApply(t("应用材质"), [
      blenderAssignMaterialOperation({
        objectId: activeMeshId,
        materialName: resolvedMaterialName,
        createIfMissing: creatingMaterial,
        faceScope,
        parameters: {
          alpha: material.alpha,
          baseColor: hexToLinearRgb(material.color),
          metallic: material.metallic,
          roughness: material.roughness,
        },
      }),
    ]);
    if (receipt && creatingMaterial) setMaterialChoice(resolvedMaterialName);
  }

  if (mode === "uv") {
    return (
      <div aria-label={t("Blender UV 编辑")} className="blender-uv-editor" role="region">
        <div className="blender-native-editor-summary">
          <span>{t("UV 图层")}</span>
          <small>
            {inspection?.mesh?.uvLayers.length ?? 0} · {activeUvLayer?.loopCount ?? 0} {t("个循环")}
          </small>
        </div>
        <label>
          <span>{t("图层名称")}</span>
          <input
            disabled={busy || !activeMeshId}
            onChange={(event) => setUvLayerName(event.currentTarget.value)}
            value={uvLayerName}
          />
        </label>
        <div aria-label={t("UV 投影方法")} className="blender-mesh-segments" role="group">
          {(["SMART", "UNWRAP", "CUBE"] as const).map((method) => (
            <button
              aria-pressed={uvMethod === method}
              disabled={busy || !activeMeshId}
              key={method}
              onClick={() => setUvMethod(method)}
              type="button"
            >
              {{ SMART: t("智能"), UNWRAP: t("展开"), CUBE: t("立方体") }[method]}
            </button>
          ))}
        </div>
        <label className="blender-uv-replace">
          <input
            checked={replaceExistingUv}
            disabled={busy || !activeMeshId}
            onChange={(event) => setReplaceExistingUv(event.currentTarget.checked)}
            type="checkbox"
          />
          <span>{t("替换同名 UV 层")}</span>
        </label>
        {uvLayerExists && !replaceExistingUv ? (
          <small className="blender-uv-warning" role="status">
            {t("同名 UV 层已存在；开启替换后再执行。")}
          </small>
        ) : null}
        <button
          className="blender-native-editor-apply"
          disabled={busy || !activeMeshId || !normalizedUvLayerName || (uvLayerExists && !replaceExistingUv)}
          onClick={() =>
            void onApply(t("生成 UV"), [
              blenderProjectUvOperation({
                objectId: activeMeshId,
                method: uvMethod,
                uvLayerName: normalizedUvLayerName,
                replaceExisting: replaceExistingUv,
              }),
            ])
          }
          type="button"
        >
          {t("生成 UV")}
        </button>
      </div>
    );
  }

  return (
    <div aria-label={t("Blender 材质编辑")} className="blender-material-editor" role="region">
      <label className="blender-material-picker">
        <span>{t("材质")}</span>
        <select
          disabled={busy || !activeMeshId}
          onChange={(event) => {
            const choice = event.currentTarget.value;
            setMaterialChoice(choice);
            setMaterialName(choice === NEW_MATERIAL ? `${inspection?.name || "Director"} Material` : choice);
          }}
          value={materialChoice}
        >
          {materialNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
          <option value={NEW_MATERIAL}>{t("新建材质…")}</option>
        </select>
      </label>
      {creatingMaterial ? (
        <label className="blender-material-name">
          <span>{t("名称")}</span>
          <input
            disabled={busy || !activeMeshId}
            onChange={(event) => setMaterialName(event.currentTarget.value)}
            value={materialName}
          />
        </label>
      ) : null}
      <div className="blender-material-parameters">
        <label className="blender-material-color">
          <span>{t("基础颜色")}</span>
          <input
            disabled={busy || !activeMeshId}
            onChange={(event) => {
              const color = event.currentTarget.value;
              setMaterial((current) => ({
                ...current,
                color,
              }));
            }}
            type="color"
            value={material.color}
          />
        </label>
        {numberField("roughness", t("粗糙度"))}
        {numberField("metallic", t("金属度"))}
        {numberField("alpha", t("不透明度"))}
      </div>
      <div className="blender-material-scope">
        <div className="blender-native-editor-summary">
          <span>{t("作用范围")}</span>
          <small>
            {inspection?.mesh?.selection?.faces.count ?? 0} {t("个面已选")}
          </small>
        </div>
        <div aria-label={t("材质作用范围")} className="blender-mesh-segments" role="group">
          {(["PRESERVE", "SELECTED", "ALL"] as const).map((scope) => (
            <button
              aria-pressed={faceScope === scope}
              disabled={busy || !activeMeshId}
              key={scope}
              onClick={() => setFaceScope(scope)}
              type="button"
            >
              {{ PRESERVE: t("保留"), SELECTED: t("已选面"), ALL: t("全部面") }[scope]}
            </button>
          ))}
        </div>
      </div>
      <button
        className="blender-native-editor-apply"
        disabled={busy || !activeMeshId || !resolvedMaterialName}
        onClick={() => void applyMaterial()}
        type="button"
      >
        {creatingMaterial ? t("新建并应用") : t("应用材质")}
      </button>
      <BlenderMaterialNodesEditor
        activeMeshId={activeMeshId}
        busy={busy}
        inspection={inspection}
        materialName={creatingMaterial ? "" : resolvedMaterialName}
        onApply={onApply}
      />
    </div>
  );
}
