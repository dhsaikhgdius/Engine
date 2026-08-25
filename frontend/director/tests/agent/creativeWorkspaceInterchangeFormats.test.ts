import { describe, expect, it } from "vitest";
import { creativeWorkspaceInterchangeFormatSchema } from "@director/protocol/creativeWorkspaceProtocol";
import interchangeFormats from "../../src/agent/creativeWorkspaceInterchangeFormats.json";

describe("creativeWorkspaceInterchangeFormats", () => {
  it("covers every protocol format exactly once with unique extensions per encoding", () => {
    const ids = interchangeFormats.map((format) => format.id);
    expect(ids).toEqual([...creativeWorkspaceInterchangeFormatSchema.options]);
    expect(new Set(ids).size).toBe(ids.length);

    for (const format of interchangeFormats) {
      expect(format.workspaces.length).toBeGreaterThan(0);
      expect(format.extensions.every((extension) => extension.startsWith("."))).toBe(true);
    }
  });

  it("keeps text formats utf8 and binary archives base64", () => {
    const encodingById = Object.fromEntries(interchangeFormats.map((format) => [format.id, format.payload_encoding]));
    expect(encodingById).toMatchObject({
      otio: "utf8",
      fountain: "utf8",
      gltf: "utf8",
      usd: "utf8",
      otioz: "base64",
      glb: "base64",
      usdz: "base64",
      obj: "base64",
      stl: "base64",
    });
  });
});
