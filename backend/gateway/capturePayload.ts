import type { StageCapturePayload } from "@director/agent-engine";

const SUPPORTED_IMAGE_TYPES = new Set<StageCapturePayload["mimeType"]>(["image/png", "image/jpeg", "image/webp"]);

/** Maximum allowed size of a base64-encoded capture payload (12 MiB). */
export const MAX_CAPTURE_BYTES = 12 * 1024 * 1024;

/**
 * Parses a `data:` URL into a {@link StageCapturePayload}, validating the
 * MIME type and base64 payload size against {@link MAX_CAPTURE_BYTES}.
 *
 * @param dataUrl - The `data:image/...;base64,...` URL from a browser capture.
 * @returns The parsed payload, or `null` if the URL is invalid or too large.
 */
export function parseCaptureDataUrl(dataUrl: string): StageCapturePayload | null {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) return null;
  const mimeType = match[1] as StageCapturePayload["mimeType"];
  if (!SUPPORTED_IMAGE_TYPES.has(mimeType)) return null;
  const data = match[2];
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const byteLength = Math.floor((data.length * 3) / 4) - padding;
  if (byteLength <= 0 || byteLength > MAX_CAPTURE_BYTES) return null;
  return { mimeType, data };
}
