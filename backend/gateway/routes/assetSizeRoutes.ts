import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { AssetSizeEstimator } from "../promptExpansion/assetSizeEstimator";

type JsonWriter = (response: ServerResponse, status: number, body: unknown) => void;

/**
 * Locally imported models carry no catalog size, so the workbench asks the
 * gateway for a plausible real-world height and normalizes the asset onto the
 * stage's metric scale. Estimation is advisory: callers keep working when this
 * route is unavailable.
 */
const assetSizeEstimateRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  prompt: z.string().trim().max(2_000).optional(),
});

export type AssetSizeRouteDependencies = {
  readBody: (request: IncomingMessage) => Promise<unknown>;
  json: JsonWriter;
  /** Absent when the gateway has no film LLM credentials configured. */
  sizeEstimator?: Pick<AssetSizeEstimator, "estimate">;
};

export async function handleAssetSizeRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  dependencies: AssetSizeRouteDependencies,
) {
  const { json, sizeEstimator } = dependencies;
  if (request.method !== "POST" || url.pathname !== "/api/assets/size-estimate") return false;

  const parsed = assetSizeEstimateRequestSchema.safeParse(await dependencies.readBody(request));
  if (!parsed.success) {
    json(response, 400, { message: "Asset size estimate request is invalid", issues: parsed.error.issues });
    return true;
  }
  if (!sizeEstimator) {
    json(response, 503, {
      code: "asset_size_estimator_not_configured",
      message: "Asset size estimation is not configured on the Director gateway",
    });
    return true;
  }

  try {
    // The name doubles as the object description when the caller has no prompt,
    // which is the normal case for a model file the user picked from disk.
    const estimate = await sizeEstimator.estimate({
      name: parsed.data.name,
      prompt: parsed.data.prompt ?? parsed.data.name,
    });
    json(response, 200, { heightMeters: estimate.heightMeters });
  } catch (error) {
    json(response, 502, {
      code: "asset_size_estimate_failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return true;
}
