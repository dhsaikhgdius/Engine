/**
 * Blender Mesh 编辑器，提供几何编辑（细分、挤出、内插、倒角）、材质和 UV 面板。
 *
 * @module blender-mesh-editor
 */

import { useState } from "react";
import type {
  BlenderAgentOperation,
  BlenderEffectReceipt,
  BlenderLiveSceneSnapshot,
  BlenderObjectInspection,
} from "../../../../../../packages/protocol/src/blenderLiveProtocol";
import { useLanguage } from "../../i18n/language";
import {
  blenderMeshEditOperation,
  blenderMeshSelectionOperation,
  type BlenderMeshDomain,
} from "../api/blenderLiveClient";
import { BlenderMaterialEditor } from "./BlenderMaterialEditor";

type MeshParameters = {
  bevelOffset: number;
  bevelSegments: number;
  extrudeDistance: number;
  insetDepth: number;
  insetThickness: number;
  subdivideCuts: number;
  subdivideSmoothness: number;
};

interface BlenderMeshEditorProps {
  activeMeshId: string;
  busy: boolean;
  inspection: BlenderObjectInspection | null;
  meshes: BlenderLiveSceneSnapshot["objects"];
  onApply: (
    label: string,
    operations: BlenderAgentOperation[],
    preferredMeshId?: string,
  ) => Promise<BlenderEffectReceipt | null>;
  receipt: BlenderEffectReceipt | null;
}

/**
 * 渲染 Mesh 编辑器，包含几何编辑、材质和 UV 面板，通过 Blender 实时会话操作网格。
 * @param activeMeshId - 当前活动网格的 ID。
 * @param busy - 是否正在执行操作。
 * @param inspection - 当前对象的检查数据。
 * @param meshes - 场景中的网格列表。
 * @param onApply - 应用操作的回调。
 * @param receipt - 最近一次操作的效果收据。
 */
