/**
 * 掌镜模式 HUD 叠加层，显示控制状态、目标信息、快捷键提示和操作按钮。
 *
 * @module camera-pilot-hud
 */

import { CornerDownLeft, Crosshair, LogOut, MousePointer2 } from "lucide-react";
import { useLanguage } from "../../i18n/language";

/**
 * 渲染掌镜模式 HUD，包含状态指示、准星/目标信息、快捷键帮助和退出/录制按钮。
 * @param controlActive - 是否已激活拖拽控制。
 * @param currentFrame - 当前帧编号。
 * @param lockedTargetName - 锁定的目标名称。
 * @param onExit - 退出掌镜模式回调。
 * @param onRecord - 录制轨迹点回调。
 * @param pointedTargetName - 准星瞄准的目标名称。
 * @param recordedCount - 已录制的轨迹点数量。
 * @param targetLocked - 是否已锁定目标。
 */
export function CameraPilotHud({
  controlActive,
  currentFrame,
  lockedTargetName,
  onExit,
  onRecord,
  pointedTargetName,
  recordedCount,
  targetLocked,
}: {
  controlActive: boolean;
  currentFrame: number;
  lockedTargetName: string | null;
  onExit: () => void;
  onRecord: () => void;
  pointedTargetName: string | null;
  recordedCount: number;
  targetLocked: boolean;
}) {
  const { t } = useLanguage();
  const targetName = targetLocked ? (lockedTargetName ?? t("当前视点")) : pointedTargetName;
  const targetAction = targetLocked ? t("解锁目标") : t("锁定目标");
  const controlMessage = controlActive ? t("拖拽转向 · WASD 已启用") : t("点击场景启用拖拽与 WASD");
  return (
    <div aria-label={t("掌镜模式")} className="camera-pilot-hud">
      <div className="camera-pilot-status" role="status">
        <span aria-hidden className={`camera-pilot-status-dot${controlActive ? " is-active" : ""}`} />
        <strong>{t("掌镜模式")}</strong>
        <span>
          {controlMessage} · F{currentFrame} · {recordedCount}
        </span>
      </div>

      <div
        aria-label={
          targetLocked
            ? `${t("掌镜模式")} · ${targetName}`
            : targetName
              ? `${targetName} · F`
              : controlActive
                ? t("拖拽取景 · Esc 退出")
                : t("点击场景启用拖拽与 WASD")
        }
        className={`camera-pilot-crosshair${targetLocked ? " is-locked" : targetName ? " is-pointing" : ""}`}
      >
        <span className="camera-pilot-crosshair-ring" />
        <span className="camera-pilot-crosshair-dot" />
        <span className="camera-pilot-target">
          {targetName ? <Crosshair aria-hidden size={13} /> : <MousePointer2 aria-hidden size={13} />}
          {targetLocked
            ? `F · ${targetName}`
            : targetName
              ? `${targetName} · F`
              : controlActive
                ? t("拖拽取景 · Esc 退出")
                : t("点击场景启用拖拽与 WASD")}
        </span>
      </div>

      <div
        aria-label={t(targetLocked ? "WASD 移动 · E/Q 升降 · F 解锁目标" : "WASD 移动 · E/Q 升降 · F 锁定目标")}
        className="camera-pilot-help"
      >
        <span>
          <kbd>W A S D</kbd> {t("移动")}
        </span>
        <span>
          <kbd>← → ↑ ↓</kbd> {t("方向键转视角")}
        </span>
        <span>
          <kbd>E / Q</kbd> ↑ ↓
        </span>
        <span>
          <kbd>Shift / Alt</kbd> {t("加速 / 精细移动")}
        </span>
        <span>
          <kbd>F</kbd> {targetAction}
        </span>
      </div>

      <div className="camera-pilot-actions">
        <button aria-label={t("退出掌镜模式")} type="button" onClick={onExit}>
          <LogOut aria-hidden size={15} />
          Esc
        </button>
        <button aria-label={t("记录当前轨迹点")} className="is-primary" type="button" onClick={onRecord}>
          <CornerDownLeft aria-hidden size={15} />
          {t("Enter 记录轨迹点")}
        </button>
      </div>
    </div>
  );
}
