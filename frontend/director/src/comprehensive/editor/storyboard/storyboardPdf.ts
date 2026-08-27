/**
 * Storyboard PDF export: lays out storyboard shots (thumbnail, shot size,
 * movement, dialogue/notes) onto paginated A4/letter pages, builds the PDF
 * in the browser, and optionally wraps it in a verification ZIP with
 * per-page renders and a manifest keyed by the versioned contract id. The
 * contract id and manifest let downstream tooling and agents verify a
 * package was produced by a known layout version.
 */
import JSZip from "jszip";
import {
  DIRECTOR_STORYBOARD_MOVEMENTS,
  DIRECTOR_STORYBOARD_SHOT_SIZES,
  type DirectorProject,
  type DirectorStoryboardShot,
} from "../schema/directorProject";
import {
  persistentCreativeMediaLibrary,
  type PersistentCreativeMediaLibrary,
} from "../media/persistentCreativeMediaStore";
import { createEmptyDirectorStoryboard, sortStoryboardShots } from "./directorStoryboard";

/** Contract identifier embedded in every PDF and verification manifest. */
export const DIRECTOR_STORYBOARD_PDF_CONTRACT = "director-storyboard-pdf-v1" as const;
/** Default file name for the standalone PDF download. */
export const DIRECTOR_STORYBOARD_PDF_FILE_NAME = "director-storyboard.pdf";
/** Default file name for the verification ZIP package containing the PDF, pages, and manifest. */
export const DIRECTOR_STORYBOARD_PACKAGE_FILE_NAME = "director-storyboard-package.zip";

export type DirectorStoryboardPaperSize = "a4" | "letter";
export type DirectorStoryboardOrientation = "portrait" | "landscape";
export type DirectorStoryboardExportScope = "all" | "selected";
export type DirectorStoryboardColumns = 1 | 2 | 3 | 4;

/** User-configurable settings that control the PDF layout and content inclusion. */
export interface DirectorStoryboardPdfSettings {
  paperSize: DirectorStoryboardPaperSize;
  orientation: DirectorStoryboardOrientation;
  columns: DirectorStoryboardColumns;
  scope: DirectorStoryboardExportScope;
  selectedShotIds: string[];
  includeMetadata: boolean;
  includeAction: boolean;
}

/** Default settings for a new storyboard PDF export: A4 landscape, 3 columns, metadata and action included. */
export const DEFAULT_DIRECTOR_STORYBOARD_PDF_SETTINGS: DirectorStoryboardPdfSettings = {
  paperSize: "a4",
  orientation: "landscape",
  columns: 3,
  scope: "all",
  selectedShotIds: [],
  includeMetadata: true,
  includeAction: true,
};

/** A single raster page in the PDF: its dimensions, contained shot IDs, and JPEG bytes. */
export interface DirectorStoryboardPdfPage {
  index: number;
  widthPoints: number;
  heightPoints: number;
  widthPixels: number;
  heightPixels: number;
  shotIds: string[];
  jpegBytes: Uint8Array;
}

/** Self-describing manifest that accompanies every storyboard PDF for verification and archival. */
export interface DirectorStoryboardPdfManifest {
  contract: typeof DIRECTOR_STORYBOARD_PDF_CONTRACT;
  createdAt: string;
  storyboard: { title: string; logline: string };
  settings: DirectorStoryboardPdfSettings;
  shots: Array<{
    index: number;
    id: string;
    title: string;
    cameraId: string | null;
    cameraName: string | null;
    frameStart: number;
    frameEnd: number;
    shotSize: DirectorStoryboardShot["shotSize"];
    movement: DirectorStoryboardShot["movement"];
    action: string;
    page: number;
    thumbnail: DirectorStoryboardShot["thumbnail"] | null;
  }>;
  pages: Array<{
    index: number;
    path: string;
    widthPoints: number;
    heightPoints: number;
    widthPixels: number;
    heightPixels: number;
    shotIds: string[];
    bytes: number;
  }>;
  pdf: { path: string; bytes: number };
  warnings: string[];
}

/** The complete result of a storyboard PDF export: PDF bytes, page data, and manifest. */
export interface DirectorStoryboardPdfResult {
  pdfBytes: Uint8Array;
  pages: DirectorStoryboardPdfPage[];
  manifest: DirectorStoryboardPdfManifest;
}

