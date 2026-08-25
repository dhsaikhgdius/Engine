import { describe, expect, it } from "vitest";
import { parseCaptureDataUrl } from "../../capturePayload";

describe("capture payload", () => {
  it("extracts supported image bytes for MCP image content", () => {
    expect(parseCaptureDataUrl("data:image/png;base64,AAAA")).toEqual({ mimeType: "image/png", data: "AAAA" });
    expect(parseCaptureDataUrl("data:image/webp;base64,AAAA")).toEqual({ mimeType: "image/webp", data: "AAAA" });
  });

  it("rejects unsupported, malformed, and empty data URLs", () => {
    expect(parseCaptureDataUrl("data:image/gif;base64,AAAA")).toBeNull();
    expect(parseCaptureDataUrl("data:image/png;base64,")).toBeNull();
    expect(parseCaptureDataUrl("https://example.com/image.png")).toBeNull();
  });
});
