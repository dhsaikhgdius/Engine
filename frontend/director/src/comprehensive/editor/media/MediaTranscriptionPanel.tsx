import { useEffect, useMemo, useRef, useState } from "react";
import { Captions, Download, Languages, RotateCcw, Square, X } from "lucide-react";
import {
  serializeDirectorMediaTranscriptVtt,
  type DirectorMediaTranscript,
} from "../../../../../../packages/protocol/src/mediaTranscriptionProtocol";
import { useLanguage } from "../../i18n/language";
import {
  insertDirectorCaptionCuesIntoTimeline,
  directorMediaTranscriptToCaptionCues,
} from "../workspaces/captionImport";
import { useDirectorCreativeWorkspaceStore } from "../workspaces/directorWorkspaceStore";
import {
  cancelMediaTranscriptionJob,
  fetchDirectorMediaTranscript,
  getMediaTranscriptionCapabilities,
  inspectMediaTranscriptionJob,
  listMediaTranscriptionJobs,
  retryMediaTranscriptionJob,
  submitMediaTranscription,
  type MediaTranscriptionJob,
} from "./mediaTranscriptionBridge";
import { friendlyErrorMessage } from "../api/friendlyError";
import { useSuppressViewportChromeWhileMounted } from "../canvas/viewportChromeSuppression";
import { persistentCreativeMediaLibrary, type CreativeMediaAsset } from "./persistentCreativeMediaStore";
import "../../styles/mediaTranscription.css";

/** Consecutive poll failures tolerated before the panel surfaces an error (avoids single-blip flicker). */
const MAX_POLL_FAILURES = 3;

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function newIdempotencyKey(prefix: string) {
  const id = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  return `${prefix}:${id}`.slice(0, 200);
}

function statusLabel(status: MediaTranscriptionJob["status"]) {
  if (status === "queued") return "排队中";
  if (status === "running") return "转录中";
  if (status === "succeeded") return "已完成";
  if (status === "cancelled") return "已取消";
  if (status === "outcome_unknown") return "执行中断，待重试";
  return "失败";
}

export interface MediaTranscriptionPanelProps {
  asset: CreativeMediaAsset;
  captionOffsetSec?: number;
  onClose: () => void;
  onInserted?: (count: number) => void;
}

