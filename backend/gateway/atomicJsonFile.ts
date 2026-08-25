import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Options for {@link writeJsonAtomic}. */
export interface AtomicJsonWriteOptions {
  /** Number of spaces for JSON indentation (default 2). */
  space?: number;
  /** Whether to append a trailing newline after the JSON (default false). */
  trailingNewline?: boolean;
}

/**
 * Writes a JSON value to a file atomically: data is written to a temporary
 * file first, then renamed onto the target path. This guarantees that readers
 * never see a partial write.
 *
 * The temporary file is named with the process PID and a random UUID to avoid
 * collisions across concurrent writers on the same path.
 *
 * @param path - Destination file path. Parent directories are created if needed.
 * @param value - The value to serialize as JSON.
 * @param options - Serialization options.
 */
export async function writeJsonAtomic(
  path: string,
  value: unknown,
  options: AtomicJsonWriteOptions = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const suffix = options.trailingNewline ? "\n" : "";
  await writeFile(temporaryPath, `${JSON.stringify(value, null, options.space ?? 2)}${suffix}`, {
    encoding: "utf8",
    flag: "wx",
  });
  await rename(temporaryPath, path);
}
