import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import JSZip from "jszip";
import { z } from "zod";
import {
  blenderLiveCommandBatchSchema,
  blenderNativeToolRequestInputSchema,
} from "../../../packages/protocol/src/blenderLiveProtocol";
import { BlenderNativeSessionError, type BlenderNativeSession } from "../dcc/blenderNativeSession";
import { prepareGltfForBlender } from "../dcc/gltfPrepare";
import {
  assertBlenderLiveKernelPolicy,
  executeBlenderNativeTool,
  exportBlenderScenePreview,
  publicBlenderJob,
} from "../dcc/blenderNativeTool";
import {
  evaluateHttpToolGovernance,
  recordRejectedHttpToolCall,
  withHttpToolAudit,
  type HttpToolGovernanceDependencies,
} from "../agents/httpToolGovernance";

type JsonWriter = (response: ServerResponse, status: number, body: unknown) => void;

const jobPathSchema = z.string().uuid();
const MAX_NATIVE_MODEL_BYTES = 512 * 1024 * 1024;
const NATIVE_MODEL_EXTENSIONS = new Set([".fbx", ".obj", ".glb", ".gltf"]);
/** Gaussian splatting scene captures rendered by Spark in the browser viewport. */
const SPLAT_MODEL_EXTENSIONS = new Set([".ply", ".splat", ".ksplat", ".spz", ".sog"]);
/**
 * A `.zip` upload on the assets endpoint is a 4D gaussian splatting sequence:
 * one splat file per frame plus an optional `manifest.json` declaring fps.
 * The gateway unpacks the frames and answers with a sequence manifest URL.
 */
const SPLAT_SEQUENCE_ARCHIVE_EXTENSION = ".zip";
const SPLAT_SEQUENCE_MANIFEST_SUFFIX = ".4dgs.json";
const SPLAT_SEQUENCE_FORMAT = "director-splat-sequence@1";
const SPLAT_SEQUENCE_DEFAULT_FPS = 30;
const MAX_SPLAT_SEQUENCE_FRAMES = 900;
const MAX_SPLAT_SEQUENCE_UNPACKED_BYTES = 2 * 1024 * 1024 * 1024;
const nativeToolEnvelopeSchema = z.looseObject({
  input: blenderNativeToolRequestInputSchema,
  session_id: z.string().trim().min(1).max(160).optional(),
  target_token: z.string().trim().min(1).max(240).optional(),
});
const PROJECT_BOUND_NATIVE_OPERATIONS = new Set(["apply"]);
type CachedScenePreview = {
  sceneEpoch: string;
  revision: number;
  mimeType: "model/gltf-binary";
  bytes: Buffer;
};
type InFlightScenePreview = {
  sceneEpoch: string;
  revision: number;
  promise: Promise<CachedScenePreview>;
};
const scenePreviewCache = new WeakMap<BlenderNativeSession, CachedScenePreview>();
const scenePreviewInFlight = new WeakMap<BlenderNativeSession, InFlightScenePreview>();

/** Dependencies injected into the Blender live route handler. */
export type BlenderLiveRouteDependencies = {
  /** Optional root directory for native model asset storage. */
  assetRoot?: string;
  /** Reads the JSON request body from the incoming HTTP message. */
  readBody: (request: IncomingMessage) => Promise<unknown>;
  /** Writes a JSON response with the given status code. */
  json: JsonWriter;
  /** The Blender native session loopback client. */
  session: BlenderNativeSession;
  /** Binds Blender to the Director project owned by the exact Agent target. */
  bindDirectorProject?: (input: { sessionId?: string; targetToken?: string }) => Promise<void>;
  /** Film-role/plan-mode policy overrides plus the audit trail for POST /api/tools. */
  governance?: HttpToolGovernanceDependencies;
};

