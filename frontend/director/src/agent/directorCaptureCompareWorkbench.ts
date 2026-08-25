import type { CaptureReconstructionPlan, CapturePlanCamera } from "@director/protocol/captureReconstructionProtocol";
import {
  persistentCreativeMediaLibrary,
  type CreativeMediaAsset,
} from "../comprehensive/editor/media/persistentCreativeMediaStore";
import {
  compareLuminanceImages,
  luminanceFromRgba,
  type CaptureCompareGrid,
  type CaptureCompareScore,
  type LuminanceImage,
} from "../comprehensive/editor/reconstruction/captureCompare";
import {
  fetchCaptureArtifactBlob,
  fetchCaptureReconstructionPlan,
} from "../comprehensive/editor/reconstruction/captureReconstructionClient";
import { useDirectorStore, type DirectorStore } from "../comprehensive/editor/store/directorStore";
import type { DirectorCompareSource, DirectorCompareWorkbenchOperation } from "@director/agent-engine/contract";
import type { DirectorWorkbenchExecution } from "./directorWorkbenchExecutor";

/**
 * General capture comparison for the quantify → locate → fix-locally loop.
 *
 * Both the public `compare` operation and the plan-bound
 * `reconstruction.compare` action resolve their image endpoints through this
 * module and score them with the one shared luminance-grid scorer
 * ({@link compareLuminanceImages}); image bytes never leave the browser.
 */

/**
 * Parameters for an offscreen render capture of a specific camera view at a
 * given frame. Structurally identical to the reconstruction workbench capture
 * request so both modules can share one live capture bridge dependency.
 */
export type CaptureViewportRequest = {
  /** Identifier of the camera to render from. */
  cameraId: string;
  /** Frame number to capture. */
  frame: number;
  /** Render width in pixels. */
  width: number;
  /** Render height in pixels. */
  height: number;
};

/** Composite score at or above this threshold reads as a strong match. */
const STRONG_MATCH_COMPOSITE = 0.75;

/**
 * Injectable dependencies for the general capture comparison. Every field has
 * a default wired to the live Director store and API clients; override
 * individual fields in tests or headless environments.
 */
export type DirectorCaptureCompareWorkbenchDependencies = {
  /** Returns the current Director Zustand store snapshot. */
  getStore?: () => DirectorStore;
  /** Looks up a Creative Media asset by id from the persistent library. */
  getMediaAsset?: (id: string) => CreativeMediaAsset | null;
  /** Reads the raw bytes of a Creative Media asset. */
  getMediaBlob?: (id: string) => Promise<Blob | null>;
  /** Fetches the full reconstruction plan for a completed job. */
  fetchPlan?: typeof fetchCaptureReconstructionPlan;
  /** Downloads a reconstruction artifact blob by artifact id. */
  fetchArtifactBlob?: typeof fetchCaptureArtifactBlob;
  /** Offscreen stage render through the browser capture bridge. */
  requestCapture?: (request: CaptureViewportRequest, signal?: AbortSignal) => Promise<string | null>;
  /** Decodes an image Blob or a stage-capture data URL into luminance. */
  decodeImage?: (source: Blob | string) => Promise<LuminanceImage>;
  /** Returns the current timestamp as an ISO-8601 string. */
  now?: () => string;
};

/**
 * Decodes an image blob or a data URL into a luminance image for comparison.
 * createImageBitmap handles both formats natively; the canvas round-trip
 * extracts raw pixel data for luminance computation.
 */
export async function decodeImageSourceToLuminance(source: Blob | string): Promise<LuminanceImage> {
  const bitmap = await createImageBitmap(typeof source === "string" ? await (await fetch(source)).blob() : source);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D context is unavailable; cannot compare images");
    context.drawImage(bitmap, 0, 0);
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    return luminanceFromRgba(imageData.data, imageData.width, imageData.height);
  } finally {
    bitmap.close();
  }
}

/**
 * Resolves the capture-view camera a comparison endpoint refers to:
 * an exact camera id wins, then a key-view id, then the first plan camera.
 *
 * @returns The matching plan camera, or null when the plan has none.
 */
export function resolveCapturePlanCamera(
  plan: CaptureReconstructionPlan,
  selector: { cameraId?: string; viewId?: string },
): CapturePlanCamera | null {
  const camera = selector.cameraId
    ? plan.cameras.find((candidate) => candidate.id === selector.cameraId)
    : selector.viewId
      ? plan.cameras.find((candidate) => candidate.viewId === selector.viewId)
      : plan.cameras[0];
  return camera ?? null;
}

/**
 * One-line next-step hint for a comparison score: strong matches need no
 * action; weak matches direct the caller to the worst grid regions first.
 */
export function captureCompareHint(score: CaptureCompareScore, referenceLabel = "the reference"): string {
  return score.composite >= STRONG_MATCH_COMPOSITE
    ? `Match to ${referenceLabel} is strong.`
    : "Match is weak: fix the regions in grid.worst first (large forms and layout, then materials, then lighting).";
}

// Wire production dependencies to the live Director singleton and API clients.
function defaultDependencies(): Required<DirectorCaptureCompareWorkbenchDependencies> {
  return {
    getStore: () => useDirectorStore.getState(),
    getMediaAsset: (id) => persistentCreativeMediaLibrary.getAsset(id),
    getMediaBlob: (id) => persistentCreativeMediaLibrary.getBlob(id),
    fetchPlan: fetchCaptureReconstructionPlan,
    fetchArtifactBlob: fetchCaptureArtifactBlob,
    requestCapture: async () => null,
    decodeImage: decodeImageSourceToLuminance,
    now: () => new Date().toISOString(),
  };
}