/** Injectable dependencies for storyboard PDF generation, enabling test isolation. */
export interface DirectorStoryboardPdfDependencies {
  mediaLibrary?: Pick<PersistentCreativeMediaLibrary, "getBlob">;
  now?: () => Date;
  signal?: AbortSignal;
}

const POINTS_PER_INCH = 72;
const RASTER_DPI = 144;
const RASTER_SCALE = RASTER_DPI / POINTS_PER_INCH;
const PAPER_POINTS: Record<DirectorStoryboardPaperSize, [number, number]> = {
  a4: [595.28, 841.89],
  letter: [612, 792],
};
const utf8 = new TextEncoder();

function concatBytes(parts: Uint8Array[]) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function ascii(value: string) {
  return utf8.encode(value);
}

function pdfUtf16Hex(value: string) {
  const bytes = [0xfe, 0xff];
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    bytes.push((code >>> 8) & 0xff, code & 0xff);
  }
  return `<${bytes
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}>`;
}

function streamObject(dictionary: string, bytes: Uint8Array) {
  return concatBytes([ascii(`<< ${dictionary} /Length ${bytes.length} >>\nstream\n`), bytes, ascii("\nendstream")]);
}

/** Builds a standards-valid PDF whose pages are exact JPEG renderings. */
export function buildDirectorStoryboardRasterPdf(pages: DirectorStoryboardPdfPage[], title: string) {
  if (!pages.length) throw new Error("分镜 PDF 至少需要一页");
  const objectCount = 2 + pages.length * 3 + 1;
  const infoId = objectCount;
  const objects = new Map<number, Uint8Array>();
  const pageIds = pages.map((_, index) => 3 + index * 3);
  objects.set(1, ascii("<< /Type /Catalog /Pages 2 0 R >>"));
  objects.set(
    2,
    ascii(`<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>`),
  );

  pages.forEach((page, index) => {
    const pageId = pageIds[index]!;
    const imageId = pageId + 1;
    const contentId = pageId + 2;
    const width = Number(page.widthPoints.toFixed(2));
    const height = Number(page.heightPoints.toFixed(2));
    objects.set(
      pageId,
      ascii(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`,
      ),
    );
    objects.set(
      imageId,
      streamObject(
        `/Type /XObject /Subtype /Image /Width ${page.widthPixels} /Height ${page.heightPixels} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`,
        page.jpegBytes,
      ),
    );
    const content = ascii(`q\n${width} 0 0 ${height} 0 0 cm\n/Im0 Do\nQ\n`);
    objects.set(contentId, streamObject("", content));
  });
  objects.set(
    infoId,
    ascii(`<< /Title ${pdfUtf16Hex(title)} /Creator ${pdfUtf16Hex("Director Storyboard PDF v1")} >>`),
  );

  const header = concatBytes([ascii("%PDF-1.7\n%"), new Uint8Array([0xe2, 0xe3, 0xcf, 0xd3]), ascii("\n")]);
  const chunks = [header];
  const offsets = new Array<number>(objectCount + 1).fill(0);
  let offset = header.length;
  for (let id = 1; id <= objectCount; id += 1) {
    const body = objects.get(id);
    if (!body) throw new Error(`分镜 PDF 缺少对象 ${id}`);
    const chunk = concatBytes([ascii(`${id} 0 obj\n`), body, ascii("\nendobj\n")]);
    offsets[id] = offset;
    chunks.push(chunk);
    offset += chunk.length;
  }
  const xrefOffset = offset;
  const xref = ["xref", `0 ${objectCount + 1}`, "0000000000 65535 f "];
  for (let id = 1; id <= objectCount; id += 1) xref.push(`${String(offsets[id]).padStart(10, "0")} 00000 n `);
  chunks.push(
    ascii(
      `${xref.join("\n")}\ntrailer\n<< /Size ${objectCount + 1} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
    ),
  );
  return concatBytes(chunks);
}

function normalizeSettings(
  settings: Partial<DirectorStoryboardPdfSettings>,
  orderedShots: DirectorStoryboardShot[],
): DirectorStoryboardPdfSettings {
  const merged = { ...DEFAULT_DIRECTOR_STORYBOARD_PDF_SETTINGS, ...settings };
  if (![1, 2, 3, 4].includes(merged.columns)) throw new Error("分镜 PDF 列数必须为 1–4");
  const available = new Set(orderedShots.map((shot) => shot.id));
  return {
    paperSize: merged.paperSize === "letter" ? "letter" : "a4",
    orientation: merged.orientation === "portrait" ? "portrait" : "landscape",
    columns: merged.columns,
    scope: merged.scope === "selected" ? "selected" : "all",
    selectedShotIds: merged.selectedShotIds.filter(
      (id, index, values) => available.has(id) && values.indexOf(id) === index,
    ),
    includeMetadata: Boolean(merged.includeMetadata),
    includeAction: Boolean(merged.includeAction),
  };
}

/**
 * Filters and sorts storyboard shots for export based on the selected scope.
 *
 * @param shots - All storyboard shots.
 * @param settings - The scope and selected shot IDs.
 * @returns The ordered shots to include in the export.
 */
export function selectDirectorStoryboardExportShots(
  shots: DirectorStoryboardShot[],
  settings: Pick<DirectorStoryboardPdfSettings, "scope" | "selectedShotIds">,
) {
  const ordered = sortStoryboardShots(shots);
  if (settings.scope === "all") return ordered;
  const selected = new Set(settings.selectedShotIds);
  return ordered.filter((shot) => selected.has(shot.id));
}

/**
 * Returns the page dimensions in points (1/72 inch) for the given paper size and orientation.
 *
 * @param paperSize - The paper size (a4 or letter).
 * @param orientation - The page orientation (portrait or landscape).
 * @returns The width and height in points.
 */
export function getDirectorStoryboardPageSize(
  paperSize: DirectorStoryboardPaperSize,
  orientation: DirectorStoryboardOrientation,
) {
  const [portraitWidth, portraitHeight] = PAPER_POINTS[paperSize];
  return orientation === "portrait"
    ? { width: portraitWidth, height: portraitHeight }
    : { width: portraitHeight, height: portraitWidth };
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new DOMException("分镜 PDF 导出已取消", "AbortError");
}

function decodeDataUrl(dataUrl: string) {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([a-z\d+/=\s]+)$/i.exec(dataUrl);
  if (!match) return null;
  const binary = atob(match[2]!.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: match[1]!.toLowerCase() });
}

type DecodedImage = { source: CanvasImageSource; close: () => void };

async function decodeImage(blob: Blob): Promise<DecodedImage> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob);
    return { source: bitmap, close: () => bitmap.close() };
  }
  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = objectUrl;
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("分镜图片解码失败"));
    });
    return { source: image, close: () => URL.revokeObjectURL(objectUrl) };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

