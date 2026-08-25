import { useDeferredValue, useRef, useState, type DragEvent, type PointerEvent } from "react";
import {
  Clapperboard,
  Film,
  Image,
  Link2,
  Music2,
  Plus,
  Search,
  SearchX,
  TriangleAlert,
  Upload,
  Video,
  X,
} from "lucide-react";
import { setTransparentDragImage } from "../drag/transparentDragImage";
import { useLanguage } from "../../i18n/language";
import {
  DIRECTOR_MEDIA_COLLECTIONS,
  type DirectorMediaCollection,
  type DirectorMediaItem,
} from "./directorMediaLibrary";
import {
  beginDirectorMediaDragSession,
  DIRECTOR_MEDIA_DRAG_TYPE,
  endDirectorMediaDragSession,
} from "./directorWorkspaceStore";

function MediaGlyph({ kind }: { kind: DirectorMediaItem["kind"] }) {
  return kind === "audio" ? (
    <Music2 aria-hidden size={22} />
  ) : kind === "video" ? (
    <Video aria-hidden size={22} />
  ) : kind === "shot" ? (
    <Clapperboard aria-hidden size={22} />
  ) : (
    <Image aria-hidden size={22} />
  );
}

function setMediaDragData(event: DragEvent, item: DirectorMediaItem) {
  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.setData(DIRECTOR_MEDIA_DRAG_TYPE, item.id);
  event.dataTransfer.setData("text/plain", item.id);
  beginDirectorMediaDragSession(item.id);
  setTransparentDragImage(event.dataTransfer);
}

/** Cards with a thumbnail render an <img>, so a missing <video> is expected. */
function playCardVideoPreview(event: PointerEvent<HTMLElement>) {
  // play() may return undefined outside real browsers (e.g. jsdom).
  void event.currentTarget
    .querySelector("video")
    ?.play()
    ?.catch(() => undefined);
}

function resetCardVideoPreview(event: PointerEvent<HTMLElement>) {
  const video = event.currentTarget.querySelector("video");
  if (!video) return;
  video.pause();
  video.currentTime = 0;
}

