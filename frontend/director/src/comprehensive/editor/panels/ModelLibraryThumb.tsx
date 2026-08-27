/**
 * Thumbnail for asset-library cards: prefers the item's raster thumbnail,
 * falls back to an .svg sibling when the .webp is missing, then to inline
 * vector covers for native actions, and finally to a generic boxes icon.
 */
import { Boxes, Eye } from "lucide-react";
import { memo, useEffect, useState } from "react";
import type { ModelLibraryItem } from "../modelLibrary/modelLibraryCatalog";

/** Catalog thumbnails ship as .webp with an .svg sibling; swap extensions for the fallback. */
function svgFallbackThumbnailUrl(url: string) {
  return /\.webp$/i.test(url) ? url.replace(/\.webp$/i, ".svg") : null;
}

/** Hand-drawn vector covers for the built-in native actions (human, camera, sphere, generic cube). */
function NativeModelLibraryThumb({ action }: { action: NonNullable<ModelLibraryItem["nativeAction"]> }) {
  if (action === "add-human") {
    return (
      <svg className="model-library-native-thumb" viewBox="0 0 72 72">
        <circle cx="36" cy="15" r="8" fill="#c89d45" />
        <rect x="27" y="23" width="18" height="25" rx="8" fill="#c89d45" />
        <path
          d="M27 27 19 43M45 27l8 16M31 47l-4 17M41 47l4 17"
          stroke="#c89d45"
          strokeLinecap="round"
          strokeWidth="6"
        />
        <path d="M27 30h18M29 47h14" stroke="#6434b5" strokeLinecap="round" strokeWidth="2.5" />
      </svg>
    );
  }

  if (action === "add-camera") {
    return (
      <svg className="model-library-native-thumb" viewBox="0 0 72 72">
        <rect x="13" y="25" width="37" height="25" rx="5" fill="#303942" />
        <path d="m50 31 10-6v25l-10-6Z" fill="#596876" />
        <circle cx="31.5" cy="37.5" r="8" fill="#8ea6ba" />
        <circle cx="31.5" cy="37.5" r="4" fill="#17212a" />
        <rect x="18" y="20" width="14" height="6" rx="2" fill="#596876" />
      </svg>
    );
  }

  if (action === "add-sphere") {
    return (
      <svg className="model-library-native-thumb" viewBox="0 0 72 72">
        <circle cx="36" cy="36" r="22" fill="#aeb9c6" />
        <ellipse cx="29" cy="27" rx="8" ry="6" fill="#e1e7ee" opacity=".85" />
        <path d="M20 49c9 7 24 7 32-2" fill="none" stroke="#7b8795" strokeLinecap="round" strokeWidth="2" />
      </svg>
    );
  }

  return (
    <svg className="model-library-native-thumb" viewBox="0 0 72 72">
      <path d="m36 10 23 13-23 13-23-13Z" fill="#d3dbe4" />
      <path d="m13 23 23 13v26L13 49Z" fill="#9ca9b7" />
      <path d="m59 23-23 13v26l23-13Z" fill="#b9c4cf" />
    </svg>
  );
}

/** Static card cover: a local image, a native vector cover, or a safe fallback icon. */
export const ModelLibraryThumb = memo(function ModelLibraryThumb({
  item,
  thumbnailUrl,
  showPreviewCue = false,
  iconSize = 23,
}: {
  item?: ModelLibraryItem;
  name?: string;
  thumbnailUrl?: string;
  showPreviewCue?: boolean;
  iconSize?: number;
}) {
  const [imageSrc, setImageSrc] = useState(thumbnailUrl);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setImageSrc(thumbnailUrl);
    setFailed(false);
  }, [thumbnailUrl]);

  const showImage = Boolean(imageSrc) && !failed;

  return (
    <span className="model-library-thumb" aria-hidden="true">
      {showImage ? (
        <img
          alt=""
          className="model-library-thumb-image"
          decoding="async"
          loading="lazy"
          src={imageSrc}
          onError={() => {
            const fallback = imageSrc ? svgFallbackThumbnailUrl(imageSrc) : null;
            if (fallback) {
              setImageSrc(fallback);
              return;
            }
            setFailed(true);
          }}
        />
      ) : item?.nativeAction ? (
        <NativeModelLibraryThumb action={item.nativeAction} />
      ) : (
        <Boxes size={iconSize} strokeWidth={1.6} />
      )}
      {showPreviewCue ? (
        <span className="model-library-preview-cue">
          <Eye size={12} />
          预览
        </span>
      ) : null}
    </span>
  );
});
