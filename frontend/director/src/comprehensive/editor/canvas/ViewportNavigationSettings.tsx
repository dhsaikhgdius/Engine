/**
 * 视口导航设置面板，提供视角灵敏度、移动速度、掌镜手感和舞台音效的调整控件。
 *
 * @module viewport-navigation-settings
 */

import { RotateCcw, Settings2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLanguage } from "../../i18n/language";
import { setStageViewportAudioEnabled, useStageViewportAudioEnabled } from "../audio/stageViewportAudio";
import {
  CAMERA_PILOT_FEEL_MAX,
  CAMERA_PILOT_FEEL_MIN,
  CAMERA_PILOT_FEEL_STEP,
  DEFAULT_CAMERA_PILOT_BANK_STRENGTH,
  DEFAULT_CAMERA_PILOT_INERTIA,
  DEFAULT_CAMERA_PILOT_LOOK_SMOOTHING,
  DEFAULT_VIEWPORT_MOVE_SPEED,
  DEFAULT_VIEWPORT_CHARACTER_MOVE_SPEED,
  DEFAULT_VIEWPORT_ROTATE_SENSITIVITY,
  DEFAULT_VIEWPORT_ZOOM_SENSITIVITY,
  VIEWPORT_MOVE_SPEED_MAX,
  VIEWPORT_MOVE_SPEED_MIN,
  VIEWPORT_MOVE_SPEED_STEP,
  VIEWPORT_CHARACTER_MOVE_SPEED_MAX,
  VIEWPORT_CHARACTER_MOVE_SPEED_MIN,
  VIEWPORT_CHARACTER_MOVE_SPEED_STEP,
  VIEWPORT_SENSITIVITY_MAX,
  VIEWPORT_SENSITIVITY_MIN,
  VIEWPORT_SENSITIVITY_STEP,
} from "../schema/viewportNavigation";
import { useDirectorStore } from "../store/directorStore";

function sensitivityLabel(value: number) {
  if (value <= 0.25) return "很慢";
  if (value <= 0.5) return "舒缓";
  if (value <= 0.8) return "适中";
  if (value <= 1.1) return "灵敏";
  return "很快";
}

/**
 * 视口导航设置弹出面板，包含视角灵敏度、移动速度、掌镜手感、舞台音效和 Blender 开关。
 * @param blenderLive - 可选的 Blender 实时连接开关配置。
 */
