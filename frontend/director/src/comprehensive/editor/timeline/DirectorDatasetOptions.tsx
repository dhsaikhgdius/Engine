/**
 * @module DirectorDatasetOptions
 * @description Collapsible dataset export options panel for selecting render
 *   passes, additional formats (depth EXR, optical flow, instance annotations),
 *   and per-frame camera/object parameters.
 */

import { useEffect, useRef } from "react";
import { ChevronDown } from "lucide-react";
import type { DirectorMultimodalFrameExportSelection } from "../video/multimodalFrameExport";
import { DIRECTOR_SHOT_RENDER_PASS_IDS, type DirectorShotRenderPassId } from "../shot/shotPackage";
import { useLanguage } from "../../i18n/language";

const RENDER_PASS_LABELS: Record<DirectorShotRenderPassId, string> = {
  clean: "干净",
  clay: "白模",
  albedo: "反照率",
  roughness: "粗糙度",
  metalness: "金属度",
  emissive: "自发光",
  ao: "AO",
  shadow: "阴影",
  depth: "深度",
  normal: "法线",
  "object-id": "物体ID",
  mask: "蒙版",
  pose: "姿态",
  lineart: "线稿",
  semantic: "语义",
  motion: "光流",
};

/** Removes an optional flag entirely instead of writing `false`, keeping the selection payload minimal. */
function omitFlag<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const { [key]: _removed, ...rest } = value;
  return rest;
}

/**
 * Toggles one render pass with two invariants: at least one pass stays
 * selected, and the result preserves catalog order (not click order) so the
 * exported package layout is deterministic. Deselecting "depth" also drops
 * the dependent depth-EXR flag.
 */
function toggleRenderPass(
  current: DirectorMultimodalFrameExportSelection,
  renderPass: DirectorShotRenderPassId,
): DirectorMultimodalFrameExportSelection {
  const enabled = current.renderPasses.includes(renderPass);
  if (enabled && current.renderPasses.length === 1) return current;
  const renderPasses = enabled
    ? current.renderPasses.filter((pass) => pass !== renderPass)
    : DIRECTOR_SHOT_RENDER_PASS_IDS.filter((pass) => pass === renderPass || current.renderPasses.includes(pass));
  if (enabled && renderPass === "depth") return { ...omitFlag(current, "depthExr"), renderPasses };
  return { ...current, renderPasses };
}

/** One labelled checkbox chip in the dataset panel. */
function DatasetChip({
  ariaLabel,
  checked,
  disabled,
  label,
  onChange,
  title,
}: {
  ariaLabel: string;
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
  title?: string;
}) {
  const { t } = useLanguage();
  return (
    <label className="animation-timeline-dataset-chip" title={title}>
      <input
        aria-label={ariaLabel}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
        type="checkbox"
      />
      <span>{t(label)}</span>
    </label>
  );
}

/**
 * Controlled options popover: the parent owns the selection (it is passed to
 * the multimodal export) and this component only proposes replacements via
 * `onChange`. Uses a native `<details>` element with manual light-dismiss
 * (outside pointer / Escape) since `<details>` has no built-in popover close.
 */
export function DirectorDatasetOptions({
  disabled,
  selection,
  onChange,
}: {
  disabled: boolean;
  selection: DirectorMultimodalFrameExportSelection;
  onChange: (next: DirectorMultimodalFrameExportSelection) => void;
}) {
  const { t } = useLanguage();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const depthSelected = selection.renderPasses.includes("depth");
  const onlyOnePass = selection.renderPasses.length === 1;
  const allPassesSelected = selection.renderPasses.length === DIRECTOR_SHOT_RENDER_PASS_IDS.length;

  useEffect(() => {
    const node = detailsRef.current;
    if (!node) return;

    const closeIfOutside = (event: PointerEvent) => {
      if (!node.open) return;
      if (event.target instanceof Node && node.contains(event.target)) return;
      node.open = false;
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !node.open) return;
      event.stopPropagation();
      node.open = false;
    };

    document.addEventListener("pointerdown", closeIfOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeIfOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  return (
    <details className="animation-timeline-dataset-options" ref={detailsRef}>
      <summary>
        数据选项
        <small aria-hidden="true">{selection.renderPasses.length}</small>
        <ChevronDown aria-hidden size={12} strokeWidth={1.75} />
      </summary>
      <div className="animation-timeline-dataset-panel" role="group" aria-label="数据导出选项">
        <header>
          <strong>{t("图像通道（至少一项）")}</strong>
          <div className="animation-timeline-dataset-presets">
            <button
              disabled={disabled || (selection.renderPasses.length === 1 && selection.renderPasses[0] === "clean")}
              onClick={() => onChange({ ...omitFlag(selection, "depthExr"), renderPasses: ["clean"] })}
              type="button"
            >
              {t("仅干净")}
            </button>
            <button
              disabled={disabled || allPassesSelected}
              onClick={() => onChange({ ...selection, renderPasses: [...DIRECTOR_SHOT_RENDER_PASS_IDS] })}
              type="button"
            >
              {t("全选")}
            </button>
          </div>
        </header>
        <div className="animation-timeline-dataset-chips">
          {DIRECTOR_SHOT_RENDER_PASS_IDS.map((renderPass) => {
            const checked = selection.renderPasses.includes(renderPass);
            return (
              <DatasetChip
                ariaLabel={`导出 ${renderPass}`}
                checked={checked}
                disabled={disabled || (checked && onlyOnePass)}
                key={renderPass}
                label={RENDER_PASS_LABELS[renderPass]}
                onChange={() => onChange(toggleRenderPass(selection, renderPass))}
                title={renderPass}
              />
            );
          })}
        </div>
        <section>
          <strong>{t("附加格式")}</strong>
          <div className="animation-timeline-dataset-chips">
            <DatasetChip
              ariaLabel="导出 depth 米制 EXR"
              checked={selection.depthExr === true}
              disabled={disabled || !depthSelected}
              label="深度 EXR"
              onChange={(checked) =>
                onChange(checked ? { ...selection, depthExr: true } : omitFlag(selection, "depthExr"))
              }
              title="depth EXR"
            />
            <DatasetChip
              ariaLabel="导出 motion 稠密光流 EXR"
              checked={selection.denseMotionExr === true}
              disabled={disabled}
              label="光流 EXR"
              onChange={(checked) => onChange({ ...selection, denseMotionExr: checked })}
              title="motion EXR"
            />
            <DatasetChip
              ariaLabel="导出实例标注 JSON"
              checked={selection.includeInstanceAnnotations === true}
              disabled={disabled}
              label="实例 JSON"
              onChange={(checked) =>
                onChange(
                  checked
                    ? { ...selection, includeInstanceAnnotations: true }
                    : omitFlag(selection, "includeInstanceAnnotations"),
                )
              }
            />
          </div>
        </section>
        <section>
          <strong>{t("逐帧参数")}</strong>
          <div className="animation-timeline-dataset-chips">
            <DatasetChip
              ariaLabel="导出相机参数"
              checked={selection.includeCamera}
              disabled={disabled}
              label="相机"
              onChange={(checked) => onChange({ ...selection, includeCamera: checked })}
            />
            <DatasetChip
              ariaLabel="导出对象状态"
              checked={selection.includeObjects}
              disabled={disabled}
              label="对象"
              onChange={(checked) => onChange({ ...selection, includeObjects: checked })}
            />
          </div>
        </section>
      </div>
    </details>
  );
}
