/**
 * Typed HTTP client for the gateway's DCC provider domain: lists the provider
 * catalog (Blender, engine connectors, portable exchange), exports the
 * current scene as an exchange package in a chosen portable format, and sends
 * packages to a target engine. Responses are Zod-validated against the shared
 * DCC contracts so the UI and the `director_dcc` agent tool consume the same
 * catalog and results.
 */
import { z } from "zod";
import {
  directorDccPortableExchangeFormatSchema,
  directorDccProviderCatalogSchema,
  directorDccProviderIdSchema,
  type DirectorDccPortableExchangeFormat,
  type DirectorDccProviderCatalog,
  type DirectorDccProviderId,
} from "../../../dcc/directorDccProviderContract";
import {
  directorDccExchangePackageResultSchema,
  type DirectorDccExchangePackageResult,
} from "../../../dcc/directorDccExchangePackageContract";
import {
  directorDccEngineSendResultSchema,
  type DirectorDccEngineSendResult,
} from "../../../dcc/directorDccEngineContract";
import { directorDccEngineIdSchema, type DirectorDccEngineId } from "../../../dcc/directorDccEngineSpace";
import { directorControlPlaneFetch } from "./directorControlPlaneClient";

export type { DirectorDccExchangePackageResult } from "../../../dcc/directorDccExchangePackageContract";
export type { DirectorDccEngineSendResult } from "../../../dcc/directorDccEngineContract";

const providerCatalogResponseSchema = z.strictObject({
  success: z.literal(true),
  result: directorDccProviderCatalogSchema,
});

const exportExchangePackageResponseSchema = z.strictObject({
  success: z.literal(true),
  result: directorDccExchangePackageResultSchema,
});

const sendToEngineResponseSchema = z.strictObject({
  success: z.literal(true),
  result: directorDccEngineSendResultSchema,
});

const gatewayErrorDiagnosticsSchema = z.looseObject({
  provider: directorDccEngineIdSchema,
  ready: z.boolean(),
  warnings: z.array(z.string()),
  recovery: z.array(z.string()),
});

const gatewayErrorSchema = z.looseObject({
  success: z.literal(false).optional(),
  code: z.string().trim().min(1).optional(),
  error: z.string().trim().min(1).optional(),
  recovery: z.string().trim().min(1).optional(),
  diagnostics: gatewayErrorDiagnosticsSchema.optional(),
});

const exportExchangePackageInputSchema = z.strictObject({
  provider: directorDccProviderIdSchema,
  formats: z.array(directorDccPortableExchangeFormatSchema).min(1).max(2).optional(),
  cameraId: z.string().trim().min(1).max(160).optional(),
  frame: z.number().finite().nonnegative().optional(),
});

/** Input shape for requesting a DCC exchange package export. */
export interface DirectorDccExchangePackageRequest {
  /** The DCC tool to target (e.g. "blender", "maya"). */
  provider: DirectorDccProviderId;
  /** Optional portable formats to include in the exchange package. */
  formats?: DirectorDccPortableExchangeFormat[];
  /** Optional camera id to snapshot from when exporting. */
  cameraId?: string;
  /** Optional frame number to snapshot at. */
  frame?: number;
}

/** Structured not-ready diagnostics forwarded from the gateway, when present. */
export interface DirectorDccProviderClientDiagnostics {
  provider: DirectorDccEngineId;
  ready: boolean;
  warnings: string[];
  recovery: string[];
}

/** Error thrown by DCC provider API calls when the gateway rejects the request. */
export class DirectorDccProviderClientError extends Error {
  /** HTTP status code from the gateway response. */
  readonly status: number;
  /** Machine-readable error code from the gateway. */
  readonly code?: string;
  /** Optional recovery hint from the gateway. */
  readonly recovery?: string;
  /** Structured engine diagnostics from the gateway, when present. */
  readonly diagnostics?: DirectorDccProviderClientDiagnostics;

  constructor(
    message: string,
    status: number,
    code?: string,
    recovery?: string,
    diagnostics?: DirectorDccProviderClientDiagnostics,
  ) {
    super(message);
    this.name = "DirectorDccProviderClientError";
    this.status = status;
    this.code = code;
    this.recovery = recovery;
    this.diagnostics = diagnostics;
  }
}

async function responseJson(response: Response): Promise<unknown> {
  return response.json().catch(() => ({}));
}

function throwGatewayError(response: Response, body: unknown, fallback: string): never {
  const parsed = gatewayErrorSchema.safeParse(body);
  if (parsed.success && (parsed.data.error || parsed.data.code)) {
    throw new DirectorDccProviderClientError(
      parsed.data.error ?? fallback,
      response.status,
      parsed.data.code,
      parsed.data.recovery,
      parsed.data.diagnostics,
    );
  }
  throw new DirectorDccProviderClientError(
    `${fallback}: gateway response did not match the Director DCC provider contract`,
    response.ok ? 502 : response.status,
    "invalid_response",
  );
}