function drawCover(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const dimensions = source as { width?: number; height?: number; naturalWidth?: number; naturalHeight?: number };
  const sourceWidth = dimensions.naturalWidth ?? dimensions.width ?? width;
  const sourceHeight = dimensions.naturalHeight ?? dimensions.height ?? height;
  const scale = Math.max(width / Math.max(1, sourceWidth), height / Math.max(1, sourceHeight));
  const drawnWidth = sourceWidth * scale;
  const drawnHeight = sourceHeight * scale;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, width, height);
  ctx.clip();
  ctx.drawImage(source, x + (width - drawnWidth) / 2, y + (height - drawnHeight) / 2, drawnWidth, drawnHeight);
  ctx.restore();
}

function ellipsize(ctx: CanvasRenderingContext2D, value: string, maxWidth: number) {
  if (ctx.measureText(value).width <= maxWidth) return value;
  let result = value;
  while (result.length > 1 && ctx.measureText(`${result}…`).width > maxWidth) result = result.slice(0, -1);
  return `${result}…`;
}

function wrapLines(ctx: CanvasRenderingContext2D, value: string, maxWidth: number, maxLines: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const lines: string[] = [];
  let line = "";
  for (const character of normalized) {
    const next = line + character;
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line);
      line = character;
      if (lines.length === maxLines) break;
    } else line = next;
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines && lines.join("").length < normalized.length) {
    lines[maxLines - 1] = ellipsize(ctx, `${lines[maxLines - 1]}…`, maxWidth);
  }
  return lines;
}

function canvasToJpeg(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("浏览器无法编码分镜 PDF 页面"))),
      "image/jpeg",
      0.92,
    );
  });
}

