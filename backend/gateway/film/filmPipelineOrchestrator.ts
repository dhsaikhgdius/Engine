import { join } from "node:path";
import {
  createFilmRunRequestSchema,
  filmRunSchema,
  type CreateFilmRunRequestInput,
  type FilmRun,
  type FilmRunPhase,
  type FilmSceneState,
  type ShotSpec,
  type StageReference,
} from "../../../packages/protocol/src/filmPipelineProtocol";
import { concatVideos } from "./filmFfmpeg";
import type { FilmPlanningAgents } from "./filmPlanningAgents";
import type { FilmRenderCoordinator, ShotAudioMixHook } from "./filmRenderCoordinator";
import type { FilmRunStore } from "./filmRunStore";

/**
 * Film pipeline orchestrator.
 *
 * The end-to-end film pipeline state machine: story development, character
 * extraction, scene segmentation, per-scene storyboard/shot/camera planning,
 * an optional review gate, then portrait/keyframe/clip rendering and final
 * assembly. Every phase writes durable state, so resume continues from the
 * first incomplete artifact instead of regenerating finished work.
 */

/** Subset of FilmPlanningAgents needed by the orchestrator. */
export type FilmPlanningAgentsLike = Pick<
  FilmPlanningAgents,
  "developStory" | "writeScenes" | "extractCharacters" | "designStoryboard" | "decomposeShot" | "constructCameraPlan"
>;

/** Subset of FilmRenderCoordinator needed by the orchestrator. */
export type FilmRenderCoordinatorLike = Pick<FilmRenderCoordinator, "ensurePortraits" | "renderScene">;

/** Captures white-box anchors from the connected Stage for one scene's shots. */
export type StageAnchorHook = (input: {
  runDirectory: string;
  sceneIdx: number;
  shots: readonly ShotSpec[];
  aspectRatio?: string;
  signal?: AbortSignal;
}) => Promise<StageReference[]>;

/** Writes an OTIO timeline for the completed run and returns its path. */
export type TimelineExportHook = (input: {
  run: FilmRun;
  runDirectory: string;
  signal?: AbortSignal;
}) => Promise<string>;

/** Configuration for the film pipeline orchestrator. */
export type FilmPipelineOrchestratorOptions = {
  store: FilmRunStore;
  planningAgents: FilmPlanningAgentsLike;
  renderCoordinator: FilmRenderCoordinatorLike;
  ffmpegPath: string;
  resolveStageAnchors?: StageAnchorHook;
  mixShotAudio?: ShotAudioMixHook;
  exportTimeline?: TimelineExportHook;
};

function mergeStageReferences(manual: readonly StageReference[], auto: readonly StageReference[]): StageReference[] {
  const merged = [...manual];
  for (const anchor of auto) {
    const overridden = manual.some(
      (reference) => reference.sceneIdx === anchor.sceneIdx && reference.shotIdx === anchor.shotIdx,
    );
    if (!overridden) merged.push(anchor);
  }
  return merged;
}

/**
 * End-to-end film pipeline orchestrator. Manages the full state machine:
 * story development, character extraction, scene segmentation, per-scene
 * storyboard/shot/camera planning, optional review gate, rendering, and final
 * assembly. Every phase writes durable state so resume continues from the
 * first incomplete artifact.
 */
export class FilmPipelineOrchestrator {
  private readonly controllers = new Map<string, AbortController>();
  private readonly executions = new Map<string, Promise<void>>();

  constructor(private readonly options: FilmPipelineOrchestratorOptions) {}

  /**
   * Creates a new film run from the given request, persists it, and starts
   * execution asynchronously.
   *
   * @param request - Validated film run creation input.
   * @returns The newly created (and queued) film run.
   */
  async create(request: CreateFilmRunRequestInput) {
    const parsed = createFilmRunRequestSchema.parse(request);
    const now = new Date().toISOString();
    const run = filmRunSchema.parse({
      version: 1,
      id: `film-${crypto.randomUUID()}`,
      workflow: parsed.workflow,
      status: "queued",
      phase: parsed.workflow === "idea-to-film" && parsed.input.idea ? "develop-story" : "extract-characters",
      input: parsed.input,
      createdAt: now,
      updatedAt: now,
    });
    await this.options.store.create(run);
    this.start(run.id);
    return run;
  }

  /** Returns the latest state of a film run by id, or null when it does not exist. */
  get(id: string) {
    return this.options.store.get(id);
  }