/**
 * Discovers available DCC providers from the gateway.
 *
 * Returns a catalog of registered DCC tools (Blender, Maya, etc.) with their
 * capabilities and connection status.
 *
 * @param options - Optional abort signal for cancellation.
 * @returns The DCC provider catalog.
 */
export async function discoverDirectorDccProviders(
  options: { signal?: AbortSignal } = {},
): Promise<DirectorDccProviderCatalog> {
  const response = await directorControlPlaneFetch("/api/dcc/providers", { signal: options.signal });
  const body = await responseJson(response);
  const parsed = providerCatalogResponseSchema.safeParse(body);
  if (parsed.success && response.ok) return parsed.data.result;
  return throwGatewayError(response, body, "DCC provider discovery failed");
}

/**
 * Exports a DCC exchange package for the current scene.
 *
 * Packages the current Director scene into a portable format that can be
 * opened in the target DCC tool. The gateway validates the response against
 * the expected provider.
 *
 * @param input - The export request specifying provider, formats, and optional camera/frame.
 * @param options - Optional abort signal for cancellation.
 * @returns The exchange package result with download URLs.
 */
export async function exportDirectorDccExchangePackage(
  input: DirectorDccExchangePackageRequest,
  options: { signal?: AbortSignal } = {},
): Promise<DirectorDccExchangePackageResult> {
  const request = exportExchangePackageInputSchema.parse(input);
  const response = await directorControlPlaneFetch("/api/tools/director_dcc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input: {
        op: "export_exchange_package",
        provider: request.provider,
        ...(request.formats ? { formats: request.formats } : {}),
        ...(request.cameraId ? { camera_id: request.cameraId } : {}),
        ...(request.frame !== undefined ? { frame: request.frame } : {}),
      },
    }),
    signal: options.signal,
  });
  const body = await responseJson(response);
  const parsed = exportExchangePackageResponseSchema.safeParse(body);
  if (!parsed.success || !response.ok) return throwGatewayError(response, body, "DCC exchange package export failed");

  const result = parsed.data.result;
  if (result.provider !== request.provider) {
    throw new DirectorDccProviderClientError(
      `DCC exchange package response targeted ${result.provider}, not ${request.provider}`,
      502,
      "provider_mismatch",
    );
  }
  return result;
}

const sendToEngineInputSchema = z.strictObject({
  provider: directorDccEngineIdSchema,
  formats: z.array(directorDccPortableExchangeFormatSchema).min(1).max(2).optional(),
  cameraId: z.string().trim().min(1).max(160).optional(),
  frame: z.number().finite().nonnegative().optional(),
  cleanFrame: z.boolean().optional(),
});

/** Input shape for a headless send-to-engine handoff. */
export interface DirectorDccEngineSendRequest {
  /** The engine connector to target ("unreal", "unity", or "godot"). */
  provider: DirectorDccEngineId;
  /** Optional portable formats to include in the exchange package. */
  formats?: DirectorDccPortableExchangeFormat[];
  /** Optional camera id to snapshot from when exporting. */
  cameraId?: string;
  /** Optional frame number to snapshot at. */
  frame?: number;
  /**
   * Unreal-only: also render one best-effort clean still (no gizmos or
   * labels) and attach its receipt (`rendered` with a hash-pinned image, or
   * `skipped` with a reason — a skip never fails the handoff).
   */
  cleanFrame?: boolean;
}

/**
 * Runs a headless send-to-engine handoff through the gateway.
 *
 * The gateway exports an exchange package, invokes the fixed Director-authored
 * connector entry point inside the user's engine installation, and returns the
 * schema-validated host report. Rejected with structured diagnostics when the
 * engine connector is not nativeReady.
 *
 * @param input - The send request specifying provider, formats, and optional camera/frame.
 * @param options - Optional abort signal for cancellation.
 * @returns The completed send result including the host report.
 */
export async function sendDirectorProjectToEngine(
  input: DirectorDccEngineSendRequest,
  options: { signal?: AbortSignal } = {},
): Promise<DirectorDccEngineSendResult> {
  const request = sendToEngineInputSchema.parse(input);
  const response = await directorControlPlaneFetch("/api/tools/director_dcc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input: {
        op: "send_to_engine",
        provider: request.provider,
        ...(request.formats ? { formats: request.formats } : {}),
        ...(request.cameraId ? { camera_id: request.cameraId } : {}),
        ...(request.frame !== undefined ? { frame: request.frame } : {}),
        ...(request.cleanFrame !== undefined ? { clean_frame: request.cleanFrame } : {}),
      },
    }),
    signal: options.signal,
  });
  const body = await responseJson(response);
  const parsed = sendToEngineResponseSchema.safeParse(body);
  if (!parsed.success || !response.ok) return throwGatewayError(response, body, "Engine handoff failed");

  const result = parsed.data.result;
  if (result.provider !== request.provider) {
    throw new DirectorDccProviderClientError(
      `Engine handoff response targeted ${result.provider}, not ${request.provider}`,
      502,
      "provider_mismatch",
    );
  }
  return result;
}