async function resolveShotImage(
  project: DirectorProject,
  shot: DirectorStoryboardShot,
  library: Pick<PersistentCreativeMediaLibrary, "getBlob">,
  warnings: string[],
) {
  if (shot.thumbnail) {
    const stale = shot.thumbnail.cameraId !== shot.cameraId || shot.thumbnail.frame !== shot.frameStart;
    if (stale) warnings.push(`${shot.title}：缩略图机位或帧已变化，导出保留旧画面并标记为待重拍`);
    const blob = await library.getBlob(shot.thumbnail.mediaId);
    if (!blob) warnings.push(`${shot.title}：缩略图媒体 ${shot.thumbnail.mediaId} 不存在`);
    else {
      return blob;
    }
  }
  const cameraCapture = project.cameras.find((camera) => camera.id === shot.cameraId)?.lastCaptureUrl;
  const legacy = cameraCapture ? decodeDataUrl(cameraCapture) : null;
  if (legacy) {
    warnings.push(`${shot.title}：使用未绑定帧版本的相机预览作为后备画面`);
    return legacy;
  }
  warnings.push(`${shot.title}：没有可用画面，PDF 使用占位卡`);
  return null;
}

function getLabel<T extends string>(options: ReadonlyArray<{ id: T; label: string }>, id: T) {
  return options.find((option) => option.id === id)?.label ?? id;
}

async function renderStoryboardPages(
  project: DirectorProject,
  shots: DirectorStoryboardShot[],
  settings: DirectorStoryboardPdfSettings,
  dependencies: DirectorStoryboardPdfDependencies,
  warnings: string[],
) {
  const pageSize = getDirectorStoryboardPageSize(settings.paperSize, settings.orientation);
  const margin = 30;
  const headerHeight = 52;
  const footerHeight = 18;
  const gutter = 9;
  const usableWidth = pageSize.width - margin * 2;
  const cardWidth = (usableWidth - gutter * (settings.columns - 1)) / settings.columns;
  const imageHeight = Math.min((cardWidth * 9) / 16, settings.orientation === "landscape" ? 190 : 205);
  const cardHeight = 28 + imageHeight + (settings.includeMetadata ? 24 : 0) + (settings.includeAction ? 40 : 0) + 14;
  const usableHeight = pageSize.height - margin * 2 - headerHeight - footerHeight;
  const rows = Math.max(1, Math.floor((usableHeight + gutter) / (cardHeight + gutter)));
  const perPage = rows * settings.columns;
  const pageCount = Math.ceil(shots.length / perPage);
  const pages: DirectorStoryboardPdfPage[] = [];
  const mediaLibrary = dependencies.mediaLibrary ?? persistentCreativeMediaLibrary;
  const storyboard = project.storyboard ?? createEmptyDirectorStoryboard();

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    throwIfAborted(dependencies.signal);
    const pageShots = shots.slice(pageIndex * perPage, (pageIndex + 1) * perPage);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(pageSize.width * RASTER_SCALE);
    canvas.height = Math.round(pageSize.height * RASTER_SCALE);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("浏览器不支持 Canvas，无法生成分镜 PDF");
    ctx.scale(RASTER_SCALE, RASTER_SCALE);
    ctx.fillStyle = "#f5f3ed";
    ctx.fillRect(0, 0, pageSize.width, pageSize.height);
    ctx.fillStyle = "#111827";
    ctx.font = '700 18px system-ui, "PingFang SC", sans-serif';
    ctx.fillText(ellipsize(ctx, storyboard.title || "未命名分镜", usableWidth - 90), margin, margin + 18);
    ctx.font = '11px system-ui, "PingFang SC", sans-serif';
    ctx.fillStyle = "#586174";
    ctx.fillText(ellipsize(ctx, storyboard.logline || "", usableWidth - 90), margin, margin + 37);
    ctx.textAlign = "right";
    ctx.fillText(`${pageIndex + 1} / ${pageCount}`, pageSize.width - margin, margin + 18);
    ctx.textAlign = "left";

    for (let localIndex = 0; localIndex < pageShots.length; localIndex += 1) {
      throwIfAborted(dependencies.signal);
      const shot = pageShots[localIndex]!;
      const globalIndex = pageIndex * perPage + localIndex;
      const column = localIndex % settings.columns;
      const row = Math.floor(localIndex / settings.columns);
      const x = margin + column * (cardWidth + gutter);
      const y = margin + headerHeight + row * (cardHeight + gutter);
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "#cdd2da";
      ctx.lineWidth = 0.75;
      ctx.beginPath();
      ctx.roundRect(x, y, cardWidth, cardHeight, 5);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#111827";
      ctx.font = '700 10px system-ui, "PingFang SC", sans-serif';
      ctx.fillText(
        `${String(globalIndex + 1).padStart(2, "0")}  ${ellipsize(ctx, shot.title, cardWidth - 38)}`,
        x + 7,
        y + 17,
      );
      const imageY = y + 26;
      ctx.fillStyle = "#111827";
      ctx.fillRect(x + 6, imageY, cardWidth - 12, imageHeight);
      const blob = await resolveShotImage(project, shot, mediaLibrary, warnings);
      if (blob) {
        try {
          const image = await decodeImage(blob);
          drawCover(ctx, image.source, x + 6, imageY, cardWidth - 12, imageHeight);
          image.close();
        } catch {
          warnings.push(`${shot.title}：画面无法解码，PDF 使用占位卡`);
        }
      }
      if (!blob) {
        ctx.fillStyle = "#778195";
        ctx.font = '10px system-ui, "PingFang SC", sans-serif';
        ctx.textAlign = "center";
        ctx.fillText("尚未捕获镜头画面", x + cardWidth / 2, imageY + imageHeight / 2);
        ctx.textAlign = "left";
      }
      let textY = imageY + imageHeight + 14;
      if (settings.includeMetadata) {
        const cameraName = project.cameras.find((camera) => camera.id === shot.cameraId)?.name ?? "未指定机位";
        ctx.fillStyle = "#4b5567";
        ctx.font = '8.5px system-ui, "PingFang SC", sans-serif';
        ctx.fillText(
          ellipsize(ctx, `F${shot.frameStart}–${shot.frameEnd} · ${cameraName}`, cardWidth - 14),
          x + 7,
          textY,
        );
        ctx.fillText(
          ellipsize(
            ctx,
            `${getLabel(DIRECTOR_STORYBOARD_SHOT_SIZES, shot.shotSize)} · ${getLabel(DIRECTOR_STORYBOARD_MOVEMENTS, shot.movement)}`,
            cardWidth - 14,
          ),
          x + 7,
          textY + 11,
        );
        textY += 25;
      }
      if (settings.includeAction) {
        ctx.fillStyle = "#252b37";
        ctx.font = '8.5px system-ui, "PingFang SC", sans-serif';
        wrapLines(ctx, shot.action || "（未填写调度 / 表演）", cardWidth - 14, 3).forEach((line, lineIndex) => {
          ctx.fillText(line, x + 7, textY + lineIndex * 10);
        });
      }
    }
    ctx.fillStyle = "#6b7280";
    ctx.font = '8px system-ui, "PingFang SC", sans-serif';
    ctx.fillText(DIRECTOR_STORYBOARD_PDF_CONTRACT, margin, pageSize.height - margin + 5);
    const jpeg = await canvasToJpeg(canvas);
    pages.push({
      index: pageIndex + 1,
      widthPoints: pageSize.width,
      heightPoints: pageSize.height,
      widthPixels: canvas.width,
      heightPixels: canvas.height,
      shotIds: pageShots.map((shot) => shot.id),
      jpegBytes: new Uint8Array(await jpeg.arrayBuffer()),
    });
  }
  return pages;
}