  /** Lists recent film runs, newest first, up to the given limit (default 50). */
  list(limit?: number) {
    return this.options.store.list(limit);
  }

  /**
   * Resumes a paused, failed, or cancelled run from its last durable state.
   * Completed runs and runs awaiting approval are returned unchanged.
   *
   * @param id - The film run id to resume.
   * @returns The run after resumption (or as-is when already terminal).
   * @throws When the run does not exist.
   */
  async resume(id: string) {
    let run = await this.options.store.get(id);
    if (!run) throw new Error(`Film run ${id} 不存在`);
    const activeExecution = this.executions.get(id);
    if (activeExecution) {
      if (["queued", "running"].includes(run.status)) return run;
      await activeExecution.catch(() => undefined);
      run = await this.options.store.get(id);
      if (!run) throw new Error(`Film run ${id} 不存在`);
    }
    if (run.status === "completed") return run;
    if (run.status === "waiting_approval" && !run.approvedAt) return run;
    const queued = await this.options.store.update(id, (current) => ({
      ...current,
      status: "queued",
      error: null,
    }));
    if (!this.controllers.has(id)) this.start(id);
    return (await this.options.store.get(id)) ?? queued;
  }

  /**
   * Approves a run waiting at the review gate and resumes execution.
   *
   * @param id - The film run id to approve.
   * @returns The run after approval and resumption.
   * @throws When the run does not exist.
   */
  async approve(id: string) {
    const run = await this.options.store.get(id);
    if (!run) throw new Error(`Film run ${id} 不存在`);
    if (run.status !== "waiting_approval") return run;
    await this.options.store.update(id, (current) => ({
      ...current,
      approvedAt: new Date().toISOString(),
    }));
    return this.resume(id);
  }

  /**
   * Cancels an in-flight film run. Already-completed runs are returned unchanged.
   *
   * @param id - The film run id to cancel.
   * @returns The run after cancellation.
   */
  async cancel(id: string) {
    const execution = this.executions.get(id);
    this.controllers.get(id)?.abort(new DOMException("Film run cancelled", "AbortError"));
    const cancelled = await this.options.store.update(id, (run) => ({
      ...run,
      status: run.status === "completed" ? run.status : "cancelled",
    }));
    if (execution) await execution.catch(() => undefined);
    return (await this.options.store.get(id)) ?? cancelled;
  }

  private start(id: string) {
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const execution = new Promise<void>((resolveExecution) => {
      setTimeout(() => {
        void this.execute(id, controller.signal).finally(resolveExecution);
      }, 0);
    });
    this.executions.set(id, execution);
    const release = () => {
      if (this.executions.get(id) === execution) this.executions.delete(id);
      if (this.controllers.get(id) === controller) this.controllers.delete(id);
    };
    void execution.then(release, release);
  }

  private async recordEvent(id: string, stage: string, message: string) {
    await this.options.store
      .update(id, (run) => ({
        ...run,
        events: [...run.events, { at: new Date().toISOString(), stage, message }].slice(-200),
      }))
      .catch(() => undefined);
  }

  private async setPhase(id: string, phase: FilmRunPhase) {
    await this.options.store.update(id, (run) => ({ ...run, phase }));
  }

