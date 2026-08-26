/**
 * Unreal 交接专属区块:Sequencer 烘焙回执、洁净帧回执、结构化省略通道,以及
 * 网关 → 编辑器回环实时预览(推送 Director 活动相机;仅预览、绝不写入工程)。
 *
 * @module unreal-handoff-sections
 */

import { Camera, Link2, Link2Off } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Matrix4, Quaternion, Vector3 } from "three";
import type { DirectorDccEngineSendResult } from "../../../../dcc/directorDccEngineContract";
import type { DirectorUnrealLivePreviewSessionStatus } from "../../../../dcc/directorUnrealLivePreviewContract";
import { useLanguage } from "../../../i18n/language";
import {
  closeDirectorUnrealLivePreviewSession,
  openDirectorUnrealLivePreviewSession,
  sendDirectorUnrealLivePreviewFrame,
} from "../../api/dccEngineHandoffClient";
import { useDirectorStore } from "../../store/directorStore";

const OMITTED_CHANNEL_LABELS: Record<string, string> = {
  pose_values: "姿态控制",
  motion_blocks: "动作片段",
  character_rig: "角色绑定",
};

const UNREAL_OMITTED_MATERIAL_LABELS: Record<string, string> = {
  unsupported_channels: "不支持的材质通道",
  no_mesh_target: "材质无网格目标",
  parent_unavailable: "父材质不可用",
  apply_failed: "材质应用失败",
};

const UNREAL_OMITTED_SKELETAL_LABELS: Record<string, string> = {
  skeleton_unavailable: "骨架不可用",
  character_unskinned: "角色无蒙皮",
  empty_actor: "空 Actor",
};

/** zh-CN source strings describing the Unreal send payload. */
export const UNREAL_SEND_NOTES = [
  "以 USD 优先（附 GLB）发送场景、相机与稳定 ID",
  "网关烘焙的变换/相机动画由连接器写入 LevelSequence；Control Rig 姿态与动作片段警示省略",
];

/**
 * Unreal 发送回执:Sequencer 时基与轨道计数、洁净帧 rendered/skipped、
 * 结构化 omittedAnimationChannels(含 Control Rig 省略)。
 */
