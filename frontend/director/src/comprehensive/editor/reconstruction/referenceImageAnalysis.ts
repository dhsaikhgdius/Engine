/**
 * Browser-side preparation of reference images for scene reconstruction:
 * decode, downscale to the protocol's normalized edge, re-encode as JPEG,
 * hash (sha256), and extract lightweight visual metrics (dominant colors,
 * luminance distribution) that the analysis prompt consumes.
 */
import {
  DIRECTOR_REFERENCE_IMAGE_MAX_BYTES,
  referenceImageMetricsSchema,
  type ReferenceImageMetrics,
} from "../../../../../../packages/protocol/src/referenceSceneReconstructionProtocol";

const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_NORMALIZED_EDGE = 1_280;
const MAX_ANALYSIS_EDGE = 160;
const SUPPORTED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

type BrowserImageSource = CanvasImageSource & {
  width: number;
  height: number;
  close?: () => void;
};

/**
 * A reference image that has been normalized, compressed, hashed, and analyzed
 * for downstream reconstruction.
 */
export type PreparedDirectorReferenceImage = {
  fileName: string;
  mimeType: "image/jpeg";
  base64: string;
  sha256: string;
  dataUrl: string;
  byteLength: number;
  metrics: ReferenceImageMetrics;
};

function hexByte(value: number) {
  return Math.max(0, Math.min(255, Math.round(value)))
    .toString(16)
    .padStart(2, "0");
}

function rgbHex(red: number, green: number, blue: number) {
  return `#${hexByte(red)}${hexByte(green)}${hexByte(blue)}`;
}

function colorDistance(a: readonly number[], b: readonly number[]) {
  return Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0), (a[2] ?? 0) - (b[2] ?? 0));
}

function pixel(pixels: Uint8ClampedArray, index: number) {
  return [pixels[index] ?? 0, pixels[index + 1] ?? 0, pixels[index + 2] ?? 0] as const;
}

function luminance(red: number, green: number, blue: number) {
  return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
}

/**
 * Extracts color palette, mean luminance, edge density, and foreground
 * coverage from raw RGBA pixel data. Pixels with alpha below 24 are treated as
 * fully transparent and excluded from statistics.
 *
 * @param pixels - RGBA pixel buffer (4 bytes per pixel).
 * @param width - Image width in pixels.
 * @param height - Image height in pixels.
 * @returns Parsed and validated reference image metrics.
 */
export function analyzeReferenceImagePixels(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): ReferenceImageMetrics {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error("Reference image dimensions are invalid");
  }
  if (pixels.length !== width * height * 4) throw new Error("Reference image pixel buffer has the wrong length");

  const histogram = new Map<string, { count: number; red: number; green: number; blue: number }>();
  let luminanceTotal = 0;
  let opaqueCount = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    if ((pixels[index + 3] ?? 0) < 24) continue;
    const red = pixels[index] ?? 0;
    const green = pixels[index + 1] ?? 0;
    const blue = pixels[index + 2] ?? 0;
    luminanceTotal += luminance(red, green, blue);
    opaqueCount += 1;
    const key = `${Math.round(red / 32)},${Math.round(green / 32)},${Math.round(blue / 32)}`;
    const bucket = histogram.get(key) ?? { count: 0, red: 0, green: 0, blue: 0 };
    bucket.count += 1;
    bucket.red += red;
    bucket.green += green;
    bucket.blue += blue;
    histogram.set(key, bucket);
  }

  const paletteRgb: number[][] = [];
  for (const bucket of [...histogram.values()].sort((a, b) => b.count - a.count)) {
    const candidate = [bucket.red / bucket.count, bucket.green / bucket.count, bucket.blue / bucket.count];
    if (paletteRgb.some((existing) => colorDistance(existing, candidate) < 42)) continue;
    paletteRgb.push(candidate);
    if (paletteRgb.length >= 6) break;
  }
  if (!paletteRgb.length) paletteRgb.push([128, 128, 128]);

  let edgeCount = 0;
  let edgeComparisons = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const current = pixel(pixels, index);
      const currentLuma = luminance(...current);
      if (x + 1 < width) {
        const right = pixel(pixels, index + 4);
        if (Math.abs(currentLuma - luminance(...right)) > 0.12) edgeCount += 1;
        edgeComparisons += 1;
      }
      if (y + 1 < height) {
        const below = pixel(pixels, index + width * 4);
        if (Math.abs(currentLuma - luminance(...below)) > 0.12) edgeCount += 1;
        edgeComparisons += 1;
      }
    }
  }

  const cornerIndexes = [0, (width - 1) * 4, (height - 1) * width * 4, (width * height - 1) * 4];
  const background = cornerIndexes
    .map((index) => pixel(pixels, index))
    .reduce((total, value) => [total[0] + value[0] / 4, total[1] + value[1] / 4, total[2] + value[2] / 4], [0, 0, 0]);
  let foregroundCount = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    if ((pixels[index + 3] ?? 0) < 24) continue;
    if (colorDistance(pixel(pixels, index), background) > 48) foregroundCount += 1;
  }

  return referenceImageMetricsSchema.parse({
    width,
    height,
    palette: paletteRgb.map((value) => rgbHex(value[0]!, value[1]!, value[2]!)),
    meanLuminance: opaqueCount ? luminanceTotal / opaqueCount : 0,
    edgeDensity: edgeComparisons ? edgeCount / edgeComparisons : 0,
    foregroundCoverage: opaqueCount ? foregroundCount / opaqueCount : 0,
  });
}