async function readNativeModelBytes(request: IncomingMessage) {
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_NATIVE_MODEL_BYTES) {
    throw new BlenderNativeSessionError("Native model exceeds the 512 MB import limit.", 413);
  }
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += bytes.byteLength;
    if (byteLength > MAX_NATIVE_MODEL_BYTES) {
      throw new BlenderNativeSessionError("Native model exceeds the 512 MB import limit.", 413);
    }
    chunks.push(bytes);
  }
  if (!byteLength) throw new BlenderNativeSessionError("Native model upload is empty.", 400);
  return Buffer.concat(chunks, byteLength);
}

function splatSequenceZipEntries(zip: JSZip) {
  const entries = Object.values(zip.files).filter((entry) => {
    if (entry.dir) return false;
    const name = basename(entry.name);
    if (entry.name.startsWith("__MACOSX/") || name.startsWith(".")) return false;
    return SPLAT_MODEL_EXTENSIONS.has(extname(name).toLowerCase());
  });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en", { numeric: true, sensitivity: "base" }));
  return entries;
}

/** The archive `manifest.json` is advisory: a valid fps wins, anything else falls back to 30. */
async function readSplatSequenceFps(zip: JSZip) {
  const manifest = Object.values(zip.files).find(
    (entry) => !entry.dir && !entry.name.startsWith("__MACOSX/") && basename(entry.name) === "manifest.json",
  );
  if (!manifest) return SPLAT_SEQUENCE_DEFAULT_FPS;
  try {
    const parsed = JSON.parse(await manifest.async("string")) as { fps?: unknown };
    const fps = Number(parsed?.fps);
    if (Number.isFinite(fps) && fps >= 1 && fps <= 240) return fps;
  } catch {
    // Malformed advisory metadata never fails the import.
  }
  return SPLAT_SEQUENCE_DEFAULT_FPS;
}

async function storeSplatSequenceAsset(bytes: Buffer, fileName: string, directory: string, directoryId: string) {
  const zip = await JSZip.loadAsync(bytes).catch(() => {
    throw new BlenderNativeSessionError("Splat sequence archive is not a readable ZIP file.", 400);
  });
  const entries = splatSequenceZipEntries(zip);
  if (!entries.length) {
    throw new BlenderNativeSessionError("Splat sequence archive contains no PLY/SPLAT/KSPLAT/SPZ/SOG frames.", 400);
  }
  if (entries.length > MAX_SPLAT_SEQUENCE_FRAMES) {
    throw new BlenderNativeSessionError(
      `Splat sequence archives are limited to ${MAX_SPLAT_SEQUENCE_FRAMES} frames.`,
      413,
    );
  }
  const fps = await readSplatSequenceFps(zip);
  const uploadId = crypto.randomUUID();
  const stagingDirectory = resolve(directory, `.director-frames-${uploadId}`);
  const framesDirectory = resolve(directory, "frames");
  const frames: string[] = [];
  let unpackedBytes = 0;
  try {
    await mkdir(stagingDirectory, { recursive: true });
    for (const [index, entry] of entries.entries()) {
      const frameBytes = Buffer.from(await entry.async("uint8array"));
      unpackedBytes += frameBytes.byteLength;
      if (unpackedBytes > MAX_SPLAT_SEQUENCE_UNPACKED_BYTES) {
        throw new BlenderNativeSessionError("Splat sequence unpacks beyond the 2 GB frame budget.", 413);
      }
      // Frame files get deterministic names; archive entry names are order only, never paths.
      const frameName = `frame-${String(index + 1).padStart(5, "0")}${extname(entry.name).toLowerCase()}`;
      await writeFile(resolve(stagingDirectory, frameName), frameBytes, { flag: "wx" });
      frames.push(`frames/${frameName}`);
    }
    await rm(framesDirectory, { recursive: true, force: true });
    await rename(stagingDirectory, framesDirectory);
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }

  const manifestFileName = `${fileName.slice(0, -SPLAT_SEQUENCE_ARCHIVE_EXTENSION.length)}${SPLAT_SEQUENCE_MANIFEST_SUFFIX}`;
  const manifestBytes = Buffer.from(
    `${JSON.stringify({ format: SPLAT_SEQUENCE_FORMAT, fps, frameCount: frames.length, frames }, null, 2)}\n`,
  );
  const manifestStaging = resolve(directory, `.director-manifest-${uploadId}.json`);
  const manifestDestination = resolve(directory, manifestFileName);
  try {
    await writeFile(manifestStaging, manifestBytes, { flag: "wx" });
    await rename(manifestStaging, manifestDestination);
  } finally {
    await rm(manifestStaging, { force: true });
  }
  return {
    byteLength: unpackedBytes,
    fileName: manifestFileName,
    url: `/native-models/${directoryId}/${encodeURIComponent(manifestFileName)}`,
    splatSequence: { frameCount: frames.length, fps },
  };
}

