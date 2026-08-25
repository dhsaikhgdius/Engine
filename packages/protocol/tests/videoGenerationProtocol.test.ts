import { describe, expect, it } from "vitest";
import {
  normalizeLtxDimension,
  normalizeLtxFrameCount,
  videoModelOperationSchema,
} from "../src/videoGenerationProtocol";

describe("video generation protocol", () => {
  it("normalizes LTX-2.3 spatial and temporal constraints", () => {
    expect(normalizeLtxDimension(720)).toBe(704);
    expect(normalizeLtxDimension(1280)).toBe(1280);
    expect(normalizeLtxFrameCount(120)).toBe(121);
    expect((normalizeLtxFrameCount(56) - 1) % 8).toBe(0);
  });

  it("keeps provider choice server-validatable", () => {
    expect(
      videoModelOperationSchema.parse({
        op: "render",
        provider: "ltx-2.3",
        prompt: "A clean previs shot becomes a cinematic live-action shot",
        duration_s: 5,
      }),
    ).toMatchObject({ provider: "ltx-2.3" });
    expect(
      videoModelOperationSchema.parse({
        op: "render",
        provider: "minimax-h3",
        prompt: "A clean previs shot becomes a cinematic live-action shot",
        duration_s: 5,
      }),
    ).toMatchObject({ provider: "minimax-h3" });
    expect(videoModelOperationSchema.safeParse({ op: "status", job_id: "../../secret" }).success).toBe(false);
  });
});
