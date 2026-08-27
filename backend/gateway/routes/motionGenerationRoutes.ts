import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename } from "node:path";
import { ZodError } from "zod";
import type { ArdyMotionService } from "../motion/ardyMotionService";

type JsonWriter = (response: ServerResponse, status: number, body: unknown) => void;

export type MotionGenerationRouteDependencies = {
  readBody: (request: IncomingMessage) => Promise<unknown>;
  json: JsonWriter;
  ardy: ArdyMotionService;
};

/**
 * `/api/motion/ardy/*`: status, streaming generation, and motion retrieval
 * for the ARDY text-to-motion bridge. Generation streams NDJSON events so the
 * workbench can narrate long GPU runs; the terminal event is `done` or
 * `error`. Motion files are served strictly from the service's in-memory
 * allowlist — an id is a lookup key, never a path.
 */
export async function handleMotionGenerationRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  dependencies: MotionGenerationRouteDependencies,
): Promise<boolean> {
  const { json, ardy } = dependencies;

  if (url.pathname === "/api/motion/ardy/status") {
    if (request.method !== "GET") {
      json(response, 405, { success: false, error: "ARDY status requires GET." });
      return true;
    }
    json(response, 200, { success: true, result: ardy.status() });
    return true;
  }

  if (url.pathname === "/api/motion/ardy/generate") {
    if (request.method !== "POST") {
      json(response, 405, { success: false, error: "ARDY generation requires POST." });
      return true;
    }
    if (!ardy.configured) {
      json(response, 503, {
        success: false,
        error:
          "ARDY is not configured; set DIRECTOR_ARDY_REPO (and optionally DIRECTOR_ARDY_SSH_HOST) or run npm run setup:ardy.",
      });
      return true;
    }
    let body: unknown;
    try {
      body = await dependencies.readBody(request);
    } catch {
      json(response, 400, { success: false, error: "ARDY generation request body is not valid JSON." });
      return true;
    }

    // A client that disconnects mid-stream aborts the GPU run instead of
    // leaving it rendering for nobody.
    const abort = new AbortController();
    request.once("close", () => abort.abort());
    response.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
    });
    const write = (event: unknown) => {
      if (!response.writableEnded) response.write(`${JSON.stringify(event)}\n`);
    };
    try {
      await ardy.generate(body, write, abort.signal);
    } catch (error) {
      // Headers are already sent, so failures become a terminal NDJSON
      // error event rather than an HTTP status.
      write({
        event: "error",
        message:
          error instanceof ZodError
            ? "ARDY generation request is invalid: prompt (1-600 chars) is required; durationS 1-30; seed integer."
            : error instanceof Error
              ? error.message
              : String(error),
      });
    }
    response.end();
    return true;
  }

  const motionMatch = url.pathname.match(/^\/api\/motion\/ardy\/motions\/([^/]+)$/);
  if (motionMatch) {
    if (request.method !== "GET") {
      json(response, 405, { success: false, error: "ARDY motions require GET." });
      return true;
    }
    const motionPath = ardy.resolveMotionPath(decodeURIComponent(motionMatch[1] ?? ""));
    if (!motionPath) {
      json(response, 404, { success: false, error: "Unknown motion id." });
      return true;
    }
    try {
      const fileInfo = await stat(motionPath);
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(fileInfo.size),
        "content-disposition": `attachment; filename="${basename(motionPath)}"`,
        "cache-control": "private, no-store",
      });
      createReadStream(motionPath).pipe(response);
    } catch {
      json(response, 404, { success: false, error: "Motion file is no longer available." });
    }
    return true;
  }

  return false;
}
