const DEFAULT_TRUNCATION_MARKER = "[... output truncated; showing tail ...]\n";

function renderUtf8TailWithinBudget(buffer: Buffer, maxBytes: number) {
  const normalized = Buffer.from(buffer.toString("utf8"), "utf8");
  if (normalized.length <= maxBytes) return normalized.toString("utf8");
  let start = normalized.length - maxBytes;
  while (start < normalized.length && (normalized[start] & 0xc0) === 0x80) start += 1;
  return normalized.subarray(start).toString("utf8");
}

/**
 * Keeps only the newest bytes from a process stream. The marker is included in
 * the byte budget, so callers can safely persist or forward `toString()`
 * without applying another memory bound.
 */
export class BoundedTextBuffer {
  private tail = Buffer.alloc(0);
  private truncated = false;
  private readonly marker: Buffer;

  constructor(
    /** Maximum byte capacity of the buffer, including the truncation marker. */
    readonly maxBytes: number,
    marker = DEFAULT_TRUNCATION_MARKER,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new TypeError("BoundedTextBuffer maxBytes must be a positive safe integer");
    }
    this.marker = Buffer.from(marker, "utf8");
    if (this.marker.length >= maxBytes) {
      throw new RangeError("BoundedTextBuffer marker must be smaller than maxBytes");
    }
  }

  /**
   * Appends a string or buffer to the tail. When the buffer exceeds
   * `maxBytes`, older content is silently dropped and the truncation marker
   * is prepended to the output.
   *
   * @param value - UTF-8 string or raw buffer to append.
   */
  append(value: string | Buffer) {
    const incoming = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
    if (!incoming.length) return;

    if (!this.truncated && this.tail.length + incoming.length <= this.maxBytes) {
      this.tail = Buffer.concat([this.tail, incoming]);
      return;
    }

    this.truncated = true;
    const tailBudget = this.maxBytes - this.marker.length;
    if (incoming.length >= tailBudget) {
      this.tail = Buffer.from(incoming.subarray(incoming.length - tailBudget));
      return;
    }
    const retainedBytes = Math.max(0, tailBudget - incoming.length);
    const retained = this.tail.subarray(Math.max(0, this.tail.length - retainedBytes));
    this.tail = Buffer.concat([retained, incoming]);
  }

  /** The current byte length of the rendered output. */
  get byteLength() {
    return Buffer.byteLength(this.toString(), "utf8");
  }

  /** Whether the buffer has ever been truncated. */
  get wasTruncated() {
    return this.truncated;
  }

  toString() {
    const tailBudget = this.maxBytes - (this.truncated ? this.marker.length : 0);
    const tail = renderUtf8TailWithinBudget(this.tail, tailBudget);
    return this.truncated ? `${this.marker.toString("utf8")}${tail}` : tail;
  }
}
