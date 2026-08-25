import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { DirectorControlPlaneConfig } from "../controlPlane/controlPlaneConfig";
import { createVideoPromptExpander } from "../promptExpansion/createPromptExpanders";
import { ComfyUiVideoProvider } from "./providers/comfyUiVideoProvider";
import { Ltx23SpawnProvider } from "./providers/ltx23SpawnProvider";
import { MinimaxH3Provider } from "./providers/minimaxH3Provider";
import type { VideoGenerationRequest, VideoProvider } from "./providers/videoProvider";
import { VideoGenerationService } from "./videoGenerationService";

/**
 * Recursively replaces template tokens in a ComfyUI workflow value.
 *
 * @param value - The workflow node or subtree to process.
 * @param tokens - Map of token strings to their replacement values.
 * @returns The workflow with all tokens replaced.
 */
function replaceWorkflowTokens(value: unknown, tokens: Record<string, string | number>): unknown {
  if (Array.isArray(value)) return value.map((entry) => replaceWorkflowTokens(entry, tokens));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replaceWorkflowTokens(entry, tokens)]));
  }
  if (typeof value !== "string") return value;
  if (value in tokens) return tokens[value];
  return Object.entries(tokens).reduce(
    (text, [token, replacement]) => text.replaceAll(token, String(replacement)),
    value,
  );
}

/**
 * Resolves a workflow file path relative to the workspace root, rejecting
 * paths that escape the workspace boundary.
 *
 * @param workspaceRoot - The workspace root directory.
 * @param configured - The configured path, possibly relative.
 * @returns An absolute path within the workspace.
 * @throws When the resolved path is outside the workspace.
 */
function workflowPath(workspaceRoot: string, configured: string) {
  const path = resolve(workspaceRoot, configured);
  const scoped = relative(workspaceRoot, path);
  if (scoped.startsWith("..") || isAbsolute(scoped)) {
    throw new Error("COMFYUI_VIDEO_WORKFLOW_PATH must stay inside the Director workspace");
  }
  return path;
}

/**
 * Creates a factory function that reads a ComfyUI workflow template from disk
 * and replaces its tokens with values from the video generation request.
 *
 * Uploads reference images to the ComfyUI server and injects the resulting
 * filename into the workflow.
 *
 * @param baseUrl - The ComfyUI server base URL.
 * @param path - Absolute path to the workflow JSON template file.
 * @returns An async workflow factory suitable for {@link ComfyUiVideoProviderOptions.workflowFactory}.
 */
function comfyWorkflowFactory(baseUrl: string, path: string) {
  return async (request: VideoGenerationRequest) => {
    const reference = request.conditioning.find((entry) => entry.role === "clean-frame" || entry.role === "reference");
    let uploadedImage = "";
    if (reference) {
      const bytes = await readFile(reference.uri);
      const form = new FormData();
      const fileName = `${request.idempotencyKey}.${reference.mimeType === "image/jpeg" ? "jpg" : "png"}`;
      form.append("image", new Blob([bytes], { type: reference.mimeType ?? "image/png" }), fileName);
      form.append("type", "input");
      form.append("overwrite", "true");
      const response = await fetch(`${baseUrl}/upload/image`, { method: "POST", body: form });
      const body = (await response.json().catch(() => ({}))) as { name?: unknown; subfolder?: unknown };
      if (!response.ok || typeof body.name !== "string") {
        throw new Error(`ComfyUI reference upload failed (HTTP ${response.status})`);
      }
      uploadedImage = `${typeof body.subfolder === "string" && body.subfolder ? `${body.subfolder}/` : ""}${body.name}`;
    }
    const template: unknown = JSON.parse(await readFile(path, "utf8"));
    return replaceWorkflowTokens(template, {
      "{{PROMPT}}": request.prompt,
      "{{NEGATIVE_PROMPT}}": request.negativePrompt ?? "",
      "{{REFERENCE_IMAGE}}": uploadedImage,
      "{{WIDTH}}": request.width,
      "{{HEIGHT}}": request.height,
      "{{FPS}}": request.frameRate,
      "{{NUM_FRAMES}}": request.numFrames,
      "{{DURATION_SECONDS}}": request.numFrames / request.frameRate,
      "{{SEED}}": request.seed,
      "{{SCENE_STRUCTURE_JSON}}": String(request.metadata.scene_structure_json ?? "[]"),
      "{{CAMERA_PLAN_JSON}}": String(request.metadata.camera_plan_json ?? "[]"),
    });
  };
}

/**
 * Creates a fully configured video generation service from the control plane
 * configuration.
 *
 * Instantiates every provider whose configuration is present (LTX-2.3 spawn,
 * ComfyUI, Minimax H3) and wires them together with prompt expansion and
 * a Stage capture preview callback.
 *
 * @param config - The Director control plane configuration.
 * @param dataDirectory - The data directory for job persistence.
 * @param capturePreview - Callback that captures a snapshot of the current Stage viewport.
 * @returns A configured {@link VideoGenerationService}.
 */
export function createVideoGenerationService(
  config: DirectorControlPlaneConfig,
  dataDirectory: string,
  capturePreview: () => Promise<string | null>,
) {
  const providers: VideoProvider[] = [];
  if (
    config.video.ltx23.sourceRoot &&
    config.video.ltx23.distilledCheckpointPath &&
    config.video.ltx23.spatialUpsamplerPath &&
    config.video.ltx23.gemmaRoot
  ) {
    providers.push(
      new Ltx23SpawnProvider({
        sourceRoot: config.video.ltx23.sourceRoot,
        distilledCheckpointPath: config.video.ltx23.distilledCheckpointPath,
        spatialUpsamplerPath: config.video.ltx23.spatialUpsamplerPath,
        gemmaRoot: config.video.ltx23.gemmaRoot,
        generateScript: config.video.ltx23.generateScript,
        dataDirectory,
        uvBinary: config.video.ltx23.uvBinary,
        model: config.video.ltx23.model,
        timeoutMs: config.video.ltx23.timeoutMs,
        device: config.video.ltx23.device,
        quantization: config.video.ltx23.quantization,
        offload: config.video.ltx23.offload,
        repository: config.video.ltx23.repository,
        commit: config.video.ltx23.commit,
        pipelineVersion: config.video.ltx23.pipelineVersion,
      }),
    );
  }
  if (config.video.comfyui.baseUrl && config.video.comfyui.workflowPath) {
    providers.push(
      new ComfyUiVideoProvider({
        baseUrl: config.video.comfyui.baseUrl,
        workflowFactory: comfyWorkflowFactory(
          config.video.comfyui.baseUrl,
          workflowPath(config.workspaceRoot, config.video.comfyui.workflowPath),
        ),
      }),
    );
  }
  if (config.video.minimax.apiKey) {
    providers.push(
      new MinimaxH3Provider({
        apiKey: config.video.minimax.apiKey,
        baseUrl: config.video.minimax.baseUrl,
        model: config.video.minimax.model,
      }),
    );
  }
  return new VideoGenerationService({
    workspaceRoot: config.workspaceRoot,
    dataDirectory,
    defaultProvider: config.video.defaultProvider,
    providers,
    capturePreview,
    promptExpander: createVideoPromptExpander(config),
  });
}
