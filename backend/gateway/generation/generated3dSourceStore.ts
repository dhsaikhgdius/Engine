import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  DIRECTOR_GENERATED_3D_MAX_SOURCE_BYTES,
  generated3dSourceImageSchema,
  type Generated3DJobInput,
} from "../../../packages/protocol/src/generated3dProtocol";

const DATA_URL = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/]+={0,2})$/;

function extensionFor(mimeType: "image/jpeg" | "image/png") {
  return mimeType === "image/png" ? "png" : "jpg";
}

function assertImageSignature(bytes: Buffer, mimeType: "image/jpeg" | "image/png") {
  const valid =
    mimeType === "image/png"
      ? bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!valid) throw new Error(`Source image bytes do not match ${mimeType}`);
}

/**
 * Stores and retrieves source images used as conditioning inputs for
 * generated 3D jobs, keyed by SHA-256 hash.
 *
 * Source images are imported from base64 data URLs, validated against
 * their declared MIME types, and persisted to disk with hash-based paths.
 * Hash collisions are detected and rejected.
 */
export class Generated3DSourceStore {
  private readonly directory: string;

  /**
   * Creates a new source store.
   *
   * @param dataDirectory - The data directory under which source images are stored.
   */
  constructor(dataDirectory: string) {
    this.directory = resolve(dataDirectory, "generated-3d-inputs");
  }

  /**
   * Imports a source image from a JPEG or PNG base64 data URL.
   *
   * Validates the image signature, computes its SHA-256 hash, and persists
   * it to disk. Returns metadata suitable for inclusion in a job input.
   *
   * @param dataUrl - The base64-encoded data URL.
   * @returns Metadata including the SHA-256 hash, MIME type, and byte length.
   * @throws When the data URL is invalid, the image exceeds the size limit,
   *         or a hash collision is detected.
   */
  async importDataUrl(dataUrl: string) {
    const match = dataUrl.match(DATA_URL);
    if (!match) throw new Error("Generated 3D source image must be a JPEG or PNG base64 data URL");
    const mimeType = match[1] as "image/jpeg" | "image/png";
    const bytes = Buffer.from(match[2]!, "base64");
    if (!bytes.byteLength || bytes.byteLength > DIRECTOR_GENERATED_3D_MAX_SOURCE_BYTES) {
      throw new Error(`Generated 3D source image must be between 1 byte and ${DIRECTOR_GENERATED_3D_MAX_SOURCE_BYTES}`);
    }
    assertImageSignature(bytes, mimeType);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const metadata = generated3dSourceImageSchema.parse({ sha256, mimeType, bytes: bytes.byteLength });
    await mkdir(this.directory, { recursive: true });
    const path = this.pathFor(metadata);
    const existing = await readFile(path).catch(() => null);
    if (existing) {
      if (!existing.equals(bytes)) throw new Error(`Generated 3D source hash collision for ${sha256}`);
    } else {
      await writeFile(path, bytes, { flag: "wx" }).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
        const raced = await readFile(path);
        if (!raced.equals(bytes)) throw new Error(`Generated 3D source hash collision for ${sha256}`);
      });
    }
    return metadata;
  }

  private pathFor(source: NonNullable<Generated3DJobInput["sourceImage"]>) {
    return resolve(this.directory, `${source.sha256}.${extensionFor(source.mimeType)}`);
  }

  /**
   * Reads a previously imported source image from disk, verifying its
   * integrity against the declared metadata.
   *
   * @param source - The source image metadata to look up.
   * @returns The raw image bytes.
   * @throws When the file is unavailable, has changed, or fails hash verification.
   */
  async read(source: NonNullable<Generated3DJobInput["sourceImage"]>) {
    const parsed = generated3dSourceImageSchema.parse(source);
    const path = this.pathFor(parsed);
    const information = await stat(path);
    if (!information.isFile() || information.size !== parsed.bytes) {
      throw new Error(`Generated 3D source image ${parsed.sha256} is unavailable or changed`);
    }
    const bytes = await readFile(path);
    assertImageSignature(bytes, parsed.mimeType);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== parsed.sha256)
      throw new Error(`Generated 3D source image ${parsed.sha256} failed hash verification`);
    return bytes;
  }
}