/**
 * Creates a complete storyboard PDF from the project's storyboard shots.
 *
 * Renders each shot's thumbnail (or a fallback) into a gridded page layout,
 * builds a valid PDF 1.7 document, and returns it alongside the page data
 * and a self-describing manifest.
 *
 * @param project - The Director project containing the storyboard and cameras.
 * @param requestedSettings - Partial PDF settings merged with defaults.
 * @param dependencies - Injectable dependencies for testing.
 * @returns The PDF bytes, page data, and manifest.
 */
export async function createDirectorStoryboardPdf(
  project: DirectorProject,
  requestedSettings: Partial<DirectorStoryboardPdfSettings> = {},
  dependencies: DirectorStoryboardPdfDependencies = {},
): Promise<DirectorStoryboardPdfResult> {
  const storyboard = project.storyboard ?? createEmptyDirectorStoryboard();
  const orderedShots = sortStoryboardShots(storyboard.shots);
  const settings = normalizeSettings(requestedSettings, orderedShots);
  const shots = selectDirectorStoryboardExportShots(orderedShots, settings);
  if (!shots.length) throw new Error(settings.scope === "selected" ? "请至少选择一镜再导出" : "没有可导出的分镜");
  const warnings: string[] = [];
  const pages = await renderStoryboardPages(project, shots, settings, dependencies, warnings);
  throwIfAborted(dependencies.signal);
  const pdfBytes = buildDirectorStoryboardRasterPdf(pages, storyboard.title || "Director Storyboard");
  const pageByShot = new Map(pages.flatMap((page) => page.shotIds.map((shotId) => [shotId, page.index] as const)));
  const manifest: DirectorStoryboardPdfManifest = {
    contract: DIRECTOR_STORYBOARD_PDF_CONTRACT,
    createdAt: (dependencies.now ?? (() => new Date()))().toISOString(),
    storyboard: { title: storyboard.title, logline: storyboard.logline },
    settings,
    shots: shots.map((shot, index) => ({
      index: index + 1,
      id: shot.id,
      title: shot.title,
      cameraId: shot.cameraId,
      cameraName: project.cameras.find((camera) => camera.id === shot.cameraId)?.name ?? null,
      frameStart: shot.frameStart,
      frameEnd: shot.frameEnd,
      shotSize: shot.shotSize,
      movement: shot.movement,
      action: shot.action,
      page: pageByShot.get(shot.id) ?? 0,
      thumbnail: shot.thumbnail ? { ...shot.thumbnail } : null,
    })),
    pages: pages.map((page) => ({
      index: page.index,
      path: `pages/page-${String(page.index).padStart(3, "0")}.jpg`,
      widthPoints: page.widthPoints,
      heightPoints: page.heightPoints,
      widthPixels: page.widthPixels,
      heightPixels: page.heightPixels,
      shotIds: [...page.shotIds],
      bytes: page.jpegBytes.length,
    })),
    pdf: { path: DIRECTOR_STORYBOARD_PDF_FILE_NAME, bytes: pdfBytes.length },
    warnings: [...new Set(warnings)],
  };
  return { pdfBytes, pages, manifest };
}