export function renderUnrealReceipt(result: DirectorDccEngineSendResult, t: (source: string) => string) {
  const sequencer = result.report.sequencer;
  const cleanFrame = result.cleanFrame;
  const omitted = result.omittedAnimationChannels ?? result.report.omittedAnimationChannels ?? [];
  const omittedMaterials = result.report.omittedMaterials ?? [];
  const omittedMaterialCount = result.report.omittedMaterialCount ?? omittedMaterials.length;
  const omittedSkeletal = result.report.omittedSkeletal ?? [];
  const omittedSkeletalCount = result.report.omittedSkeletalCount ?? omittedSkeletal.length;
  const appliedMaterialCount = result.report.appliedMaterialCount;
  return (
    <div className="director-engine-handoff-receipt-extra">
      {sequencer ? (
        <dl aria-label={t("Sequencer 回执")} className="director-engine-handoff-facts">
          <div>
            <dt>{t("显示速率")}</dt>
            <dd>
              {sequencer.displayRate}
              {sequencer.dropFrame ? " DF" : ""}
            </dd>
          </div>
          <div>
            <dt>{t("起始时码")}</dt>
            <dd>{sequencer.startTimecode}</dd>
          </div>
          <div>
            <dt>{t("相机切换")}</dt>
            <dd>{sequencer.cameraCutCount}</dd>
          </div>
          <div>
            <dt>{t("变换轨道")}</dt>
            <dd>{sequencer.transformTrackCount}</dd>
          </div>
          <div>
            <dt>{t("焦距轨道")}</dt>
            <dd>{sequencer.focalLengthTrackCount}</dd>
          </div>
          <div>
            <dt>{t("烘焙关键帧")}</dt>
            <dd>{sequencer.bakedKeyCount}</dd>
          </div>
          {appliedMaterialCount !== undefined ? (
            <div>
              <dt>{t("材质")}</dt>
              <dd>{appliedMaterialCount}</dd>
            </div>
          ) : null}
          {omittedMaterialCount > 0 || omittedMaterials.length > 0 ? (
            <div>
              <dt>{t("省略材质")}</dt>
              <dd>{omittedMaterialCount}</dd>
            </div>
          ) : null}
          {omittedSkeletalCount > 0 || omittedSkeletal.length > 0 ? (
            <div>
              <dt>{t("省略骨骼")}</dt>
              <dd>{omittedSkeletalCount}</dd>
            </div>
          ) : null}
        </dl>
      ) : (
        <p className="director-engine-handoff-empty">{t("本次运行未写入 Sequencer 回执（静态导入）")}</p>
      )}
      {cleanFrame ? (
        <div
          aria-label={t("洁净帧回执")}
          className="director-engine-handoff-clean-frame"
          data-status={cleanFrame.status}
        >
          <Camera aria-hidden size={12} />
          {cleanFrame.status === "rendered" ? (
            <span>
              {t("洁净帧已渲染")} · {cleanFrame.width}×{cleanFrame.height} · F{cleanFrame.frame}
            </span>
          ) : (
            <span>
              {t("洁净帧已跳过")}：{cleanFrame.skipReason}
            </span>
          )}
        </div>
      ) : null}
      {omittedMaterials.length ? (
        <ul aria-label={t("结构化省略材质")} className="director-engine-handoff-list is-warning">
          {omittedMaterials.slice(0, 6).map((entry) => (
            <li key={`material:${entry.code}:${entry.directorId}`}>
              <code data-i18n-user-content>{entry.directorId}</code>
              {` · ${t(UNREAL_OMITTED_MATERIAL_LABELS[entry.code] ?? entry.code)} · `}
              <span data-i18n-user-content title={entry.reason}>
                {entry.reason}
              </span>
            </li>
          ))}
          {omittedMaterials.length > 6 ? (
            <li className="director-engine-handoff-more">+{omittedMaterials.length - 6}</li>
          ) : null}
        </ul>
      ) : null}
      {omittedSkeletal.length ? (
        <ul aria-label={t("结构化省略骨骼")} className="director-engine-handoff-list is-warning">
          {omittedSkeletal.slice(0, 6).map((entry) => (
            <li key={`skeletal:${entry.code}:${entry.directorId}`}>
              <code data-i18n-user-content>{entry.directorId}</code>
              {` · ${t(UNREAL_OMITTED_SKELETAL_LABELS[entry.code] ?? entry.code)} · `}
              <span data-i18n-user-content title={entry.reason}>
                {entry.reason}
              </span>
            </li>
          ))}
          {omittedSkeletal.length > 6 ? (
            <li className="director-engine-handoff-more">+{omittedSkeletal.length - 6}</li>
          ) : null}
        </ul>
      ) : null}
      {omitted.length ? (
        <ul aria-label={t("省略的动画通道")} className="director-engine-handoff-list is-warning">
          {omitted.slice(0, 6).map((entry) => (
            <li key={`${entry.directorId}:${entry.channels.join(",")}`}>
              <code data-i18n-user-content>{entry.directorId}</code>
              {` · ${entry.channels.map((channel) => t(OMITTED_CHANNEL_LABELS[channel] ?? channel)).join("、")} · ${t("仅烘焙世界变换")}`}
            </li>
          ))}
          {omitted.length > 6 ? <li className="director-engine-handoff-more">+{omitted.length - 6}</li> : null}
        </ul>
      ) : null}
    </div>
  );
}

/** Preview push cadence; ticks are skipped while a request is still in flight. */
const LIVE_PREVIEW_INTERVAL_MS = 100;

/**
 * Unreal 实时预览:网关到连接器的 127.0.0.1 回环推送。此面板打开网关侧会话并
 * 以固定节奏推送 Director 活动相机(带序号,单向);帧只作用于编辑器视口,
 * 绝不写入工程。共享令牌只存在于网关环境变量,从不经过浏览器。
 */
