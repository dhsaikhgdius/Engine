import {
  videoModelOperationSchema,
  type VideoModelOperation,
} from "@director/protocol/videoGenerationProtocol";
import type { StageScene } from "@director/stage-protocol";
import { validateStageScene } from "./commandEngine";

/**
 * Parses and validates video model input against the shared operation schema.
 *
 * For `prepare` and `render` operations, the scene must pass readiness checks
 * (at least one renderable object and one camera) before the operation is accepted.
 *
 * @param input - The raw video model operation input.
 * @param scene - The current stage scene to validate against.
 * @returns Parsed operation on success, or a localized error message.
 */
export function parseVideoModelInput(
  input: unknown,
  scene: StageScene,
): { success: true; operation: VideoModelOperation } | { success: false; error: string } {
  const parsed = videoModelOperationSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "stage_video input does not match the shared operation schema" };
  if (parsed.data.op === "prepare" || parsed.data.op === "render") {
    const readiness = validateStageScene(scene);
    if (!readiness.ready) {
      return {
        success: false,
        error: `scene is not video-ready: ${readiness.issues
          .filter((issue) => issue.severity === "error")
          .map((issue) => issue.message)
          .join("; ")}`,
      };
    }
  }
  return { success: true, operation: parsed.data };
}

/**
 * Validates video model input for plan dry-run checks.
 *
 * @param input - The raw video model operation input.
 * @param scene - The current stage scene.
 * @returns `null` when valid, or an error string when the input is invalid.
 */
export function validateVideoModelInput(input: unknown, scene: StageScene) {
  const parsed = parseVideoModelInput(input, scene);
  return parsed.success ? null : parsed.error;
}
