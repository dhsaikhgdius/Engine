import { z } from "zod";
import {
  generated3dProviderCapabilitySchema,
  type Generated3DJobInput,
  type Generated3DProviderCapability,
  type Generated3DProviderId,
} from "../../../packages/protocol/src/generated3dProtocol";
import type { DirectorControlPlaneConfig } from "../controlPlane/controlPlaneConfig";
import { InfinigenGenerated3DProvider } from "./infinigenGenerated3dProvider";

export type Generated3DProviderSource = {
  bytes: Buffer;
  mimeType: "image/jpeg" | "image/png";
};

export type Generated3DProviderSnapshot = {
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  progress: number;
  externalId: string;
  modelUrl?: string;
  thumbnailUrl?: string;
  error?: string;
};

export interface Generated3DProvider {
  readonly id: Generated3DProviderId;
  readonly capability: Generated3DProviderCapability;
  /** Local providers emit file:// artifact URLs that the executor reads from disk instead of fetching. */
  readonly localArtifacts?: boolean;
  submit(input: Generated3DJobInput, source: Generated3DProviderSource | null, signal: AbortSignal): Promise<string>;
  inspect(externalId: string, input: Generated3DJobInput, signal: AbortSignal): Promise<Generated3DProviderSnapshot>;
  cancel(externalId: string, input: Generated3DJobInput, signal: AbortSignal): Promise<boolean>;
}

type ProviderConfig = DirectorControlPlaneConfig["generation"]["generated3d"]["providers"]["meshy" | "tripo"];

const meshyTaskSchema = z.looseObject({
  id: z.string().optional(),
  status: z.string().default("PENDING"),
  progress: z.number().finite().default(0),
  model_urls: z.record(z.string(), z.string()).optional(),
  thumbnail_url: z.string().url().optional(),
  alpha_thumbnail_url: z.string().url().optional(),
  task_error: z.looseObject({ message: z.string().optional() }).optional(),
});

const tripoEnvelopeSchema = z.looseObject({
  code: z.number().int(),
  message: z.string().optional(),
  suggestion: z.string().optional(),
  data: z.unknown().optional(),
});

const tripoTaskSchema = z.looseObject({
  task_id: z.string(),
  status: z.string(),
  progress: z.number().finite().default(0),
  output: z
    .looseObject({
      model: z.string().url().optional(),
      base_model: z.string().url().optional(),
      pbr_model: z.string().url().optional(),
      rendered_image: z.string().url().optional(),
    })
    .default({}),
});

function clampProgress(value: number) {
  return Math.max(0, Math.min(1, value));
}

function externalId(prefix: string, taskId: string) {
  if (!taskId.trim() || taskId.length > 400) throw new Error("3D provider returned an invalid task id");
  return `${prefix}:${taskId}`;
}

function taskIdFromExternal(external: string, prefix: string) {
  const marker = `${prefix}:`;
  if (!external.startsWith(marker) || !external.slice(marker.length)) {
    throw new Error(`3D provider task id does not match ${prefix}`);
  }
  return external.slice(marker.length);
}

async function responseJson(response: Response, label: string) {
  const text = await response.text();
  let value: unknown;
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${label} returned non-JSON HTTP ${response.status}`);
  }
  if (!response.ok) {
    const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const detail = typeof record.message === "string" ? record.message : text.slice(0, 500);
    throw new Error(`${label} returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  return value;
}

function modelType(input: Generated3DJobInput) {
  return input.topology === "lowpoly" ? "lowpoly" : "standard";
}

class MeshyGenerated3DProvider implements Generated3DProvider {
  readonly id = "meshy" as const;
  readonly capability: Generated3DProviderCapability;

  constructor(
    private readonly config: ProviderConfig,
    private readonly fetchImpl: typeof fetch,
  ) {
    this.capability = generated3dProviderCapabilitySchema.parse({
      id: this.id,
      label: config.label,
      configured: Boolean(config.apiKey),
      modes: ["text-to-3d", "image-to-3d"],
      modelVersion: config.modelVersion,
      cancellation: "remote",
      documentationUrl: "https://docs.meshy.ai/en/api",
    });
  }

  private headers() {
    if (!this.config.apiKey) throw new Error("Meshy is not configured; set DIRECTOR_MESHY_API_KEY");
    return { authorization: `Bearer ${this.config.apiKey}`, "content-type": "application/json" };
  }

  private endpoint(input: Generated3DJobInput, taskId?: string) {
    const path = input.mode === "text-to-3d" ? "/openapi/v2/text-to-3d" : "/openapi/v1/image-to-3d";
    return `${this.config.baseUrl}${path}${taskId ? `/${encodeURIComponent(taskId)}` : ""}`;
  }

