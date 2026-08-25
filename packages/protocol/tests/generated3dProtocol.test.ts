import { describe, expect, it } from "vitest";
import {
  DIRECTOR_GENERATED_3D_MAX_SOURCE_BYTES,
  generated3dJobInputSchema,
  generated3dSubmitRequestSchema,
} from "../src/generated3dProtocol";

describe("generated 3D protocol", () => {
  it("keeps text and image source contracts mutually exclusive", () => {
    expect(
      generated3dSubmitRequestSchema.safeParse({
        mode: "text-to-3d",
        name: "Chair",
        prompt: "A production-ready wooden chair",
      }).success,
    ).toBe(true);
    expect(
      generated3dSubmitRequestSchema.safeParse({
        mode: "image-to-3d",
        name: "Chair",
        prompt: "Reconstruct this chair",
      }).success,
    ).toBe(false);
    expect(
      generated3dJobInputSchema.safeParse({
        mode: "image-to-3d",
        providerId: "meshy",
        name: "Chair",
        prompt: "Reconstruct this chair",
        sourceImage: { sha256: "a".repeat(64), mimeType: "image/jpeg", bytes: 1024 },
      }).success,
    ).toBe(true);
  });

  it("bounds source data and rejects PBR without textures", () => {
    expect(
      generated3dSubmitRequestSchema.safeParse({
        mode: "text-to-3d",
        name: "Clay",
        prompt: "Clay bust",
        texture: false,
        pbr: true,
      }).success,
    ).toBe(false);
    expect(DIRECTOR_GENERATED_3D_MAX_SOURCE_BYTES).toBe(5 * 1024 * 1024);
  });
});
