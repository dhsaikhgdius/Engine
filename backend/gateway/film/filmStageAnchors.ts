import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  stageReferenceSchema,
  type ShotSpec,
  type StageReference,
} from "../../../packages/protocol/src/filmPipelineProtocol";
import { asRecord, errorMessage } from "../../../packages/protocol/src/primitives";

/**
 * Film stage anchor resolver.
 *
 * Bridges the Director 3D workbench (white-box stage) and the film render
 * pipeline: it discovers the storyboard of the connected Director project,
 * aligns storyboard shots with the film scene's shot specs by order, captures
 * a sharp offscreen clay plate through each storyboard shot's bound camera, and persists the
 * frames as `<runDirectory>/stage_anchors/scene_<sceneIdx>/shot_<shotIdx>.png`.
 * The returned StageReference[] plugs into FilmRenderCoordinator.renderScene,
 * where each capture becomes the authoritative spatial reference for the
 * shot's generated first frame and skips transition-video camera
 * derivation for that camera.
 *
 * Stage anchoring is strictly best-effort: a project without a storyboard, a
 * shot without a usable camera binding, or a failed capture only shrinks the
 * result. This resolver never throws into the render pipeline — only an
 * AbortSignal abort propagates. Already-persisted PNGs are reused so a
 * resumed run does not re-capture.
 */

/** Injected by the integrator: executes one director_workbench operation against the connected browser workbench. */
export type WorkbenchExecute = (input: Record<string, unknown>) => Promise<unknown>;

/** Input for resolving white-box stage anchors for one film scene. */
export type StageAnchorRequest = {
  execute: WorkbenchExecute;
  runDirectory: string;
  sceneIdx: number;
  shots: readonly ShotSpec[];
  /** Film frame aspect; selects an offscreen clay raster instead of a live viewport snapshot. */
  aspectRatio?: string;
  signal?: AbortSignal;
};

/** Offscreen clay rasters that stay under the Agent-wire 2_073_600 pixel cap. */
export const FILM_STAGE_ANCHOR_RASTERS = {
  "16:9": { width: 1280, height: 720 },
  "9:16": { width: 720, height: 1280 },
  "2.39:1": { width: 1280, height: 536 },
  "1:1": { width: 1024, height: 1024 },
} as const;

/** Picks the capture raster for a film aspect ratio, defaulting to 16:9. */
export function filmStageAnchorRaster(aspectRatio?: string): { width: number; height: number } {
  if (aspectRatio && aspectRatio in FILM_STAGE_ANCHOR_RASTERS) {
    return FILM_STAGE_ANCHOR_RASTERS[aspectRatio as keyof typeof FILM_STAGE_ANCHOR_RASTERS];
  }
  return FILM_STAGE_ANCHOR_RASTERS["16:9"];
}

const EVENT_STAGE = "stage_anchors";

// ---------------------------------------------------------------------------
// Wire tolerance
// ---------------------------------------------------------------------------
// The injected execute may surface a director_workbench response from any of
// the real execution boundaries (directorWorkbenchContract.ts consumers):
//   - gateway HTTP StageGatewayExecution: { success, result, error?, capture: { mimeType, data } }
//   - browser wire response:              { success, result, captureDataUrl: "data:image/...;base64,..." }
//   - MCP tool response:                  { content: [{ type: "image", data }], structuredContent: { ok, result }, isError }
// Operation payloads are looked up across those layers and capture images are
// accepted both as raw base64 fields and as data URLs.

const storyboardShotWireSchema = z.looseObject({
  id: z.string().min(1),
  title: z.string().nullish(),
  /** observe maps project storyboard shot.cameraId (string | null) to camera_id. */
  camera_id: z.string().min(1).nullish(),
});

const storyboardWireSchema = z.looseObject({
  shots: z.array(z.unknown()).default([]),
});

const cameraWireSchema = z.looseObject({ id: z.string().min(1) });

/** inspect(entity=storyboard_shot) returns the raw project storyboard shot as result.value. */
const storyboardShotDetailWireSchema = z.looseObject({
  frameStart: z.number().nullish(),
});

type StoryboardShotBinding = {
  id: string;
  title: string | null;
  cameraId: string | null;
};