export function ViewportNavigationSettings({
  blenderLive,
}: {
  blenderLive?: { visible: boolean; onVisibleChange: (visible: boolean) => void };
} = {}) {
  const { t } = useLanguage();
  const rotateSensitivity = useDirectorStore((state) => state.viewportRotateSensitivity);
  const zoomSensitivity = useDirectorStore((state) => state.viewportZoomSensitivity);
  const moveSpeed = useDirectorStore((state) => state.viewportMoveSpeed);
  const characterMoveSpeed = useDirectorStore((state) => state.viewportCharacterMoveSpeed);
  const pilotInertia = useDirectorStore((state) => state.viewportPilotInertia);
  const pilotLookSmoothing = useDirectorStore((state) => state.viewportPilotLookSmoothing);
  const pilotBankStrength = useDirectorStore((state) => state.viewportPilotBankStrength);
  const setRotateSensitivity = useDirectorStore((state) => state.setViewportRotateSensitivity);
  const setZoomSensitivity = useDirectorStore((state) => state.setViewportZoomSensitivity);
  const setMoveSpeed = useDirectorStore((state) => state.setViewportMoveSpeed);
  const setCharacterMoveSpeed = useDirectorStore((state) => state.setViewportCharacterMoveSpeed);
  const setPilotInertia = useDirectorStore((state) => state.setViewportPilotInertia);
  const setPilotLookSmoothing = useDirectorStore((state) => state.setViewportPilotLookSmoothing);
  const setPilotBankStrength = useDirectorStore((state) => state.setViewportPilotBankStrength);
  const reset = useDirectorStore((state) => state.resetViewportNavigation);
  const stageAudioEnabled = useStageViewportAudioEnabled();
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || wrapperRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const defaults =
    rotateSensitivity === DEFAULT_VIEWPORT_ROTATE_SENSITIVITY &&
    zoomSensitivity === DEFAULT_VIEWPORT_ZOOM_SENSITIVITY &&
    moveSpeed === DEFAULT_VIEWPORT_MOVE_SPEED &&
    characterMoveSpeed === DEFAULT_VIEWPORT_CHARACTER_MOVE_SPEED &&
    pilotInertia === DEFAULT_CAMERA_PILOT_INERTIA &&
    pilotLookSmoothing === DEFAULT_CAMERA_PILOT_LOOK_SMOOTHING &&
    pilotBankStrength === DEFAULT_CAMERA_PILOT_BANK_STRENGTH;

  return (
    <div className="viewport-navigation-settings" ref={wrapperRef}>
      <button
        aria-controls="viewport-navigation-popover"
        aria-expanded={open}
        aria-haspopup="dialog"
        className={`top-bar-settings-trigger viewport-navigation-trigger${open ? " is-active" : ""}`}
        ref={triggerRef}
        title={t("视角手感")}
        type="button"
        onClick={() => setOpen((current) => !current)}
      >
        <Settings2 aria-hidden size={14} />
        <span className="top-bar-settings-label">{t("视角手感")}</span>
      </button>

      {open ? (
        <section
          aria-label={t("视角手感设置")}
          className="viewport-navigation-popover"
          id="viewport-navigation-popover"
          role="dialog"
        >
          <header className="viewport-navigation-header">
            <div>
              <strong>{t("视角手感")}</strong>
              <small>{t("拖动后立即生效，并自动保存")}</small>
            </div>
            <button aria-label={t("关闭视角手感设置")} type="button" onClick={() => setOpen(false)}>
              <X aria-hidden size={15} />
            </button>
          </header>

          <NavigationRange
            id="viewport-rotate-sensitivity"
            label={t("转动视角")}
            max={VIEWPORT_SENSITIVITY_MAX}
            min={VIEWPORT_SENSITIVITY_MIN}
            output={`${t(sensitivityLabel(rotateSensitivity))} · ${Math.round(rotateSensitivity * 100)}%`}
            step={VIEWPORT_SENSITIVITY_STEP}
            value={rotateSensitivity}
            onChange={setRotateSensitivity}
          />
          <NavigationRange
            id="viewport-zoom-sensitivity"
            label={t("拉近 / 拉远")}
            max={VIEWPORT_SENSITIVITY_MAX}
            min={VIEWPORT_SENSITIVITY_MIN}
            output={`${t(sensitivityLabel(zoomSensitivity))} · ${Math.round(zoomSensitivity * 100)}%`}
            step={VIEWPORT_SENSITIVITY_STEP}
            value={zoomSensitivity}
            onChange={setZoomSensitivity}
          />
          <NavigationRange
            id="viewport-move-speed"
            label={t("WASD 移动速度")}
            max={VIEWPORT_MOVE_SPEED_MAX}
            min={VIEWPORT_MOVE_SPEED_MIN}
            output={`${moveSpeed.toFixed(1)} m/s`}
            step={VIEWPORT_MOVE_SPEED_STEP}
            value={moveSpeed}
            onChange={setMoveSpeed}
          />
          <NavigationRange
            id="viewport-character-move-speed"
            label={t("人物移速")}
            max={VIEWPORT_CHARACTER_MOVE_SPEED_MAX}
            min={VIEWPORT_CHARACTER_MOVE_SPEED_MIN}
            output={`${characterMoveSpeed.toFixed(2)}×`}
            step={VIEWPORT_CHARACTER_MOVE_SPEED_STEP}
            value={characterMoveSpeed}
            onChange={setCharacterMoveSpeed}
          />

          <div className="viewport-navigation-section-title">{t("舞台音效")}</div>
          <label className="viewport-navigation-toggle">
            <span>
              <strong>{t("启用舞台音效")}</strong>
              <small>{t("天气环境音、漫游脚步与时间线预听")}</small>
            </span>
            <input
              aria-label={t("启用舞台音效")}
              checked={stageAudioEnabled}
              type="checkbox"
              onChange={(event) => setStageViewportAudioEnabled(event.currentTarget.checked)}
            />
          </label>

          <div className="viewport-navigation-section-title">{t("掌镜手感")}</div>
          <NavigationRange
            id="viewport-pilot-inertia"
            label={t("移动惯性")}
            max={CAMERA_PILOT_FEEL_MAX}
            min={CAMERA_PILOT_FEEL_MIN}
            output={`${Math.round(pilotInertia * 100)}%`}
            step={CAMERA_PILOT_FEEL_STEP}
            value={pilotInertia}
            onChange={setPilotInertia}
          />
          <NavigationRange
            id="viewport-pilot-look-smoothing"
            label={t("转向缓动")}
            max={CAMERA_PILOT_FEEL_MAX}
            min={CAMERA_PILOT_FEEL_MIN}
            output={`${Math.round(pilotLookSmoothing * 100)}%`}
            step={CAMERA_PILOT_FEEL_STEP}
            value={pilotLookSmoothing}
            onChange={setPilotLookSmoothing}
          />
          <NavigationRange
            id="viewport-pilot-bank-strength"
            label={t("侧倾幅度")}
            max={CAMERA_PILOT_FEEL_MAX}
            min={CAMERA_PILOT_FEEL_MIN}
            output={`${Math.round(pilotBankStrength * 100)}%`}
            step={CAMERA_PILOT_FEEL_STEP}
            value={pilotBankStrength}
            onChange={setPilotBankStrength}
          />

          {blenderLive ? (
            <>
              <div className="viewport-navigation-section-title">{t("场景显示")}</div>
              <label className="viewport-navigation-toggle">
                <span>
                  <strong>{t("Blender 实时连接")}</strong>
                  <small>{t("显示 Blender 权威环境层")}</small>
                </span>
                <input
                  aria-label="Blender live"
                  checked={blenderLive.visible}
                  type="checkbox"
                  onChange={(event) => blenderLive.onVisibleChange(event.currentTarget.checked)}
                />
              </label>
            </>
          ) : null}

          <p className="viewport-navigation-note">
            {t("浏览与掌镜共用视角手感；人物移速只作用于角色跟随。设置按当前导演台保存。")}
          </p>
          <button className="viewport-navigation-reset" disabled={defaults} type="button" onClick={reset}>
            <RotateCcw aria-hidden size={14} />
            {t("恢复默认手感")}
          </button>
        </section>
      ) : null}
    </div>
  );
}

function NavigationRange({
  id,
  label,
  max,
  min,
  onChange,
  output,
  step,
  value,
}: {
  id: string;
  label: string;
  max: number;
  min: number;
  onChange: (value: number) => void;
  output: string;
  step: number;
  value: number;
}) {
  return (
    <div className="viewport-navigation-control">
      <div className="viewport-navigation-label">
        <label htmlFor={id}>{label}</label>
        <output htmlFor={id}>{output}</output>
      </div>
      <input
        aria-label={label}
        id={id}
        max={max}
        min={min}
        step={step}
        type="range"
        value={value}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
    </div>
  );
}
