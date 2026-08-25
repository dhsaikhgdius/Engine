import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export class MediaInputMissingError extends Error {
  readonly code = "staged_input_missing";

  constructor(message: string) {
    super(message);
    this.name = "MediaInputMissingError";
  }
}

export class MediaInputIntegrityError extends Error {
  readonly code = "staged_input_invalid";

  constructor(message: string) {
    super(message);
    this.name = "MediaInputIntegrityError";
  }
}

function assertSha256(value: string) {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new TypeError("Media input SHA-256 is invalid");
  return value;
}

/**
 * Content-addressed source cache for media.transcode / media.proxy jobs,
 * mirroring the transcription input store: staging is idempotent (re-uploading
 * identical bytes is a no-op), so retries and fresh attempts after a gateway
 * restart never depend on the uploading client still being around.
 */
export class MediaTranscodeInputStore {
  constructor(
    private readonly dataDirectory: string,
    readonly maxInputBytes: number,
  ) {}

  private directory() {
    return join(this.dataDirectory, "media-transcode-inputs");
  }

  private path(sha256: string) {
    return join(this.directory(), `${assertSha256(sha256)}.bin`);
  }

  async put(bytes: Uint8Array, expectedSha256: string) {
    if (!bytes.byteLength) throw new TypeError("Media input is empty");
    if (bytes.byteLength > this.maxInputBytes) throw new RangeError("Media input exceeds the configured size limit");
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== assertSha256(expectedSha256)) {
      throw new MediaInputIntegrityError("Media input failed SHA-256 verification");
    }
    await mkdir(this.directory(), { recursive: true });
    try {
      await writeFile(this.path(actual), bytes, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return { sha256: actual, bytes: bytes.byteLength };
  }

  /**
   * Re-hashes the staged file (streamed, sources can be large) and only then
   * returns its path, so ffmpeg never consumes bytes that drifted from the
   * hash recorded in the job input.
   */
  async verifiedSourcePath(sha256: string) {
    const path = this.path(sha256);
    let info;
    try {
      info = await stat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new MediaInputMissingError(
          `No staged media input exists for sha256 ${sha256}; upload it via POST /api/production-jobs/media-inputs`,
        );
      }
      throw error;
    }
    if (info.size > this.maxInputBytes) {
      throw new MediaInputIntegrityError("Staged media input exceeds the configured size limit");
    }
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    if (hash.digest("hex") !== sha256) {
      throw new MediaInputIntegrityError("Staged media input failed SHA-256 verification");
    }
    return path;
  }
}
