import { LoaderCircle, Plus, RefreshCw, Server, X } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { ComfyNodeSnapshot } from "../../../../../../packages/protocol/src/comfyGenerationProtocol";
import { useLanguage } from "../../i18n/language";
import {
  listComfyGenerationNodes,
  removeComfyGenerationNode,
  saveComfyGenerationNode,
} from "../workspaces/galleryGenerationBridge";
import "./comfyNodes.css";

const STATUS_LABELS: Record<ComfyNodeSnapshot["status"], string> = {
  online: "在线",
  busy: "忙碌",
  offline: "离线",
  disabled: "已停用",
};

/**
 * Messages emitted by the Canvas pipeline (canvasPipeline.ts) and the gateway
 * (generationRoutes.ts / comfyNodePool.ts) when a generation cannot start
 * because no ComfyUI node is able to accept jobs.
 */
const COMFY_NODE_AVAILABILITY_PATTERN =
  /没有在线的 ComfyUI 执行节点|指定的 ComfyUI 节点不可用|No selected ComfyUI node|Unknown ComfyUI node/;

export function isComfyNodeAvailabilityError(message: string | null | undefined): boolean {
  return Boolean(message && COMFY_NODE_AVAILABILITY_PATTERN.test(message));
}

/** Builds a pool-unique node id that satisfies comfyNodeDefinitionSchema (`/^[a-z0-9][a-z0-9._-]{1,79}$/i`). */
export function deriveComfyNodeId(label: string, takenIds: Iterable<string>): string {
  const taken = new Set(takenIds);
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 48);
  const base = /^[a-z0-9]/.test(slug) && slug.length >= 2 ? slug : `comfy-${Date.now().toString(36)}`;
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function normalizeComfyBaseUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, "");
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return trimmed;
}

