import { z } from "zod";
import {
  blenderLiveCommandBatchSchema,
  blenderLiveHealthSchema,
  blenderLiveJobAcceptedSchema,
  blenderLiveJobSchema,
  blenderLiveSceneSnapshotSchema,
  type BlenderLiveCommandBatchInput,
  type BlenderLiveJob,
  type BlenderLiveJobAccepted,
  type BlenderLiveSceneSnapshot,
  type BlenderLiveStatus,
} from "../../../packages/protocol/src/blenderLiveProtocol";

// A 2K Blender viewport/camera capture is returned as a base64 PNG inside the
// native job envelope. Keep enough headroom for a detailed clean-frame result.
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
// Scene GLB previews bypass JSON and stream as raw binary; match the gateway's
// 512 MB native model ceiling instead of the JSON envelope limit.
const MAX_BINARY_RESPONSE_BYTES = 512 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 4_000;
const SNAPSHOT_TIMEOUT_MS = 30_000;
const jobIdSchema = z.string().uuid();
const previewSceneEpochSchema = z.string().uuid();

/** A binary GLB scene preview streamed from the native session. */
export interface BlenderNativePreviewGlb {
  /** Raw GLB bytes. */
  bytes: Buffer;
  /** The scene epoch at the time the preview was captured. */
  sceneEpoch: string;
  /** The scene revision at the time the preview was captured. */
  revision: number;
}

/**
 * A typed HTTP client for the Blender native session (Blender's in-process
 * loopback server). All methods are bound to the same loopback origin and
 * enforce the live contract schema on every response.
 */
export interface BlenderNativeSession {
  /** Query the native session health and version. */
  status(): Promise<BlenderLiveStatus>;
  /** Capture a full scene snapshot (objects, cameras, lights, metadata). */
  snapshot(): Promise<BlenderLiveSceneSnapshot>;
  /** Submit a batch of live commands and receive an accepted job id. */
  submit(batch: BlenderLiveCommandBatchInput): Promise<BlenderLiveJobAccepted>;
  /** Poll a job by id; when `consume` is true the native session deletes the job record after serving it. */
  job(jobId: string, options?: { consume?: boolean }): Promise<BlenderLiveJob>;
  /** Download a binary GLB scene preview for a completed export job. */
  previewGlb(jobId: string, options?: { consume?: boolean }): Promise<BlenderNativePreviewGlb>;
}

/** Options for creating a Blender native session client. */
export interface CreateBlenderNativeSessionOptions {
  /** Loopback base URL (defaults to `http://127.0.0.1:8791`). */
  baseUrl?: string;
  /** Optional bearer token for the native session. */
  token?: string;
  /** Per-request timeout in milliseconds (defaults to 4 000). */
  timeoutMs?: number;
  /** Override the global fetch implementation (e.g. for testing). */
  fetcher?: typeof fetch;
}

/**
 * An error returned by the Blender native session HTTP client.
 * Carries the HTTP status code, a machine-readable error code, and
 * an optional structured result payload.
 */
export class BlenderNativeSessionError extends Error {
  /** HTTP status code from the native session response. */
  readonly status: number;
  /** Machine-readable error code. */
  readonly code: string;
  /** Optional structured result payload attached to the error. */
  readonly result?: Record<string, unknown>;

  constructor(message: string, status = 502, code = "blender_session_error", result?: Record<string, unknown>) {
    super(message);
    this.name = "BlenderNativeSessionError";
    this.status = status;
    this.code = code;
    this.result = result;
  }
}

function normalizeLoopbackUrl(raw: string | undefined) {
  const parsed = new URL(raw?.trim() || "http://127.0.0.1:8791");
  if (parsed.protocol !== "http:") {
    throw new Error("Blender native session must use loopback HTTP.");
  }
  if (!new Set(["127.0.0.1", "localhost", "::1", "[::1]"]).has(parsed.hostname)) {
    throw new Error(`Blender native session cannot use non-loopback host ${parsed.hostname}.`);
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

async function decodeBoundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new BlenderNativeSessionError("Blender native session response exceeded the size limit.");
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw new BlenderNativeSessionError("Blender native session response exceeded the size limit.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new BlenderNativeSessionError("Blender native session returned invalid JSON.");
  }
}

function fetchCauseCode(error: unknown): string {
  if (!error || typeof error !== "object" || !("cause" in error)) return "";
  const cause = (error as { cause?: { code?: unknown } }).cause;
  return cause && typeof cause === "object" && typeof cause.code === "string" ? cause.code : "";
}

function isTransientNativeFetchError(error: unknown): boolean {
  if (error instanceof BlenderNativeSessionError) return false;
  if (error instanceof Error && error.name === "AbortError") return false;
  const message = error instanceof Error ? error.message : String(error);
  if (/abort/i.test(message)) return false;
  const code = fetchCauseCode(error);
  return (
    message === "fetch failed" ||
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "UND_ERR_SOCKET" ||
    code === "UND_ERR_CONNECT_TIMEOUT"
  );
}

function toSessionError(error: unknown, baseUrl: string): BlenderNativeSessionError {
  if (error instanceof BlenderNativeSessionError) return error;
  if (error instanceof Error && error.name === "AbortError") {
    return new BlenderNativeSessionError("Blender native session request timed out.", 504, "blender_timeout");
  }
  return new BlenderNativeSessionError(
    `Blender native session is unavailable at ${baseUrl}. ${error instanceof Error ? error.message : String(error)}`,
    503,
    "blender_unavailable",
  );
}

async function failedResponseError(response: Response): Promise<BlenderNativeSessionError> {
  let message = `Blender native session request failed with HTTP ${response.status}.`;
  try {
    const body: unknown = JSON.parse(await response.text());
    if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
      message = body.error;
    }
  } catch {
    // Keep the HTTP status message for non-JSON error bodies.
  }
  return new BlenderNativeSessionError(message, response.status);
}