export function BlenderMeshEditor({
  activeMeshId,
  busy,
  inspection,
  meshes,
  onApply,
  receipt,
}: BlenderMeshEditorProps) {
  const { t } = useLanguage();
  const [activePanel, setActivePanel] = useState<"geometry" | "material" | "uv">("geometry");
  const [domain, setDomain] = useState<BlenderMeshDomain>("FACE");
  const [parameters, setParameters] = useState<MeshParameters>({
    bevelOffset: 0.08,
    bevelSegments: 2,
    extrudeDistance: 0.25,
    insetDepth: 0,
    insetThickness: 0.12,
    subdivideCuts: 1,
    subdivideSmoothness: 0,
  });

  const selectionKey = domain === "VERTEX" ? "vertices" : domain === "EDGE" ? "edges" : "faces";
  const selectedElementCount = inspection?.mesh?.selection?.[selectionKey].count ?? 0;
  const activeMesh = meshes.find((mesh) => mesh.id === activeMeshId);
  const directorId = activeMesh?.directorId;
  const editMode = inspection?.mode === "EDIT";
  const editDisabled = busy || !activeMeshId || !editMode;

  function numberField(
    field: keyof MeshParameters,
    label: string,
    options: { min: number; max?: number; step: number },
  ) {
    return (
      <label>
        <span>{label}</span>
        <input
          max={options.max}
          min={options.min}
          onChange={(event) => {
            const value = Number(event.currentTarget.value);
            setParameters((current) => ({
              ...current,
              [field]: Number.isFinite(value) ? value : current[field],
            }));
          }}
          step={options.step}
          type="number"
          value={parameters[field]}
        />
      </label>
    );
  }

  return (
    <section aria-label={t("网格编辑")} className="blender-mesh-editor">
      <div className="blender-mesh-editor-heading">
        <div>
          <strong>{t("Mesh 编辑器")}</strong>
          <small data-i18n-user-content>{activeMesh?.name ?? t("选择 Mesh")}</small>
        </div>
        <span className={`blender-mesh-link${directorId ? " is-linked" : ""}`}>
          {directorId ? t("Director 已关联") : t("Director 管理")}
          {directorId ? (
            <code data-i18n-user-content title={directorId}>
              {directorId}
            </code>
          ) : null}
        </span>
      </div>

      <label className="blender-mesh-picker">
        <span>{t("活动 Mesh")}</span>
        <select
          disabled={busy || meshes.length === 0}
          onChange={(event) => {
            const objectId = event.currentTarget.value;
            if (!objectId) return;
            void onApply(
              t("选择活动 Mesh"),
              [
                {
                  op: "set_selection",
                  selectedIds: [objectId],
                  activeId: objectId,
                  mode: "OBJECT",
                },
              ],
              objectId,
            );
          }}
          value={activeMeshId}
        >
          <option value="">{meshes.length ? t("选择 Mesh") : t("场景中没有 Mesh")}</option>
          {meshes.map((mesh) => (
            <option key={mesh.id} value={mesh.id}>
              {mesh.name}
            </option>
          ))}
        </select>
      </label>

      {inspection?.mesh ? (
        <dl className="blender-mesh-facts">
          <div>
            <dt>{t("点")}</dt>
            <dd>{inspection.mesh.vertices}</dd>
          </div>
          <div>
            <dt>{t("边")}</dt>
            <dd>{inspection.mesh.edges}</dd>
          </div>
          <div>
            <dt>{t("面")}</dt>
            <dd>{inspection.mesh.faces}</dd>
          </div>
          <div>
            <dt>{t("修改器")}</dt>
            <dd>{activeMesh?.modifierCount ?? 0}</dd>
          </div>
        </dl>
      ) : null}

      <div aria-label={t("Mesh 编辑面板")} className="blender-mesh-tabs" role="tablist">
        {(["geometry", "material", "uv"] as const).map((panel) => (
          <button
            aria-selected={activePanel === panel}
            key={panel}
            onClick={() => setActivePanel(panel)}
            role="tab"
            type="button"
          >
            {{ geometry: t("几何"), material: t("材质"), uv: "UV" }[panel]}
          </button>
        ))}
      </div>

      {activePanel === "geometry" ? (
        <div className="blender-geometry-editor" role="tabpanel">
          <div className="blender-mesh-mode-row">
            <small>{t("模式")}</small>
            <div aria-label={t("Object Edit 模式")} className="blender-mesh-segments" role="group">
              {(["OBJECT", "EDIT"] as const).map((mode) => (
                <button
                  aria-pressed={inspection?.mode === mode}
                  disabled={busy || !activeMeshId}
                  key={mode}
                  onClick={() =>
                    void onApply(t(mode === "OBJECT" ? "切换 Object Mode" : "切换 Edit Mode"), [
                      {
                        op: "set_selection",
                        selectedIds: [activeMeshId],
                        activeId: activeMeshId,
                        mode,
                      },
                    ])
                  }
                  type="button"
                >
                  {mode === "OBJECT" ? "Object" : "Edit"}
                </button>
              ))}
            </div>
          </div>

          {editMode ? (
            <div className="blender-mesh-edit-tools">
              <div className="blender-mesh-selection-row">
                <div aria-label={t("网格选择域")} className="blender-mesh-segments" role="group">
                  {(["VERTEX", "EDGE", "FACE"] as const).map((nextDomain) => (
                    <button
                      aria-pressed={domain === nextDomain}
                      disabled={editDisabled}
                      key={nextDomain}
                      onClick={() => {
                        setDomain(nextDomain);
                        void onApply(t("切换选择域"), [
                          blenderMeshSelectionOperation({
                            objectId: activeMeshId,
                            domain: nextDomain,
                            action: "RESET",
                          }),
                        ]);
                      }}
                      type="button"
                    >
                      {{ VERTEX: t("点"), EDGE: t("边"), FACE: t("面") }[nextDomain]}
                    </button>
                  ))}
                </div>
                <small>
                  {t("已选")} {selectedElementCount}
                </small>
              </div>

              <div aria-label={t("网格元素选择")} className="blender-mesh-selection-actions" role="group">
                <button
                  disabled={editDisabled}
                  onClick={() =>
                    void onApply(t("全选网格元素"), [
                      blenderMeshSelectionOperation({
                        objectId: activeMeshId,
                        domain,
                        action: "ALL",
                      }),
                    ])
                  }
                  type="button"
                >
                  {t("全选")}
                </button>
                <button
                  disabled={editDisabled}
                  onClick={() =>
                    void onApply(t("取消选择网格元素"), [
                      blenderMeshSelectionOperation({
                        objectId: activeMeshId,
                        domain,
                        action: "NONE",
                      }),
                    ])
                  }
                  type="button"
                >
                  {t("全不选")}
                </button>
              </div>

              <div aria-label={t("网格编辑工具")} className="blender-mesh-operations">
                <div>
                  <strong>{t("细分")}</strong>
                  {numberField("subdivideCuts", t("切割"), {
                    min: 1,
                    max: 64,
                    step: 1,
                  })}
                  {numberField("subdivideSmoothness", t("平滑"), {
                    min: 0,
                    max: 1,
                    step: 0.1,
                  })}
                  <button
                    disabled={editDisabled}
                    onClick={() =>
                      void onApply(t("细分"), [
                        blenderMeshEditOperation(activeMeshId, {
                          tool: "subdivide",
                          cuts: parameters.subdivideCuts,
                          smoothness: parameters.subdivideSmoothness,
                        }),
                      ])
                    }
                    type="button"
                  >
                    {t("细分")}
                  </button>
                </div>
                <div>
                  <strong>{t("挤出")}</strong>
                  {numberField("extrudeDistance", t("距离"), {
                    min: -100,
                    max: 100,
                    step: 0.05,
                  })}
                  <button
                    disabled={editDisabled}
                    onClick={() =>
                      void onApply(t("挤出"), [
                        blenderMeshEditOperation(activeMeshId, {
                          tool: "extrude",
                          distance: parameters.extrudeDistance,
                        }),
                      ])
                    }
                    type="button"
                  >
                    {t("挤出")}
                  </button>
                </div>
                <div>
                  <strong>{t("内插")}</strong>
                  {numberField("insetThickness", t("厚度"), {
                    min: 0,
                    max: 100,
                    step: 0.01,
                  })}
                  {numberField("insetDepth", t("深度"), {
                    min: -100,
                    max: 100,
                    step: 0.01,
                  })}
                  <button
                    disabled={editDisabled || domain !== "FACE"}
                    onClick={() =>
                      void onApply(t("内插"), [
                        blenderMeshEditOperation(activeMeshId, {
                          tool: "inset",
                          thickness: parameters.insetThickness,
                          depth: parameters.insetDepth,
                        }),
                      ])
                    }
                    type="button"
                  >
                    {t("内插")}
                  </button>
                </div>
                <div>
                  <strong>{t("倒角")}</strong>
                  {numberField("bevelOffset", t("宽度"), {
                    min: 0,
                    max: 100,
                    step: 0.01,
                  })}
                  {numberField("bevelSegments", t("段数"), {
                    min: 1,
                    max: 64,
                    step: 1,
                  })}
                  <button
                    disabled={editDisabled}
                    onClick={() =>
                      void onApply(t("倒角"), [
                        blenderMeshEditOperation(activeMeshId, {
                          tool: "bevel",
                          offset: parameters.bevelOffset,
                          segments: parameters.bevelSegments,
                        }),
                      ])
                    }
                    type="button"
                  >
                    {t("倒角")}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <p className="blender-mesh-mode-hint">{t("切换到 Edit 模式以使用点、边、面工具。")}</p>
          )}
        </div>
      ) : (
        <BlenderMaterialEditor
          activeMeshId={activeMeshId}
          busy={busy}
          inspection={inspection}
          mode={activePanel}
          onApply={onApply}
        />
      )}

      {receipt ? (
        <small className="blender-mesh-receipt" role="status">
          rev {receipt.revisionBefore} → {receipt.revisionAfter} · {receipt.dirtyObjectIds.length} {t("个对象更新")}
        </small>
      ) : null}
    </section>
  );
}
