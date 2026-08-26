import type { DirectorControlPlaneConfig } from "../controlPlane/controlPlaneConfig";
import { createModelDriver } from "@director/model-provider/runtime";
import type { AgentUsageMeter } from "../../../packages/protocol/src/agentObservabilityProtocol";
import type { FilmPipelineCapabilities } from "../../../packages/protocol/src/filmPipelineProtocol";
import { FilmAudioMixer, OpenAiSpeechProvider } from "./filmAudioPipeline";
import { FilmPlanningAgents } from "./filmPlanningAgents";
import { FilmPipelineOrchestrator, type StageAnchorHook, type TimelineExportHook } from "./filmPipelineOrchestrator";
import { FilmRenderCoordinator, type ShotAudioMixHook } from "./filmRenderCoordinator";
import { FilmRunStore } from "./filmRunStore";
import { createFilmRunAttributingMeter } from "./filmRunUsageMeter";
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
  /** Optional-capability readiness (dialogue TTS, stage anchoring) reported on the pipeline surface. */
  capabilities: FilmPipelineCapabilities;
};

/** Optional integrations the film pipeline can use when the host environment provides them. */
export type FilmPipelineIntegrations = {
  /** Dispatches one director_workbench operation to a connected browser Stage. */
  workbenchExecute?: (input: Record<string, unknown>) => Promise<unknown>;
  /**
   * Records film planning LLM completions (`film-llm`), render-phase hosted
   * image/video HTTP calls (`film-image` / `film-video`), and dialogue speech
   * synthesis calls (`film-tts`) into the shared agent usage meter. Tokens
   * stay 0 for image/video/speech; duration includes poll or retry wait.
   */
  usageMeter?: AgentUsageMeter;
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
  // Optional capabilities are reported explicitly instead of silently
  // degrading runs that request them: their absence never blocks the core
  // pipeline, but agents must see it before spending render budget.
  const capabilities: FilmPipelineCapabilities = {
    dialogueAudio: film.tts.baseUrl
      ? { configured: true, reason: null }
      : { configured: false, reason: "对白 TTS 未配置：缺少 DIRECTOR_FILM_TTS_API_KEY/BASE_URL" },
    stageAnchors: integrations.workbenchExecute
      ? { configured: true, reason: null }
      : { configured: false, reason: "Stage 锚点捕捉不可用：Gateway 未接入 director_workbench 执行通道" },
  };
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
      capabilities,
    };
  }

  const driver = createModelDriver({
    kind: film.llm.driver === "anthropic" ? "anthropic-messages" : "openai-chat-compatible",
    id: "film-llm",
    baseUrl: film.llm.baseUrl!,
    apiKey: film.llm.apiKey ?? "",
  });
  // Attribute film-llm / film-image / film-video / film-tts samples both to
  // the shared Trace meter and to the active run's durable usage rollup (via ALS).
  const usageMeter = createFilmRunAttributingMeter(store, integrations.usageMeter);
  const planningAgents = new FilmPlanningAgents(
    new FilmStructuredCaller(driver, film.llm.model!, undefined, {
      meter: usageMeter,
      provider: film.llm.driver === "anthropic" ? "anthropic" : "openai-compatible",
    }),
  );
  const renderCoordinator = new FilmRenderCoordinator({
    planningAgents,
    imageGenerator: new HostedImagesApiGenerator({
      baseUrl: film.image.baseUrl!,
      apiKey: film.image.apiKey,
      model: film.image.model,
      meter: usageMeter,
    }),
    videoGenerator: new HostedVideosApiGenerator({
      baseUrl: film.video.baseUrl!,
      apiKey: film.video.apiKey,
      model: film.video.model,
      timeoutMs: film.videoTimeoutMs,
      pollIntervalMs: film.videoPollMs,
      meter: usageMeter,
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
        meter: usageMeter,
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
  return { store, orchestrator, capabilities };
}
