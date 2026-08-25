import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cameraPlanNodeSchema,
  shotSpecSchema,
  type FilmCharacter,
  type ShotSpec,
} from "../../../../packages/protocol/src/filmPipelineProtocol";
import type { FilmImageGenerator, FilmVideoGenerator } from "../../film/filmMediaProviders";
import { FilmRenderCoordinator } from "../../film/filmRenderCoordinator";

vi.mock("../../film/filmFfmpeg", () => ({
  concatVideos: vi.fn(async (_ffmpeg: string, inputs: readonly string[], output: string) => {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `concat:${inputs.length}`);
    return output;
  }),
  extractFrameAfterFirstCut: vi.fn(async (_ffmpeg: string, video: string, output: string) => {
    await mkdir(dirname(output), { recursive: true });
    await copyFile(video, output);
    return output;
  }),
  extractLastFrame: vi.fn(),
  runFfmpeg: vi.fn(),
}));

function character(idx: number, name: string): FilmCharacter {
  return { idx, name, isVisible: true, staticFeatures: `features of ${name}`, dynamicFeatures: null };
}

function spec(idx: number, camIdx: number, variation: "small" | "medium" = "small"): ShotSpec {
  return shotSpecSchema.parse({
    idx,
    camIdx,
    visualDesc: `visual ${idx}`,
    variationType: variation,
    ffDesc: `ff ${idx}`,
    ffVisCharIdxs: [0],
    lfDesc: variation === "small" ? "" : `lf ${idx}`,
    lfVisCharIdxs: [0],
    motionDesc: `motion ${idx}`,
    audioDesc: "",
  });
}

function fakeGenerators() {
  const imageCalls: string[] = [];
  const videoCalls: string[] = [];
  const imageGenerator: FilmImageGenerator = {
    id: "fake-image",
    async generateImage(request) {
      imageCalls.push(request.prompt);
      return Buffer.from(`image:${imageCalls.length}`);
    },
  };
  const videoGenerator: FilmVideoGenerator = {
    id: "fake-video",
    async generateVideoClip(request) {
      videoCalls.push(request.prompt);
      return Buffer.from(`video:${request.frameImagePaths.length}`);
    },
  };
  return { imageGenerator, videoGenerator, imageCalls, videoCalls };
}

function fakeSelector() {
  const calls: { frameDescription: string; candidateDescriptions: string[] }[] = [];
  return {
    calls,
    async selectReferences(input: {
      candidates: readonly { imagePath: string; description: string }[];
      frameDescription: string;
    }) {
      calls.push({
        frameDescription: input.frameDescription,
        candidateDescriptions: input.candidates.map((candidate) => candidate.description),
      });
      return {
        references: input.candidates.slice(0, 2).map((candidate) => ({ ...candidate })),
        textPrompt: `generate: ${input.frameDescription}`,
      };
    },
  };
}

