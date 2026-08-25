import { memo, useCallback, useEffect, useRef, useState } from "react";
import { InspectorRangeNumberField, InspectorSection, InspectorTextField } from "./InspectorControls";
import type { DirectorObject } from "../schema/directorProject";
import {
  fetchArdyBridgeStatus,
  generateArdyMotion,
  loadArdyMotionClip,
  type ArdyBridgeStatus,
} from "../motion/ardy/ardyMotionClient";
import type { ArdyMotionClip } from "../motion/ardy/ardyNpz";
import { useArdyMotionPreviewStore } from "../motion/ardy/ardyMotionPreviewStore";

/**
 * "AI 生成动作" — the character panel's ARDY text-to-motion area. Generation
 * streams the bridge's status lines into a short log; a finished motion is
 * decoded in the browser and immediately previewed on the selected character
 * as a non-destructive overlay.
 */

function clampNumber(value: string, minimum: number, maximum: number, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

interface ArdyGenerationResultState {
  jobId: string;
  prompt: string;
  clip: ArdyMotionClip;
}

export const ArdyMotionSection = memo(function ArdyMotionSection({ role }: { role: DirectorObject }) {
  const [bridge, setBridge] = useState<ArdyBridgeStatus | null | "unreachable">(null);
  const [prompt, setPrompt] = useState("");
  const [durationS, setDurationS] = useState(4);
  const [seedText, setSeedText] = useState("");
  const [generating, setGenerating] = useState(false);
  const [statusLines, setStatusLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ArdyGenerationResultState | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const previewObjectId = useArdyMotionPreviewStore((state) => state.objectId);
  const previewPlaying = useArdyMotionPreviewStore((state) => state.playing);
  const previewingThisRole = previewPlaying && previewObjectId === role.id;

  useEffect(() => {
    let cancelled = false;
    fetchArdyBridgeStatus()
      .then((status) => {
        if (!cancelled) setBridge(status);
      })
      .catch(() => {
        if (!cancelled) setBridge("unreachable");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const supportedRig = role.characterRig?.rigType === "mixamo";

  const handleGenerate = useCallback(async () => {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt || generating) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setGenerating(true);
    setError(null);
    setStatusLines([]);
    try {
      const seed = seedText.trim() === "" ? undefined : Math.max(0, Math.round(Number(seedText)));
      const job = await generateArdyMotion({
        prompt: trimmedPrompt,
        durationS,
        ...(seed !== undefined && Number.isFinite(seed) ? { seed } : {}),
        signal: controller.signal,
        onStatus: (message) => setStatusLines((lines) => [...lines.slice(-2), message]),
      });
      setStatusLines((lines) => [...lines.slice(-2), "正在下载并解码动作数据…"]);
      const clip = await loadArdyMotionClip(job.motionUrl, controller.signal);
      setResult({ jobId: job.jobId, prompt: trimmedPrompt, clip });
      setStatusLines([]);
      useArdyMotionPreviewStore.getState().startPreview(role.id, clip);
    } catch (generationError) {
      if (!controller.signal.aborted) {
        setError(generationError instanceof Error ? generationError.message : String(generationError));
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setGenerating(false);
    }
  }, [durationS, generating, prompt, role.id, seedText]);

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setGenerating(false);
    setStatusLines([]);
  }, []);

  const handleTogglePreview = useCallback(() => {
    const store = useArdyMotionPreviewStore.getState();
    if (previewingThisRole) {
      store.stopPreview();
      return;
    }
    if (result) store.startPreview(role.id, result.clip);
  }, [previewingThisRole, result, role.id]);

  return (
    <InspectorSection title="AI 生成动作" className="ardy-motion-section">
      {bridge === null ? (
        <p className="character-ik-note">正在检查 ARDY 桥接状态…</p>
      ) : bridge === "unreachable" ? (
        <p className="character-ik-note">无法连接网关的动作生成服务。</p>
      ) : !bridge.configured ? (
        <p className="character-ik-note">
          ARDY 未配置。运行 npm run setup:ardy，或设置 DIRECTOR_ARDY_REPO（可选 DIRECTOR_ARDY_SSH_HOST）后重启网关；参见
          integrations/ardy/README.md。
        </p>
      ) : !supportedRig ? (
        <p className="character-ik-note">该角色不是 Mixamo 骨骼，暂不支持 AI 动作预览。</p>
      ) : (
        <>
          <p className="character-ik-note">
            {bridge.model} · {bridge.remote ? "远程 GPU 主机" : "本机运行"} · NVIDIA ARDY 文本生成动作
          </p>
          <label className="inspector-field ardy-prompt-field">
            <span className="inspector-field-label">动作描述</span>
            <textarea
              aria-label="AI 动作描述"
              className="inspector-text-input ardy-prompt-input"
              maxLength={600}
              placeholder="例如：A person walks forward, then waves."
              rows={3}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </label>
          <InspectorRangeNumberField
            label="时长（秒）"
            rangeAriaLabel="AI 动作时长滑杆"
            numberAriaLabel="AI 动作时长"
            min="1"
            max="12"
            step="0.5"
            value={durationS}
            onValueChange={(value) => setDurationS(clampNumber(value, 1, 12, durationS))}
          />
          <InspectorTextField
            label="随机种子（留空随机）"
            ariaLabel="AI 动作随机种子"
            type="number"
            step="1"
            value={seedText}
            onChange={(value) => setSeedText(value)}
          />
          {generating ? (
            <button className="inspector-action-button" type="button" onClick={handleCancel}>
              取消生成
            </button>
          ) : (
            <button
              className="inspector-action-button ardy-generate-button"
              type="button"
              disabled={!prompt.trim()}
              onClick={() => void handleGenerate()}
            >
              生成动作
            </button>
          )}
          {statusLines.length > 0 ? (
            <div aria-live="polite" className="ardy-status-log">
              {statusLines.map((line, index) => (
                <p key={`${index}-${line}`}>{line}</p>
              ))}
            </div>
          ) : null}
          {error ? (
            <p aria-live="polite" className="ardy-error-note">
              {error}
            </p>
          ) : null}
          {result ? (
            <>
              <p className="character-ik-note">
                「{result.prompt}」 · {result.clip.durationS.toFixed(1)} 秒 · {result.clip.frames} 帧 @{" "}
                {result.clip.fps}fps
              </p>
              <button className="inspector-action-button" type="button" onClick={handleTogglePreview}>
                {previewingThisRole ? "停止预览" : "在视口预览"}
              </button>
            </>
          ) : null}
        </>
      )}
    </InspectorSection>
  );
});
