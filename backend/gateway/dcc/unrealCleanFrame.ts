import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  DIRECTOR_UNREAL_CLEAN_FRAME_CONTRACT,
  directorUnrealCleanFrameReceiptSchema,
  type DirectorUnrealCleanFrameReceipt,
  type DirectorUnrealCleanFrameSkipped,
} from "@director/dcc-protocol";

/**
 * Gateway side of the optional Unreal clean-frame render: one headless still,
 * rendered offscreen through a Director-tagged CineCamera with no editor
 * gizmos, labels, or helper overlays. The render is best-effort by contract —
 * every failure path degrades to a `skipped` receipt with a reason instead of
 * failing the engine handoff.
 */

/** Caller options for one clean-frame render. */
export interface UnrealCleanFrameRequest {
  /** Director camera id to render through (defaults to the first tagged camera). */
  cameraId?: string;
  /** Director timeline frame to represent (defaults to the import snapshot). */
  frame?: number;
  width?: number;
  height?: number;
}

/** A minimal process runner matching the engine bridge runner shape. */
export type UnrealCleanFrameProcessRunner = (
  executable: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ stdout: string; stderr: string }>;

/** Everything the render invocation needs, resolved by the engine bridge. */
export interface UnrealCleanFrameContext {
  executable: string;
  projectPath: string;
  /** Absolute path of the fixed connector entry script inside the engine project. */
  scriptPath: string;
  /** The exchange package directory of the current job. */
  packageDirectory: string;
  /** The private job directory that receives the receipt and image. */
  jobDirectory: string;
  /** The exchange package id the receipt must reference. */
  expectedPackageId: string;
  /** The project revision the receipt must reference. */
  expectedSourceRevision: string;
  runProcess: UnrealCleanFrameProcessRunner;
  timeoutMs: number;
}

const DEFAULT_WIDTH = 1_920;
const DEFAULT_HEIGHT = 1_080;

/**
 * Build a `skipped` clean-frame receipt with a reason.
 *
 * @param skipReason - Why the clean frame was not rendered.
 * @param warnings - Optional extra context for the caller.
 * @returns A schema-valid skipped receipt.
 */
export function skippedUnrealCleanFrame(skipReason: string, warnings: string[] = []): DirectorUnrealCleanFrameSkipped {
  return {
    contract: DIRECTOR_UNREAL_CLEAN_FRAME_CONTRACT,
    provider: "unreal",
    status: "skipped",
    skipReason,
    warnings,
  };
}

function quoteForUnrealScriptArgument(path: string): string {
  return `"${path.replaceAll('"', "")}"`;
}

function isInside(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

/**
 * Run the fixed connector render mode and validate its receipt.
 *
 * The invocation uses `-ExecCmds="py …"` with `-RenderOffscreen` (never
 * `-nullrhi`) so the editor keeps a rendering RHI while drawing no editor
 * widgets; the connector quits itself when the screenshot task completes.
 * Rendered receipts are only accepted when the image bytes on disk re-hash to
 * the pinned SHA-256 and the receipt references the exact package and
 * revision of this job; anything else degrades to `skipped` with a reason.
 *
 * @param context - Executable, script, job paths, and pinned identifiers.
 * @param request - Camera, frame, and resolution options.
 * @returns The validated receipt; never throws.
 */
export async function runUnrealCleanFrame(
  context: UnrealCleanFrameContext,
  request: UnrealCleanFrameRequest = {},
): Promise<DirectorUnrealCleanFrameReceipt> {
  const receiptPath = resolve(context.jobDirectory, "clean-frame.json");
  const width = request.width ?? DEFAULT_WIDTH;
  const height = request.height ?? DEFAULT_HEIGHT;
  const scriptArguments = [
    quoteForUnrealScriptArgument(context.scriptPath),
    "--mode",
    "render",
    "--package",
    quoteForUnrealScriptArgument(context.packageDirectory),
    "--report",
    quoteForUnrealScriptArgument(receiptPath),
    "--render-output",
    quoteForUnrealScriptArgument(resolve(context.jobDirectory, "clean-frame.png")),
    "--render-width",
    String(width),
    "--render-height",
    String(height),
    ...(request.cameraId ? ["--render-camera", quoteForUnrealScriptArgument(request.cameraId)] : []),
    ...(request.frame !== undefined ? ["--render-frame", String(Math.round(request.frame))] : []),
  ].join(" ");
  const args = [
    context.projectPath,
    `-ExecCmds=py ${scriptArguments}`,
    "-unattended",
    "-nopause",
    "-nosplash",
    "-RenderOffscreen",
    "-stdout",
  ];

  try {
    await context.runProcess(context.executable, args, context.timeoutMs);
  } catch (error) {
    return skippedUnrealCleanFrame(
      `Clean-frame render process failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let rawReceipt: unknown;
  try {
    rawReceipt = JSON.parse(await readFile(receiptPath, "utf8")) as unknown;
  } catch {
    return skippedUnrealCleanFrame("The connector did not write a readable clean-frame receipt.");
  }
  const parsed = directorUnrealCleanFrameReceiptSchema.safeParse(rawReceipt);
  if (!parsed.success) {
    return skippedUnrealCleanFrame(
      `The clean-frame receipt failed validation: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    );
  }
  const receipt = parsed.data;
  if (receipt.status === "skipped") return receipt;

  if (receipt.packageId !== context.expectedPackageId || receipt.sourceRevision !== context.expectedSourceRevision) {
    return skippedUnrealCleanFrame("The clean-frame receipt does not reference the exchange package that was sent.");
  }
  const imageAbsolute = resolve(context.jobDirectory, receipt.imagePath);
  if (!isInside(context.jobDirectory, imageAbsolute)) {
    return skippedUnrealCleanFrame("The clean-frame image path escapes the private job directory.");
  }
  let imageBytes: Buffer;
  try {
    imageBytes = await readFile(imageAbsolute);
  } catch {
    return skippedUnrealCleanFrame(`The clean-frame image is missing: ${receipt.imagePath}.`);
  }
  const actualSha256 = createHash("sha256").update(imageBytes).digest("hex");
  if (actualSha256 !== receipt.imageSha256) {
    return skippedUnrealCleanFrame(
      `The clean-frame image bytes do not match the pinned SHA-256 (expected ${receipt.imageSha256}, found ${actualSha256}).`,
    );
  }
  return receipt;
}