export function UnrealLiveLinkSection() {
  const { t } = useLanguage();
  const [portInput, setPortInput] = useState("");
  const [session, setSession] = useState<DirectorUnrealLivePreviewSessionStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const sequenceRef = useRef(0);
  const inFlightRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  const stopTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const stopPushing = useCallback(
    async (reason?: string) => {
      stopTimer();
      const sessionId = sessionIdRef.current;
      sessionIdRef.current = null;
      if (reason) setError(reason);
      if (sessionId) {
        try {
          const finalSession = await closeDirectorUnrealLivePreviewSession(sessionId);
          setSession(finalSession);
        } catch {
          // The gateway already dropped the session (peer close, stale sweep);
          // there is nothing durable to clean up on a preview-only channel.
        }
      }
    },
    [stopTimer],
  );

  useEffect(
    () => () => {
      stopTimer();
      const sessionId = sessionIdRef.current;
      sessionIdRef.current = null;
      if (sessionId) void closeDirectorUnrealLivePreviewSession(sessionId).catch(() => undefined);
    },
    [stopTimer],
  );

  const pushFrame = useCallback(async () => {
    const sessionId = sessionIdRef.current;
    if (!sessionId || inFlightRef.current) return;
    const project = useDirectorStore.getState().project;
    const camera = project.cameras.find((entry) => entry.id === project.activeCameraId) ?? project.cameras[0];
    if (!camera) return;
    const eye = new Vector3(...camera.transform.position);
    const target = new Vector3(...camera.target);
    if (eye.distanceToSquared(target) < 1e-10) return;
    const rotation = new Quaternion().setFromRotationMatrix(new Matrix4().lookAt(eye, target, new Vector3(0, 1, 0)));
    sequenceRef.current += 1;
    inFlightRef.current = true;
    try {
      const outcome = await sendDirectorUnrealLivePreviewFrame(sessionId, {
        seq: sequenceRef.current,
        transform: {
          location: [eye.x, eye.y, eye.z],
          rotationQuaternion: [rotation.x, rotation.y, rotation.z, rotation.w],
          scale: [1, 1, 1],
        },
        ...(camera.focalLengthMm ? { focalLengthMm: camera.focalLengthMm } : {}),
      });
      if (sessionIdRef.current !== sessionId) return;
      setSession(outcome.session);
      if (outcome.session.summary.closed) {
        sessionIdRef.current = null;
        stopTimer();
        setError(t("会话已结束（连接器断开或超时）"));
      }
    } catch (pushError) {
      if (sessionIdRef.current !== sessionId) return;
      sessionIdRef.current = null;
      stopTimer();
      setSession(null);
      setError(pushError instanceof Error ? pushError.message : t("Unreal 实时预览推送失败"));
    } finally {
      inFlightRef.current = false;
    }
  }, [stopTimer, t]);

  const startPushing = useCallback(async () => {
    const port = Number.parseInt(portInput.trim(), 10);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      setError(t("端口无效（1-65535，填 live-preview 模式打印的端口）"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const opened = await openDirectorUnrealLivePreviewSession(port);
      sequenceRef.current = 0;
      sessionIdRef.current = opened.sessionId;
      setSession(opened);
      timerRef.current = window.setInterval(() => void pushFrame(), LIVE_PREVIEW_INTERVAL_MS);
    } catch (openError) {
      setSession(null);
      setError(openError instanceof Error ? openError.message : t("Unreal 实时预览会话打开失败"));
    } finally {
      setBusy(false);
    }
  }, [portInput, pushFrame, t]);

  const pushing = session !== null && sessionIdRef.current !== null && !session.summary.closed;

  return (
    <div className="director-engine-handoff-live" data-live-engine="unreal">
      <div className="director-engine-handoff-live-toolbar">
        <input
          aria-label={t("Unreal 实时预览端口")}
          className="ui-field"
          disabled={busy || pushing}
          inputMode="numeric"
          onChange={(event) => setPortInput(event.currentTarget.value)}
          placeholder={t("连接器端口")}
          spellCheck={false}
          value={portInput}
        />
        {pushing ? (
          <button disabled={busy} onClick={() => void stopPushing()} type="button">
            {t("停止推送")}
          </button>
        ) : (
          <button disabled={busy || !portInput.trim()} onClick={() => void startPushing()} type="button">
            {t("推送活动相机")}
          </button>
        )}
      </div>
      {error ? (
        <p className="director-engine-handoff-error" role="alert">
          {error}
        </p>
      ) : null}
      {session ? (
        <div className="director-engine-handoff-live-status" data-status={pushing ? "connected" : "disconnected"}>
          {pushing ? <Link2 aria-hidden size={12} /> : <Link2Off aria-hidden size={12} />}
          <span>
            {pushing ? t("已连接（网关 → 编辑器回环推送）") : t("已断开")} · {t("已转发")}{" "}
            {session.summary.forwardedFrameCount} · {t("已丢弃")} {session.summary.droppedFrameCount}
          </span>
        </div>
      ) : (
        <div className="director-engine-handoff-live-status" data-status="disconnected">
          <Link2Off aria-hidden size={12} />
          <span>{t("未连接；在引擎侧运行 director_headless.py --mode live-preview，填入其打印的端口")}</span>
        </div>
      )}
      <ul className="director-engine-handoff-notes">
        <li>{t("链路仅绑定 127.0.0.1、单向、带序号；帧只作用于编辑器视口，绝不写入工程")}</li>
        <li>
          {t("共享令牌 DIRECTOR_UNREAL_PREVIEW_TOKEN 由网关与引擎环境各自读取，从不经过浏览器")}
        </li>
        <li>{t("Remote Control 不是安全边界；此链路不经过也不依赖它")}</li>
      </ul>
    </div>
  );
}
