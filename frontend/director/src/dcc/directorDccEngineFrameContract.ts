import { z } from "zod";
import { directorDccEngineIdSchema } from "./directorDccEngineSpace";

/**
 * One on-demand engine frame render (`render_engine_frame`): the perception
 * primitive of the engine handoff. The gateway spawns the engine with a fixed
 * argument vector, verifies the produced image bytes by SHA-256, and returns
 * the receipt; the image itself travels once through the shared `capture`
 * attachment channel so agents can see the engine's pixels.
 */

const nonEmpty = z.string().trim().min(1);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "expected lowercase SHA-256 hex");

/** Contract identifier for one engine frame receipt. */
export const DIRECTOR_DCC_ENGINE_FRAME_CONTRACT = "director-dcc-engine-frame-v1" as const;

/** Side-length bounds for a requested engine frame. */
export const DIRECTOR_DCC_ENGINE_FRAME_MIN_SIDE = 64;
export const DIRECTOR_DCC_ENGINE_FRAME_MAX_WIDTH = 1_920;
export const DIRECTOR_DCC_ENGINE_FRAME_MAX_HEIGHT = 1_080;

/** A rendered engine frame: hash-verified image on disk plus dimensions. */
export const directorDccEngineFrameRenderedSchema = z.strictObject({
  contract: z.literal(DIRECTOR_DCC_ENGINE_FRAME_CONTRACT),
  provider: directorDccEngineIdSchema,
  status: z.literal("rendered"),
  /** Image path relative to the private job directory that produced it. */
  imagePath: nonEmpty.max(1_024),
  imageSha256: sha256,
  width: z.number().int().min(1).max(16_384),
  height: z.number().int().min(1).max(16_384),
  warnings: z.array(z.string().max(2_000)).max(32),
});

/** A skipped engine frame with the reason (never silent). */
export const directorDccEngineFrameSkippedSchema = z.strictObject({
  contract: z.literal(DIRECTOR_DCC_ENGINE_FRAME_CONTRACT),
  provider: directorDccEngineIdSchema,
  status: z.literal("skipped"),
  skipReason: nonEmpty.max(2_000),
  warnings: z.array(z.string().max(2_000)).max(32),
});

/** The full engine frame receipt union. */
export const directorDccEngineFrameReceiptSchema = z.discriminatedUnion("status", [
  directorDccEngineFrameRenderedSchema,
  directorDccEngineFrameSkippedSchema,
]);

/** A validated rendered engine frame receipt. */
export type DirectorDccEngineFrameRendered = z.infer<typeof directorDccEngineFrameRenderedSchema>;

/** A validated skipped engine frame receipt. */
export type DirectorDccEngineFrameSkipped = z.infer<typeof directorDccEngineFrameSkippedSchema>;

/** A validated engine frame receipt. */
export type DirectorDccEngineFrameReceipt = z.infer<typeof directorDccEngineFrameReceiptSchema>;