export function ComfyNodesDialog({ onClose }: { onClose: () => void }) {
  const { t } = useLanguage();
  const [nodes, setNodes] = useState<ComfyNodeSnapshot[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [labelDraft, setLabelDraft] = useState("");
  const [urlDraft, setUrlDraft] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pendingNodeId, setPendingNodeId] = useState<string | null>(null);
  const [confirmingRemoveId, setConfirmingRemoveId] = useState<string | null>(null);

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  // Removing a node is unrecoverable, so deletion uses the same inline
  // two-step confirm as CameraPanel: arm on first click, disarm after 4s/blur.
  useEffect(() => {
    if (!confirmingRemoveId) return;
    const timer = window.setTimeout(() => setConfirmingRemoveId(null), 4000);
    return () => window.clearTimeout(timer);
  }, [confirmingRemoveId]);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setLoadError(null);
    try {
      const snapshots = await listComfyGenerationNodes(signal);
      if (signal?.aborted) return;
      setNodes(snapshots);
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  async function submitNewNode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const label = labelDraft.trim();
    if (!label) {
      setFormError(t("请填写节点名称"));
      return;
    }
    const baseUrl = normalizeComfyBaseUrl(urlDraft);
    if (!baseUrl) {
      setFormError(t("节点地址必须是 http:// 或 https:// 开头的 URL"));
      return;
    }
    setFormError(null);
    setSubmitting(true);
    setNotice(null);
    try {
      await saveComfyGenerationNode({
        id: deriveComfyNodeId(
          label,
          (nodes ?? []).map((node) => node.id),
        ),
        label: label.slice(0, 160),
        baseUrl,
        enabled: true,
        maxConcurrent: 1,
      });
      setLabelDraft("");
      setUrlDraft("");
      setNotice(t("ComfyUI 节点已保存"));
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleNodeEnabled(node: ComfyNodeSnapshot) {
    setPendingNodeId(node.id);
    setNotice(null);
    try {
      await saveComfyGenerationNode({
        id: node.id,
        label: node.label,
        baseUrl: node.baseUrl,
        enabled: !node.enabled,
        maxConcurrent: node.maxConcurrent,
      });
      setNotice(node.enabled ? t("节点已停用") : t("节点已启用"));
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingNodeId(null);
    }
  }

  async function removeNode(node: ComfyNodeSnapshot) {
    setPendingNodeId(node.id);
    setNotice(null);
    try {
      await removeComfyGenerationNode(node.id);
      setNotice(t("节点已移除"));
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingNodeId(null);
    }
  }

  return (
    <div
      className="comfy-nodes-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
      role="presentation"
    >
      <section aria-label={t("ComfyUI 节点池")} aria-modal="true" className="comfy-nodes-surface" role="dialog">
        <header className="comfy-nodes-header">
          <div>
            <Server aria-hidden size={17} />
            <span>
              <strong>{t("ComfyUI 节点池")}</strong>
              <small>{t("画布生成流水线会把图片 / 视频 / 音频任务分发到这些节点")}</small>
            </span>
          </div>
          <button
            aria-label={t("刷新")}
            className="comfy-nodes-icon-button"
            disabled={loading}
            onClick={() => void refresh()}
            type="button"
          >
            {loading ? (
              <LoaderCircle aria-hidden className="comfy-nodes-spin" size={15} />
            ) : (
              <RefreshCw aria-hidden size={15} />
            )}
          </button>
          <button aria-label={t("关闭")} className="comfy-nodes-icon-button" onClick={onClose} type="button">
            <X aria-hidden size={15} />
          </button>
        </header>
        <div className="comfy-nodes-body">
          {loadError ? (
            <p className="comfy-nodes-error" role="alert">
              {loadError}
            </p>
          ) : nodes === null ? (
            <p className="comfy-nodes-loading">{t("正在读取节点状态…")}</p>
          ) : nodes.length === 0 ? (
            <div className="comfy-nodes-empty">
              <p>{t("尚未配置 ComfyUI 节点。可在此添加，或设置 COMFYUI_URL。")}</p>
              <small>{t("COMFYUI_URL 环境变量在网关启动时读取，修改后需重启网关。")}</small>
            </div>
          ) : (
            <ul className="comfy-nodes-list">
              {nodes.map((node) => {
                const rowBusy = pendingNodeId === node.id;
                const confirming = confirmingRemoveId === node.id;
                return (
                  <li className={`comfy-node-row${node.enabled ? "" : " is-disabled-node"}`} key={node.id}>
                    <div className="comfy-node-copy">
                      <strong data-i18n-user-content>{node.label}</strong>
                      <small data-i18n-user-content>{node.baseUrl}</small>
                      {node.status === "offline" && node.detail ? (
                        <small className="comfy-node-detail" data-i18n-user-content>
                          {node.detail}
                        </small>
                      ) : null}
                    </div>
                    <span className={`comfy-node-status is-${node.status}`}>{t(STATUS_LABELS[node.status])}</span>
                    <div className="comfy-node-actions">
                      <button
                        aria-label={`${node.enabled ? t("停用") : t("启用")} ${node.label}`}
                        disabled={rowBusy}
                        onClick={() => void toggleNodeEnabled(node)}
                        type="button"
                      >
                        {node.enabled ? t("停用") : t("启用")}
                      </button>
                      <button
                        aria-label={confirming ? t("确定移除这个 ComfyUI 节点吗？") : `${t("删除")} ${node.label}`}
                        className={confirming ? "is-confirming" : undefined}
                        disabled={rowBusy}
                        onBlur={() => setConfirmingRemoveId((current) => (current === node.id ? null : current))}
                        onClick={() => {
                          if (confirming) {
                            setConfirmingRemoveId(null);
                            void removeNode(node);
                            return;
                          }
                          setConfirmingRemoveId(node.id);
                        }}
                        type="button"
                      >
                        {confirming ? t("确定移除这个 ComfyUI 节点吗？") : t("删除")}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <form className="comfy-nodes-form" onSubmit={(event) => void submitNewNode(event)}>
          <strong>{t("添加生成节点")}</strong>
          <div className="comfy-nodes-form-grid">
            <label>
              {t("节点名称")}
              <input
                maxLength={160}
                onChange={(event) => setLabelDraft(event.currentTarget.value)}
                placeholder={t("例如：本机 ComfyUI")}
                value={labelDraft}
              />
            </label>
            <label>
              {t("节点地址")}
              <input
                onChange={(event) => setUrlDraft(event.currentTarget.value)}
                placeholder="http://127.0.0.1:8188"
                value={urlDraft}
              />
            </label>
          </div>
          {formError ? (
            <p className="comfy-nodes-error" role="alert">
              {formError}
            </p>
          ) : null}
          <button className="comfy-nodes-primary" disabled={submitting} type="submit">
            {submitting ? (
              <LoaderCircle aria-hidden className="comfy-nodes-spin" size={14} />
            ) : (
              <Plus aria-hidden size={14} />
            )}
            {t("添加生成节点")}
          </button>
        </form>
        {notice ? (
          <p className="comfy-nodes-notice" role="status">
            {notice}
          </p>
        ) : null}
      </section>
    </div>
  );
}
