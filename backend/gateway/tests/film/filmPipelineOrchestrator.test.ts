import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  filmRunSchema,
  groupShotsIntoCameras,
  shotBriefSchema,
  shotSpecSchema,
  type FilmRun,
  type ShotBrief,
} from "../../../../packages/protocol/src/filmPipelineProtocol";
import {
  FilmPipelineOrchestrator,
  type FilmPlanningAgentsLike,
  type FilmRenderCoordinatorLike,
} from "../../film/filmPipelineOrchestrator";
import { FilmRunStore } from "../../film/filmRunStore";

vi.mock("../../film/filmFfmpeg", () => ({
  concatVideos: vi.fn(async (_ffmpeg: string, inputs: readonly string[], output: string) => {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `concat:${inputs.length}`);
    return output;
  }),
  extractFrameAfterFirstCut: vi.fn(),
  extractLastFrame: vi.fn(),
  runFfmpeg: vi.fn(),
}));

function fakePlanningAgents(overrides: Partial<FilmPlanningAgentsLike> = {}): FilmPlanningAgentsLike & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    async developStory() {
      calls.push("developStory");
      return "一段完整的故事";
    },
    async writeScenes() {
      calls.push("writeScenes");
      return ["场景一的剧本", "场景二的剧本"];
    },
    async extractCharacters() {
      calls.push("extractCharacters");
      return [{ idx: 0, name: "Alice", isVisible: true, staticFeatures: "短发", dynamicFeatures: null }];
    },
    async designStoryboard() {
      calls.push("designStoryboard");
      return [shotBriefSchema.parse({ idx: 0, camIdx: 0, visualDesc: "远景", audioDesc: "" })] as ShotBrief[];
    },
    async decomposeShot(input) {
      calls.push("decomposeShot");
      return shotSpecSchema.parse({
        idx: input.brief.idx,
        camIdx: input.brief.camIdx,
        visualDesc: input.brief.visualDesc,
        variationType: "small",
        ffDesc: "首帧",
        motionDesc: "推近",
      });
    },
    async constructCameraPlan(input) {
      calls.push("constructCameraPlan");
      return groupShotsIntoCameras(input.shotSpecs);
    },
    ...overrides,
  };
}

function fakeRenderCoordinator(): FilmRenderCoordinatorLike & { renders: number[] } {
  const renders: number[] = [];
  return {
    renders,
    async ensurePortraits() {
      return {};
    },
    async renderScene(request) {
      renders.push(request.sceneIdx);
      const path = join(request.runDirectory, `scene_${request.sceneIdx}`, "scene_video.mp4");
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "scene");
      return { videoPath: path, clipCount: request.shotSpecs.length };
    },
  };
}

