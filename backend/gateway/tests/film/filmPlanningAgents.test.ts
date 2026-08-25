import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelCompletionRequest, ModelDriver } from "@director/model-provider/runtime";
import { shotSpecSchema, type ShotSpec } from "../../../../packages/protocol/src/filmPipelineProtocol";
import { FilmPlanningAgents } from "../../film/filmPlanningAgents";
import { FilmStructuredCaller } from "../../film/structuredCall";

function scriptedDriver(replies: string[]): ModelDriver & { requests: ModelCompletionRequest[] } {
  const requests: ModelCompletionRequest[] = [];
  return {
    id: "scripted",
    kind: "openai-chat-compatible",
    requests,
    async complete(request) {
      requests.push(request);
      const reply = replies.shift();
      if (reply === undefined) throw new Error("scripted driver exhausted");
      return {
        id: null,
        model: null,
        message: { role: "assistant", content: [{ type: "text", text: reply }] },
        finishReason: "stop",
        rawFinishReason: null,
        usage: null,
      };
    },
  };
}

function agentsWith(replies: string[]) {
  const driver = scriptedDriver(replies);
  return { agents: new FilmPlanningAgents(new FilmStructuredCaller(driver, "test-model")), driver };
}

function spec(idx: number, camIdx: number, visualDesc = `shot ${idx}`): ShotSpec {
  return shotSpecSchema.parse({
    idx,
    camIdx,
    visualDesc,
    variationType: "small",
    ffDesc: `ff ${idx}`,
    motionDesc: `motion ${idx}`,
  });
}

describe("FilmPlanningAgents", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it("extracts characters and renumbers idx sequentially", async () => {
    const { agents } = agentsWith([
      JSON.stringify({
        characters: [
          { idx: 3, name: "老渔夫", isVisible: true, staticFeatures: "花白胡须", dynamicFeatures: "蓑衣" },
          { idx: 9, name: "旁白", isVisible: false, staticFeatures: "" },
        ],
      }),
    ]);
    const characters = await agents.extractCharacters({ script: "剧本" });
    expect(characters.map((character) => character.idx)).toEqual([0, 1]);
    expect(characters[0].name).toBe("老渔夫");
    expect(characters[1].isVisible).toBe(false);
  });

  it("designs a storyboard with normalized shot indices", async () => {
    const { agents } = agentsWith([
      JSON.stringify({
        shots: [
          { idx: 5, camIdx: 0, visualDesc: "远景建立环境", audioDesc: "风声" },
          { idx: 6, camIdx: 1, visualDesc: "<老渔夫> 的特写", audioDesc: "" },
        ],
      }),
    ]);
    const storyboard = await agents.designStoryboard({
      script: "剧本",
      characters: [],
      userRequirement: "",
      maxShots: 10,
    });
    expect(storyboard.map((shot) => shot.idx)).toEqual([0, 1]);
    expect(storyboard[1].camIdx).toBe(1);
  });

  it("decomposes a shot, bounds character indices and falls back lfDesc to ffDesc", async () => {
    const { agents } = agentsWith([
      JSON.stringify({
        ffDesc: "静态首帧",
        ffVisCharIdxs: [0, 7],
        lfDesc: "",
        lfVisCharIdxs: [0],
        motionDesc: "镜头缓慢推近",
        variationType: "small",
        variationReason: "只有表情变化",
      }),
    ]);
    const decomposed = await agents.decomposeShot({
      brief: { idx: 2, camIdx: 1, visualDesc: "特写", audioDesc: "" },
      characters: [{ idx: 0, name: "A", isVisible: true, staticFeatures: "", dynamicFeatures: null }],
    });
    expect(decomposed.ffVisCharIdxs).toEqual([0]);
    expect(decomposed.lfDesc).toBe("静态首帧");
    expect(decomposed.idx).toBe(2);
  });

  it("short-circuits the camera plan when only one camera exists", async () => {
    const { agents, driver } = agentsWith([]);
    const plan = await agents.constructCameraPlan({ shotSpecs: [spec(0, 0), spec(1, 0)] });
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ idx: 0, activeShotIdxs: [0, 1], parentCamIdx: null });
    expect(driver.requests).toHaveLength(0);
  });

  it("builds and validates a multi-camera plan from the model response", async () => {
    const { agents } = agentsWith([
      JSON.stringify({
        cameraParentItems: [
          null,
          {
            parentCamIdx: 0,
            parentShotIdx: 0,
            reason: "宽景包含特写",
            isParentFullyCoversChild: false,
            missingInfo: "角色的正面",
          },
        ],
      }),
    ]);
    const plan = await agents.constructCameraPlan({ shotSpecs: [spec(0, 0), spec(1, 1)] });
    expect(plan[1]).toMatchObject({ parentCamIdx: 0, parentShotIdx: 0, missingInfo: "角色的正面" });
  });

  it("rejects camera plans with mismatched length after retries", async () => {
    const mismatched = JSON.stringify({ cameraParentItems: [null] });
    const { agents } = agentsWith([mismatched, mismatched, mismatched]);
    await expect(agents.constructCameraPlan({ shotSpecs: [spec(0, 0), spec(1, 1)] })).rejects.toThrow(
      /length mismatch/,
    );
  });

  it("selects references with a single multimodal pass for small libraries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "director-film-agents-"));
    tempDirs.push(dir);
    const imagePath = join(dir, "front.png");
    await writeFile(imagePath, Buffer.from("89504e470d0a1a0a", "hex"));
    const { agents, driver } = agentsWith([
      JSON.stringify({ refImageIndices: [0], textPrompt: "Create the frame. The man references Image 0." }),
    ]);
    const selection = await agents.selectReferences({
      candidates: [{ imagePath, description: "A front view portrait." }],
      frameDescription: "中景",
    });
    expect(selection.references).toHaveLength(1);
    expect(selection.textPrompt).toContain("Image 0");
    expect(driver.requests).toHaveLength(1);
    const content = driver.requests[0].messages[1].content;
    expect(content.some((item) => item.type === "image")).toBe(true);
  });

  it("rejects out-of-range reference indices", async () => {
    const dir = await mkdtemp(join(tmpdir(), "director-film-agents-"));
    tempDirs.push(dir);
    const imagePath = join(dir, "front.png");
    await writeFile(imagePath, Buffer.from("89504e470d0a1a0a", "hex"));
    const bad = JSON.stringify({ refImageIndices: [4], textPrompt: "bad" });
    const { agents } = agentsWith([bad, bad, bad]);
    await expect(
      agents.selectReferences({
        candidates: [{ imagePath, description: "portrait" }],
        frameDescription: "frame",
      }),
    ).rejects.toThrow(/out of range/);
  });
});