async function storeNativeModelAsset(request: IncomingMessage, url: URL, assetRoot: string) {
  const requestedName = url.searchParams.get("fileName")?.trim() ?? "";
  const assetId = url.searchParams.get("assetId")?.trim() ?? "";
  const fileName = basename(requestedName).replace(/[\u0000-\u001f]/g, "");
  const extension = extname(fileName).toLowerCase();
  if (
    !fileName ||
    (!NATIVE_MODEL_EXTENSIONS.has(extension) &&
      !SPLAT_MODEL_EXTENSIONS.has(extension) &&
      extension !== SPLAT_SEQUENCE_ARCHIVE_EXTENSION)
  ) {
    throw new BlenderNativeSessionError(
      "Native model filename must use FBX, OBJ, GLB, GLTF, a PLY/SPLAT/KSPLAT/SPZ/SOG gaussian splat, or a ZIP splat sequence.",
      400,
    );
  }
  if (assetId && Buffer.byteLength(assetId, "utf8") > 120) {
    throw new BlenderNativeSessionError("Native model asset ID is too long.", 400);
  }
  const bytes = await readNativeModelBytes(request);
  const directoryId = assetId ? `asset-${Buffer.from(assetId, "utf8").toString("base64url")}` : crypto.randomUUID();
  const directory = resolve(assetRoot, "native-models", directoryId);
  if (extension === SPLAT_SEQUENCE_ARCHIVE_EXTENSION) {
    await mkdir(directory, { recursive: true });
    return storeSplatSequenceAsset(bytes, fileName, directory, directoryId);
  }
  const destination = resolve(directory, fileName);
  const uploadId = crypto.randomUUID();
  const source = resolve(directory, `.director-upload-${uploadId}${extension}`);
  const prepared = resolve(directory, `.director-prepared-${uploadId}${extension}`);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(source, bytes, { flag: "wx" });
    const compressedGlb =
      extension === ".glb" &&
      (bytes.includes(Buffer.from("EXT_meshopt_compression")) ||
        bytes.includes(Buffer.from("KHR_draco_mesh_compression")));
    if (compressedGlb) {
      await prepareGltfForBlender(source, prepared);
      await rename(prepared, destination);
    } else {
      await rename(source, destination);
    }
  } catch (error) {
    throw error;
  } finally {
    await Promise.all([rm(source, { force: true }), rm(prepared, { force: true })]);
  }
  return {
    byteLength: (await stat(destination)).size,
    fileName,
    url: `/native-models/${directoryId}/${encodeURIComponent(fileName)}`,
  };
}

function writeSessionError(response: ServerResponse, json: JsonWriter, error: unknown) {
  if (error instanceof BlenderNativeSessionError) {
    json(response, error.status, {
      success: false,
      code: error.code,
      error: error.message,
      ...(error.result ? { result: error.result } : {}),
    });
    return;
  }
  json(response, 500, {
    success: false,
    code: "blender_internal_error",
    error: error instanceof Error ? error.message : String(error),
  });
}

