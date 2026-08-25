import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { referenceSceneAnalysisRequestSchema } from "../../../packages/protocol/src/referenceSceneReconstructionProtocol";
import { ReferenceSceneAnalysisError, type ReferenceSceneAnalyzer } from "../reconstruction/referenceSceneAnalyzer";

type JsonWriter = (response: ServerResponse, status: number, body: unknown) => void;

/** Dependencies required by the reference scene analysis route handler. */
export type ReferenceSceneRouteDependencies = {
  /** Parses the request body into a JSON-compatible value. */
  readBody: (request: IncomingMessage) => Promise<unknown>;
  /** Writes a JSON response with the given status code. */
  json: JsonWriter;
  /** The reference scene analyzer that performs the analysis. */
  analyzer: ReferenceSceneAnalyzer;
};

/**
 * Handles the POST /api/reconstruction/reference-scene/analyze route.
 *
 * Validates the request body against the reference scene analysis schema,
 * delegates to the analyzer, and returns the reconstruction plan. Supports
 * abort via the request's `aborted` event or response close.
 *
 * @param request - The incoming HTTP request.
 * @param response - The outgoing HTTP response.
 * @param url - The parsed request URL.
 * @param dependencies - The route dependencies.
 * @returns True if the route was handled, false otherwise.
 */
export async function handleReferenceSceneRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  dependencies: ReferenceSceneRouteDependencies,
) {
  if (request.method !== "POST" || url.pathname !== "/api/reconstruction/reference-scene/analyze") return false;
  const parsed = referenceSceneAnalysisRequestSchema.safeParse(await dependencies.readBody(request));
  if (!parsed.success) {
    dependencies.json(response, 400, {
      error: "Reference scene analysis request is invalid",
      code: "invalid_request",
      issues: parsed.error.issues,
    });
    return true;
  }

  const controller = new AbortController();
  const abort = () => controller.abort(new DOMException("Reference scene analysis cancelled", "AbortError"));
  request.once("aborted", abort);
  response.once("close", () => {
    if (!response.writableEnded) abort();
  });

  try {
    const plan = await dependencies.analyzer.analyze(parsed.data, controller.signal);
    if (!response.destroyed) dependencies.json(response, 200, { plan });
  } catch (error) {
    if (controller.signal.aborted || response.destroyed) return true;
    if (error instanceof ReferenceSceneAnalysisError) {
      dependencies.json(response, error.status, { error: error.message, code: error.code });
      return true;
    }
    if (error instanceof z.ZodError) {
      dependencies.json(response, 422, {
        error: "Reference scene analyzer returned an invalid plan",
        code: "invalid_plan",
        issues: error.issues,
      });
      return true;
    }
    dependencies.json(response, 500, {
      error: error instanceof Error ? error.message : "Reference scene analysis failed",
      code: "analysis_failed",
    });
  }
  return true;
}
