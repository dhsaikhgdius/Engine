import { z } from "zod";
import { DIRECTOR_PROJECT_REVISION_PATTERN } from "../../../frontend/director/src/comprehensive/editor/schema/directorProjectRevision";

/**
 * Contract identifier for the Unreal clean-frame render receipt: one optional
 * headless still, rendered offscreen through a Director-tagged CineCamera with
 * no editor gizmos, labels, or helper overlays. The receipt is host-free
 * (plain JSON validated by this schema); when Unreal cannot render, the
 * receipt records `skipped` with a reason instead of failing the handoff.
 */
export const DIRECTOR_UNREAL_CLEAN_FRAME_CONTRACT = "director-unreal-clean-frame-v1" as const;

const nonEmpty = z.string().trim().min(1);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "expected lowercase SHA-256 hex");
const safeRelativePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !/^[A-Za-z]:/.test(path) &&
      path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
    { message: "path must be a safe relative path" },
  );

/** A clean frame that was actually rendered, with the image pinned by hash. */
export const directorUnrealCleanFrameRenderedSchema = z.strictObject({
  contract: z.literal(DIRECTOR_UNREAL_CLEAN_FRAME_CONTRACT),
  provider: z.literal("unreal"),
  status: z.literal("rendered"),
  /** The exchange package (job) this frame belongs to. */
  packageId: nonEmpty.max(240),
  sourceRevision: z.string().regex(DIRECTOR_PROJECT_REVISION_PATTERN),
  /** Content path of the imported Director level the frame was rendered from. */
  levelPath: nonEmpty.max(1_024),
  /** The Director camera the frame was rendered through, or null for the first tagged camera. */
  cameraDirectorId: z.string().trim().min(1).max(200).nullable(),
  /** The Director timeline frame the still represents. */
  frame: z.number().int().min(-1_000_000).max(75_000_000_000),
  width: z.number().int().positive().max(16_384),
  height: z.number().int().positive().max(16_384),
  /** Image path relative to the receipt file, inside the private job directory. */
  imagePath: safeRelativePathSchema,
  /** SHA-256 of the exact image bytes on disk; the Gateway re-hashes before accepting. */
  imageSha256: sha256Schema,
  /**
   * The render path that guarantees a clean frame: an offscreen high-resolution
   * screenshot never composites editor gizmos, actor labels, or helper widgets.
   */
  method: z.literal("offscreen_high_res_screenshot"),
  hostVersion: nonEmpty.max(200),
  warnings: z.array(z.string().max(2_000)).max(2_000),
});

/** A validated rendered clean-frame receipt. */
export type DirectorUnrealCleanFrameRendered = z.infer<typeof directorUnrealCleanFrameRenderedSchema>;

/** A clean frame that was skipped, with a machine-relayable reason. */
export const directorUnrealCleanFrameSkippedSchema = z.strictObject({
  contract: z.literal(DIRECTOR_UNREAL_CLEAN_FRAME_CONTRACT),
  provider: z.literal("unreal"),
  status: z.literal("skipped"),
  skipReason: nonEmpty.max(2_000),
  warnings: z.array(z.string().max(2_000)).max(2_000),
});

/** A validated skipped clean-frame receipt. */
export type DirectorUnrealCleanFrameSkipped = z.infer<typeof directorUnrealCleanFrameSkippedSchema>;

/** The clean-frame receipt: rendered with a hash-pinned image, or skipped with a reason. */
export const directorUnrealCleanFrameReceiptSchema = z.discriminatedUnion("status", [
  directorUnrealCleanFrameRenderedSchema,
  directorUnrealCleanFrameSkippedSchema,
]);

/** A validated clean-frame receipt (rendered or skipped). */
export type DirectorUnrealCleanFrameReceipt = z.infer<typeof directorUnrealCleanFrameReceiptSchema>;
