// @vitest-environment node

import { describe, expect, it } from "vitest";
import { BoundedTextBuffer } from "../../boundedTextBuffer";

describe("BoundedTextBuffer", () => {
  it("keeps output within the exact byte budget and preserves the newest tail", () => {
    const buffer = new BoundedTextBuffer(80, "[truncated; tail follows]\n");
    buffer.append(`very-old-line\n${"filler-line\n".repeat(20)}`);
    buffer.append("newest-diagnostic");

    expect(buffer.wasTruncated).toBe(true);
    expect(buffer.byteLength).toBeLessThanOrEqual(80);
    expect(Buffer.byteLength(buffer.toString(), "utf8")).toBeLessThanOrEqual(80);
    expect(buffer.toString()).toContain("[truncated; tail follows]");
    expect(buffer.toString()).not.toContain("very-old-line");
    expect(buffer.toString()).toContain("newest-diagnostic");
  });

  it("does not mark output that fits", () => {
    const buffer = new BoundedTextBuffer(64);
    buffer.append("hello");
    buffer.append(Buffer.from(" world"));

    expect(buffer.toString()).toBe("hello world");
    expect(buffer.wasTruncated).toBe(false);
    expect(buffer.byteLength).toBe(11);
  });

  it("keeps rendered UTF-8 within the byte budget even for malformed process bytes", () => {
    const buffer = new BoundedTextBuffer(80, "[truncated]\n");
    buffer.append(Buffer.alloc(200, 0xff));

    expect(buffer.wasTruncated).toBe(true);
    expect(buffer.byteLength).toBeLessThanOrEqual(80);
    expect(Buffer.byteLength(buffer.toString(), "utf8")).toBeLessThanOrEqual(80);
  });
});
