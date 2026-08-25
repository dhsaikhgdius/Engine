import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

const DCC_IMPORT_PREFIX = "/dcc-import/";
const GENERATED_3D_PREFIX = "/generated-3d/";
const NATIVE_MODEL_PREFIX = "/native-models/";
const MAX_GENERATED_ASSET_BYTES = 512 * 1024 * 1024;
const MAX_GENERATED_THUMBNAIL_BYTES = 20 * 1024 * 1024;
const NATIVE_MESH_EXTENSIONS = [".fbx", ".obj", ".glb", ".gltf"];
const NATIVE_SPLAT_EXTENSIONS = [".ply", ".splat", ".ksplat", ".spz", ".sog"];
/** Unpacked 4DGS frame sequences live in one `frames/` directory beside their manifest. */
const SPLAT_SEQUENCE_MANIFEST_SUFFIX = ".4dgs.json";

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function jsonError(response: ServerResponse, status: number, error: string): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify({ error }));
}

export async function handleGeneratedAssetRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  generatedRoot: string,
): Promise<boolean> {
  const dccImport = url.pathname.startsWith(DCC_IMPORT_PREFIX);
  const generated3d = url.pathname.startsWith(GENERATED_3D_PREFIX);
  const nativeModel = url.pathname.startsWith(NATIVE_MODEL_PREFIX);
  if (!dccImport && !generated3d && !nativeModel) return false;
  if (request.method !== "GET" && request.method !== "HEAD") {
    jsonError(response, 405, "Generated assets only support GET and HEAD.");
    return true;
  }

  let decoded: string;
  try {
    const prefix = dccImport ? DCC_IMPORT_PREFIX : generated3d ? GENERATED_3D_PREFIX : NATIVE_MODEL_PREFIX;
    decoded = decodeURIComponent(url.pathname.slice(prefix.length));
  } catch {
    jsonError(response, 400, "Generated asset path is not valid URL encoding.");
    return true;
  }
  const extension = extname(decoded).toLowerCase();
  const validDccPath = dccImport && extension === ".glb";
  const validGenerated3DPath =
    generated3d && /^(?:[a-f0-9]{64})\/(?:model\.glb|thumbnail\.(?:png|jpg|webp))$/.test(decoded);
  const nativeSegments = decoded.split("/");
  const nativeDirectory = nativeSegments[0] ?? "";
  const validNativeDirectory =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(nativeDirectory) ||
    /^asset-[A-Za-z0-9_-]{1,180}$/.test(nativeDirectory);
  const validNativeModelPath =
    nativeModel &&
    validNativeDirectory &&
    ((nativeSegments.length === 2 &&
      (NATIVE_MESH_EXTENSIONS.includes(extension) ||
        NATIVE_SPLAT_EXTENSIONS.includes(extension) ||
        decoded.toLowerCase().endsWith(SPLAT_SEQUENCE_MANIFEST_SUFFIX))) ||
      (nativeSegments.length === 3 && nativeSegments[1] === "frames" && NATIVE_SPLAT_EXTENSIONS.includes(extension)));
  if (
    !decoded ||
    decoded.includes("\\") ||
    decoded.split("/").some((segment) => !segment || segment === "." || segment === "..") ||
    (!validDccPath && !validGenerated3DPath && !validNativeModelPath)
  ) {
    jsonError(response, 400, "Generated asset path is not supported.");
    return true;
  }

  const routeRoot = resolve(generatedRoot, dccImport ? "dcc-import" : generated3d ? "generated-3d" : "native-models");
  const candidate = resolve(routeRoot, decoded);
  if (!isInside(routeRoot, candidate)) {
    jsonError(response, 403, "Generated asset path escaped its storage root.");
    return true;
  }

  try {
    const canonicalRoot = await realpath(routeRoot);
    const canonical = await realpath(candidate);
    if (!isInside(canonicalRoot, canonical)) {
      jsonError(response, 403, "Generated asset symlink escaped its storage root.");
      return true;
    }
    const info = await stat(canonical);
    const maximumBytes =
      nativeModel || extension === ".glb" ? MAX_GENERATED_ASSET_BYTES : MAX_GENERATED_THUMBNAIL_BYTES;
    if (!info.isFile() || info.size > maximumBytes) {
      jsonError(response, 413, "Generated asset is not a supported file size.");
      return true;
    }
    const contentType =
      extension === ".glb"
        ? "model/gltf-binary"
        : extension === ".gltf"
          ? "model/gltf+json"
          : extension === ".fbx" || NATIVE_SPLAT_EXTENSIONS.includes(extension)
            ? "application/octet-stream"
            : extension === ".json"
              ? "application/json; charset=utf-8"
              : extension === ".obj"
                ? "text/plain; charset=utf-8"
                : extension === ".png"
                  ? "image/png"
                  : extension === ".jpg"
                    ? "image/jpeg"
                    : "image/webp";
    response.writeHead(200, {
      "content-type": contentType,
      "content-length": String(info.size),
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    });
    if (request.method === "HEAD") {
      response.end();
    } else if (typeof response.write === "function" && typeof response.on === "function") {
      const stream = createReadStream(canonical);
      stream.on("error", () => response.destroy());
      stream.pipe(response);
    } else {
      // Lightweight route unit tests use a minimal ServerResponse double. The
      // real gateway always takes the streaming branch above.
      response.end(await readFile(canonical));
    }
  } catch {
    jsonError(response, 404, "Generated asset was not found.");
  }
  return true;
}
