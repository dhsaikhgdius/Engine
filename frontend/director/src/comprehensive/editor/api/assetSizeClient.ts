import { z } from "zod";
import { gatewayErrorWireSchema } from "../../../../../../packages/protocol/src/agentGatewayProtocol";
import { directorControlPlaneFetch } from "./directorControlPlaneClient";

const assetSizeEstimateSchema = z.strictObject({ heightMeters: z.number().finite().positive() });

/** Error thrown by asset size estimation API calls when the gateway rejects the request. */
export class AssetSizeClientError extends Error {
  constructor(
    message: string,
    /** HTTP status code from the gateway response. */
    readonly status: number,
    /** Machine-readable error code from the gateway, if available. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "AssetSizeClientError";
  }
}

/**
 * Asks the gateway for a plausible real-world height, in meters, of the object
 * an asset depicts. Assets that arrive without a catalog size use this to land
 * on the same metric scale as the rest of the stage.
 */
export async function estimateAssetRealWorldSize(
  input: { name: string; prompt?: string },
  options: { signal?: AbortSignal } = {},
): Promise<number> {
  const response = await directorControlPlaneFetch("/api/assets/size-estimate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: input.name, ...(input.prompt ? { prompt: input.prompt } : {}) }),
    signal: options.signal,
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = gatewayErrorWireSchema.safeParse(body);
    throw new AssetSizeClientError(
      failure.success
        ? failure.data.message || failure.data.error || `Asset size estimate failed (HTTP ${response.status})`
        : `Asset size estimate failed (HTTP ${response.status})`,
      response.status,
      failure.success ? failure.data.code : undefined,
    );
  }
  const parsed = assetSizeEstimateSchema.safeParse(body);
  if (!parsed.success) {
    throw new AssetSizeClientError(
      "Asset size estimate response is incompatible.",
      response.status,
      "invalid_response",
    );
  }
  return parsed.data.heightMeters;
}