async function readImageSource(file: File): Promise<BrowserImageSource> {
  if (typeof createImageBitmap === "function") return await createImageBitmap(file);
  return await new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("无法解码参考图片"));
    };
    image.src = url;
  });
}

function scaledSize(width: number, height: number, maximum: number) {
  const ratio = Math.min(1, maximum / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
}

function canvasFor(source: BrowserImageSource, maximum: number) {
  const size = scaledSize(source.width, source.height, maximum);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d", { willReadFrequently: maximum === MAX_ANALYSIS_EDGE });
  if (!context) throw new Error("当前浏览器无法读取参考图片像素");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, size.width, size.height);
  context.drawImage(source, 0, 0, size.width, size.height);
  return { canvas, context };
}

function decodeDataUrl(dataUrl: string) {
  const marker = ";base64,";
  const index = dataUrl.indexOf(marker);
  if (index < 0) throw new Error("参考图片编码失败");
  const base64 = dataUrl.slice(index + marker.length);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let offset = 0; offset < binary.length; offset += 1) bytes[offset] = binary.charCodeAt(offset);
  return { base64, bytes };
}

async function sha256Hex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

/**
 * Normalizes, compresses, hashes, and analyzes a browser File into a
 * reconstruction-ready reference image. The source is decoded via
 * createImageBitmap or a fallback Image element, clamped to 1280 px on the
 * longest edge, and re-encoded as JPEG. If the result exceeds the protocol
 * byte limit a second, more aggressive compression pass is attempted.
 *
 * @param file - The user-selected image File (PNG, JPEG, or WebP).
 * @returns A prepared reference image with metrics, SHA-256, and data URL.
 */
export async function prepareDirectorReferenceImage(file: File): Promise<PreparedDirectorReferenceImage> {
  if (!SUPPORTED_MIME_TYPES.has(file.type)) throw new Error("参考图仅支持 PNG / JPG / WEBP");
  if (file.size < 1 || file.size > MAX_SOURCE_BYTES) throw new Error("参考图必须小于 20 MB");
  const source = await readImageSource(file);
  try {
    if (!source.width || !source.height) throw new Error("参考图片尺寸无效");
    const normalized = canvasFor(source, MAX_NORMALIZED_EDGE);
    let dataUrl = normalized.canvas.toDataURL("image/jpeg", 0.88);
    let decoded = decodeDataUrl(dataUrl);
    if (decoded.bytes.byteLength > DIRECTOR_REFERENCE_IMAGE_MAX_BYTES) {
      const compact = canvasFor(source, 960);
      dataUrl = compact.canvas.toDataURL("image/jpeg", 0.76);
      decoded = decodeDataUrl(dataUrl);
    }
    if (decoded.bytes.byteLength > DIRECTOR_REFERENCE_IMAGE_MAX_BYTES) {
      throw new Error("参考图压缩后仍超过 5 MB，请缩小图片后重试");
    }
    const analysis = canvasFor(source, MAX_ANALYSIS_EDGE);
    const pixels = analysis.context.getImageData(0, 0, analysis.canvas.width, analysis.canvas.height).data;
    const sampled = analyzeReferenceImagePixels(pixels, analysis.canvas.width, analysis.canvas.height);
    const metrics = referenceImageMetricsSchema.parse({
      ...sampled,
      width: source.width,
      height: source.height,
    });
    return {
      fileName: `${file.name.replace(/\.[^.]+$/, "") || "reference"}.director-reference.jpg`,
      mimeType: "image/jpeg",
      base64: decoded.base64,
      sha256: await sha256Hex(decoded.bytes),
      dataUrl,
      byteLength: decoded.bytes.byteLength,
      metrics,
    };
  } finally {
    source.close?.();
  }
}