  private async execute(id: string, signal: AbortSignal) {
    try {
      await this.options.store.update(id, (run) => ({ ...run, status: "running", error: null }));
      let run = (await this.options.store.get(id))!;
      const runDirectory = this.options.store.runDirectory(id);
      const input = run.input;

      // 1. Story development (idea-to-film only).
      if (run.workflow === "idea-to-film" && input.idea && run.story === null && !input.sceneScripts) {
        await this.setPhase(id, "develop-story");
        await this.recordEvent(id, "develop-story", "Developing story from idea");
        const story = await this.options.planningAgents.developStory({
          idea: input.idea,
          userRequirement: input.userRequirement,
          signal,
        });
        run = await this.options.store.update(id, (current) => ({ ...current, story }));
        await this.recordEvent(id, "develop-story", "Story developed");
      }

      // 2. Character extraction over the full narrative.
      if (run.characters === null) {
        await this.setPhase(id, "extract-characters");
        await this.recordEvent(id, "extract-characters", "Extracting characters");
        const source = run.story ?? input.script ?? input.sceneScripts?.join("\n\n") ?? input.idea ?? "";
        const characters = await this.options.planningAgents.extractCharacters({ script: source, signal });
        run = await this.options.store.update(id, (current) => ({ ...current, characters }));
        await this.recordEvent(id, "extract-characters", `Extracted ${characters.length} characters`);
      }
      const characters = run.characters!;

      // 3. Scene segmentation.
      if (!run.scenes.length) {
        await this.setPhase(id, "write-scenes");
        let sceneScripts: string[];
        if (input.sceneScripts) {
          sceneScripts = [...input.sceneScripts];
        } else if (run.workflow === "script-to-film" && input.script) {
          sceneScripts = [input.script];
        } else {
          await this.recordEvent(id, "write-scenes", "Splitting story into scene scripts");
          sceneScripts = await this.options.planningAgents.writeScenes({
            story: run.story ?? input.script ?? "",
            userRequirement: input.userRequirement,
            signal,
          });
        }
        run = await this.options.store.update(id, (current) => ({
          ...current,
          scenes: sceneScripts.map((script, idx) => ({
            idx,
            script,
            storyboard: null,
            shotSpecs: null,
            cameraPlan: null,
            stageAnchors: [],
            clipCount: 0,
            videoPath: null,
          })),
        }));
        await this.recordEvent(id, "write-scenes", `Prepared ${sceneScripts.length} scenes`);
      }

      // 4. Per-scene storyboard, shot decomposition and camera plan.
      await this.setPhase(id, "plan-scenes");
      for (const scene of run.scenes) {
        signal.throwIfAborted();
        run = await this.planScene(id, run, scene.idx, signal);
      }

      // 5. Optional review gate before spending render budget.
      if (input.reviewGate && !run.approvedAt) {
        await this.options.store.update(id, (current) => ({
          ...current,
          status: "waiting_approval",
          phase: "await-approval",
        }));
        await this.recordEvent(id, "await-approval", "Planning complete; waiting for approval before rendering");
        return;
      }

      // 6. Rendering: portraits, keyframes, clips.
      await this.setPhase(id, "render");
      await this.recordEvent(id, "render", "Ensuring character portraits");
      const registry = await this.options.renderCoordinator.ensurePortraits({
        runDirectory,
        characters,
        style: input.style,
        characterReferences: input.characterReferences,
        signal,
      });
      run = await this.options.store.update(id, (current) => ({ ...current, portraitsReady: true }));

      for (const scene of run.scenes) {
        signal.throwIfAborted();
        if (scene.videoPath) continue;
        if (!scene.shotSpecs || !scene.cameraPlan) throw new Error(`Scene ${scene.idx} is missing plans`);

        // White-box grounding: resolve per-shot Stage captures once per scene
        // and persist them so a resumed run does not depend on the browser.
        let stageAnchors = scene.stageAnchors;
        if (input.autoStageAnchors && this.options.resolveStageAnchors && !stageAnchors.length) {
          await this.recordEvent(id, "render", `Resolving white-box stage anchors for scene ${scene.idx}`);
          try {
            stageAnchors = await this.options.resolveStageAnchors({
              runDirectory,
              sceneIdx: scene.idx,
              shots: scene.shotSpecs,
              aspectRatio: input.aspectRatio,
              signal,
            });
            if (stageAnchors.length) {
              run = await this.options.store.update(id, (current) => ({
                ...current,
                scenes: current.scenes.map((candidate) =>
                  candidate.idx === scene.idx ? { ...candidate, stageAnchors } : candidate,
                ),
              }));
            }
            await this.recordEvent(id, "render", `Scene ${scene.idx} anchored with ${stageAnchors.length} captures`);
          } catch (error) {
            if (signal.aborted) throw error;
            stageAnchors = [];
            await this.recordEvent(
              id,
              "render",
              `Stage anchor resolution failed for scene ${scene.idx}; rendering without white-box grounding: ${
                error instanceof Error ? error.message.slice(0, 500) : String(error)
              }`,
            );
          }
        }

        await this.recordEvent(id, "render", `Rendering scene ${scene.idx}`);
        const rendered = await this.options.renderCoordinator.renderScene({
          runDirectory,
          sceneIdx: scene.idx,
          shotSpecs: scene.shotSpecs,
          cameraPlan: scene.cameraPlan,
          characters,
          registry,
          stageReferences: mergeStageReferences(input.stageReferences, stageAnchors),
          aspectRatio: input.aspectRatio,
          clipDurationSec: input.clipDurationSec,
          mixShotAudio: input.enableAudio ? this.options.mixShotAudio : undefined,
          signal,
        });
        run = await this.options.store.update(id, (current) => ({
          ...current,
          scenes: current.scenes.map((candidate) =>
            candidate.idx === scene.idx
              ? { ...candidate, videoPath: rendered.videoPath, clipCount: rendered.clipCount }
              : candidate,
          ),
        }));
        await this.recordEvent(id, "render", `Scene ${scene.idx} rendered (${rendered.clipCount} clips)`);
      }

      // 7. Final assembly.
      if (!run.finalVideoPath) {
        await this.setPhase(id, "assemble");
        const finalVideoPath = join(runDirectory, "final_video.mp4");
        const scenePaths = run.scenes
          .sort((left, right) => left.idx - right.idx)
          .map((scene) => scene.videoPath)
          .filter((path): path is string => Boolean(path));
        if (scenePaths.length === 1) {
          run = await this.options.store.update(id, (current) => ({
            ...current,
            finalVideoPath: scenePaths[0],
          }));
        } else {
          await concatVideos(this.options.ffmpegPath, scenePaths, finalVideoPath, signal);
          run = await this.options.store.update(id, (current) => ({ ...current, finalVideoPath }));
        }
        await this.recordEvent(id, "assemble", "Final film assembled");
      }

      // Editorial handoff: an OTIO timeline is auxiliary output, so a failed
      // export logs an event instead of failing the whole run.
      if (!run.timelinePath && this.options.exportTimeline) {
        try {
          const timelinePath = await this.options.exportTimeline({ run, runDirectory, signal });
          run = await this.options.store.update(id, (current) => ({ ...current, timelinePath }));
          await this.recordEvent(id, "assemble", "OTIO timeline exported for the Video Editor");
        } catch (error) {
          if (signal.aborted) throw error;
          await this.recordEvent(
            id,
            "assemble",
            `Timeline export failed: ${error instanceof Error ? error.message.slice(0, 500) : String(error)}`,
          );
        }
      }

      await this.options.store.update(id, (current) => ({
        ...current,
        status: "completed",
        phase: "completed",
      }));
    } catch (error) {
      const cancelled = signal.aborted;
      const message = error instanceof Error ? error.message : String(error);
      await this.options.store
        .update(id, (run) => ({
          ...run,
          status: cancelled ? "cancelled" : "failed",
          error: cancelled ? null : message.slice(0, 4_000),
        }))
        .catch(() => undefined);
      if (!cancelled) await this.recordEvent(id, "error", message.slice(0, 2_000));
    }
  }