type StoryboardDiscovery = {
  shots: StoryboardShotBinding[];
  /** null when observe did not report cameras; bindings are then trusted as-is. */
  cameraIds: ReadonlySet<string> | null;
};

/** Collects the records where operation results may live across the known execution boundaries. */
function resultLayers(response: unknown): Record<string, unknown>[] {
  const layers: Record<string, unknown>[] = [];
  const push = (value: unknown) => {
    const record = asRecord(value);
    if (record) layers.push(record);
  };
  push(response);
  const root = asRecord(response);
  if (root) {
    push(root.result);
    const structured = asRecord(root.structuredContent);
    if (structured) {
      push(structured);
      push(structured.result);
    }
  }
  return layers;
}

/** Returns an error description when any layer carries an explicit failure flag, otherwise null. */
function responseFailure(response: unknown): string | null {
  const layers = resultLayers(response);
  const failed = layers.some((layer) => layer.success === false || layer.ok === false || layer.isError === true);
  if (!failed) return null;
  for (const layer of layers) {
    if (typeof layer.error === "string" && layer.error.length > 0) return layer.error;
  }
  return "workbench reported failure without an error message";
}

function extractStoryboardShots(response: unknown): StoryboardShotBinding[] | null {
  for (const layer of resultLayers(response)) {
    const storyboard = asRecord(layer.storyboard);
    if (!storyboard) continue;
    const parsed = storyboardWireSchema.safeParse(storyboard);
    if (!parsed.success) continue;
    const shots: StoryboardShotBinding[] = [];
    for (const rawShot of parsed.data.shots) {
      const shot = storyboardShotWireSchema.safeParse(rawShot);
      if (!shot.success) continue;
      shots.push({ id: shot.data.id, title: shot.data.title ?? null, cameraId: shot.data.camera_id ?? null });
    }
    return shots;
  }
  return null;
}

function extractCameraIds(response: unknown): ReadonlySet<string> | null {
  for (const layer of resultLayers(response)) {
    if (!Array.isArray(layer.cameras)) continue;
    const ids = new Set<string>();
    for (const rawCamera of layer.cameras) {
      const camera = cameraWireSchema.safeParse(rawCamera);
      if (camera.success) ids.add(camera.data.id);
    }
    return ids;
  }
  return null;
}

/** Reads frameStart from an inspect(entity=storyboard_shot) response, normalized to a capture frame. */
function extractStoryboardShotFrame(response: unknown): number | null {
  for (const layer of resultLayers(response)) {
    for (const candidate of [asRecord(layer.value), layer]) {
      if (!candidate) continue;
      const parsed = storyboardShotDetailWireSchema.safeParse(candidate);
      if (!parsed.success) continue;
      const frameStart = parsed.data.frameStart;
      if (typeof frameStart === "number" && Number.isFinite(frameStart)) {
        return Math.max(0, Math.round(frameStart));
      }
    }
  }
  return null;
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const IMAGE_DATA_URL_PATTERN = /^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/]+={0,2})$/i;

function decodeBase64Image(base64: string): Buffer | null {
  if (!BASE64_PATTERN.test(base64)) return null;
  const bytes = Buffer.from(base64, "base64");
  return bytes.byteLength > 0 ? bytes : null;
}

function decodeImageDataUrl(value: unknown): Buffer | null {
  if (typeof value !== "string") return null;
  const match = IMAGE_DATA_URL_PATTERN.exec(value.trim());
  return match ? decodeBase64Image(match[1]) : null;
}

/** Handles StageGatewayExecution capture payloads ({ mimeType, data }) and captureBridge results ({ dataUrl }). */
function decodeCaptureRecord(value: unknown): Buffer | null {
  const capture = asRecord(value);
  if (!capture) return null;
  const fromDataUrl = decodeImageDataUrl(capture.dataUrl);
  if (fromDataUrl) return fromDataUrl;
  const base64 =
    typeof capture.data === "string"
      ? capture.data
      : typeof capture.dataBase64 === "string"
        ? capture.dataBase64
        : null;
  return base64 ? decodeBase64Image(base64) : null;
}

