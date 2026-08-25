import { Car, Circle, Eye, Footprints, Hand, Keyboard, LogOut, MousePointer2, Plane, UserRound } from "lucide-react";
import { useEffect, useState } from "react";
import { useLanguage } from "../../i18n/language";
import { PLAYER_ROAM_EMOTES } from "./playerEmotes";
import { PLAYER_CONTROLLER_KEY_HINTS, type PlayerRuntimeStatus, type PlayerViewMode } from "./playerLocomotion";

export type PlayerModeActorOption = { id: string; name: string };

function formatRecordingClock(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** Presentational elapsed-recording clock; the frame-accurate takes live in the timeline. */
function useRecordingSeconds(recording: boolean) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    if (!recording) {
      setElapsedSeconds(0);
      return;
    }
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 500);
    return () => window.clearInterval(timer);
  }, [recording]);
  return elapsedSeconds;
}

export function PlayerModeHud({
  actors = [],
  activeActorId,
  controlActive,
  flying,
  onEmote,
  onExit,
  onSelectActor,
  onToggleFlight,
  onToggleRecording,
  onToggleView,
  playerName,
  recording,
  runtimeStatus,
  viewMode,
}: {
  actors?: PlayerModeActorOption[];
  activeActorId?: string;
  controlActive: boolean;
  flying: boolean;
  onEmote?: (clipId: string) => void;
  onExit: () => void;
  onSelectActor?: (id: string) => void;
  onToggleFlight: () => void;
  onToggleRecording: () => void;
  onToggleView: () => void;
  playerName: string;
  recording: boolean;
  runtimeStatus?: PlayerRuntimeStatus | null;
  viewMode: PlayerViewMode;
}) {
  const { t } = useLanguage();
  const controlMessage = controlActive ? t("鼠标转向 · WASD 已启用") : t("点击场景锁定鼠标转向");
  const recordingSeconds = useRecordingSeconds(recording);
  const actorSwitchAvailable = Boolean(onSelectActor) && actors.length > 1;
  const activeEmoteClipId = runtimeStatus?.emoteClipId ?? null;
  const driving = runtimeStatus?.vehicle?.phase === "driving";
  const [keysOpen, setKeysOpen] = useState(false);
  return (
    <>
      <aside className="player-controller-hud" aria-label={t("角色漫游控制")}>
        <div className="player-controller-hud-heading">
          <span>
            <Footprints aria-hidden size={14} /> {t("角色漫游")}
          </span>
          {recording ? (
            <span aria-label={t("录制中")} className="player-controller-rec-badge" role="status">
              <Circle aria-hidden fill="currentColor" size={8} />
              {formatRecordingClock(recordingSeconds)}
            </span>
          ) : null}
          <button
            aria-expanded={keysOpen}
            aria-label={t("键位说明")}
            className={`player-controller-hud-icon-button${keysOpen ? " is-active" : ""}`}
            title={t("键位说明")}
            type="button"
            // Keep pointer focus on the stage so WASD stays live after the click.
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => setKeysOpen((open) => !open)}
          >
            <Keyboard aria-hidden size={14} />
          </button>
          <button aria-label={t("退出角色漫游")} className="player-controller-hud-exit" onClick={onExit} type="button">
            <LogOut aria-hidden size={14} />
          </button>
        </div>
        {actorSwitchAvailable ? (
          <label className="player-controller-actor-switch">
            <UserRound aria-hidden size={13} />
            <select
              aria-label={t("切换漫游角色")}
              value={activeActorId ?? actors[0]?.id}
              onChange={(event) => onSelectActor?.(event.currentTarget.value)}
            >
              {actors.map((actor) => (
                <option key={actor.id} value={actor.id} data-i18n-user-content>
                  {t(actor.name)}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p>
            <UserRound aria-hidden size={13} /> <span data-i18n-user-content>{t(playerName)}</span>
          </p>
        )}
        <div aria-live="polite" className={`player-controller-lock-status${controlActive ? " is-active" : ""}`}>
          <MousePointer2 aria-hidden size={12} />
          {controlMessage}
        </div>
        {runtimeStatus?.crouching || runtimeStatus?.slowWalking ? (
          <div className="player-controller-camera-status player-controller-gait-status" role="status">
            {runtimeStatus?.crouching ? <span className="is-crouching">{t("蹲伏中")}</span> : null}
            {runtimeStatus?.slowWalking ? <span className="is-slow-walking">{t("缓步中")}</span> : null}
          </div>
        ) : null}
        {runtimeStatus?.vehicle?.phase === "prompt" ? (
          <div aria-live="polite" className="player-controller-lock-status is-active" role="status">
            <Car aria-hidden size={12} />
            {t("按 E 进入载具")} · <span data-i18n-user-content>{t(runtimeStatus.vehicle.vehicleName)}</span>
          </div>
        ) : null}
        {runtimeStatus?.interaction && !runtimeStatus.vehicle ? (
          <div aria-live="polite" className="player-controller-lock-status is-active" role="status">
            <Hand aria-hidden size={12} />
            {t("按 E")} · <span data-i18n-user-content>{t(runtimeStatus.interaction.prompt)}</span>
          </div>
        ) : null}
        {runtimeStatus?.vehicle?.phase === "driving" ? (
          <div
            aria-label={`${t("驾驶中")}；${Math.round(runtimeStatus.vehicle.speedKph)} km/h`}
            className="player-controller-camera-status player-controller-vehicle-status"
            role="status"
          >
            <span>
              <Car aria-hidden size={12} /> <span data-i18n-user-content>{t(runtimeStatus.vehicle.vehicleName)}</span>
            </span>
            <span>{Math.round(runtimeStatus.vehicle.speedKph)} km/h</span>
            <span>{t("按 E 下车")}</span>
          </div>
        ) : null}
        {runtimeStatus?.viewMode === "third" ? (
          <div
            aria-label={`${t("第三人称相机状态")}；${t("视距")} ${runtimeStatus.cameraDistance.toFixed(2)} m；${t("相机")} ${runtimeStatus.cameraPosition.map((value) => value.toFixed(2)).join(",")}；${t("角色")} ${runtimeStatus.playerPosition.map((value) => value.toFixed(2)).join(",")}；${t("目标")} ${runtimeStatus.targetPosition.map((value) => value.toFixed(2)).join(",")}`}
            className="player-controller-camera-status"
            data-camera-position={runtimeStatus.cameraPosition.join(",")}
            data-player-position={runtimeStatus.playerPosition.join(",")}
            data-target-position={runtimeStatus.targetPosition.join(",")}
          >
            <span>
              {t("视距")} {runtimeStatus.cameraDistance.toFixed(1)} m
            </span>
            {runtimeStatus.aiming ? <span className="is-aiming">{t("瞄准中")}</span> : null}
            {runtimeStatus.cameraObstructed ? <span>{t("相机避障中")}</span> : <span>{t("自由跟随")}</span>}
            {!runtimeStatus.playerVisible ? <span>{t("近距隐藏角色")}</span> : null}
          </div>
        ) : null}
        {/* Action buttons keep pointer focus on the stage so WASD stays live. */}
        <div className="player-controller-hud-actions">
          <button
            aria-pressed={viewMode === "first"}
            type="button"
            onPointerDown={(event) => event.preventDefault()}
            onClick={onToggleView}
          >
            <Eye aria-hidden size={13} /> {viewMode === "first" ? t("第一人称") : t("第三人称")}
          </button>
          <button
            aria-pressed={flying}
            type="button"
            onPointerDown={(event) => event.preventDefault()}
            onClick={onToggleFlight}
          >
            <Plane aria-hidden size={13} /> {flying ? t("飞行中") : t("步行")}
          </button>
          <button
            aria-pressed={recording}
            className={recording ? "is-recording" : undefined}
            type="button"
            onPointerDown={(event) => event.preventDefault()}
            onClick={onToggleRecording}
          >
            <Circle aria-hidden fill={recording ? "currentColor" : "none"} size={13} />{" "}
            {recording ? t("停止记录") : t("记录移动")}
          </button>
        </div>
        <small>{t("点击锁定鼠标转向 / 滚轮：视距 / Esc：解锁")}</small>
        {keysOpen ? (
          <dl className="player-controller-hud-keys" aria-label={t("漫游快捷键")}>
            {PLAYER_CONTROLLER_KEY_HINTS.map((hint) => (
              <div key={hint.keys.join("-")} className="player-controller-hud-key-row">
                <dt>
                  {hint.keys.map((key) => (
                    <kbd key={key}>{key}</kbd>
                  ))}
                </dt>
                <dd>{t(hint.action)}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </aside>
      {onEmote && !driving ? (
        <div aria-label={t("表情动作")} className="player-controller-emote-dock" role="group">
          {PLAYER_ROAM_EMOTES.map((emote) => (
            <button
              aria-pressed={activeEmoteClipId === emote.clipId}
              key={emote.clipId}
              type="button"
              // Keep pointer focus on the stage so WASD stays live after the
              // click; the emote itself is delivered through onEmote.
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => onEmote(emote.clipId)}
            >
              <kbd aria-hidden>{emote.hotkeyLabel}</kbd>
              <span>{t(emote.name)}</span>
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}
