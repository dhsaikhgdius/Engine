import type { DirectorControlPlaneConfig } from "../controlPlane/controlPlaneConfig";
import { createModelDriver } from "@director/model-provider/runtime";
import { FilmAudioMixer, OpenAiSpeechProvider } from "./filmAudioPipeline";
import { FilmPlanningAgents } from "./filmPlanningAgents";
import { FilmPipelineOrchestrator, type StageAnchorHook, type TimelineExportHook } from "./filmPipelineOrchestrator";
import { FilmRenderCoordinator, type ShotAudioMixHook } from "./filmRenderCoordinator";
import { FilmRunStore } from "./filmRunStore";
import { HostedImagesApiGenerator, HostedVideosApiGenerator } from "./filmMediaProviders";
import { StageAnchorResolver } from "./filmStageAnchors";
import { createFfprobeClipProbe, exportFilmTimeline } from "./filmTimelineExport";
import { FilmStructuredCaller } from "./structuredCall";

/** Live film pipeline handle: the run store is always readable; the orchestrator only exists when all providers are configured. */
export type FilmPipelineRuntime = {
  /** Durable run store, always available so existing runs stay readable. */
  store: FilmRunStore;
  /** Pipeline orchestrator carrying the full film pipeline state machine; null when required LLM/image/video providers are missing. */
  orchestrator: FilmPipelineOrchestrator | null;
  /** Human-readable reason why the orchestrator was not created (a missing-config diagnostic, not an error). */
  unconfiguredReason?: string;
};

/** Optional integrations the film pipeline can use when the host environment provides them. */
export type FilmPipelineIntegrations = {
  /** Dispatches one director_workbench operation to a connected browser Stage. */
  workbenchExecute?: (input: Record<string, unknown>) => Promise<unknown>;
};

/**
 * Wires the film pipeline from control-plane configuration. The run store is
 * always available so existing runs stay readable; the orchestrator only
 * exists when the planning LLM plus image and video providers are configured.
 */
export function createFilmPipeline(
  config: DirectorControlPlaneConfig,
  dataDirectory: string,
  integrations: FilmPipelineIntegrations = {},
): FilmPipelineRuntime {
  const store = new FilmRunStore(dataDirectory);
  const film = config.film;
  const missing: string[] = [];
  if (!film.llm.baseUrl || !film.llm.model) missing.push("DIRECTOR_FILM_LLM_MODEL/BASE_URL");
  if (film.llm.driver === "anthropic" && !film.llm.apiKey) missing.push("DIRECTOR_FILM_LLM_API_KEY");
  if (!film.image.baseUrl) missing.push("DIRECTOR_FILM_IMAGE_API_KEY/BASE_URL");
  if (!film.video.baseUrl) missing.push("DIRECTOR_FILM_VIDEO_API_KEY/BASE_URL");
  if (missing.length) {
    // No orchestrator will ever execute in this process, so runs left
    // queued/running by a previous process are interrupted by definition.
    void store.reconcileInterrupted().catch((error: unknown) => {
      console.warn("Film run startup reconciliation failed", error);
    });
    return {
      store,
      orchestrator: null,
      unconfiguredReason: `Film pipeline 未配置：缺少 ${missing.join("、")}`,
    };
  }

  const driver = createModelDriver({
    kind: film.llm.driver === "anthropic" ? "anthropic-messages" : "openai-chat-compatible",
    id: "film-llm",
    baseUrl: film.llm.baseUrl!,
    apiKey: film.llm.apiKey ?? "",
  });
  const planningAgents = new FilmPlanningAgents(new FilmStructuredCaller(driver, film.llm.model!));
  const renderCoordinator = new FilmRenderCoordinator({
    planningAgents,
    imageGenerator: new HostedImagesApiGenerator({
      baseUrl: film.image.baseUrl!,
      apiKey: film.image.apiKey,
      model: film.image.model,
    }),
    videoGenerator: new HostedVideosApiGenerator({
      baseUrl: film.video.baseUrl!,
      apiKey: film.video.apiKey,
      model: film.video.model,
      timeoutMs: film.videoTimeoutMs,
      pollIntervalMs: film.videoPollMs,
    }),
    ffmpegPath: film.ffmpegPath,
    imageConcurrency: film.imageConcurrency,
    videoConcurrency: film.videoConcurrency,
  });
  // White-box anchoring needs a connected browser Stage; dialogue TTS needs a
  // configured speech endpoint. Both stay optional so the core pipeline runs
  // with just LLM + image + video providers.
  const workbenchExecute = integrations.workbenchExecute;
  let resolveStageAnchors: StageAnchorHook | undefined;
  if (workbenchExecute) {
    const stageAnchorResolver = new StageAnchorResolver();
    resolveStageAnchors = (request) =>
      stageAnchorResolver.resolveSceneAnchors({ ...request, execute: workbenchExecute });
  }

  let mixShotAudio: ShotAudioMixHook | undefined;
  if (film.tts.baseUrl) {
    const audioMixer = new FilmAudioMixer({
      speechGenerator: new OpenAiSpeechProvider({
        baseUrl: film.tts.baseUrl,
        apiKey: film.tts.apiKey,
        model: film.tts.model,
      }),
      ffmpegPath: film.ffmpegPath,
    });
    mixShotAudio = (request) => audioMixer.mixShotAudio(request);
  }

  const probe = createFfprobeClipProbe(film.ffprobePath);
  const exportTimeline: TimelineExportHook = (input) => exportFilmTimeline({ ...input, probe });

  const orchestrator = new FilmPipelineOrchestrator({
    store,
    planningAgents,
    renderCoordinator,
    ffmpegPath: film.ffmpegPath,
    resolveStageAnchors,
    mixShotAudio,
    exportTimeline,
  });
  return { store, orchestrator };
}