export function CreativeMediaBrowser({
  items,
  title = "素材",
  onAdd,
  onImportFiles,
  onRelink,
}: {
  items: DirectorMediaItem[];
  title?: string;
  onAdd?: (item: DirectorMediaItem) => void;
  onImportFiles?: (files: File[]) => Promise<void> | void;
  onRelink?: (item: DirectorMediaItem) => void;
}) {
  const { t } = useLanguage();
  const [collection, setCollection] = useState<"all" | DirectorMediaCollection>("all");
  const [query, setQuery] = useState("");
  const [draggingItemId, setDraggingItemId] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase());
  const visibleItems = items.filter((item) => {
    if (collection !== "all" && item.collection !== collection) return false;
    if (!deferredQuery) return true;
    return `${item.name} ${item.subtitle}`.toLocaleLowerCase().includes(deferredQuery);
  });

  return (
    <section className="creative-media-browser" aria-label={t(title)}>
      <header className="creative-panel-heading">
        <span>
          <Film aria-hidden size={16} />
        </span>
        <div>
          <strong>{t(title)}</strong>
        </div>
        {onImportFiles ? (
          <button
            aria-label={t("导入素材")}
            className="creative-media-import-button"
            onClick={() => importInputRef.current?.click()}
            title={t("导入图片、视频或音频")}
            type="button"
          >
            <Upload aria-hidden size={14} />
          </button>
        ) : null}
        <input
          accept="image/*,video/*,audio/*"
          aria-label={t("导入素材")}
          className="sr-only"
          multiple
          onChange={(event) => {
            const input = event.currentTarget;
            const files = Array.from(input.files ?? []);
            if (files.length > 0) void onImportFiles?.(files);
            input.value = "";
          }}
          ref={importInputRef}
          tabIndex={-1}
          type="file"
        />
      </header>
      <div className="creative-media-tabs" role="tablist" aria-label={t("素材分类")}>
        {DIRECTOR_MEDIA_COLLECTIONS.map((entry) => (
          <button
            aria-selected={collection === entry.id}
            className={collection === entry.id ? "is-active" : ""}
            key={entry.id}
            onClick={() => setCollection(entry.id)}
            role="tab"
            type="button"
          >
            {t(entry.label)}
          </button>
        ))}
      </div>
      <label className="creative-search-field">
        <Search aria-hidden size={14} />
        <span className="sr-only">{t("搜索素材")}</span>
        <input
          aria-label={t("搜索素材")}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder={t("搜索素材")}
          ref={searchInputRef}
          type="search"
          value={query}
        />
        {query ? (
          <button
            aria-label={t("清空搜索")}
            className="creative-search-clear"
            onClick={() => {
              setQuery("");
              searchInputRef.current?.focus();
            }}
            type="button"
          >
            <X aria-hidden size={12} />
          </button>
        ) : null}
      </label>
      <div className="creative-media-list" role="list" aria-label={t("素材列表")}>
        {visibleItems.map((item) => (
          <article
            aria-grabbed={draggingItemId === item.id}
            className={`creative-media-card${item.availability === "offline" ? " is-offline" : ""}${draggingItemId === item.id ? " is-dragging" : ""}`}
            draggable={item.availability !== "offline"}
            key={item.id}
            onDoubleClick={(event) => {
              if (!onAdd || item.availability === "offline") return;
              if (event.target instanceof Element && event.target.closest("button")) return;
              onAdd(item);
            }}
            onDragStart={(event) => {
              if (item.availability === "offline") {
                event.preventDefault();
                return;
              }
              setDraggingItemId(item.id);
              setMediaDragData(event, item);
            }}
            onDragEnd={() => {
              endDirectorMediaDragSession();
              setDraggingItemId(null);
            }}
            onPointerEnter={item.availability === "offline" ? undefined : playCardVideoPreview}
            onPointerLeave={item.availability === "offline" ? undefined : resetCardVideoPreview}
            role="listitem"
            title={onAdd && item.availability !== "offline" ? t("双击添加到工作区") : undefined}
          >
            <div className="creative-media-cover">
              {item.thumbnailUrl ? (
                <img alt="" draggable={false} src={item.thumbnailUrl} />
              ) : item.kind === "video" && item.sourceUrl ? (
                <video aria-label={item.name} muted playsInline preload="metadata" src={item.sourceUrl} />
              ) : item.kind === "shot" ? (
                <span className="creative-media-preview-empty">
                  <Clapperboard aria-hidden size={22} />
                  <span>{t("未捕获画面")}</span>
                </span>
              ) : (
                <MediaGlyph kind={item.kind} />
              )}
              <span className={`creative-media-kind is-${item.kind}`}>
                {t(
                  item.kind === "audio"
                    ? "音频"
                    : item.kind === "video"
                      ? "视频"
                      : item.kind === "shot"
                        ? "分镜"
                        : "图片",
                )}
              </span>
              {item.durationSec > 0 ? <time>{item.durationSec.toFixed(1)}s</time> : null}
              {item.availability === "offline" ? (
                <span className="creative-media-offline-badge">
                  <TriangleAlert aria-hidden size={10} /> {t("离线")}
                </span>
              ) : item.playbackSource?.variant === "proxy" ? (
                <span className="creative-media-proxy-badge">Proxy</span>
              ) : null}
            </div>
            <div className="creative-media-card-copy">
              <strong data-i18n-user-content>{item.name}</strong>
              <small data-i18n-user-content>{item.subtitle}</small>
            </div>
            {item.availability === "offline" && onRelink ? (
              <button
                aria-label={`${t("重连")} ${item.name}`}
                className="creative-media-add"
                onClick={() => onRelink(item)}
                title={t("选择替代文件并修复所有引用")}
                type="button"
              >
                <Link2 aria-hidden size={14} />
              </button>
            ) : onAdd && item.availability !== "offline" ? (
              <button
                aria-label={`${t("添加")} ${item.name}`}
                className="creative-media-add"
                onClick={() => onAdd(item)}
                title={t("添加到当前工作区")}
                type="button"
              >
                <Plus aria-hidden size={14} />
              </button>
            ) : null}
          </article>
        ))}
        {!visibleItems.length ? (
          items.length ? (
            <div className="creative-media-empty">
              <SearchX aria-hidden size={24} />
              <strong>{t("没有匹配的素材")}</strong>
              <button
                className="creative-media-clear-filters"
                onClick={() => {
                  setCollection("all");
                  setQuery("");
                }}
                type="button"
              >
                {t("清除筛选")}
              </button>
            </div>
          ) : (
            <div className="creative-media-empty">
              <Image aria-hidden size={24} />
              <strong>{t("暂无可用素材")}</strong>
              <span>{t("请先在 3D 片场保存截图、分镜或录制视频。")}</span>
            </div>
          )
        ) : null}
      </div>
    </section>
  );
}