/** Resolved identity of one comparison endpoint, echoed back in the result. */
type ResolvedCompareSource = Record<string, unknown> & { kind: DirectorCompareSource["kind"] };

async function resolveCompareSource(
  role: "reference" | "candidate",
  source: DirectorCompareSource,
  dependencies: Required<DirectorCaptureCompareWorkbenchDependencies>,
  signal?: AbortSignal,
): Promise<{ image: LuminanceImage; resolved: ResolvedCompareSource }> {
  signal?.throwIfAborted();
  if (source.kind === "stage") {
    const project = dependencies.getStore().project;
    const cameraId = source.camera_id ?? project.activeCameraId ?? null;
    if (!cameraId) {
      throw new Error(`compare ${role} stage source needs camera_id: the project has no active camera.`);
    }
    if (!project.cameras.some((candidate) => candidate.id === cameraId)) {
      throw new Error(`compare ${role} stage camera "${cameraId}" does not exist; observe cameras first.`);
    }
    const dataUrl = await dependencies.requestCapture(
      { cameraId, frame: source.frame, width: source.width, height: source.height },
      signal,
    );
    if (!dataUrl) throw new Error("Stage capture failed: the browser canvas is unavailable");
    const image = await dependencies.decodeImage(dataUrl);
    return {
      image,
      resolved: { kind: "stage", camera_id: cameraId, frame: source.frame, width: image.width, height: image.height },
    };
  }
  if (source.kind === "media") {
    const media = dependencies.getMediaAsset(source.media_id);
    if (!media) throw new Error(`Gallery media "${source.media_id}" does not exist`);
    if (media.kind !== "image") {
      throw new Error(`Gallery media "${media.id}" is ${media.kind}; compare needs a still image endpoint.`);
    }
    const blob = await dependencies.getMediaBlob(media.id);
    if (!blob) throw new Error(`Gallery media "${media.id}" has no usable bytes`);
    const image = await dependencies.decodeImage(blob);
    return {
      image,
      resolved: {
        kind: "media",
        media_id: media.id,
        file_name: media.fileName,
        width: image.width,
        height: image.height,
      },
    };
  }
  const plan = await dependencies.fetchPlan(source.job_id, signal);
  const camera = resolveCapturePlanCamera(plan, { cameraId: source.camera_id, viewId: source.view_id });
  if (!camera) {
    throw new Error("This reconstruction plan has no matching capture-view camera; confirm view_id / camera_id first.");
  }
  signal?.throwIfAborted();
  const blob = await dependencies.fetchArtifactBlob(source.job_id, camera.keyframeArtifactId, signal);
  const image = await dependencies.decodeImage(blob);
  return {
    image,
    resolved: {
      kind: "reconstruction_keyframe",
      job_id: source.job_id,
      view_id: camera.viewId,
      camera_id: camera.id,
      width: image.width,
      height: image.height,
    },
  };
}

// Attach a normalized 0..1 region rectangle to each worst grid cell so the
// caller can locate the weak area on either image without knowing grid math.
function gridWithRegions(grid: CaptureCompareGrid) {
  return {
    ...grid,
    worst: grid.worst.map((cell) => ({
      ...cell,
      region: {
        x0: Number((cell.col / grid.cols).toFixed(4)),
        y0: Number((cell.row / grid.rows).toFixed(4)),
        x1: Number(((cell.col + 1) / grid.cols).toFixed(4)),
        y1: Number(((cell.row + 1) / grid.rows).toFixed(4)),
      },
    })),
  };
}

/**
 * Executes the general `compare` workbench operation.
 *
 * Resolves the reference endpoint, then the candidate endpoint (sequential so
 * two stage renders never race the viewport), scores them on the shared
 * luminance grid, and returns scores, the worst grid cells with normalized
 * regions, and a fix-locally hint.
 *
 * @param operation - The parsed compare operation.
 * @param signal - Optional abort signal to cancel the comparison.
 * @param options - Optional dependency overrides for tests and live wiring.
 * @returns A workbench execution result with success status and payload.
 * @throws Never throws — errors are caught and returned as a failed execution.
 */
export async function executeDirectorCaptureCompareWorkbenchCommand(
  operation: DirectorCompareWorkbenchOperation,
  signal?: AbortSignal,
  options: { dependencies?: DirectorCaptureCompareWorkbenchDependencies } = {},
): Promise<DirectorWorkbenchExecution> {
  const dependencies = { ...defaultDependencies(), ...options.dependencies };
  try {
    signal?.throwIfAborted();
    const reference = await resolveCompareSource("reference", operation.reference, dependencies, signal);
    const candidate = await resolveCompareSource("candidate", operation.candidate, dependencies, signal);
    signal?.throwIfAborted();
    const { score, grid } = compareLuminanceImages(reference.image, candidate.image, operation.grid ?? {});
    return {
      success: true,
      result: {
        compare: {
          reference: reference.resolved,
          candidate: candidate.resolved,
          score,
          grid: gridWithRegions(grid),
          captured_at: dependencies.now(),
        },
        hint: captureCompareHint(score),
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      result: {
        code: error instanceof DOMException && error.name === "AbortError" ? "cancelled" : "compare_failed",
      },
    };
  }
}