/**
 * Verifies that a storyboard PDF result's manifest matches its actual bytes and page count.
 * Throws on any mismatch; returns true when valid.
 *
 * @param result - The storyboard PDF result to verify.
 * @returns true when the result is internally consistent.
 */
export function verifyDirectorStoryboardPdfResult(result: DirectorStoryboardPdfResult) {
  if (result.manifest.contract !== DIRECTOR_STORYBOARD_PDF_CONTRACT) throw new Error("未知的分镜 PDF 清单版本");
  if (result.manifest.pdf.bytes !== result.pdfBytes.length) throw new Error("分镜 PDF 文件大小不一致");
  if (result.pages.length !== result.manifest.pages.length) throw new Error("分镜 PDF 页面数量与清单不一致");
  result.pages.forEach((page, index) => {
    const declared = result.manifest.pages[index];
    if (!declared || declared.bytes !== page.jpegBytes.length)
      throw new Error(`分镜 PDF 第 ${index + 1} 页文件大小不一致`);
  });
  return true;
}

/**
 * Creates a ZIP verification package containing the PDF, per-page JPEGs, and the manifest.
 * Verifies internal consistency before packaging.
 *
 * @param result - The storyboard PDF result to package.
 * @returns A Blob containing the ZIP file.
 */
export async function createDirectorStoryboardVerificationPackage(result: DirectorStoryboardPdfResult) {
  verifyDirectorStoryboardPdfResult(result);
  const zip = new JSZip();
  zip.file(result.manifest.pdf.path, result.pdfBytes);
  result.pages.forEach((page, index) => zip.file(result.manifest.pages[index]!.path, page.jpegBytes));
  zip.file("manifest.json", `${JSON.stringify(result.manifest, null, 2)}\n`);
  return zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Triggers a browser download of the storyboard PDF. Verifies integrity before downloading. */
export function downloadDirectorStoryboardPdf(result: DirectorStoryboardPdfResult) {
  verifyDirectorStoryboardPdfResult(result);
  downloadBlob(new Blob([result.pdfBytes], { type: "application/pdf" }), DIRECTOR_STORYBOARD_PDF_FILE_NAME);
}

/** Triggers a browser download of the storyboard verification ZIP package. */
export async function downloadDirectorStoryboardVerificationPackage(result: DirectorStoryboardPdfResult) {
  downloadBlob(await createDirectorStoryboardVerificationPackage(result), DIRECTOR_STORYBOARD_PACKAGE_FILE_NAME);
}