describe("FilmRenderCoordinator", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function runDirectory() {
    const dir = await mkdtemp(join(tmpdir(), "director-film-render-"));
    tempDirs.push(dir);
    return dir;
  }

  it("generates front/side/back portraits with checkpointed registry and reference override", async () => {
    const dir = await runDirectory();
    const { imageGenerator, videoGenerator, imageCalls } = fakeGenerators();
    const selector = fakeSelector();
    const coordinator = new FilmRenderCoordinator({
      planningAgents: selector,
      imageGenerator,
      videoGenerator,
      ffmpegPath: "ffmpeg",
    });
    const referencePath = join(dir, "user-face.png");
    await writeFile(referencePath, "user-provided");
    const registry = await coordinator.ensurePortraits({
      runDirectory: dir,
      characters: [character(0, "Alice"), { ...character(1, "旁白"), isVisible: false }],
      style: "Cartoon",
      characterReferences: [{ name: "Alice", view: "front", imagePath: referencePath, note: "" }],
    });
    expect(Object.keys(registry)).toEqual(["Alice"]);
    // Front view came from the user reference, so only side and back were generated.
    expect(imageCalls).toHaveLength(2);
    expect(await readFile(registry.Alice.front.path, "utf8")).toBe("user-provided");

    const again = await coordinator.ensurePortraits({
      runDirectory: dir,
      characters: [character(0, "Alice")],
      style: "Cartoon",
      characterReferences: [],
    });
    expect(imageCalls).toHaveLength(2);
    expect(again.Alice.side.path).toBe(registry.Alice.side.path);
  });

  it("renders a scene end to end: root anchor, camera-tree transition, clips and assembly", async () => {
    const dir = await runDirectory();
    const { imageGenerator, videoGenerator, videoCalls } = fakeGenerators();
    const selector = fakeSelector();
    const coordinator = new FilmRenderCoordinator({
      planningAgents: selector,
      imageGenerator,
      videoGenerator,
      ffmpegPath: "ffmpeg",
    });
    const characters = [character(0, "Alice")];
    const registry = await coordinator.ensurePortraits({
      runDirectory: dir,
      characters,
      style: "Realistic",
      characterReferences: [],
    });
    const shotSpecs = [spec(0, 0), spec(1, 1, "medium"), spec(2, 0)];
    const cameraPlan = [
      cameraPlanNodeSchema.parse({ idx: 0, activeShotIdxs: [0, 2] }),
      cameraPlanNodeSchema.parse({
        idx: 1,
        activeShotIdxs: [1],
        parentCamIdx: 0,
        parentShotIdx: 0,
        missingInfo: "Alice 的正面",
      }),
    ];
    const rendered = await coordinator.renderScene({
      runDirectory: dir,
      sceneIdx: 0,
      shotSpecs,
      cameraPlan,
      characters,
      registry,
      stageReferences: [],
      aspectRatio: "16:9",
      clipDurationSec: 8,
      signal: undefined,
    });
    expect(rendered.clipCount).toBe(3);
    expect(await readFile(rendered.videoPath, "utf8")).toBe("concat:3");
    // Transition video for camera 1 plus three shot clips.
    expect(videoCalls).toHaveLength(4);
    expect(videoCalls.some((prompt) => prompt.includes("cut to"))).toBe(true);
    // Shot 1 is medium variation: its clip conditions on first and last frames.
    expect(await readFile(join(dir, "scene_0", "shots", "1", "video.mp4"), "utf8")).toBe("video:2");
    // The new-camera candidate carries the replacement note for missing info.
    const shot1Selection = selector.calls.find((call) => call.frameDescription === "ff 1");
    expect(shot1Selection?.candidateDescriptions.join("\n")).toContain("Alice 的正面");

    const secondPass = await coordinator.renderScene({
      runDirectory: dir,
      sceneIdx: 0,
      shotSpecs,
      cameraPlan,
      characters,
      registry,
      stageReferences: [],
      aspectRatio: "16:9",
      clipDurationSec: 8,
      signal: undefined,
    });
    expect(secondPass.videoPath).toBe(rendered.videoPath);
    expect(videoCalls).toHaveLength(4);
  });

  it("prefers white-box stage references over camera-tree derivation", async () => {
    const dir = await runDirectory();
    const { imageGenerator, videoGenerator, videoCalls } = fakeGenerators();
    const selector = fakeSelector();
    const coordinator = new FilmRenderCoordinator({
      planningAgents: selector,
      imageGenerator,
      videoGenerator,
      ffmpegPath: "ffmpeg",
    });
    const characters = [character(0, "Alice")];
    const registry = await coordinator.ensurePortraits({
      runDirectory: dir,
      characters,
      style: "Realistic",
      characterReferences: [],
    });
    const stagePath = join(dir, "stage-shot-1.png");
    await writeFile(stagePath, "white-box");
    const shotSpecs = [spec(0, 0), spec(1, 1)];
    const cameraPlan = [
      cameraPlanNodeSchema.parse({ idx: 0, activeShotIdxs: [0] }),
      cameraPlanNodeSchema.parse({
        idx: 1,
        activeShotIdxs: [1],
        parentCamIdx: 0,
        parentShotIdx: 0,
        missingInfo: "正面",
      }),
    ];
    await coordinator.renderScene({
      runDirectory: dir,
      sceneIdx: 0,
      shotSpecs,
      cameraPlan,
      characters,
      registry,
      stageReferences: [{ sceneIdx: 0, shotIdx: 1, imagePath: stagePath, note: "white-box reference" }],
      aspectRatio: "16:9",
      clipDurationSec: null,
      signal: undefined,
    });
    // Only the two shot clips — no transition video was needed.
    expect(videoCalls).toHaveLength(2);
    const shot1Selection = selector.calls.find((call) => call.frameDescription === "ff 1");
    expect(shot1Selection?.candidateDescriptions.join("\n")).toContain("white-box reference");
  });
});
