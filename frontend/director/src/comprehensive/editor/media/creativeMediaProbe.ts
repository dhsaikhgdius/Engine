import type { CreativeMediaImportOptions, CreativeMediaKind } from "./persistentCreativeMediaStore";
import { generateCreativeMediaWaveform } from "./creativeMediaEngineering";
import { extractDirectorPngMetadata } from "./pngMetadata";

const PROBE_TIMEOUT_MS = 15_000;

/** Determines the media kind from the MIME type prefix of a File. */
function fileKind(file: File): CreativeMediaKind {
  const prefix = file.type.split("/", 1)[0];
  if (prefix === "image" || prefix === "video" || prefix === "audio") return prefix;
  throw new Error(`${file.name} 不是支持的图片、视频或音频文件`);
}

/**
 * Waits for an HTMLMediaElement to load its metadata.
 *
 * The timeout prevents indefinite hangs on corrupted or unsupported files.
 */
function waitForMetadata(element: HTMLMediaElement) {
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => finish(() => reject(new Error("媒体信息读取超时"))), PROBE_TIMEOUT_MS);
    const cleanup = () => {
      window.clearTimeout(timeout);
      element.removeEventListener("loadedmetadata", loaded);
      element.removeEventListener("error", failed);
    };
    const finish = (callback: () => void) => {
      cleanup();
      callback();
    };
    const loaded = () => finish(resolve);
    const failed = () => finish(() => reject(new Error("媒体文件无法解码")));
    element.addEventListener("loadedmetadata", loaded, { once: true });
    element.addEventListener("error", failed, { once: true });
  });
}

/**
 * Loads an image from a blob URL to extract its natural dimensions.
 *
 * @param url - A blob: URL pointing to the image.
 * @returns The natural width and height, or null for each when unavailable.
 */
function probeImage(url: string) {
  return new Promise<Pick<CreativeMediaImportOptions, "width" | "height">>((resolve, reject) => {
    const image = new Image();
    const timeout = window.setTimeout(() => finish(() => reject(new Error("图片信息读取超时"))), PROBE_TIMEOUT_MS);
    const cleanup = () => {
      window.clearTimeout(timeout);
      image.removeEventListener("load", loaded);
      image.removeEventListener("error", failed);
    };
    const finish = (callback: () => void) => {
      cleanup();
      callback();
    };
    const loaded = () =>
      finish(() => resolve({ width: image.naturalWidth || null, height: image.naturalHeight || null }));
    const failed = () => finish(() => reject(new Error("图片文件无法解码")));
    image.addEventListener("load", loaded, { once: true });
    image.addEventListener("error", failed, { once: true });
    image.src = url;
  });
}

/**
 * Probes a File for dimensions, duration, waveform, and embedded metadata.
 *
 * Images are decoded through an Image element; video/audio use an HTMLMediaElement
 * and additionally generate a waveform. The blob URL is revoked after probing.
 *
 * @param file - The file to probe.
 * @returns Import options suitable for passing to the creative media library.
 */
export async function probeCreativeMediaFile(file: File): Promise<CreativeMediaImportOptions> {
  const kind = fileKind(file);
  const url = URL.createObjectURL(file);
  try {
    if (kind === "image") {
      const [dimensions, embeddedMetadata] = await Promise.all([
        probeImage(url),
        file.type.toLocaleLowerCase() === "image/png" || file.name.toLocaleLowerCase().endsWith(".png")
          ? extractDirectorPngMetadata(file)
          : null,
      ]);
      return { kind, ...dimensions, embeddedMetadata };
    }
    const element = document.createElement(kind === "video" ? "video" : "audio");
    element.preload = "metadata";
    const metadata = waitForMetadata(element);
    element.src = url;
    element.load();
    await metadata;
    const waveform = await generateCreativeMediaWaveform(file);
    return {
      kind,
      durationSec: Number.isFinite(element.duration) && element.duration > 0 ? element.duration : null,
      width: element instanceof HTMLVideoElement ? element.videoWidth || null : null,
      height: element instanceof HTMLVideoElement ? element.videoHeight || null : null,
      waveform,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}