function extractCaptureImage(response: unknown): Buffer | null {
  for (const layer of resultLayers(response)) {
    const direct =
      decodeImageDataUrl(layer.captureDataUrl) ??
      decodeCaptureRecord(layer.capture) ??
      decodeImageDataUrl(layer.dataUrl);
    if (direct) return direct;
    if (!Array.isArray(layer.content)) continue;
    for (const item of layer.content) {
      const entry = asRecord(item);
      if (entry?.type !== "image" || typeof entry.data !== "string") continue;
      const decoded = decodeBase64Image(entry.data) ?? decodeImageDataUrl(entry.data);
      if (decoded) return decoded;
    }
  }
  return null;
}

async function fileExists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function stageAnchorNote(storyboardShot: StoryboardShotBinding): string {
  const label = (storyboardShot.title?.trim() || storyboardShot.id).slice(0, 120);
  const camera = storyboardShot.cameraId ? ` through camera "${storyboardShot.cameraId}"` : "";
  return (
    `Director white-box stage capture of storyboard shot "${label}"${camera}. ` +
    "Warm clay figures are characters; cool grey geometry is the environment. " +
    "Composition, camera angle and spatial blocking in this frame are the authoritative reference. " +
    "Replace the mannequin figures and untextured geometry with the final styled characters and environment while preserving this staged layout."
  );
}

/**
 * Bridges the Director 3D workbench (white-box stage) and the film render
 * pipeline: discovers the storyboard of the connected Director project, aligns
 * storyboard shots with the film scene's shot specs by order, captures a clay
 * plate through each storyboard shot's bound camera, and persists the frames.
 *
 * Stage anchoring is strictly best-effort: a project without a storyboard, a
 * shot without a usable camera binding, or a failed capture only shrinks the
 * result. This resolver never throws into the render pipeline — only an
 * AbortSignal abort propagates.
 */
export class StageAnchorResolver {
  private readonly onEvent?: (stage: string, message: string) => void;

  constructor(options?: { onEvent?: (stage: string, message: string) => void }) {
    this.onEvent = options?.onEvent;
  }

  private emit(message: string) {
    this.onEvent?.(EVENT_STAGE, message);
  }

  /**
   * Resolves white-box stage anchors for one film scene. Storyboard shot N is
   * aligned with request.shots[N]; unmatched or uncapturable shots are skipped.
   * Never rejects except when request.signal aborts.
   */
  async resolveSceneAnchors(request: StageAnchorRequest): Promise<StageReference[]> {
    const references: StageReference[] = [];
    const sceneDirectory = join(request.runDirectory, "stage_anchors", `scene_${request.sceneIdx}`);
    try {
      request.signal?.throwIfAborted();
      const discovery = await this.discoverStoryboard(request);
      if (!discovery || discovery.shots.length === 0) return references;

      const pairCount = Math.min(discovery.shots.length, request.shots.length);
      this.emit(
        `Aligning ${pairCount} storyboard shot(s) with scene ${request.sceneIdx} film shots by order ` +
          `(storyboard ${discovery.shots.length}, film ${request.shots.length})`,
      );
      for (let position = 0; position < pairCount; position += 1) {
        request.signal?.throwIfAborted();
        const storyboardShot = discovery.shots[position];
        const filmShot = request.shots[position];
        const imagePath = join(sceneDirectory, `shot_${filmShot.idx}.png`);
        try {
          const reference = await this.resolveShotAnchor({
            request,
            storyboardShot,
            filmShot,
            cameraIds: discovery.cameraIds,
            imagePath,
          });
          if (reference) references.push(reference);
        } catch (error) {
          if (request.signal?.aborted) throw error;
          this.emit(`Shot ${filmShot.idx}: stage capture failed (${errorMessage(error)}); skipping this anchor`);
        }
      }
      this.emit(`Resolved ${references.length}/${pairCount} stage anchor(s) for scene ${request.sceneIdx}`);
      return references;
    } catch (error) {
      if (request.signal?.aborted) throw error;
      this.emit(
        `Stage anchor resolution stopped (${errorMessage(error)}); ` +
          `continuing render with ${references.length} resolved anchor(s)`,
      );
      return references;
    }
  }