async function binaryScenePreview(session: BlenderNativeSession): Promise<CachedScenePreview> {
  const status = await session.status();
  if (!status.available) {
    throw new BlenderNativeSessionError(status.reason, 503, "blender_unavailable");
  }
  const cached = scenePreviewCache.get(session);
  if (cached?.sceneEpoch === status.sceneEpoch && cached.revision === status.revision) return cached;
  const inFlight = scenePreviewInFlight.get(session);
  if (inFlight?.sceneEpoch === status.sceneEpoch && inFlight.revision === status.revision) {
    return inFlight.promise;
  }

  const promise = exportBlenderScenePreview(session).then(({ preview }) => {
    const value = {
      sceneEpoch: preview.sceneEpoch,
      revision: preview.revision,
      mimeType: preview.mimeType,
      bytes: preview.bytes,
    };
    scenePreviewCache.set(session, value);
    return value;
  });
  scenePreviewInFlight.set(session, {
    sceneEpoch: status.sceneEpoch,
    revision: status.revision,
    promise,
  });
  try {
    return await promise;
  } finally {
    if (scenePreviewInFlight.get(session)?.promise === promise) scenePreviewInFlight.delete(session);
  }
}

/**
 * Narrow gateway facade over Blender's in-process native scene session.
 * Browsers and agents never receive the session token and can
 * only submit operations accepted by the shared, versioned contract.
 *
 * Routes handled: `/api/dcc/blender/assets` (POST native model upload),
 * `/api/tools/blender_native` (POST tool execution), `/api/dcc/blender/status`,
 * `/api/dcc/blender/scene`, `/api/dcc/blender/preview.glb` (GET binary GLB),
 * `/api/dcc/blender/commands` (POST command batch), and
 * `/api/dcc/blender/jobs/:id` (GET job status).
 *
 * @param request - The incoming HTTP request.
 * @param response - The outgoing HTTP response.
 * @param url - The parsed request URL.
 * @param dependencies - The Blender live subsystem dependencies.
 * @returns `true` when the request was handled, `false` otherwise.
 */
