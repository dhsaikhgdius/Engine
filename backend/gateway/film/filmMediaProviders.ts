import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { z } from "zod";
import { fetchModelJson, ModelDriverHttpError } from "@director/model-provider/runtime";
import type { AgentUsageMeter } from "../../../packages/protocol/src/agentObservabilityProtocol";

/**
 * Hosted image and video generation for the film pipeline.
 *
 * Speaks OpenRouter-style Images/Videos APIs (GPT Image / nano-banana class
 * image editing with reference images, and Veo / Seedance class first/last-frame
 * conditioned video generation). Both providers are pure HTTP clients: bytes
 * in, bytes out, no local model state.
 */

/** Parameters for a single image generation request. */
export type FilmImageRequest = {
  /** Natural-language prompt describing the desired image. */
  prompt: string;
  /** Optional reference images for image-to-image editing. */
  referenceImagePaths?: readonly string[];
  /** Desired aspect ratio (e.g. "16:9"). */
  aspectRatio?: string;
  signal?: AbortSignal;
};

/** Pluggable image generation provider for the film pipeline. */
export interface FilmImageGenerator {
  /** Stable provider identifier. */
  readonly id: string;
  /** Generates one image and returns the raw bytes (PNG/JPEG). */
  generateImage(request: FilmImageRequest): Promise<Buffer>;
}

/** Parameters for a single video generation request. */
export type FilmVideoRequest = {
  /** Natural-language prompt describing the desired motion. */
  prompt: string;
  /** One or two frame images: first frame, optionally followed by the last frame. */
  frameImagePaths: readonly string[];
  /** Clip duration in seconds (provider default when omitted). */
  durationSec?: number;
  /** Desired aspect ratio (e.g. "16:9"). */
  aspectRatio?: string;
  signal?: AbortSignal;
};

/** Pluggable video generation provider for the film pipeline. */
export interface FilmVideoGenerator {
  /** Stable provider identifier. */
  readonly id: string;
  /** Generates one video clip and returns the raw bytes (MP4). */
  generateVideoClip(request: FilmVideoRequest): Promise<Buffer>;
}

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

async function imageDataUrl(imagePath: string) {
  const mediaType = IMAGE_MEDIA_TYPES[extname(imagePath).toLowerCase()] ?? "image/png";
  const bytes = await readFile(imagePath);
  return `data:${mediaType};base64,${bytes.toString("base64")}`;
}

function decodeBase64Payload(encoded: string) {
  const stripped = encoded.startsWith("data:") ? encoded.slice(encoded.indexOf(",") + 1) : encoded;
  return Buffer.from(stripped, "base64");
}

/** Shared configuration for hosted image and video API providers. */
export type HostedMediaProviderConfig = {
  baseUrl: string;
  apiKey?: string;
  model: string;
  fetchImpl?: typeof fetch;
  /** Total budget for one video job including polling. */
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** Optional shared agent usage meter (image → `film-image`, video → `film-video`). */
  meter?: AgentUsageMeter;
};

function meterMediaCall(
  meter: AgentUsageMeter | undefined,
  input: {
    scope: "film-image" | "film-video";
    providerId: string;
    model: string;
    startedAtMs: number;
    retries: number;
    succeeded: boolean;
  },
): void {
  meter?.({
    scope: input.scope,
    provider: input.providerId,
    model: input.model,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    duration_ms: Math.max(0, Date.now() - input.startedAtMs),
    retries: Math.max(0, input.retries),
    succeeded: input.succeeded,
  });
}

const imagesResponseSchema = z.looseObject({
  data: z.array(z.looseObject({ b64_json: z.string().optional(), url: z.string().optional() })).min(1),
});

/**
 * OpenRouter-style /images API client. Generates images from text prompts
 * with optional reference images for image-to-image editing.
 */
export class HostedImagesApiGenerator implements FilmImageGenerator {
  readonly id: string;
  private readonly config: HostedMediaProviderConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(config: HostedMediaProviderConfig) {
    this.config = { ...config, baseUrl: config.baseUrl.replace(/\/+$/, "") };
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.id = `images-api:${config.model}`;
  }

  async generateImage(request: FilmImageRequest): Promise<Buffer> {
    const references = request.referenceImagePaths ?? [];
    if (references.length > 16) throw new Error("image generation supports at most 16 reference images");
    const aspectRatio = request.aspectRatio ?? "16:9";
    const payload: Record<string, unknown> = {
      model: this.config.model,
      prompt: `${request.prompt}\n\nComposition requirement: create an image with an approximate ${aspectRatio} aspect ratio.`,
      n: 1,
    };
    if (references.length) {
      payload.input_references = await Promise.all(
        references.map(async (path) => ({ type: "image_url", image_url: { url: await imageDataUrl(path) } })),
      );
    }
    const startedAtMs = Date.now();
    try {
      const body = await fetchModelJson({
        fetch: this.fetchImpl,
        url: `${this.config.baseUrl}/images`,
        init: {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
          },
          body: JSON.stringify(payload),
        },
        signal: request.signal,
        providerId: this.id,
        secrets: [this.config.apiKey],
        maxRetries: 2,
      });
      const parsed = imagesResponseSchema.parse(body);
      const item = parsed.data[0];
      let bytes: Buffer;
      if (item.b64_json) bytes = decodeBase64Payload(item.b64_json);
      else if (item.url?.startsWith("data:")) bytes = decodeBase64Payload(item.url);
      else if (item.url) {
        const response = await this.fetchImpl(item.url, { signal: request.signal });
        if (!response.ok) throw new Error(`${this.id} image download failed (HTTP ${response.status})`);
        bytes = Buffer.from(await response.arrayBuffer());
      } else {
        throw new Error(`${this.id} response missing image data`);
      }
      meterMediaCall(this.config.meter, {
        scope: "film-image",
        providerId: this.id,
        model: this.config.model,
        startedAtMs,
        retries: 0,
        succeeded: true,
      });
      return bytes;
    } catch (error) {
      meterMediaCall(this.config.meter, {
        scope: "film-image",
        providerId: this.id,
        model: this.config.model,
        startedAtMs,
        retries: 0,
        succeeded: false,
      });
      throw error;
    }
  }
}