export function MediaTranscriptionPanel({
  asset,
  captionOffsetSec = 0,
  onClose,
  onInserted,
}: MediaTranscriptionPanelProps) {
  useSuppressViewportChromeWhileMounted("media-transcription");
  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  const { t } = useLanguage();
  const setWorkspaceMode = useDirectorCreativeWorkspaceStore((state) => state.setMode);
  const [capabilities, setCapabilities] = useState<Awaited<
    ReturnType<typeof getMediaTranscriptionCapabilities>
  > | null>(null);
  const [jobs, setJobs] = useState<MediaTranscriptionJob[]>([]);
  const [activeJob, setActiveJob] = useState<MediaTranscriptionJob | null>(null);
  const [transcript, setTranscript] = useState<DirectorMediaTranscript | null>(asset.transcript ?? null);
  const [language, setLanguage] = useState(asset.transcript?.language ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pollFailures, setPollFailures] = useState(0);
  const [pollErrorDetail, setPollErrorDetail] = useState("");
  const promotedJobRef = useRef<string | null>(asset.transcript?.jobId ?? null);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      getMediaTranscriptionCapabilities(controller.signal),
      listMediaTranscriptionJobs(100, controller.signal),
    ])
      .then(([nextCapabilities, nextJobs]) => {
        const matching = nextJobs.filter((job) => job.input.sourceMediaId === asset.id);
        setCapabilities(nextCapabilities);
        setJobs(matching);
        setActiveJob(matching[0] ?? null);
      })
      .catch((loadError) => {
        if (!controller.signal.aborted)
          setError(loadError instanceof Error ? friendlyErrorMessage(loadError) : t("转录服务不可用"));
      });
    return () => controller.abort();
  }, [asset.id, t]);

  useEffect(() => {
    if (!activeJob || !new Set(["queued", "running"]).has(activeJob.status)) return;
    if (pollFailures >= MAX_POLL_FAILURES) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void inspectMediaTranscriptionJob(activeJob.id, controller.signal)
        .then((job) => {
          setPollFailures(0);
          setPollErrorDetail("");
          setActiveJob(job);
          setJobs((current) => [job, ...current.filter((candidate) => candidate.id !== job.id)]);
        })
        .catch((pollError) => {
          if (controller.signal.aborted) return;
          // Transient blips are retried silently; the error surfaces only after
          // MAX_POLL_FAILURES consecutive failures (with a retry button).
          setPollErrorDetail(friendlyErrorMessage(pollError));
          setPollFailures((count) => count + 1);
        });
    }, 900);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [activeJob, pollFailures]);

  useEffect(() => {
    if (!activeJob || activeJob.status !== "succeeded" || promotedJobRef.current === activeJob.id) return;
    const controller = new AbortController();
    promotedJobRef.current = activeJob.id;
    setBusy(true);
    void fetchDirectorMediaTranscript(activeJob, controller.signal)
      .then(async (nextTranscript) => {
        await persistentCreativeMediaLibrary.setTranscript(asset.id, nextTranscript);
        setTranscript(nextTranscript);
        setLanguage(nextTranscript.language ?? "");
        setNotice(`${nextTranscript.segments.length} ${t("条字幕已写入媒体库")}`);
      })
      .catch((promoteError) => {
        promotedJobRef.current = null;
        if (!controller.signal.aborted)
          setError(promoteError instanceof Error ? friendlyErrorMessage(promoteError) : t("转录结果写入失败"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [activeJob, asset.id, t]);

  const matchingJobs = useMemo(() => jobs.filter((job) => job.input.sourceMediaId === asset.id), [asset.id, jobs]);

  async function submit() {
    setBusy(true);
    setError("");
    setNotice(t("正在校验并上传媒体…"));
    try {
      const blob = await persistentCreativeMediaLibrary.getBlob(asset.id);
      if (!blob) throw new Error(t("媒体原始字节不可用"));
      if (capabilities && blob.size > capabilities.maxInputBytes) {
        throw new Error(`${t("媒体超过转录大小限制")} (${Math.round(capabilities.maxInputBytes / 1024 / 1024)} MB)`);
      }
      const job = await submitMediaTranscription({
        asset,
        blob,
        language: language || undefined,
        idempotencyKey: newIdempotencyKey("transcription"),
      });
      promotedJobRef.current = null;
      setActiveJob(job);
      setJobs((current) => [job, ...current.filter((candidate) => candidate.id !== job.id)]);
      setNotice(t("转录任务已提交"));
    } catch (submitError) {
      setError(submitError instanceof Error ? friendlyErrorMessage(submitError) : t("转录提交失败"));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!activeJob) return;
    setBusy(true);
    setError("");
    try {
      const job = await cancelMediaTranscriptionJob(activeJob.id);
      setActiveJob(job);
      setJobs((current) => [job, ...current.filter((candidate) => candidate.id !== job.id)]);
    } catch (cancelError) {
      setError(cancelError instanceof Error ? friendlyErrorMessage(cancelError) : t("取消转录失败"));
    } finally {
      setBusy(false);
    }
  }

  async function retry() {
    if (!activeJob) return;
    setBusy(true);
    setError("");
    try {
      const job = await retryMediaTranscriptionJob(activeJob.id, newIdempotencyKey("transcription-retry"));
      promotedJobRef.current = null;
      setActiveJob(job);
      setJobs((current) => [job, ...current.filter((candidate) => candidate.id !== job.id)]);
    } catch (retryError) {
      setError(retryError instanceof Error ? friendlyErrorMessage(retryError) : t("重试转录失败"));
    } finally {
      setBusy(false);
    }
  }

  function insertCaptions() {
    if (!transcript) return;
    const result = insertDirectorCaptionCuesIntoTimeline(directorMediaTranscriptToCaptionCues(transcript), {
      sourceMediaId: asset.id,
      transcriptionJobId: transcript.jobId,
      offsetSec: captionOffsetSec,
    });
    if (!result.inserted) {
      setError(t("无法创建字幕轨道"));
      return;
    }
    setWorkspaceMode("video");
    setNotice(`${result.inserted} ${t("条字幕已加入 Video Editor")}`);
    onInserted?.(result.inserted);
  }

  return (
    <div
      className="media-transcription-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section aria-label={t("媒体转录")} aria-modal="true" className="media-transcription-panel" role="dialog">
        <header>
          <div>
            <Languages aria-hidden size={18} />
            <span>
              <strong>{t("媒体转录与字幕")}</strong>
              <small data-i18n-user-content>{asset.name}</small>
            </span>
          </div>
          <button aria-label={t("关闭")} onClick={onClose} type="button">
            <X aria-hidden size={16} />
          </button>
        </header>
        <div className="media-transcription-toolbar">
          <label>
            {t("语言（留空自动识别）")}
            <input
              disabled={busy || activeJob?.status === "running"}
              maxLength={80}
              onChange={(event) => setLanguage(event.currentTarget.value)}
              placeholder="zh / en / ja"
              value={language}
            />
          </label>
          <div>
            <button
              className="is-primary"
              disabled={
                busy || capabilities?.configured === false || asset.size > (capabilities?.maxInputBytes ?? Infinity)
              }
              onClick={() => void submit()}
              type="button"
            >
              <Languages aria-hidden size={13} /> {transcript ? t("重新转录") : t("开始转录")}
            </button>
            {activeJob && new Set(["queued", "running"]).has(activeJob.status) ? (
              <button disabled={busy} onClick={() => void cancel()} type="button">
                <Square aria-hidden size={12} /> {t("取消")}
              </button>
            ) : null}
            {activeJob && new Set(["failed", "cancelled", "outcome_unknown"]).has(activeJob.status) ? (
              <button disabled={busy} onClick={() => void retry()} type="button">
                <RotateCcw aria-hidden size={12} /> {t("重试")}
              </button>
            ) : null}
          </div>
          <small>
            {capabilities
              ? capabilities.configured
                ? `${capabilities.provider} · ${capabilities.model} · ${Math.round(capabilities.maxInputBytes / 1024 / 1024)} MB`
                : t("尚未配置转录服务，请在网关设置 DIRECTOR_TRANSCRIPTION_API_KEY（或 OPENAI_API_KEY）后重启网关")
              : t("正在读取转录能力…")}
          </small>
        </div>
        {activeJob ? (
          <div className={`media-transcription-status is-${activeJob.status}`}>
            <span>{statusLabel(activeJob.status)}</span>
            <progress max={1} value={activeJob.progress} />
            <small data-i18n-user-content>{activeJob.message ?? activeJob.error ?? ""}</small>
          </div>
        ) : null}
        {error ? (
          <p className="media-transcription-error" role="alert">
            {error}
          </p>
        ) : null}
        {pollFailures >= MAX_POLL_FAILURES ? (
          <p className="media-transcription-error" role="alert">
            {t("转录状态连续读取失败")}
            {pollErrorDetail ? `：${pollErrorDetail}` : ""}
            <button
              onClick={() => {
                setPollErrorDetail("");
                setPollFailures(0);
              }}
              type="button"
            >
              <RotateCcw aria-hidden size={12} /> {t("重试")}
            </button>
          </p>
        ) : null}
        {notice ? (
          <p className="media-transcription-notice" role="status">
            {notice}
          </p>
        ) : null}
        <div className="media-transcription-content">
          {transcript ? (
            <>
              <div className="media-transcription-summary">
                <strong>{t("转录文本")}</strong>
                <span>{transcript.language ?? t("自动识别")}</span>
                <span>
                  {transcript.segments.length} {t("段")}
                </span>
                <span data-i18n-user-content>{transcript.model}</span>
              </div>
              <textarea aria-label={t("转录文本")} readOnly value={transcript.text} />
              <div className="media-transcription-segments">
                {transcript.segments.slice(0, 2_000).map((segment, index) => (
                  <article key={`${segment.startSec}:${index}`}>
                    <time>
                      {segment.startSec.toFixed(2)}–{segment.endSec.toFixed(2)}
                    </time>
                    <span data-i18n-user-content>{segment.text}</span>
                  </article>
                ))}
              </div>
              <footer>
                <button onClick={insertCaptions} type="button">
                  <Captions aria-hidden size={13} /> {t("加入 Video Editor 字幕轨")}
                </button>
                <button
                  onClick={() =>
                    downloadBlob(
                      new Blob([serializeDirectorMediaTranscriptVtt(transcript)], { type: "text/vtt" }),
                      `${asset.name || "captions"}.vtt`,
                    )
                  }
                  type="button"
                >
                  <Download aria-hidden size={13} /> VTT
                </button>
                <button
                  onClick={() =>
                    downloadBlob(
                      new Blob([JSON.stringify(transcript, null, 2)], { type: "application/json" }),
                      `${asset.name || "transcript"}.transcript.json`,
                    )
                  }
                  type="button"
                >
                  <Download aria-hidden size={13} /> JSON
                </button>
              </footer>
            </>
          ) : (
            <div className="media-transcription-empty">
              <Captions aria-hidden size={28} />
              <strong>{t("尚无转录结果")}</strong>
              <span>{t("提交音频或视频后，文本、时间段和 VTT 会持久保存。")}</span>
            </div>
          )}
        </div>
        {matchingJobs.length > 1 ? (
          <details className="media-transcription-history">
            <summary>
              {t("历史任务")} · {matchingJobs.length}
            </summary>
            {matchingJobs.map((job) => (
              <button key={job.id} onClick={() => setActiveJob(job)} type="button">
                <span>{statusLabel(job.status)}</span>
                <small>{new Date(job.createdAt).toLocaleString()}</small>
              </button>
            ))}
          </details>
        ) : null}
      </section>
    </div>
  );
}