async function waitForStatus(store: FilmRunStore, id: string, statuses: readonly string[]): Promise<FilmRun> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const run = await store.get(id);
    if (run && statuses.includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${id} to reach ${statuses.join("/")}`);
}

describe("FilmPipelineOrchestrator", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 })));
    tempDirs.length = 0;
  });

  async function harness(agents = fakePlanningAgents(), coordinator = fakeRenderCoordinator()) {
    const dir = await mkdtemp(join(tmpdir(), "director-film-orchestrator-"));
    tempDirs.push(dir);
    const store = new FilmRunStore(dir);
    const orchestrator = new FilmPipelineOrchestrator({
      store,
      planningAgents: agents,
      renderCoordinator: coordinator,
      ffmpegPath: "ffmpeg",
    });
    return { store, orchestrator, agents, coordinator };
  }

  it("runs idea-to-film end to end and assembles the final video", async () => {
    const { store, orchestrator, agents, coordinator } = await harness();
    const created = await orchestrator.create({
      workflow: "idea-to-film",
      input: { idea: "猫和狗成为朋友", userRequirement: "两个场景" },
    });
    const run = await waitForStatus(store, created.id, ["completed", "failed"]);
    expect(run.status).toBe("completed");
    expect(run.story).toBe("一段完整的故事");
    expect(run.scenes).toHaveLength(2);
    expect(run.scenes.every((scene) => scene.videoPath)).toBe(true);
    expect(run.finalVideoPath).toContain("final_video.mp4");
    expect(coordinator.renders).toEqual([0, 1]);
    expect(agents.calls.filter((call) => call === "designStoryboard")).toHaveLength(2);
  });

  it("treats a script-to-film script as a single scene and reuses its video as the final cut", async () => {
    const { store, orchestrator, agents } = await harness();
    const created = await orchestrator.create({
      workflow: "script-to-film",
      input: { script: "INT. 客栈 - 夜" },
    });
    const run = await waitForStatus(store, created.id, ["completed", "failed"]);
    expect(run.status).toBe("completed");
    expect(run.story).toBeNull();
    expect(run.scenes).toHaveLength(1);
    expect(run.finalVideoPath).toBe(run.scenes[0].videoPath);
    expect(agents.calls).not.toContain("developStory");
    expect(agents.calls).not.toContain("writeScenes");
  });

  it("pauses at the review gate and resumes rendering after approval", async () => {
    const { store, orchestrator, coordinator } = await harness();
    const created = await orchestrator.create({
      workflow: "script-to-film",
      input: { script: "INT. 剧场 - 日", reviewGate: true },
    });
    const waiting = await waitForStatus(store, created.id, ["waiting_approval", "failed"]);
    expect(waiting.status).toBe("waiting_approval");
    expect(waiting.phase).toBe("await-approval");
    expect(waiting.scenes[0].shotSpecs).not.toBeNull();
    expect(coordinator.renders).toHaveLength(0);

    // resume without approval keeps the gate closed
    expect((await orchestrator.resume(created.id)).status).toBe("waiting_approval");

    await orchestrator.approve(created.id);
    const completed = await waitForStatus(store, created.id, ["completed", "failed"]);
    expect(completed.status).toBe("completed");
    expect(coordinator.renders).toEqual([0]);
  });

  it("stamps the typed timeline export receipt next to timelinePath", async () => {
    const dir = await mkdtemp(join(tmpdir(), "director-film-orchestrator-"));
    tempDirs.push(dir);
    const store = new FilmRunStore(dir);
    const orchestrator = new FilmPipelineOrchestrator({
      store,
      planningAgents: fakePlanningAgents(),
      renderCoordinator: fakeRenderCoordinator(),
      ffmpegPath: "ffmpeg",
      exportTimeline: async ({ runDirectory }) => {
        const outputPath = join(runDirectory, "timeline.otio");
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, "{}");
        return {
          outputPath,
          receipt: {
            shotCount: 2,
            clipCount: 1,
            omittedShotCount: 1,
            omittedShots: [
              { sceneIdx: 0, shotIdx: 1, code: "clip_missing" as const, reason: "clip bytes were missing" },
            ],
          },
        };
      },
    });
    const created = await orchestrator.create({
      workflow: "script-to-film",
      input: { script: "INT. 剪辑室 - 夜" },
    });
    const run = await waitForStatus(store, created.id, ["completed", "failed"]);
    expect(run.status).toBe("completed");
    expect(run.timelinePath).toContain("timeline.otio");
    // The partial handoff is a durable typed fact, not a silent skip.
    expect(run.timelineExport).toEqual({
      shotCount: 2,
      clipCount: 1,
      omittedShotCount: 1,
      omittedShots: [{ sceneIdx: 0, shotIdx: 1, code: "clip_missing", reason: "clip bytes were missing" }],
    });
    expect(
      run.events.some(
        (event) =>
          event.message === "OTIO timeline exported with 1 of 2 planned shots omitted (missing rendered clips)",
      ),
    ).toBe(true);
  });

  it("stamps a typed dialogue-audio omission when enableAudio has no TTS hook", async () => {
    const { store, orchestrator } = await harness();
    // enableAudio defaults to true; the harness wires no mixShotAudio hook.
    const created = await orchestrator.create({
      workflow: "script-to-film",
      input: { script: "INT. 录音棚 - 日" },
    });
    const run = await waitForStatus(store, created.id, ["completed", "failed"]);
    expect(run.status).toBe("completed");
    expect(run.capabilityOmissions).toEqual([
      {
        capability: "dialogue_audio",
        code: "tts_unconfigured",
        sceneIdx: null,
        reason: "enableAudio was requested but no TTS provider is configured; clips render without dialogue dubbing",
        at: expect.any(String) as string,
      },
    ]);
    expect(run.events.some((event) => event.message.includes("no TTS provider is configured"))).toBe(true);
  });

  it("stamps no omission when the run opts out of audio or the TTS hook exists", async () => {
    const optedOut = await harness();
    const withoutAudio = await optedOut.orchestrator.create({
      workflow: "script-to-film",
      input: { script: "INT. 默片影院 - 夜", enableAudio: false },
    });
    const silent = await waitForStatus(optedOut.store, withoutAudio.id, ["completed", "failed"]);
    expect(silent.capabilityOmissions).toEqual([]);

    const dir = await mkdtemp(join(tmpdir(), "director-film-orchestrator-"));
    tempDirs.push(dir);
    const store = new FilmRunStore(dir);
    const orchestrator = new FilmPipelineOrchestrator({
      store,
      planningAgents: fakePlanningAgents(),
      renderCoordinator: fakeRenderCoordinator(),
      ffmpegPath: "ffmpeg",
      mixShotAudio: async ({ shotDirectory }) => join(shotDirectory, "video.mp4"),
    });
    const created = await orchestrator.create({
      workflow: "script-to-film",
      input: { script: "INT. 配音棚 - 日" },
    });
    const run = await waitForStatus(store, created.id, ["completed", "failed"]);
    expect(run.status).toBe("completed");
    expect(run.capabilityOmissions).toEqual([]);
  });

  it("stamps a typed stage-anchor omission when autoStageAnchors has no workbench hook", async () => {
    const { store, orchestrator } = await harness();
    const created = await orchestrator.create({
      workflow: "script-to-film",
      input: { script: "INT. 摄影棚 - 日", enableAudio: false, autoStageAnchors: true },
    });
    const run = await waitForStatus(store, created.id, ["completed", "failed"]);
    expect(run.status).toBe("completed");
    expect(run.capabilityOmissions).toEqual([
      {
        capability: "stage_anchors",
        code: "anchor_hook_unavailable",
        sceneIdx: null,
        reason:
          "autoStageAnchors was requested but the gateway has no workbench execution channel; scenes render without white-box grounding",
        at: expect.any(String) as string,
      },
    ]);
  });

  it("stamps a per-scene omission when stage anchor resolution fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "director-film-orchestrator-"));
    tempDirs.push(dir);
    const store = new FilmRunStore(dir);
    const orchestrator = new FilmPipelineOrchestrator({
      store,
      planningAgents: fakePlanningAgents(),
      renderCoordinator: fakeRenderCoordinator(),
      ffmpegPath: "ffmpeg",
      resolveStageAnchors: async () => {
        throw new Error("no connected workbench tab");
      },
    });
    const created = await orchestrator.create({
      workflow: "script-to-film",
      input: { script: "INT. 舞台 - 夜", enableAudio: false, autoStageAnchors: true },
    });
    const run = await waitForStatus(store, created.id, ["completed", "failed"]);
    expect(run.status).toBe("completed");
    expect(run.capabilityOmissions).toEqual([
      {
        capability: "stage_anchors",
        code: "anchor_resolution_failed",
        sceneIdx: 0,
        reason: expect.stringContaining("no connected workbench tab") as string,
        at: expect.any(String) as string,
      },
    ]);
  });

  it("keeps capability omissions idempotent across resume", async () => {
    let failures = 1;
    const coordinator = fakeRenderCoordinator();
    const failingCoordinator: typeof coordinator = {
      ...coordinator,
      async renderScene(request) {
        if (failures > 0) {
          failures -= 1;
          throw new Error("render provider unavailable");
        }
        return coordinator.renderScene(request);
      },
    };
    const { store, orchestrator } = await harness(fakePlanningAgents(), failingCoordinator);
    const created = await orchestrator.create({
      workflow: "script-to-film",
      input: { script: "INT. 机房 - 夜" },
    });
    const failed = await waitForStatus(store, created.id, ["failed"]);
    expect(failed.capabilityOmissions).toHaveLength(1);
    const stampedAt = failed.capabilityOmissions[0].at;

    await orchestrator.resume(created.id);
    const completed = await waitForStatus(store, created.id, ["completed", "failed"]);
    expect(completed.status).toBe("completed");
    // The resumed render re-enters the same decision; the first record wins.
    expect(completed.capabilityOmissions).toHaveLength(1);
    expect(completed.capabilityOmissions[0].at).toBe(stampedAt);
  });

  it("marks failures with the error and resume retries only unfinished work", async () => {
    let failures = 1;
    const agents = fakePlanningAgents({
      async designStoryboard() {
        if (failures > 0) {
          failures -= 1;
          throw new Error("storyboard provider unavailable");
        }
        return [shotBriefSchema.parse({ idx: 0, camIdx: 0, visualDesc: "远景", audioDesc: "" })];
      },
    });
    const { store, orchestrator } = await harness(agents);
    const created = await orchestrator.create({
      workflow: "script-to-film",
      input: { script: "EXT. 沙漠 - 日" },
    });
    const failed = await waitForStatus(store, created.id, ["failed"]);
    expect(failed.error).toContain("storyboard provider unavailable");
    expect(failed.characters).not.toBeNull();

    await orchestrator.resume(created.id);
    const completed = await waitForStatus(store, created.id, ["completed", "failed"]);
    expect(completed.status).toBe("completed");
    // Characters were reused from the durable document; extraction ran once.
    expect(agents.calls.filter((call) => call === "extractCharacters")).toHaveLength(1);
  });

  it("cancels a queued run", async () => {
    const blocked = new Promise<never>(() => undefined);
    const agents = fakePlanningAgents({
      developStory: () => blocked,
    });
    const { store, orchestrator } = await harness(agents);
    const created = await orchestrator.create({
      workflow: "idea-to-film",
      input: { idea: "一个永远讲不完的故事" },
    });
    await waitForStatus(store, created.id, ["running"]);
    const cancelPromise = orchestrator.cancel(created.id);
    const cancelled = await waitForStatus(store, created.id, ["cancelled"]);
    expect(cancelled.status).toBe("cancelled");
    await Promise.race([cancelPromise, new Promise((resolve) => setTimeout(resolve, 200))]);
  });

  it("never resurrects a run cancelled before its execution ticks", async () => {
    const { store, orchestrator, agents } = await harness();
    const created = await orchestrator.create({
      workflow: "idea-to-film",
      input: { idea: "开拍前就取消的片子" },
    });
    // Cancel lands before the scheduled execute() runs its first write.
    await orchestrator.cancel(created.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const run = await store.get(created.id);
    expect(run?.status).toBe("cancelled");
    expect(agents.calls).not.toContain("developStory");
  });

  it("runs the render exactly once when approve is called concurrently", async () => {
    const { store, orchestrator, coordinator } = await harness();
    const created = await orchestrator.create({
      workflow: "script-to-film",
      input: { script: "INT. 剧场 - 日", reviewGate: true },
    });
    await waitForStatus(store, created.id, ["waiting_approval"]);
    await Promise.all([orchestrator.approve(created.id), orchestrator.approve(created.id)]);
    const completed = await waitForStatus(store, created.id, ["completed", "failed"]);
    expect(completed.status).toBe("completed");
    expect(coordinator.renders).toEqual([0]);
  });

  it("does not let approve resurrect a run cancelled at the review gate", async () => {
    const { store, orchestrator, coordinator } = await harness();
    const created = await orchestrator.create({
      workflow: "script-to-film",
      input: { script: "INT. 仓库 - 夜", reviewGate: true },
    });
    await waitForStatus(store, created.id, ["waiting_approval"]);
    await orchestrator.cancel(created.id);
    const afterApprove = await orchestrator.approve(created.id);
    expect(afterApprove.status).toBe("cancelled");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await store.get(created.id))?.status).toBe("cancelled");
    expect(coordinator.renders).toHaveLength(0);
  });

  it("does not start a second execution when resume races a running run", async () => {
    let releaseStory!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      releaseStory = resolveGate;
    });
    const agents = fakePlanningAgents({
      async developStory() {
        agents.calls.push("developStory");
        await gate;
        return "一段完整的故事";
      },
    });
    const { store, orchestrator } = await harness(agents);
    const created = await orchestrator.create({ workflow: "idea-to-film", input: { idea: "同时 resume 的片子" } });
    await waitForStatus(store, created.id, ["running"]);
    const resumed = await orchestrator.resume(created.id);
    expect(["queued", "running"]).toContain(resumed.status);
    releaseStory();
    await waitForStatus(store, created.id, ["completed", "failed"]);
    expect(agents.calls.filter((call) => call === "developStory")).toHaveLength(1);
  });

  it("records durable phase receipts across the run including the review gate", async () => {
    const { store, orchestrator } = await harness();
    const created = await orchestrator.create({
      workflow: "script-to-film",
      input: { script: "INT. 灯塔 - 夜", reviewGate: true },
    });
    const waiting = await waitForStatus(store, created.id, ["waiting_approval"]);
    const open = waiting.phaseReceipts.filter((receipt) => receipt.finishedAt === null);
    expect(open).toHaveLength(1);
    expect(open[0]?.phase).toBe("await-approval");

    await orchestrator.approve(created.id);
    const completed = await waitForStatus(store, created.id, ["completed", "failed"]);
    expect(completed.status).toBe("completed");
    const phases = completed.phaseReceipts.map((receipt) => receipt.phase);
    expect(phases).toContain("plan-scenes");
    expect(phases).toContain("await-approval");
    expect(phases).toContain("render");
    expect(phases).toContain("assemble");
    // A terminal run holds no open receipt.
    expect(completed.phaseReceipts.every((receipt) => receipt.finishedAt !== null)).toBe(true);
  });

  it("classifies provider transport failures with the stable error code", async () => {
    const providerError = new Error("videos-api HTTP 502");
    providerError.name = "ModelDriverHttpError";
    let failures = 1;
    const agents = fakePlanningAgents({
      async developStory() {
        if (failures > 0) {
          failures -= 1;
          throw providerError;
        }
        return "一段完整的故事";
      },
    });
    const { store, orchestrator } = await harness(agents);
    const created = await orchestrator.create({ workflow: "idea-to-film", input: { idea: "供应商掉线的片子" } });
    const failed = await waitForStatus(store, created.id, ["failed"]);
    expect(failed.errorCode).toBe("film_provider_error");
    expect(failed.phaseReceipts.every((receipt) => receipt.finishedAt !== null)).toBe(true);

    await orchestrator.resume(created.id);
    const completed = await waitForStatus(store, created.id, ["completed"]);
    // Resume clears the stale classification along with the error text.
    expect(completed.error).toBeNull();
    expect(completed.errorCode).toBeNull();
  });

  it("reconciles restart survivors before executing anything new", async () => {
    const dir = await mkdtemp(join(tmpdir(), "director-film-orchestrator-"));
    tempDirs.push(dir);
    const store = new FilmRunStore(dir);
    const now = new Date().toISOString();
    await store.create(
      filmRunSchema.parse({
        version: 1,
        id: "film-restarted-0001",
        workflow: "idea-to-film",
        status: "running",
        phase: "render",
        input: { idea: "上个进程留下的片子" },
        createdAt: now,
        updatedAt: now,
      }),
    );
    const orchestrator = new FilmPipelineOrchestrator({
      store,
      planningAgents: fakePlanningAgents(),
      renderCoordinator: fakeRenderCoordinator(),
      ffmpegPath: "ffmpeg",
    });
    // Any public entry point awaits reconciliation first.
    const listed = await orchestrator.resume("film-restarted-0001");
    expect(["queued", "running", "completed"]).toContain(listed.status);
    const survivor = await waitForStatus(store, "film-restarted-0001", ["completed", "failed"]);
    // The interrupted state was durably recorded, then resume continued.
    expect(survivor.events.some((event) => event.stage === "reconcile")).toBe(true);
  });

  it("provider failures without the transport marker classify as film_run_error", async () => {
    const agents = fakePlanningAgents({
      async extractCharacters() {
        throw new Error("planning schema mismatch");
      },
    });
    const { store, orchestrator } = await harness(agents);
    const created = await orchestrator.create({ workflow: "script-to-film", input: { script: "EXT. 海边 - 日" } });
    const failed = await waitForStatus(store, created.id, ["failed"]);
    expect(failed.errorCode).toBe("film_run_error");
  });
});