  async submit(input: Generated3DJobInput, source: Generated3DProviderSource | null, signal: AbortSignal) {
    const body =
      input.mode === "text-to-3d"
        ? {
            mode: "preview",
            prompt: input.prompt,
            model_type: modelType(input),
            ai_model: input.modelVersion ?? this.config.modelVersion,
            should_remesh: input.topology === "quad",
            ...(input.topology === "quad" ? { topology: "quad", target_polycount: input.targetPolygonCount } : {}),
            target_formats: ["glb"],
            alpha_thumbnail: true,
            moderation: true,
          }
        : {
            image_url: `data:${source!.mimeType};base64,${source!.bytes.toString("base64")}`,
            model_type: modelType(input),
            ai_model: input.modelVersion ?? this.config.modelVersion,
            should_texture: input.texture,
            enable_pbr: input.pbr,
            should_remesh: input.topology === "quad",
            ...(input.topology === "quad" ? { topology: "quad", target_polycount: input.targetPolygonCount } : {}),
            target_formats: ["glb"],
            alpha_thumbnail: true,
          };
    const response = await this.fetchImpl(this.endpoint(input), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal,
    });
    const value = (await responseJson(response, "Meshy submission")) as { result?: unknown };
    if (typeof value.result !== "string") throw new Error("Meshy submission did not return a task id");
    return externalId(input.mode === "text-to-3d" ? "meshy:text-preview" : "meshy:image", value.result);
  }

  async inspect(external: string, input: Generated3DJobInput, signal: AbortSignal) {
    const phase = external.startsWith("meshy:text-refine:")
      ? "text-refine"
      : external.startsWith("meshy:text-preview:")
        ? "text-preview"
        : "image";
    const taskId = taskIdFromExternal(external, `meshy:${phase}`);
    const response = await this.fetchImpl(this.endpoint(input, taskId), { headers: this.headers(), signal });
    const task = meshyTaskSchema.parse(await responseJson(response, "Meshy task inspection"));
    const status = task.status.toUpperCase();
    const phaseProgress = clampProgress(task.progress / 100);
    const progress =
      input.mode === "text-to-3d" && input.texture
        ? phase === "text-preview"
          ? phaseProgress * 0.5
          : 0.5 + phaseProgress * 0.5
        : phaseProgress;

    if (status === "SUCCEEDED" && phase === "text-preview" && input.texture) {
      const refineResponse = await this.fetchImpl(this.endpoint(input), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          mode: "refine",
          preview_task_id: taskId,
          enable_pbr: input.pbr,
          ai_model: input.modelVersion ?? this.config.modelVersion,
          target_formats: ["glb"],
          alpha_thumbnail: true,
          remove_lighting: true,
          moderation: true,
        }),
        signal,
      });
      const value = (await responseJson(refineResponse, "Meshy refine submission")) as { result?: unknown };
      if (typeof value.result !== "string") throw new Error("Meshy refine submission did not return a task id");
      return {
        status: "running" as const,
        progress: 0.5,
        externalId: externalId("meshy:text-refine", value.result),
      };
    }
    if (status === "SUCCEEDED") {
      const modelUrl = task.model_urls?.glb;
      const thumbnailUrl = task.alpha_thumbnail_url ?? task.thumbnail_url;
      if (!modelUrl || !thumbnailUrl) throw new Error("Meshy succeeded without both GLB and thumbnail URLs");
      return { status: "succeeded" as const, progress: 1, externalId: external, modelUrl, thumbnailUrl };
    }
    if (status === "FAILED") {
      return {
        status: "failed" as const,
        progress,
        externalId: external,
        error: task.task_error?.message || "Meshy generation failed",
      };
    }
    if (status === "CANCELED" || status === "CANCELLED") {
      return { status: "cancelled" as const, progress, externalId: external };
    }
    return {
      status: status === "PENDING" ? ("queued" as const) : ("running" as const),
      progress,
      externalId: external,
    };
  }

  async cancel(external: string, input: Generated3DJobInput, signal: AbortSignal) {
    const prefix = external.startsWith("meshy:text-refine:")
      ? "meshy:text-refine"
      : external.startsWith("meshy:text-preview:")
        ? "meshy:text-preview"
        : "meshy:image";
    const response = await this.fetchImpl(this.endpoint(input, taskIdFromExternal(external, prefix)), {
      method: "DELETE",
      headers: this.headers(),
      signal,
    });
    if (!response.ok && response.status !== 404) throw new Error(`Meshy cancellation returned HTTP ${response.status}`);
    return response.ok;
  }
}

class TripoGenerated3DProvider implements Generated3DProvider {
  readonly id = "tripo" as const;
  readonly capability: Generated3DProviderCapability;

  constructor(
    private readonly config: ProviderConfig,
    private readonly fetchImpl: typeof fetch,
  ) {
    this.capability = generated3dProviderCapabilitySchema.parse({
      id: this.id,
      label: config.label,
      configured: Boolean(config.apiKey),
      modes: ["text-to-3d", "image-to-3d"],
      modelVersion: config.modelVersion,
      cancellation: "local-only",
      documentationUrl: "https://platform.tripo3d.ai/docs",
    });
  }

