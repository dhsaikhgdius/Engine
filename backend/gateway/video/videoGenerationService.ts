import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { writeJsonAtomic } from "../atomicJsonFile";
import { parseVideoModelInput } from "@director/agent-engine";
import { validateStageScene } from "@director/agent-engine";
import { directorCameraAspectRatioSchema as aspectSchema } from "../../../packages/protocol/src/directorCameraProtocol";
import {
  normalizeLtxDimension,
  normalizeLtxFrameCount,
  videoJobStatusSchema,
  videoProviderIdSchema,
  type VideoModelOperation,
  type VideoProviderCapability,
  type VideoProviderId,
} from "../../../packages/protocol/src/videoGenerationProtocol";
import type { StageScene, ToolExecution } from "@director/stage-protocol";
import type { VideoPromptExpander } from "../promptExpansion/videoPromptExpander";
import {
  parseVideoGenerationRequest,
  videoProviderJobSchema,
  type VideoGenerationRequest,
  type VideoProvider,
} from "./providers/videoProvider";

const vec3Schema = z.tuple([z.number(), z.number(), z.number()]);

const manifestSchema = z.strictObject({
  version: z.literal(2),
  jobId: z.string().regex(/^video-[a-z0-9-]{8,80}$/i),
  createdAt: z.string(),
  updatedAt: z.string(),
  status: videoJobStatusSchema,
  provider: videoProviderIdSchema,
  model: z.string(),
  prompt: z.string(),
  /** Dialect-validated expansion of `prompt`; submission prefers it when present. */
  expandedPrompt: z.string().nullable().default(null),
  negativePrompt: z.string(),
  generation: z.strictObject({
    seed: z.number().int().min(0).max(2_147_483_647),
    generateAudio: z.boolean(),
    enhancePrompt: z.boolean(),
  }),
  requested: z.strictObject({
    width: z.number().int(),
    height: z.number().int(),
    fps: z.number(),
    durationS: z.number(),
    numFrames: z.number().int(),
  }),
  resolved: z.strictObject({
    generationWidth: z.number().int(),
    generationHeight: z.number().int(),
    deliveryWidth: z.number().int(),
    deliveryHeight: z.number().int(),
    fps: z.number(),
    numFrames: z.number().int(),
    timelineSpanSeconds: z.number(),
    encodedDurationSeconds: z.number(),
    deliveryTransformRequired: z.boolean(),
  }),
  scene: z.strictObject({
    name: z.string(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    objectCount: z.number().int().nonnegative(),
    cameraCount: z.number().int().nonnegative(),
    durationS: z.number().nonnegative(),
    aspect: aspectSchema,
    structure: z.array(
      z.strictObject({ id: z.string(), kind: z.string(), name: z.string(), position: vec3Schema, scale: vec3Schema }),
    ),
    cameraPlan: z.array(
      z.strictObject({
        id: z.string(),
        name: z.string(),
        focalLengthMm: z.number(),
        position: vec3Schema,
        target: vec3Schema.nullable(),
        actions: z.array(z.string()),
      }),
    ),
  }),
  referenceImage: z.string().nullable(),
  providerJob: videoProviderJobSchema.nullable(),
  warnings: z.array(z.string()),
  error: z.string().nullable(),
});

/** Durable manifest for a video generation job. */
export type VideoJobManifest = z.infer<typeof manifestSchema>;

/** Configuration for the video generation service. */
export type VideoGenerationServiceOptions = {
  workspaceRoot: string;
  dataDirectory: string;
  defaultProvider: VideoProviderId;
  providers?: Iterable<VideoProvider>;
  capturePreview?: () => Promise<string | null>;
  /** Rewrites prompts into the target model's dialect when enhance_prompt is requested. */
  promptExpander?: Pick<VideoPromptExpander, "expand">;
};

function ltxSafeDimensions(aspect: StageScene["recordAspect"]) {
  if (aspect === "9:16") return { width: 576, height: 1024 };
  if (aspect === "1:1") return { width: 768, height: 768 };
  if (aspect === "4:3") return { width: 1024, height: 768 };
  if (aspect === "1.85:1") return { width: 1216, height: 640 };
  if (aspect === "2.39:1") return { width: 1216, height: 512 };
  return { width: 1024, height: 576 };
}

function legacyDimensions(aspect: StageScene["recordAspect"]) {
  if (aspect === "9:16") return { width: 720, height: 1280 };
  if (aspect === "1:1") return { width: 1024, height: 1024 };
  if (aspect === "4:3") return { width: 1024, height: 768 };
  if (aspect === "1.85:1") return { width: 1280, height: 692 };
  if (aspect === "2.39:1") return { width: 1280, height: 536 };
  return { width: 1280, height: 720 };
}

function decodeImageDataUrl(dataUrl: string) {
  const match = /^data:image\/(png|jpeg|webp);base64,([a-z0-9+/=]+)$/i.exec(dataUrl);
  if (!match) return null;
  return {
    extension: match[1] === "jpeg" ? "jpg" : match[1].toLowerCase(),
    bytes: Buffer.from(match[2], "base64"),
  };
}

function sceneStructure(scene: StageScene) {
  return Object.entries(scene.objects)
    .filter(([, object]) => object.kind !== "target")
    .map(([id, object]) => ({
      id,
      kind: object.kind,
      name: object.name ?? id,
      position: [...object.position] as [number, number, number],
      scale: [...object.scale] as [number, number, number],
    }));
}

function sceneCameraPlan(scene: StageScene) {
  return Object.entries(scene.objects).flatMap(([id, object]) => {
    if (object.kind !== "camera") return [];
    const track = scene.show.tracks.find((candidate) => candidate.characterId === id);
    return [
      {
        id,
        name: object.name ?? id,
        focalLengthMm: object.focalLengthMm,
        position: [...object.position] as [number, number, number],
        target: scene.objects[object.targetId]
          ? ([...scene.objects[object.targetId].position] as [number, number, number])
          : null,
        actions:
          track?.items.map((item) => `${item.kind}@${item.startS.toFixed(2)}s+${item.durationS.toFixed(2)}s`) ?? [],
      },
    ];
  });
}

/**
 * Video generation service for the Director Stage. Wraps multiple video
 * providers (LTX-2.3, ComfyUI, MiniMax H3) behind a unified interface:
 * prepare, submit, status, cancel, and render operations. Each job is
 * tracked by a durable manifest stored under `data/video-jobs/<jobId>/`.
 */
export class VideoGenerationService {
  private readonly providers = new Map<VideoProviderId, VideoProvider>();

  constructor(private readonly options: VideoGenerationServiceOptions) {
    for (const provider of options.providers ?? []) this.providers.set(provider.id, provider);
  }

  /**
   * Executes a video model operation against a Stage scene. Supported ops:
   * capabilities, prepare, render, submit, status, cancel.
   *
   * @param scene - The current Stage scene.
   * @param input - The raw operation input parsed by the agent engine.
   * @returns A tool execution result with the scene and optional result data.
   */
  async execute(scene: StageScene, input: unknown): Promise<ToolExecution> {
    const parsed = parseVideoModelInput(input, scene);
    if (!parsed.success) return { scene, success: false, error: parsed.error };
    try {
      if (parsed.operation.op === "capabilities") {
        return { scene, success: true, result: await this.capabilities() };
      }
      if (parsed.operation.op === "prepare" || parsed.operation.op === "render") {
        const manifest = await this.prepare(scene, parsed.operation);
        if (parsed.operation.op === "render") {
          try {
            await this.submit(manifest);
          } catch {
            // submit persists the exact failure on the durable receipt. Returning that
            // receipt lets an Agent inspect or retry the prepared job deterministically.
          }
        }
        return this.result(scene, manifest);
      }
      const manifest = await this.readManifest(parsed.operation.job_id);
      if (parsed.operation.op === "submit") {
        try {
          await this.submit(manifest);
        } catch {
          // Same recovery contract as render: never lose the durable job identity.
        }
      } else if (parsed.operation.op === "status") await this.refresh(manifest);
      else await this.cancel(manifest);
      return this.result(scene, manifest);
    } catch (error) {
      return { scene, success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Returns the capabilities of all configured and known video providers.
   * Unconfigured providers are reported with `configured: false`.
   */
  async capabilities() {
    const ids: VideoProviderId[] = ["ltx-2.3", "comfyui", "minimax-h3"];
    const providers = await Promise.all(
      ids.map(async (id): Promise<VideoProviderCapability> => {
        const provider = this.providers.get(id);
        if (provider) {
          try {
            return await provider.capabilities();
          } catch {
            // A configured but unreachable worker is represented honestly as unavailable.
          }
        }
        if (id === "ltx-2.3") {
          return {
            id,
            label: "LTX-2.3 DistilledPipeline",
            configured: false,
            supportsImageConditioning: true,
            supportsAudio: true,
            supportsNegativePrompt: false,
            dimensionMultiple: 64,
            frameCountRule: "8k+1",
            model: null,
          };
        }
        if (id === "minimax-h3") {
          return {
            id,
            label: "MiniMax H3",
            configured: false,
            supportsImageConditioning: true,
            supportsAudio: true,
            supportsNegativePrompt: false,
            dimensionMultiple: null,
            frameCountRule: "any",
            model: null,
          };
        }
        return {
          id,
          label: "ComfyUI video workflow",
          configured: false,
          supportsImageConditioning: true,
          supportsAudio: true,
          supportsNegativePrompt: true,
          dimensionMultiple: null,
          frameCountRule: "any",
          model: null,
        };
      }),
    );
    return { defaultProvider: this.options.defaultProvider, providers };
  }

  private async prepare(scene: StageScene, operation: Extract<VideoModelOperation, { op: "prepare" | "render" }>) {
    const provider = operation.provider ?? this.options.defaultProvider;
    const defaults =
      provider === "ltx-2.3" ? ltxSafeDimensions(scene.recordAspect) : legacyDimensions(scene.recordAspect);
    const requestedWidth = operation.width ?? defaults.width;
    const requestedHeight = operation.height ?? defaults.height;
    const fps = operation.fps ?? 24;
    const readiness = validateStageScene(scene);
    const timelineSpanSeconds = operation.duration_s ?? Math.max(0.5, readiness.duration_s || 5);
    const requestedFrames = operation.num_frames ?? Math.max(9, Math.round(timelineSpanSeconds * fps));
    const generationWidth = provider === "ltx-2.3" ? normalizeLtxDimension(requestedWidth) : requestedWidth;
    const generationHeight = provider === "ltx-2.3" ? normalizeLtxDimension(requestedHeight) : requestedHeight;
    const numFrames =
      provider === "ltx-2.3" ? normalizeLtxFrameCount(requestedFrames) : Math.min(1_441, Math.max(9, requestedFrames));
    const sceneDigest = createHash("sha256").update(JSON.stringify(scene)).digest("hex");
    const seed = operation.seed ?? Math.abs(Number.parseInt(sceneDigest.slice(0, 8), 16)) % 2_147_483_648;
    const jobId = `video-${randomUUID()}`;
    const directory = this.jobDirectory(jobId);
    await mkdir(directory, { recursive: true });
    let referenceImage: string | null = null;
    const captured = await this.options.capturePreview?.().catch(() => null);
    const decoded = captured ? decodeImageDataUrl(captured) : null;
    if (decoded) {
      referenceImage = `reference.${decoded.extension}`;
      await writeFile(resolve(directory, referenceImage), decoded.bytes);
    }
    const structure = sceneStructure(scene);
    const cameraPlan = sceneCameraPlan(scene);
    const enhanceRequested = operation.enhance_prompt ?? false;
    let expandedPrompt: string | null = null;
    const expansionWarnings: string[] = [];
    if (enhanceRequested && this.options.promptExpander) {
      try {
        const expansion = await this.options.promptExpander.expand({
          prompt: operation.prompt,
          durationSeconds: timelineSpanSeconds,
          aspect: scene.recordAspect,
          provider,
          hasReferenceImage: referenceImage !== null,
          scene: { structure, cameraPlan },
        });
        expandedPrompt = expansion.expandedPrompt;
        expansionWarnings.push(
          `Prompt was expanded in the ${expansion.dialect} dialect before submission; the original prompt is retained in the manifest.`,
        );
      } catch (error) {
        expansionWarnings.push(
          `Prompt expansion failed (${error instanceof Error ? error.message : String(error)}); the original prompt will be submitted verbatim.`,
        );
      }
    }
    const now = new Date().toISOString();
    const manifest: VideoJobManifest = manifestSchema.parse({
      version: 2,
      jobId,
      createdAt: now,
      updatedAt: now,
      status: "prepared",
      provider,
      model:
        operation.model ??
        (provider === "ltx-2.3" ? "ltx-2.3-22b" : provider === "minimax-h3" ? "MiniMax-H3" : "configured-video-model"),
      prompt: operation.prompt,
      expandedPrompt,
      negativePrompt:
        operation.negative_prompt ?? "flicker, geometry drift, extra limbs, warped architecture, unstable camera",
      generation: {
        seed,
        generateAudio: operation.generate_audio ?? true,
        enhancePrompt: enhanceRequested,
      },
      requested: {
        width: requestedWidth,
        height: requestedHeight,
        fps,
        durationS: timelineSpanSeconds,
        numFrames: requestedFrames,
      },
      resolved: {
        generationWidth,
        generationHeight,
        deliveryWidth: requestedWidth,
        deliveryHeight: requestedHeight,
        fps,
        numFrames,
        timelineSpanSeconds,
        encodedDurationSeconds: numFrames / fps,
        deliveryTransformRequired: generationWidth !== requestedWidth || generationHeight !== requestedHeight,
      },
      scene: {
        name: scene.show.name,
        digest: sceneDigest,
        objectCount: readiness.object_count,
        cameraCount: readiness.camera_count,
        durationS: readiness.duration_s,
        aspect: scene.recordAspect,
        structure,
        cameraPlan,
      },
      referenceImage,
      providerJob: null,
      warnings: [
        ...expansionWarnings,
        ...(generationWidth !== requestedWidth || generationHeight !== requestedHeight
          ? [
              `Generation was aligned to ${generationWidth}x${generationHeight}; delivery framing remains ${requestedWidth}x${requestedHeight}.`,
            ]
          : []),
        ...(numFrames !== requestedFrames
          ? [
              provider === "ltx-2.3"
                ? `Frame count was aligned to ${numFrames} (8k+1).`
                : `Frame count was clamped to the provider contract limit of ${numFrames}.`,
            ]
          : []),
        ...(provider === "ltx-2.3" && operation.negative_prompt
          ? ["LTX-2.3 DistilledPipeline retains negative_prompt as metadata but does not consume it."]
          : []),
      ],
      error: null,
    });
    await Promise.all([writeJsonAtomic(resolve(directory, "scene.json"), scene), this.writeManifest(manifest)]);
    return manifest;
  }

  private provider(manifest: VideoJobManifest) {
    const provider = this.providers.get(manifest.provider);
    if (!provider)
      throw new Error(`${manifest.provider} video provider is not configured; job ${manifest.jobId} remains prepared`);
    return provider;
  }

  private request(manifest: VideoJobManifest): VideoGenerationRequest {
    return parseVideoGenerationRequest({
      idempotencyKey: manifest.jobId,
      prompt: manifest.expandedPrompt ?? manifest.prompt,
      negativePrompt: manifest.negativePrompt,
      model: manifest.model,
      width: manifest.resolved.generationWidth,
      height: manifest.resolved.generationHeight,
      frameRate: manifest.resolved.fps,
      numFrames: manifest.resolved.numFrames,
      seed: manifest.generation.seed,
      generateAudio: manifest.generation.generateAudio,
      // Provider-side enhancement is only forwarded when the gateway did not
      // already expand the prompt; expanding twice would drift from the manifest.
      enhancePrompt: manifest.generation.enhancePrompt && manifest.expandedPrompt === null,
      conditioning: manifest.referenceImage
        ? [
            {
              role: "clean-frame",
              uri: resolve(this.jobDirectory(manifest.jobId), manifest.referenceImage),
              mimeType: manifest.referenceImage.endsWith(".png") ? "image/png" : "image/jpeg",
              frameIndex: 0,
              strength: 1,
              crf: 0,
            },
          ]
        : [],
      metadata: {
        director_scene_digest: manifest.scene.digest,
        timeline_span_seconds: manifest.resolved.timelineSpanSeconds,
        encoded_duration_seconds: manifest.resolved.encodedDurationSeconds,
      },
    });
  }

  private async submit(manifest: VideoJobManifest) {
    try {
      const job = await this.provider(manifest).submit(this.request(manifest));
      manifest.providerJob = job;
      manifest.status = job.status;
      manifest.warnings = [...manifest.warnings, ...job.warnings];
      manifest.error = job.error?.message ?? null;
      await this.writeManifest(manifest);
    } catch (error) {
      manifest.error = error instanceof Error ? error.message : String(error);
      await this.writeManifest(manifest);
      throw error;
    }
  }

  private async refresh(manifest: VideoJobManifest) {
    if (!manifest.providerJob) return manifest;
    const job = await this.provider(manifest).getJob(manifest.providerJob.id);
    manifest.providerJob = job;
    manifest.status = job.status;
    manifest.error = job.error?.message ?? null;
    await this.writeManifest(manifest);
    return manifest;
  }

  private async cancel(manifest: VideoJobManifest) {
    if (!manifest.providerJob) {
      manifest.status = "cancelled";
    } else {
      const job = await this.provider(manifest).cancel(manifest.providerJob.id);
      manifest.providerJob = job;
      manifest.status = job.status;
      manifest.error = job.error?.message ?? null;
    }
    await this.writeManifest(manifest);
    return manifest;
  }

  private result(scene: StageScene, manifest: VideoJobManifest): ToolExecution {
    return {
      scene,
      success: !manifest.error,
      ...(manifest.error ? { error: manifest.error } : {}),
      result: {
        job_id: manifest.jobId,
        provider: manifest.provider,
        provider_job_id: manifest.providerJob?.id ?? null,
        status: manifest.status,
        manifest_path: `data/video-jobs/${manifest.jobId}/manifest.json`,
        expanded_prompt: manifest.expandedPrompt,
        reference_image: manifest.referenceImage,
        outputs: manifest.providerJob?.outputs ?? [],
        warnings: manifest.warnings,
        render: {
          width: manifest.resolved.generationWidth,
          height: manifest.resolved.generationHeight,
          fps: manifest.resolved.fps,
          durationS: manifest.resolved.timelineSpanSeconds,
          numFrames: manifest.resolved.numFrames,
          encodedDurationS: manifest.resolved.encodedDurationSeconds,
          deliveryWidth: manifest.resolved.deliveryWidth,
          deliveryHeight: manifest.resolved.deliveryHeight,
        },
      },
    };
  }

  private jobDirectory(jobId: string) {
    return resolve(this.options.dataDirectory, "video-jobs", jobId);
  }

  private manifestPath(jobId: string) {
    return resolve(this.jobDirectory(jobId), "manifest.json");
  }

  private async readManifest(jobId: string) {
    return manifestSchema.parse(JSON.parse(await readFile(this.manifestPath(jobId), "utf8")));
  }

  private async writeManifest(manifest: VideoJobManifest) {
    manifest.updatedAt = new Date().toISOString();
    const directory = this.jobDirectory(manifest.jobId);
    await mkdir(directory, { recursive: true });
    const destination = this.manifestPath(manifest.jobId);
    await writeJsonAtomic(destination, manifestSchema.parse(manifest));
  }
}
