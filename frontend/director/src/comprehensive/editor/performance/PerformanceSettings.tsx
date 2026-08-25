/**
 * @module PerformanceSettings
 * @description Popover panel for selecting a performance profile and
 *   fine-tuning render resolution, shadows, and character budget overrides.
 */

import { Download, Gauge, RotateCcw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLanguage } from "../../i18n/language";
import { PERFORMANCE_PROFILE_CONFIGS, PERFORMANCE_PROFILE_OPTIONS, resolveRenderDpr } from "./performanceProfiles";
import {
  downloadAnonymousPerformanceReport,
  resetPerformanceConfigOverrides,
  setPerformanceConfigOverride,
  setSelectedPerformanceProfile,
  usePerformanceRuntimeSnapshot,
} from "./performanceRuntime";

function formatDpr(value: number) {
  return `${Number(value.toFixed(2))}×`;
}

function PerformanceDprControl({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="performance-range-control">
      <span>{label}</span>
      <input
        aria-label={`${label}像素密度`}
        max="4"
        min="0.5"
        step="0.25"
        type="range"
        value={value}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
      <output>{formatDpr(value)}</output>
    </label>
  );
}

export function PerformanceSettings() {
  const { t } = useLanguage();
  const runtime = usePerformanceRuntimeSnapshot();
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selectedOption =
    PERFORMANCE_PROFILE_OPTIONS.find((option) => option.id === runtime.selectedProfileId) ??
    PERFORMANCE_PROFILE_OPTIONS[0];
  const effectiveProfile = PERFORMANCE_PROFILE_CONFIGS[runtime.effectiveProfileId];
  const config = runtime.resolvedConfig;
  const hasCustomOverrides = Object.keys(runtime.configOverrides).length > 0;
  const devicePixelRatio = typeof window === "undefined" ? 1 : Math.max(1, window.devicePixelRatio || 1);

  useEffect(() => {
    if (!open) return;
    function closeOutside(event: PointerEvent) {
      if (!(event.target instanceof Node) || wrapperRef.current?.contains(event.target)) return;
      setOpen(false);
    }
    function closeWithEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    }
    document.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeWithEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeWithEscape);
    };
  }, [open]);

  return (
    <div className="performance-settings" ref={wrapperRef}>
      <button
        ref={triggerRef}
        aria-controls="performance-settings-popover"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`${t("性能")} ${t(selectedOption.label)}${hasCustomOverrides ? ` ${t("自定义")}` : ""}`}
        className={`top-bar-settings-trigger performance-settings-trigger${open ? " is-active" : ""}`}
        type="button"
        onClick={() => setOpen((current) => !current)}
      >
        <Gauge aria-hidden size={14} strokeWidth={1.9} />
        <span className="top-bar-settings-label">性能</span>
        <span className="top-bar-settings-value">
          {selectedOption.label}
          {hasCustomOverrides ? ` · ${t("自定义")}` : ""}
        </span>
      </button>

      {open ? (
        <section
          id="performance-settings-popover"
          aria-label="性能档位设置"
          className="performance-settings-popover"
          role="dialog"
        >
          <header className="performance-settings-header">
            <div>
              <strong>性能档位</strong>
              <small>统一调整视口、阴影与资源预览预算</small>
            </div>
            <button aria-label="关闭性能档位设置" type="button" onClick={() => setOpen(false)}>
              <X aria-hidden size={15} />
            </button>
          </header>

          <div className="performance-profile-list" role="radiogroup" aria-label="选择性能档位">
            {PERFORMANCE_PROFILE_OPTIONS.map((option) => {
              const checked = option.id === runtime.selectedProfileId;
              return (
                <button
                  key={option.id}
                  aria-checked={checked}
                  className={checked ? "is-selected" : ""}
                  role="radio"
                  type="button"
                  onClick={() => setSelectedPerformanceProfile(option.id)}
                >
                  <span className="performance-profile-radio" aria-hidden />
                  <span>
                    <strong>{option.label}</strong>
                    <small>{option.description}</small>
                  </span>
                </button>
              );
            })}
          </div>

          <section className="performance-custom-controls" aria-label="精细调节">
            <header>
              <div>
                <strong>精细调节</strong>
                <small>以下设置会覆盖当前档位，可随时恢复</small>
              </div>
              <button
                className="performance-reset-button"
                disabled={!hasCustomOverrides}
                type="button"
                onClick={resetPerformanceConfigOverrides}
              >
                <RotateCcw aria-hidden size={12} />
                恢复当前档位默认值
              </button>
            </header>

            <div className="performance-control-group">
              <h3>渲染分辨率</h3>
              <PerformanceDprControl
                label="主视口"
                value={resolveRenderDpr(config.mainDpr, devicePixelRatio)}
                onChange={(value) => setPerformanceConfigOverride("mainDpr", value)}
              />
              <PerformanceDprControl
                label="四视图"
                value={resolveRenderDpr(config.quadDpr, devicePixelRatio)}
                onChange={(value) => setPerformanceConfigOverride("quadDpr", value)}
              />
              <PerformanceDprControl
                label="辅助视图"
                value={resolveRenderDpr(config.gizmoDpr, devicePixelRatio)}
                onChange={(value) => setPerformanceConfigOverride("gizmoDpr", value)}
              />
              <PerformanceDprControl
                label="资产预览"
                value={resolveRenderDpr(config.previewDpr, devicePixelRatio)}
                onChange={(value) => setPerformanceConfigOverride("previewDpr", value)}
              />
            </div>

            <div className="performance-control-group">
              <h3>光影</h3>
              <label className="performance-toggle-control">
                <span>实时阴影</span>
                <input
                  aria-label="启用实时阴影"
                  checked={config.shadowsEnabled}
                  type="checkbox"
                  onChange={(event) => setPerformanceConfigOverride("shadowsEnabled", event.currentTarget.checked)}
                />
              </label>
              <label className="performance-select-control">
                <span>阴影分辨率</span>
                <select
                  aria-label="阴影分辨率"
                  value={config.shadowMapSize}
                  onChange={(event) =>
                    setPerformanceConfigOverride(
                      "shadowMapSize",
                      Number(event.currentTarget.value) as 512 | 1024 | 2048 | 4096,
                    )
                  }
                >
                  <option value="512">512 px</option>
                  <option value="1024">1024 px</option>
                  <option value="2048">2048 px</option>
                  <option value="4096">4096 px</option>
                </select>
              </label>
            </div>

            <div className="performance-control-group">
              <h3>角色</h3>
              <label className="performance-select-control">
                <span>动画采样</span>
                <select
                  aria-label="角色动画采样"
                  value={config.characterAnimationSampling}
                  onChange={(event) =>
                    setPerformanceConfigOverride(
                      "characterAnimationSampling",
                      event.currentTarget.value as "adaptive" | "full",
                    )
                  }
                >
                  <option value="adaptive">自适应</option>
                  <option value="full">逐帧</option>
                </select>
              </label>
              <label className="performance-number-control">
                <span>
                  标签上限
                  <small>0 表示不限制；选中的角色始终显示标签</small>
                </span>
                <input
                  aria-label="角色标签上限"
                  max="500"
                  min="0"
                  type="number"
                  value={config.characterLabelBudget ?? 0}
                  onChange={(event) => {
                    const value = Math.min(500, Math.max(0, Math.round(Number(event.currentTarget.value))));
                    setPerformanceConfigOverride("characterLabelBudget", value === 0 ? null : value);
                  }}
                />
              </label>
            </div>
          </section>

          <div className="performance-settings-status" role="status">
            <span>
              当前实际使用{" "}
              <strong>
                {effectiveProfile.label}
                {hasCustomOverrides ? ` · ${t("自定义")}` : ""}
              </strong>
            </span>
            <span>
              {runtime.averageFps === null
                ? "正在等待稳定帧样本…"
                : `${runtime.averageFps.toFixed(1)} FPS · P95 ${runtime.p95FrameMs?.toFixed(1) ?? "—"} ms`}
            </span>
          </div>

          <button
            className="performance-report-download"
            disabled={runtime.averageFps === null}
            type="button"
            onClick={downloadAnonymousPerformanceReport}
          >
            <Download aria-hidden size={14} />
            下载匿名性能报告
          </button>
        </section>
      ) : null}
    </div>
  );
}