  private authorization() {
    if (!this.config.apiKey) throw new Error("Tripo is not configured; set DIRECTOR_TRIPO_API_KEY");
    return `Bearer ${this.config.apiKey}`;
  }

  private async envelope(response: Response, label: string) {
    const parsed = tripoEnvelopeSchema.parse(await responseJson(response, label));
    if (parsed.code !== 0) {
      throw new Error(`${label} failed (${parsed.code}): ${parsed.message ?? parsed.suggestion ?? "unknown error"}`);
    }
    return parsed.data;
  }

  private async upload(source: Generated3DProviderSource, signal: AbortSignal) {
    const form = new FormData();
    const extension = source.mimeType === "image/png" ? "png" : "jpg";
    form.append(
      "file",
      new Blob([new Uint8Array(source.bytes)], { type: source.mimeType }),
      `director-source.${extension}`,
    );
    const response = await this.fetchImpl(`${this.config.baseUrl}/upload/sts`, {
      method: "POST",
      headers: { authorization: this.authorization() },
      body: form,
      signal,
    });
    const data = (await this.envelope(response, "Tripo source upload")) as { image_token?: unknown };
    if (typeof data?.image_token !== "string") throw new Error("Tripo upload did not return an image token");
    return { type: extension === "jpg" ? "jpeg" : extension, file_token: data.image_token };
  }

  async submit(input: Generated3DJobInput, source: Generated3DProviderSource | null, signal: AbortSignal) {
    const file = source ? await this.upload(source, signal) : null;
    const body = {
      type: input.mode === "text-to-3d" ? "text_to_model" : "image_to_model",
      ...(input.mode === "text-to-3d" ? { prompt: input.prompt, negative_prompt: input.negativePrompt } : { file }),
      ...((input.modelVersion ?? this.config.modelVersion)
        ? { model_version: input.modelVersion ?? this.config.modelVersion }
        : {}),
      face_limit: input.targetPolygonCount,
      texture: input.texture,
      pbr: input.pbr,
      quad: input.topology === "quad",
      smart_low_poly: input.topology === "lowpoly",
      image_seed: input.seed,
      render_image: true,
    };
    const response = await this.fetchImpl(`${this.config.baseUrl}/task`, {
      method: "POST",
      headers: { authorization: this.authorization(), "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    const data = (await this.envelope(response, "Tripo submission")) as { task_id?: unknown };
    if (typeof data?.task_id !== "string") throw new Error("Tripo submission did not return a task id");
    return externalId("tripo:task", data.task_id);
  }

  async inspect(external: string, _input: Generated3DJobInput, signal: AbortSignal) {
    const taskId = taskIdFromExternal(external, "tripo:task");
    const response = await this.fetchImpl(`${this.config.baseUrl}/task/${encodeURIComponent(taskId)}`, {
      headers: { authorization: this.authorization() },
      signal,
    });
    const task = tripoTaskSchema.parse(await this.envelope(response, "Tripo task inspection"));
    const progress = clampProgress(task.progress / 100);
    if (task.status === "success") {
      const modelUrl = task.output.pbr_model ?? task.output.model ?? task.output.base_model;
      if (!modelUrl || !task.output.rendered_image) {
        throw new Error("Tripo succeeded without both GLB and rendered thumbnail URLs");
      }
      return {
        status: "succeeded" as const,
        progress: 1,
        externalId: external,
        modelUrl,
        thumbnailUrl: task.output.rendered_image,
      };
    }
    if (["failed", "banned", "expired", "unknown"].includes(task.status)) {
      return {
        status: "failed" as const,
        progress,
        externalId: external,
        error: `Tripo task ended with status ${task.status}`,
      };
    }
    if (task.status === "cancelled") return { status: "cancelled" as const, progress, externalId: external };
    return {
      status: task.status === "queued" ? ("queued" as const) : ("running" as const),
      progress,
      externalId: external,
    };
  }

  async cancel() {
    // Tripo's documented OpenAPI currently has no cancellation endpoint. Director stops polling
    // and records this limitation in capabilities instead of inventing a remote cancellation claim.
    return false;
  }
}

export class Generated3DProviderRegistry {
  readonly defaultProvider: Generated3DProviderId;
  private readonly providers: Map<Generated3DProviderId, Generated3DProvider>;

  constructor(config: DirectorControlPlaneConfig["generation"]["generated3d"], fetchImpl: typeof fetch = fetch) {
    this.defaultProvider = config.defaultProvider;
    const values: Generated3DProvider[] = [
      new MeshyGenerated3DProvider(config.providers.meshy, fetchImpl),
      new TripoGenerated3DProvider(config.providers.tripo, fetchImpl),
      new InfinigenGenerated3DProvider(config.providers.infinigen),
    ];
    this.providers = new Map(values.map((provider) => [provider.id, provider]));
  }

  capabilities() {
    return [...this.providers.values()].map((provider) => provider.capability);
  }

  get(id: Generated3DProviderId) {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`Generated 3D provider ${id} is unavailable`);
    return provider;
  }
}
