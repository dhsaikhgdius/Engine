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
import { directorControlPlaneFetch } from "./directorControlPlaneClient";

export type { DirectorDccExchangePackageResult } from "../../../dcc/directorDccExchangePackageContract";

const providerCatalogResponseSchema = z.strictObject({
  success: z.literal(true),
  result: directorDccProviderCatalogSchema,
});

const exportExchangePackageResponseSchema = z.strictObject({
  success: z.literal(true),
  result: directorDccExchangePackageResultSchema,
});

const gatewayErrorSchema = z.looseObject({
  success: z.literal(false).optional(),
  code: z.string().trim().min(1).optional(),
  error: z.string().trim().min(1).optional(),
  recovery: z.string().trim().min(1).optional(),
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

/** Error thrown by DCC provider API calls when the gateway rejects the request. */
export class DirectorDccProviderClientError extends Error {
  /** HTTP status code from the gateway response. */
  readonly status: number;
  /** Machine-readable error code from the gateway. */
  readonly code?: string;
  /** Optional recovery hint from the gateway. */
  readonly recovery?: string;

  constructor(message: string, status: number, code?: string, recovery?: string) {
    super(message);
    this.name = "DirectorDccProviderClientError";
    this.status = status;
    this.code = code;
    this.recovery = recovery;
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
