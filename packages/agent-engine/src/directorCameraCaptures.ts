/**
 * Shared limits and parsing for Director camera capture evidence.
 *
 * Camera captures are the visual acceptance channel of the workbench loop
 * (a 35–65 mm capture, not `audit.ready`): the browser Stage renders them,
 * the gateway persists them, and Agent tool results reference them. The
 * budgets here are the single source of truth for all three sides, so a
 * capture accepted by the UI can never be rejected by the gateway or
 * overflow an Agent tool-result payload.
 *
 * @module directorCameraCaptures
 */

import type { StageCapturePayload } from "./stageFeedback.js";

const SUPPORTED_IMAGE_TYPES = new Set<StageCapturePayload["mimeType"]>(["image/png", "image/jpeg", "image/webp"]);

/** Maximum allowed size of a base64-encoded capture payload (12 MiB). */
export const MAX_DIRECTOR_CAPTURE_BYTES = 12 * 1024 * 1024;

/** Wire string budget for a single capture data URL (matches gateway/protocol). */
export const MAX_DIRECTOR_CAPTURE_DATA_URL_CHARS = 16_800_000;

/** Viewport twelve-shot preset is the largest UI batch that lands in one call. */
export const MAX_DIRECTOR_CAMERA_CAPTURES_PER_ACTION = 12;

/**
 * Parses a `data:` URL the same way Stage capture evidence does: PNG/JPEG/WebP
 * only, base64 payload, decoded size ≤ {@link MAX_DIRECTOR_CAPTURE_BYTES}.
 */
export function parseDirectorCaptureDataUrl(dataUrl: string): StageCapturePayload | null {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) return null;
  const mimeType = match[1] as StageCapturePayload["mimeType"];
  if (!SUPPORTED_IMAGE_TYPES.has(mimeType)) return null;
  const data = match[2]!;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const byteLength = Math.floor((data.length * 3) / 4) - padding;
  if (byteLength <= 0 || byteLength > MAX_DIRECTOR_CAPTURE_BYTES) return null;
  return { mimeType, data };
}

/**
 * True when the data URL fits the wire budget and parses as a supported
 * capture ({@link parseDirectorCaptureDataUrl}). Used as the cheap gate
 * before a capture is attached to a tool result or persisted.
 */
export function isValidDirectorCaptureDataUrl(dataUrl: string): boolean {
  return dataUrl.length <= MAX_DIRECTOR_CAPTURE_DATA_URL_CHARS && parseDirectorCaptureDataUrl(dataUrl) !== null;
}

/** Human-facing capture name shown in the Gallery (UI copy is Simplified Chinese). */
export function formatDirectorCameraCaptureName(cameraName: string, captureIndex: number) {
  return `${cameraName}-截图${String(captureIndex).padStart(2, "0")}`;
}

/** Stable capture id derived from the camera id, so re-captures are addressable. */
export function formatDirectorCameraCaptureId(cameraId: string, captureIndex: number) {
  return `${cameraId}-capture-${String(captureIndex).padStart(2, "0")}`;
}