  private async planScene(id: string, run: FilmRun, sceneIdx: number, signal: AbortSignal): Promise<FilmRun> {
    const scene = run.scenes.find((candidate) => candidate.idx === sceneIdx);
    if (!scene) throw new Error(`Scene ${sceneIdx} 不存在`);
    const characters = run.characters ?? [];
    let updated: FilmSceneState = scene;

    if (!updated.storyboard) {
      await this.recordEvent(id, "plan-scenes", `Designing storyboard for scene ${sceneIdx}`);
      const storyboard = await this.options.planningAgents.designStoryboard({
        script: updated.script,
        characters,
        userRequirement: run.input.userRequirement,
        maxShots: run.input.maxShotsPerScene,
        signal,
      });
      updated = { ...updated, storyboard };
      run = await this.writeScene(id, updated);
    }

    if (!updated.shotSpecs) {
      await this.recordEvent(
        id,
        "plan-scenes",
        `Decomposing ${updated.storyboard!.length} shots for scene ${sceneIdx}`,
      );
      const shotSpecs = await Promise.all(
        updated.storyboard!.map((brief) => this.options.planningAgents.decomposeShot({ brief, characters, signal })),
      );
      updated = { ...updated, shotSpecs };
      run = await this.writeScene(id, updated);
    }

    if (!updated.cameraPlan) {
      await this.recordEvent(id, "plan-scenes", `Constructing camera plan for scene ${sceneIdx}`);
      let cameraPlan = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          cameraPlan = await this.options.planningAgents.constructCameraPlan({
            shotSpecs: updated.shotSpecs!,
            signal,
          });
          break;
        } catch (error) {
          if (attempt === 1 || signal.aborted) throw error;
        }
      }
      updated = { ...updated, cameraPlan };
      run = await this.writeScene(id, updated);
    }

    return run;
  }

  private writeScene(id: string, scene: FilmSceneState) {
    return this.options.store.update(id, (current) => ({
      ...current,
      scenes: current.scenes.map((candidate) => (candidate.idx === scene.idx ? scene : candidate)),
    }));
  }
}