export async function handleBlenderLiveRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  dependencies: BlenderLiveRouteDependencies,
): Promise<boolean> {
  const { session, json } = dependencies;

  if (url.pathname === "/api/dcc/blender/assets") {
    if (request.method !== "POST") {
      json(response, 405, {
        success: false,
        code: "blender_method_not_allowed",
        error: "Native model assets require POST.",
      });
      return true;
    }
    if (!dependencies.assetRoot) {
      json(response, 503, {
        success: false,
        code: "blender_asset_store_unavailable",
        error: "Native model asset storage is unavailable.",
      });
      return true;
    }
    try {
      json(response, 201, {
        success: true,
        result: await storeNativeModelAsset(request, url, dependencies.assetRoot),
      });
    } catch (error) {
      writeSessionError(response, json, error);
    }
    return true;
  }

  if (url.pathname === "/api/tools/blender_native") {
    if (request.method !== "POST") {
      json(response, 405, {
        success: false,
        error: "blender_native requires POST.",
      });
      return true;
    }
    const parsed = nativeToolEnvelopeSchema.safeParse(await dependencies.readBody(request));
    if (!parsed.success) {
      json(response, 400, {
        success: false,
        error: `blender_native input is invalid: ${parsed.error.issues
          .map((issue) => `${issue.path.map(String).join(".") || "$"}: ${issue.message}`)
          .join("; ")}`,
      });
      return true;
    }
    // Same film-role and plan-mode policy as MCP, checked before Blender dispatch.
    const governance = evaluateHttpToolGovernance({
      request,
      tool: "blender_native",
      toolInput: parsed.data.input,
      sessionId: parsed.data.session_id,
      dependencies: dependencies.governance,
    });
    const auditContext = {
      store: dependencies.governance?.auditStore,
      tool: "blender_native",
      toolInput: parsed.data.input,
      roleId: governance.roleId,
      source: governance.source,
      sessionId: parsed.data.session_id,
    };
    if (!governance.allowed) {
      recordRejectedHttpToolCall(governance, auditContext);
      json(response, governance.status, governance.body);
      return true;
    }
    const auditedJson = withHttpToolAudit(json, auditContext);
    try {
      if (PROJECT_BOUND_NATIVE_OPERATIONS.has(parsed.data.input.op)) {
        await dependencies.bindDirectorProject?.({
          sessionId: parsed.data.session_id,
          targetToken: parsed.data.target_token,
        });
      }
      const result = await executeBlenderNativeTool(session, parsed.data.input);
      const capture =
        result && typeof result === "object" && "capture" in result
          ? (result as { capture?: unknown }).capture
          : undefined;
      const publicResult =
        capture && result && typeof result === "object"
          ? Object.fromEntries(Object.entries(result).filter(([key]) => key !== "capture"))
          : result;
      auditedJson(response, 200, {
        success: true,
        result: publicResult,
        ...(parsed.data.input.op === "apply" ? { director_project_sync: "automatic" } : {}),
        ...(capture ? { capture } : {}),
      });
    } catch (error) {
      writeSessionError(response, auditedJson, error);
    }
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/dcc/blender/status") {
    json(response, 200, { success: true, result: await session.status() });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/dcc/blender/scene") {
    try {
      json(response, 200, { success: true, result: await session.snapshot() });
    } catch (error) {
      writeSessionError(response, json, error);
    }
    return true;
  }

  if (url.pathname === "/api/dcc/blender/preview.glb") {
    if (request.method !== "GET") {
      json(response, 405, {
        success: false,
        code: "blender_method_not_allowed",
        error: "Blender scene previews require GET.",
      });
      return true;
    }
    try {
      const preview = await binaryScenePreview(session);
      const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
      response.writeHead(200, {
        ...(origin ? { "access-control-allow-origin": origin, vary: "Origin" } : {}),
        "access-control-expose-headers": "X-Blender-Revision, X-Blender-Scene-Epoch, Content-Length",
        "cache-control": "private, no-store",
        "content-length": String(preview.bytes.byteLength),
        "content-type": preview.mimeType,
        "x-blender-scene-epoch": preview.sceneEpoch,
        "x-blender-revision": String(preview.revision),
      });
      response.end(preview.bytes);
    } catch (error) {
      writeSessionError(response, json, error);
    }
    return true;
  }

  if (url.pathname === "/api/dcc/blender/commands") {
    if (request.method !== "POST") {
      json(response, 405, {
        success: false,
        code: "blender_method_not_allowed",
        error: "Blender commands require POST.",
      });
      return true;
    }
    const parsed = blenderLiveCommandBatchSchema.safeParse(await dependencies.readBody(request));
    if (!parsed.success) {
      json(response, 400, {
        success: false,
        code: "blender_command_invalid",
        error: "Blender command batch is invalid.",
        issues: parsed.error.issues,
      });
      return true;
    }
    try {
      assertBlenderLiveKernelPolicy(parsed.data.operations);
      json(response, 202, {
        success: true,
        result: await session.submit(parsed.data),
      });
    } catch (error) {
      writeSessionError(response, json, error);
    }
    return true;
  }

  const jobMatch = url.pathname.match(/^\/api\/dcc\/blender\/jobs\/([^/]+)$/);
  if (jobMatch) {
    if (request.method !== "GET") {
      json(response, 405, {
        success: false,
        code: "blender_method_not_allowed",
        error: "Blender jobs require GET.",
      });
      return true;
    }
    const parsedJobId = jobPathSchema.safeParse(decodeURIComponent(jobMatch[1] ?? ""));
    if (!parsedJobId.success) {
      json(response, 400, {
        success: false,
        code: "blender_job_invalid",
        error: "Blender job id must be a UUID.",
      });
      return true;
    }
    try {
      json(response, 200, {
        success: true,
        result: publicBlenderJob(await session.job(parsedJobId.data)),
      });
    } catch (error) {
      writeSessionError(response, json, error);
    }
    return true;
  }

  return false;
}