  private async discoverStoryboard(request: StageAnchorRequest): Promise<StoryboardDiscovery | null> {
    this.emit(`Observing Director workbench storyboard and cameras for scene ${request.sceneIdx}`);
    const response = await request.execute({ op: "observe", fields: ["storyboard", "cameras"] });
    const failure = responseFailure(response);
    if (failure) {
      this.emit(`Workbench observe failed (${failure}); rendering scene ${request.sceneIdx} without stage anchors`);
      return null;
    }
    const shots = extractStoryboardShots(response);
    if (!shots || shots.length === 0) {
      this.emit(
        `Connected Director project has no storyboard shots; rendering scene ${request.sceneIdx} without stage anchors`,
      );
      return null;
    }
    const cameraIds = extractCameraIds(response);
    this.emit(
      `Discovered ${shots.length} storyboard shot(s), ` +
        `${shots.filter((shot) => shot.cameraId).length} with camera bindings` +
        (cameraIds ? `, ${cameraIds.size} camera(s) in project` : ""),
    );
    return { shots, cameraIds };
  }

  private async resolveShotAnchor(input: {
    request: StageAnchorRequest;
    storyboardShot: StoryboardShotBinding;
    filmShot: ShotSpec;
    cameraIds: ReadonlySet<string> | null;
    imagePath: string;
  }): Promise<StageReference | null> {
    const { request, storyboardShot, filmShot, cameraIds, imagePath } = input;

    if (await fileExists(imagePath)) {
      this.emit(`Shot ${filmShot.idx}: reusing existing stage anchor ${imagePath}`);
      return this.buildReference(request.sceneIdx, filmShot.idx, imagePath, storyboardShot);
    }

    const cameraId = storyboardShot.cameraId;
    if (!cameraId) {
      this.emit(`Shot ${filmShot.idx}: storyboard shot "${storyboardShot.id}" has no camera binding; skipping`);
      return null;
    }
    if (cameraIds && !cameraIds.has(cameraId)) {
      this.emit(`Shot ${filmShot.idx}: storyboard camera "${cameraId}" is not in the project's cameras; skipping`);
      return null;
    }

    request.signal?.throwIfAborted();
    const inspectResponse = await request.execute({ op: "inspect", entity: "storyboard_shot", id: storyboardShot.id });
    const inspectFailure = responseFailure(inspectResponse);
    const frame = inspectFailure ? null : extractStoryboardShotFrame(inspectResponse);
    if (frame === null) {
      this.emit(
        `Shot ${filmShot.idx}: could not determine capture frame for storyboard shot "${storyboardShot.id}"` +
          (inspectFailure ? ` (${inspectFailure})` : "") +
          "; skipping",
      );
      return null;
    }

    request.signal?.throwIfAborted();
    const raster = filmStageAnchorRaster(request.aspectRatio);
    this.emit(
      `Shot ${filmShot.idx}: capturing clay plate via camera "${cameraId}" at frame ${frame} (${raster.width}x${raster.height})`,
    );
    const captureResponse = await request.execute({
      op: "capture",
      camera_id: cameraId,
      frame,
      render_pass: "clay",
      clean_plate: true,
      depth_of_field: false,
      width: raster.width,
      height: raster.height,
    });
    const captureFailure = responseFailure(captureResponse);
    if (captureFailure) {
      this.emit(`Shot ${filmShot.idx}: stage capture failed (${captureFailure}); skipping this anchor`);
      return null;
    }
    const image = extractCaptureImage(captureResponse);
    if (!image) {
      this.emit(`Shot ${filmShot.idx}: capture response carried no decodable image; skipping this anchor`);
      return null;
    }

    await mkdir(dirname(imagePath), { recursive: true });
    await writeFile(imagePath, image);
    this.emit(`Shot ${filmShot.idx}: stage anchor saved to ${imagePath}`);
    return this.buildReference(request.sceneIdx, filmShot.idx, imagePath, storyboardShot);
  }

  private buildReference(
    sceneIdx: number,
    shotIdx: number,
    imagePath: string,
    storyboardShot: StoryboardShotBinding,
  ): StageReference {
    return stageReferenceSchema.parse({
      sceneIdx,
      shotIdx,
      imagePath,
      note: stageAnchorNote(storyboardShot),
    });
  }
}