const videoCreateResponseSchema = z.looseObject({
  id: z.string().min(1),
  polling_url: z.string().min(1).optional(),
  status: z.string().optional(),
});

const videoPollResponseSchema = z.looseObject({
  status: z.string(),
  unsigned_urls: z.array(z.string()).optional(),
  error: z.unknown().optional(),
});

function wait(milliseconds: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  return new Promise<void>((resolveWait, reject) => {
    const timer = setTimeout(resolveWait, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

/**
 * OpenRouter-style /videos API client. Creates a video generation job,
 * polls until completion, and downloads the result. Supports first-frame and
 * first/last-frame conditioning.
 */
export class HostedVideosApiGenerator implements FilmVideoGenerator {
  readonly id: string;
  private readonly config: HostedMediaProviderConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(config: HostedMediaProviderConfig) {
    this.config = { ...config, baseUrl: config.baseUrl.replace(/\/+$/, "") };
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.id = `videos-api:${config.model}`;
  }

  private headers() {
    return {
      "content-type": "application/json",
      ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
    };
  }

  async generateVideoClip(request: FilmVideoRequest): Promise<Buffer> {
    if (!request.frameImagePaths.length || request.frameImagePaths.length > 2) {
      throw new Error("video generation requires a first frame and optionally a last frame");
    }
    const frameTypes = ["first_frame", "last_frame"] as const;
    const frameImages = await Promise.all(
      request.frameImagePaths.map(async (path, index) => ({
        type: "image_url",
        image_url: { url: await imageDataUrl(path) },
        frame_type: frameTypes[index],
      })),
    );
    const startedAtMs = Date.now();
    let pollRounds = 0;
    try {
      const created = videoCreateResponseSchema.parse(
        await fetchModelJson({
          fetch: this.fetchImpl,
          url: `${this.config.baseUrl}/videos`,
          init: {
            method: "POST",
            headers: this.headers(),
            body: JSON.stringify({
              model: this.config.model,
              prompt: request.prompt,
              aspect_ratio: request.aspectRatio ?? "16:9",
              duration: request.durationSec ?? 8,
              frame_images: frameImages,
            }),
          },
          signal: request.signal,
          providerId: this.id,
          secrets: [this.config.apiKey],
          maxRetries: 2,
        }),
      );

      const pollUrl = created.polling_url
        ? new URL(created.polling_url, `${this.config.baseUrl}/`).toString()
        : `${this.config.baseUrl}/videos/${created.id}`;
      const pollIntervalMs = this.config.pollIntervalMs ?? 10_000;
      const deadline = Date.now() + (this.config.timeoutMs ?? 20 * 60_000);
      for (;;) {
        if (Date.now() > deadline) {
          throw new ModelDriverHttpError(this.id, 0, false, `${this.id} video job ${created.id} timed out`);
        }
        await wait(pollIntervalMs, request.signal);
        pollRounds += 1;
        const polled = videoPollResponseSchema.parse(
          await fetchModelJson({
            fetch: this.fetchImpl,
            url: pollUrl,
            init: { method: "GET", headers: this.headers() },
            signal: request.signal,
            providerId: this.id,
            secrets: [this.config.apiKey],
            maxRetries: 2,
          }),
        );
        if (polled.status === "completed") {
          const contentUrl = polled.unsigned_urls?.[0] ?? `${this.config.baseUrl}/videos/${created.id}/content?index=0`;
          const sameHost = contentUrl.startsWith(this.config.baseUrl);
          const response = await this.fetchImpl(contentUrl, {
            signal: request.signal,
            headers: sameHost ? this.headers() : undefined,
          });
          if (!response.ok) throw new Error(`${this.id} video download failed (HTTP ${response.status})`);
          const bytes = Buffer.from(await response.arrayBuffer());
          meterMediaCall(this.config.meter, {
            scope: "film-video",
            providerId: this.id,
            model: this.config.model,
            startedAtMs,
            // Poll rounds after create count as transport retries for wall-clock metering.
            retries: Math.max(0, pollRounds - 1),
            succeeded: true,
          });
          return bytes;
        }
        if (polled.status === "failed" || polled.status === "cancelled" || polled.status === "expired") {
          const detail = polled.error === undefined ? "" : `: ${JSON.stringify(polled.error).slice(0, 500)}`;
          throw new Error(`${this.id} video job ${created.id} ${polled.status}${detail}`);
        }
      }
    } catch (error) {
      meterMediaCall(this.config.meter, {
        scope: "film-video",
        providerId: this.id,
        model: this.config.model,
        startedAtMs,
        retries: Math.max(0, pollRounds - 1),
        succeeded: false,
      });
      throw error;
    }
  }
}
