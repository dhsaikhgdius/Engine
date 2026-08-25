/**
 * Modal dialog for configuring and downloading a storyboard PDF or verifiable package.
 *
 * @module DirectorStoryboardExportDialog
 */

import { FileDown, Loader2, PackageCheck, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { usePersistentCreativeMediaAssets } from "../media/persistentCreativeMediaStore";
import type { DirectorProject } from "../schema/directorProject";
import { getDirectorProjectRevision } from "../schema/directorProjectRevision";
import { createEmptyDirectorStoryboard, sortStoryboardShots } from "./directorStoryboard";
import {
  createDirectorStoryboardPdf,
  DEFAULT_DIRECTOR_STORYBOARD_PDF_SETTINGS,
  downloadDirectorStoryboardPdf,
  downloadDirectorStoryboardVerificationPackage,
  selectDirectorStoryboardExportShots,
  type DirectorStoryboardColumns,
  type DirectorStoryboardPdfSettings,
} from "./storyboardPdf";
import { useSuppressViewportChromeWhileMounted } from "../canvas/viewportChromeSuppression";

/**
 * Renders a modal with paper size, orientation, column count, and content toggles,
 * plus a live preview grid and download buttons for PDF and verifiable packages.
 */
export function DirectorStoryboardExportDialog({
  initialSelectedShotIds,
  onClose,
  project,
}: {
  initialSelectedShotIds: string[];
  onClose: () => void;
  project: DirectorProject;
}) {
  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  useSuppressViewportChromeWhileMounted("storyboard-export");
  const mediaAssets = usePersistentCreativeMediaAssets();
  const storyboard = project.storyboard ?? createEmptyDirectorStoryboard();
  const shots = useMemo(() => sortStoryboardShots(storyboard.shots), [storyboard.shots]);
  const [settings, setSettings] = useState<DirectorStoryboardPdfSettings>({
    ...DEFAULT_DIRECTOR_STORYBOARD_PDF_SETTINGS,
    selectedShotIds: initialSelectedShotIds.filter((id) => shots.some((shot) => shot.id === id)),
  });
  const [busy, setBusy] = useState<"pdf" | "package" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const previewShots = selectDirectorStoryboardExportShots(shots, settings);
  const mediaUrlById = useMemo(
    () => new Map(mediaAssets.map((asset) => [asset.id, asset.objectUrl] as const)),
    [mediaAssets],
  );

  function patchSettings(patch: Partial<DirectorStoryboardPdfSettings>) {
    setSettings((current) => ({ ...current, ...patch }));
  }

  function toggleShot(id: string) {
    setSettings((current) => ({
      ...current,
      selectedShotIds: current.selectedShotIds.includes(id)
        ? current.selectedShotIds.filter((candidate) => candidate !== id)
        : [...current.selectedShotIds, id],
    }));
  }

  async function exportArtifact(kind: "pdf" | "package") {
    if (busy) return;
    setBusy(kind);
    setNotice("正在渲染打印级页面并核对媒体哈希…");
    try {
      const revision = getDirectorProjectRevision(project);
      const { runWithDirectorProjectRevision } = await import("../../../agent/directorRevisionBoundCapture");
      const result = await runWithDirectorProjectRevision(revision, ({ project: immutableProject, signal }) =>
        createDirectorStoryboardPdf(immutableProject, settings, { signal }),
      );
      if (kind === "pdf") downloadDirectorStoryboardPdf(result);
      else await downloadDirectorStoryboardVerificationPackage(result);
      setNotice(
        `${kind === "pdf" ? "PDF" : "可验证包"}已导出 · ${result.pages.length} 页 · ${result.manifest.shots.length} 镜${
          result.manifest.warnings.length ? ` · ${result.manifest.warnings.length} 条画面提示` : ""
        }`,
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "分镜导出失败");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div aria-label="导出分镜 PDF" aria-modal="true" className="storyboard-export-dialog" role="dialog">
      <button aria-label="关闭分镜导出" className="storyboard-export-backdrop" onClick={onClose} type="button" />
      <section className="storyboard-export-surface">
        <header>
          <div>
            <strong>分镜 PDF</strong>
            <small>真实镜头画面 · A4 / Letter · 可验证哈希清单</small>
          </div>
          <button aria-label="关闭分镜导出" onClick={onClose} type="button">
            <X aria-hidden size={17} />
          </button>
        </header>

        <div className="storyboard-export-layout">
          <aside className="storyboard-export-settings">
            <fieldset>
              <legend>页面</legend>
              <label>
                <span>纸张</span>
                <select
                  aria-label="分镜纸张"
                  onChange={(event) => patchSettings({ paperSize: event.currentTarget.value as "a4" | "letter" })}
                  value={settings.paperSize}
                >
                  <option value="a4">A4</option>
                  <option value="letter">Letter</option>
                </select>
              </label>
              <label>
                <span>方向</span>
                <select
                  aria-label="分镜页面方向"
                  onChange={(event) =>
                    patchSettings({ orientation: event.currentTarget.value as "portrait" | "landscape" })
                  }
                  value={settings.orientation}
                >
                  <option value="landscape">横向</option>
                  <option value="portrait">纵向</option>
                </select>
              </label>
              <label>
                <span>每行列数</span>
                <select
                  aria-label="分镜每行列数"
                  onChange={(event) =>
                    patchSettings({ columns: Number(event.currentTarget.value) as DirectorStoryboardColumns })
                  }
                  value={settings.columns}
                >
                  {[1, 2, 3, 4].map((columns) => (
                    <option key={columns} value={columns}>
                      {columns} 列
                    </option>
                  ))}
                </select>
              </label>
            </fieldset>

            <fieldset>
              <legend>内容</legend>
              <label className="storyboard-export-check">
                <input
                  checked={settings.includeMetadata}
                  onChange={(event) => patchSettings({ includeMetadata: event.currentTarget.checked })}
                  type="checkbox"
                />
                镜头、帧区间、景别与运镜
              </label>
              <label className="storyboard-export-check">
                <input
                  checked={settings.includeAction}
                  onChange={(event) => patchSettings({ includeAction: event.currentTarget.checked })}
                  type="checkbox"
                />
                调度 / 表演备注
              </label>
              <label>
                <span>范围</span>
                <select
                  aria-label="分镜导出范围"
                  onChange={(event) => patchSettings({ scope: event.currentTarget.value as "all" | "selected" })}
                  value={settings.scope}
                >
                  <option value="all">全部 {shots.length} 镜</option>
                  <option value="selected">选中的 {settings.selectedShotIds.length} 镜</option>
                </select>
              </label>
              <div aria-label="选择导出分镜" className="storyboard-export-shot-choices">
                {shots.map((shot, index) => (
                  <label key={shot.id}>
                    <input
                      aria-label={`选择 PDF 分镜 ${shot.title}`}
                      checked={settings.selectedShotIds.includes(shot.id)}
                      onChange={() => toggleShot(shot.id)}
                      type="checkbox"
                    />
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <strong data-i18n-user-content>{shot.title}</strong>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="storyboard-export-buttons">
              <button
                disabled={Boolean(busy) || previewShots.length === 0}
                onClick={() => void exportArtifact("pdf")}
                type="button"
              >
                {busy === "pdf" ? (
                  <Loader2 aria-hidden className="is-spinning" size={15} />
                ) : (
                  <FileDown aria-hidden size={15} />
                )}
                下载 PDF
              </button>
              <button
                disabled={Boolean(busy) || previewShots.length === 0}
                onClick={() => void exportArtifact("package")}
                type="button"
              >
                {busy === "package" ? (
                  <Loader2 aria-hidden className="is-spinning" size={15} />
                ) : (
                  <PackageCheck aria-hidden size={15} />
                )}
                下载可验证包
              </button>
            </div>
            {notice ? (
              <p aria-live="polite" className="storyboard-export-notice">
                {notice}
              </p>
            ) : null}
          </aside>

          <main className={`storyboard-export-preview is-${settings.orientation}`}>
            <div className="storyboard-export-paper">
              <header>
                <strong data-i18n-user-content>{storyboard.title}</strong>
                <span data-i18n-user-content>{storyboard.logline}</span>
              </header>
              <div
                className="storyboard-export-preview-grid"
                style={{ gridTemplateColumns: `repeat(${settings.columns}, minmax(0, 1fr))` }}
              >
                {previewShots.map((shot, index) => {
                  const thumbnailUrl = shot.thumbnail ? mediaUrlById.get(shot.thumbnail.mediaId) : null;
                  const camera = project.cameras.find((candidate) => candidate.id === shot.cameraId);
                  const imageUrl = thumbnailUrl ?? camera?.lastCaptureUrl ?? null;
                  const stale = Boolean(
                    shot.thumbnail &&
                    (shot.thumbnail.cameraId !== shot.cameraId || shot.thumbnail.frame !== shot.frameStart),
                  );
                  return (
                    <article key={shot.id}>
                      <strong>
                        {String(index + 1).padStart(2, "0")} · <span data-i18n-user-content>{shot.title}</span>
                      </strong>
                      <div className="storyboard-export-preview-image">
                        {imageUrl ? <img alt="" src={imageUrl} /> : <span>待捕获</span>}
                        {stale ? <em>待重拍</em> : null}
                      </div>
                      {settings.includeMetadata ? (
                        <small>
                          F{shot.frameStart}–{shot.frameEnd} · {camera?.name ?? "未指定机位"}
                        </small>
                      ) : null}
                      {settings.includeAction ? (
                        <p data-i18n-user-content>{shot.action || "（未填写调度 / 表演）"}</p>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            </div>
          </main>
        </div>
      </section>
    </div>
  );
}
