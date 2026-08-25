import { directorControlPlaneFetch } from "../../api/directorControlPlaneClient";
import { decodeArdyMotionNpz, type ArdyMotionClip } from "./ardyNpz";

/**
 * Workbench client for the gateway's ARDY text-to-motion bridge
 * (`/api/motion/ardy/*`). Generation is a streaming NDJSON call: `status`
 * events narrate the GPU run line by line and the terminal event is `done`
 * (with a motion URL) or `error`.
 */

/** Readiness status of the ARDY motion-generation bridge on the gateway. */
export interface ArdyBridgeStatus {
  /** Whether the bridge is configured and ready to accept generation requests. */
  configured: boolean;
  /** Whether the bridge routes to a remote GPU worker. */
  remote: boolean;
  /** The model identifier the bridge is currently serving. */
  model: string;
}

/** Parameters for a single ARDY text-to-motion generation request. */
export interface ArdyGenerateOptions {
  /** Natural-language motion prompt (e.g. "a person walking forward"). */
  prompt: string;
  /** Desired clip duration in seconds. */
  durationS: number;
  /** Optional deterministic seed for reproducible generation. */
  seed?: number;
  /** Optional callback receiving live status lines from the GPU worker. */
  onStatus?: (message: string) => void;
  /** Optional abort signal to cancel the in-flight request. */
  signal?: AbortSignal;
}

/** Result of a completed ARDY text-to-motion generation. */
export interface ArdyGenerateResult {
  /** Unique job identifier assigned by the gateway. */
  jobId: string;
  /** URL from which the raw motion npz can be downloaded. */
  motionUrl: string;
  /** Size of the generated motion npz in bytes. */
  bytes: number;
  /** The model identifier that produced this clip. */
  model: string;
}

type FetchImplementation = (path: string, init?: RequestInit) => Promise<Response>;

const defaultFetch: FetchImplementation = (path, init) => directorControlPlaneFetch(path, init);

/**
 * Query the gateway's ARDY bridge status endpoint.
 *
 * @param fetchImpl - Optional fetch implementation for dependency injection.
 * @returns The bridge's current readiness status.
 */
export async function fetchArdyBridgeStatus(fetchImpl: FetchImplementation = defaultFetch): Promise<ArdyBridgeStatus> {
  const response = await fetchImpl("/api/motion/ardy/status");
  if (!response.ok) throw new Error(`ARDY status request failed (HTTP ${response.status})`);
  const payload = (await response.json()) as { success?: boolean; result?: ArdyBridgeStatus };
  if (!payload.success || !payload.result) throw new Error("ARDY status response is malformed");
  return payload.result;
}

/**
 * Run one generation and resolve with the completed job. Rejections carry the
 * bridge's own error message (configuration, validation, or GPU failure).
 */
export async function generateArdyMotion(
  options: ArdyGenerateOptions,
  fetchImpl: FetchImplementation = defaultFetch,
): Promise<ArdyGenerateResult> {
  const response = await fetchImpl("/api/motion/ardy/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      prompt: options.prompt,
      durationS: options.durationS,
      ...(options.seed === undefined ? {} : { seed: options.seed }),
    }),
    signal: options.signal,
  });
  if (!response.ok) {
    const message = await readErrorMessage(response);
    throw new Error(message ?? `ARDY generation request failed (HTTP ${response.status})`);
  }
  if (!response.body) throw new Error("ARDY generation response has no body stream");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let result: ArdyGenerateResult | null = null;

  const consumeLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return; // Partial or foreign line; NDJSON framing already isolates events.
    }
    if (event.event === "status" && typeof event.message === "string") {
      options.onStatus?.(event.message);
      return;
    }
    if (event.event === "error") {
      throw new Error(typeof event.message === "string" ? event.message : "ARDY generation failed");
    }
    if (
      event.event === "done" &&
      typeof event.jobId === "string" &&
      typeof event.motionUrl === "string" &&
      typeof event.model === "string"
    ) {
      result = {
        jobId: event.jobId,
        motionUrl: event.motionUrl,
        bytes: typeof event.bytes === "number" ? event.bytes : 0,
        model: event.model,
      };
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (value) {
      buffered += decoder.decode(value, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        consumeLine(line);
        newline = buffered.indexOf("\n");
      }
    }
    if (done) break;
  }
  consumeLine(buffered);

  if (!result) throw new Error("ARDY generation ended without a completed motion");
  return result;
}

/** Download and decode a generated motion npz from its `done` event URL. */
export async function loadArdyMotionClip(
  motionUrl: string,
  signal?: AbortSignal,
  fetchImpl: FetchImplementation = defaultFetch,
): Promise<ArdyMotionClip> {
  const response = await fetchImpl(motionUrl, { signal });
  if (!response.ok) throw new Error(`Motion download failed (HTTP ${response.status})`);
  const buffer = await response.arrayBuffer();
  return decodeArdyMotionNpz(new Uint8Array(buffer));
}

async function readErrorMessage(response: Response): Promise<string | null> {
  try {
    const payload = (await response.json()) as { error?: unknown };
    return typeof payload.error === "string" ? payload.error : null;
  } catch {
    return null;
  }
}
