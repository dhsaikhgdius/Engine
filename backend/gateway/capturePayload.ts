import type { StageCapturePayload } from "@director/agent-engine";
import { MAX_DIRECTOR_CAPTURE_BYTES, parseDirectorCaptureDataUrl } from "@director/agent-engine/camera-captures";

/** Maximum allowed size of a base64-encoded capture payload (12 MiB). */
export const MAX_CAPTURE_BYTES = MAX_DIRECTOR_CAPTURE_BYTES;

/**
 * Parses a `data:` URL into a {@link StageCapturePayload}, validating the
 * MIME type and base64 payload size against {@link MAX_CAPTURE_BYTES}.
 *
 * @param dataUrl - The `data:image/...;base64,...` URL from a browser capture.
 * @returns The parsed payload, or `null` if the URL is invalid or too large.
 */
export function parseCaptureDataUrl(dataUrl: string): StageCapturePayload | null {
  return parseDirectorCaptureDataUrl(dataUrl);
}