/**
 * Creates a typed HTTP client for the Blender native session loopback server.
 *
 * Only `127.0.0.1`, `localhost`, and `::1` loopback URLs are accepted;
 * non-loopback hosts are rejected immediately. Every response is validated
 * against the live contract schema and bounded to a configurable size limit.
 *
 * @param options - Connection options including loopback URL, token, and timeout.
 * @returns A session client with status, snapshot, submit, job, and previewGlb methods.
 */
export function createBlenderNativeSession(options: CreateBlenderNativeSessionOptions = {}): BlenderNativeSession {
  const baseUrl = normalizeLoopbackUrl(options.baseUrl);
  const fetcher = options.fetcher ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const token = options.token?.trim() || undefined;

  async function request<T>(
    path: string,
    schema: z.ZodType<T>,
    init: RequestInit = {},
    requestOptions?: { timeoutMs?: number },
  ): Promise<T> {
    const requestTimeoutMs = requestOptions?.timeoutMs ?? timeoutMs;
    const run = async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        const response = await fetcher(`${baseUrl}${path}`, {
          ...init,
          headers: {
            Accept: "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...init.headers,
          },
          signal: controller.signal,
        });
        const body = await decodeBoundedJson(response);
        if (!response.ok) {
          const message =
            body && typeof body === "object" && "error" in body && typeof body.error === "string"
              ? body.error
              : `Blender native session request failed with HTTP ${response.status}.`;
          throw new BlenderNativeSessionError(message, response.status);
        }
        const parsed = schema.safeParse(body);
        if (!parsed.success) {
          throw new BlenderNativeSessionError(
            `Blender native session contract mismatch: ${z.prettifyError(parsed.error)}`,
          );
        }
        return parsed.data;
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      return await run();
    } catch (error) {
      if (!isTransientNativeFetchError(error)) throw toSessionError(error, baseUrl);
      try {
        return await run();
      } catch (retryError) {
        throw toSessionError(retryError, baseUrl);
      }
    }
  }

  async function requestBinaryPreview(path: string): Promise<BlenderNativePreviewGlb> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(`${baseUrl}${path}`, {
        headers: {
          Accept: "model/gltf-binary",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal: controller.signal,
      });
      if (!response.ok) throw await failedResponseError(response);
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > MAX_BINARY_RESPONSE_BYTES) {
        throw new BlenderNativeSessionError("Blender native preview exceeded the binary size limit.");
      }
      const sceneEpoch = previewSceneEpochSchema.safeParse(response.headers.get("x-blender-scene-epoch"));
      const revisionHeader = response.headers.get("x-blender-revision");
      const revision = Number(revisionHeader);
      if (!sceneEpoch.success || revisionHeader === null || !Number.isInteger(revision) || revision < 0) {
        throw new BlenderNativeSessionError("Blender native preview returned invalid scene headers.");
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength > MAX_BINARY_RESPONSE_BYTES) {
        throw new BlenderNativeSessionError("Blender native preview exceeded the binary size limit.");
      }
      return { bytes, sceneEpoch: sceneEpoch.data, revision };
    } catch (error) {
      throw toSessionError(error, baseUrl);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async status() {
      try {
        return {
          available: true,
          ...(await request("/health", blenderLiveHealthSchema)),
        };
      } catch (error) {
        return {
          available: false,
          contract: "worldengine-blender-live-v1",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
    snapshot() {
      return request("/v1/scene", blenderLiveSceneSnapshotSchema, {}, { timeoutMs: SNAPSHOT_TIMEOUT_MS });
    },
    submit(input) {
      const batch = blenderLiveCommandBatchSchema.parse(input);
      return request("/v1/commands", blenderLiveJobAcceptedSchema, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(batch),
      });
    },
    job(input, jobOptions) {
      const jobId = jobIdSchema.parse(input);
      const consume = jobOptions?.consume ? "?consume=1" : "";
      return request(`/v1/jobs/${encodeURIComponent(jobId)}${consume}`, blenderLiveJobSchema);
    },
    previewGlb(input, previewOptions) {
      const jobId = jobIdSchema.parse(input);
      const consume = previewOptions?.consume ? "?consume=1" : "";
      return requestBinaryPreview(`/v1/previews/${encodeURIComponent(jobId)}.glb${consume}`);
    },
  };
}
