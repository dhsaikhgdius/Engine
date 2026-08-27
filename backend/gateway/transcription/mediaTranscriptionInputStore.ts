import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

function assertSha256(value: string) {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new TypeError("Transcription input SHA-256 is invalid");
  return value;
}

/** Thrown when the content-addressed source bytes are no longer cached on the gateway. */
export class MediaTranscriptionSourceMissingError extends Error {
  readonly code = "transcription_source_missing";

  constructor() {
    // Never include the filesystem path: this message reaches HTTP clients
    // and durable job records.
    super("Transcription source bytes are no longer cached on the gateway; upload the source media again");
    this.name = "MediaTranscriptionSourceMissingError";
  }
}

/** Content-addressed source cache keeps transcription retries independent of browser lifetime. */
export class MediaTranscriptionInputStore {
  constructor(
    private readonly dataDirectory: string,
    readonly maxInputBytes: number,
  ) {}

  private path(sha256: string) {
    return join(this.dataDirectory, "transcription-inputs", `${assertSha256(sha256)}.bin`);
  }

  /**
   * Stores the bytes under their verified digest. Writing with `wx` makes
   * re-uploads of identical content idempotent: an existing file under the
   * same digest already holds the same bytes, so EEXIST is success.
   */
  async put(bytes: Uint8Array, expectedSha256: string) {
    if (!bytes.byteLength) throw new Error("Transcription source is empty");
    if (bytes.byteLength > this.maxInputBytes)
      throw new Error("Transcription source exceeds the configured size limit");
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== assertSha256(expectedSha256)) throw new Error("Transcription source failed SHA-256 verification");
    const path = this.path(actual);
    await mkdir(join(this.dataDirectory, "transcription-inputs"), { recursive: true });
    try {
      await writeFile(path, bytes, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return { sha256: actual, bytes: bytes.byteLength };
  }

  /**
   * Reads the cached bytes, re-verifying the digest so on-disk corruption is
   * detected instead of being fed into a transcription provider. A missing
   * file is the typed {@link MediaTranscriptionSourceMissingError}.
   */
  async get(sha256: string) {
    let bytes: Buffer;
    try {
      bytes = await readFile(this.path(sha256));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new MediaTranscriptionSourceMissingError();
      throw error;
    }
    if (bytes.byteLength > this.maxInputBytes)
      throw new Error("Cached transcription source exceeds the configured limit");
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== sha256) throw new Error("Cached transcription source failed SHA-256 verification");
    return bytes;
  }
}
