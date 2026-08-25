import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
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
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
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
});
