// End-to-end scene generation test — verifies the full pipeline from
// natural language prompt → structured layout → validated → assembled → workbench ops.

import { describe, it, expect } from "vitest";
import type { ModelProvider, ChatResult } from "@director/model-provider";
import { runScenePipeline, summarizePipelineOutput } from "../src/pipeline";
import { assembleScene, summarizePlan } from "../src/assembler";
import { validateScene } from "../src/validator";
import { applySceneToStage, summarizeWorkbenchOperations } from "../src/stageIntegration";
import type { SceneLayout } from "../src/types";

// Realistic LLM response for "建一个温馨的客厅"
const LIVING_ROOM_RESPONSE: SceneLayout = {
  version: 1,
  name: "温馨客厅",
  description: "一个现代风格的温馨客厅",
  room: { width: 6, depth: 5, height: 3 },
  objects: [
    {
      id: "floor",
      label: "木地板",
      kind: "floor",
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 6, y: 0.1, z: 5 },
      color: "#d4a574",
    },
    {
      id: "wall-back",
      label: "后墙",
      kind: "wall",
      position: { x: 0, y: 1.5, z: -2.5 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 6, y: 3, z: 0.1 },
      color: "#e8e0d5",
    },
    {
      id: "sofa",
      label: "三人沙发",
      kind: "furniture",
      position: { x: 0, y: 0.5, z: -1.5 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 2.2, y: 0.9, z: 0.9 },
      color: "#5c6b73",
    },
    {
      id: "table",
      label: "茶几",
      kind: "furniture",
      position: { x: 0, y: 0.4, z: -0.3 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1.2, y: 0.4, z: 0.7 },
      color: "#8b7355",
    },
    {
      id: "tv-stand",
      label: "电视柜",
      kind: "furniture",
      position: { x: 0, y: 0.4, z: 2 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 2, y: 0.5, z: 0.4 },
      color: "#3c3c3c",
    },
    {
      id: "floor-lamp",
      label: "落地灯",
      kind: "light",
      position: { x: 2.5, y: 0, z: -1 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 0.3, y: 1.8, z: 0.3 },
      color: "#f5f0e8",
    },
  ],
  cameras: [
    {
      position: { x: 0, y: 1.6, z: 3 },
      target: { x: 0, y: 1, z: 0 },
      focalLengthMm: 35,
      label: "主视角",
    },
  ],
  lights: [
    { type: "ambient", color: "#fff8e7", intensity: 0.3 },
    { type: "directional", color: "#ffffff", intensity: 0.8, direction: { x: 0, y: -1, z: 0.5 } },
  ],
};

function createMockProvider(response: SceneLayout): ModelProvider {
  return {
    id: "mock/test",
    descriptor: {
      provider: "mock",
      model: "test",
      label: "Mock",
      capabilities: { tools: false, images: false, streaming: false, reasoning: false, maxContextTokens: 4096, maxOutputTokens: 1024 },
    },
    label: "Mock",
    async complete() {
      throw new Error("Not implemented");
    },
    async chat(): Promise<ChatResult> {
      return {
        content: JSON.stringify(response),
        finishReason: "stop",
      };
    },
  };
}

describe("End-to-end scene generation pipeline", () => {
  it("generates a living room from natural language", async () => {
    const provider = createMockProvider(LIVING_ROOM_RESPONSE);
    const output = await runScenePipeline(provider, {
      prompt: "建一个温馨的客厅，有沙发、茶几、电视柜和落地灯",
      style: "modern",
    });

    // Layout should be correct
    expect(output.layout.name).toBe("温馨客厅");
    expect(output.layout.description).toBe("一个现代风格的温馨客厅");
    expect(output.layout.room).toEqual({ width: 6, depth: 5, height: 3 });

    // Should have all expected objects
    expect(output.layout.objects.length).toBe(6);
    const ids = output.layout.objects.map((o) => o.id);
    expect(ids).toContain("floor");
    expect(ids).toContain("sofa");
    expect(ids).toContain("table");
    expect(ids).toContain("tv-stand");
    expect(ids).toContain("floor-lamp");

    // Should have a camera
    expect(output.layout.cameras?.length).toBe(1);
    expect(output.layout.cameras?.[0].label).toBe("主视角");

    // Should have lights
    expect(output.layout.lights?.length).toBe(2);
  });

  it("validates the generated layout", async () => {
    const provider = createMockProvider(LIVING_ROOM_RESPONSE);
    const output = await runScenePipeline(provider, {
      prompt: "建一个温馨的客厅",
    });

    // Run validation directly
    const issues = validateScene(output.layout);

    // Should have no errors (warnings are acceptable)
    const errors = issues.filter((i) => i.level === "error");
    expect(errors.length).toBe(0);
  });

  it("assembles the layout into stage operations", async () => {
    const provider = createMockProvider(LIVING_ROOM_RESPONSE);
    const output = await runScenePipeline(provider, {
      prompt: "建一个温馨的客厅",
    });

    const plan = assembleScene(output.layout);

    // Should have operations for all objects, lights, cameras, and room
    expect(plan.operations.length).toBeGreaterThan(6);

    // First operation should be setRoom
    expect(plan.operations[0].op).toBe("setRoom");

    // Should have addObject operations for each object
    const addOps = plan.operations.filter((o) => o.op === "addObject");
    expect(addOps.length).toBe(6);
  });

  it("converts to Director workbench operations", async () => {
    const provider = createMockProvider(LIVING_ROOM_RESPONSE);
    const output = await runScenePipeline(provider, {
      prompt: "建一个温馨的客厅",
    });

    const plan = assembleScene(output.layout);
    const workbenchOps = applySceneToStage(plan);

    // Should have multiple author operations
    expect(workbenchOps.length).toBeGreaterThanOrEqual(3);
    expect(workbenchOps.every((op) => op.op === "author")).toBe(true);

    // Should include add_object, add_camera, add_light actions
    const allActions = workbenchOps.flatMap((op) => op.actions);
    const actionTypes = allActions.map((a) => a.action);
    expect(actionTypes).toContain("add_object");
    expect(actionTypes).toContain("add_camera");
    expect(actionTypes).toContain("add_light");
  });

  it("produces a Markdown summary", async () => {
    const provider = createMockProvider(LIVING_ROOM_RESPONSE);
    const output = await runScenePipeline(provider, {
      prompt: "建一个温馨的客厅",
      summary: true,
    });

    const summary = summarizePipelineOutput(output);
    expect(summary).toContain("# 温馨客厅");
    expect(summary).toContain("沙发");
    expect(summary).toContain("茶几");
    expect(summary).toContain("性能");
  });

  it("handles invalid LLM JSON response", async () => {
    const provider: ModelProvider = {
      id: "mock/bad",
      descriptor: {
        provider: "mock",
        model: "bad",
        label: "Bad Mock",
        capabilities: { tools: false, images: false, streaming: false, reasoning: false, maxContextTokens: 4096, maxOutputTokens: 1024 },
      },
      label: "Bad Mock",
      async complete() { throw new Error("Not implemented"); },
      async chat() { return { content: "This is not JSON at all", finishReason: "stop" }; },
    };

    await expect(
      runScenePipeline(provider, { prompt: "test" }),
    ).rejects.toThrow();
  });

  it("handles partially valid JSON in markdown code blocks", async () => {
    const provider: ModelProvider = {
      id: "mock/md",
      descriptor: {
        provider: "mock",
        model: "md",
        label: "Markdown Mock",
        capabilities: { tools: false, images: false, streaming: false, reasoning: false, maxContextTokens: 4096, maxOutputTokens: 1024 },
      },
      label: "Markdown Mock",
      async complete() { throw new Error("Not implemented"); },
      async chat() {
        return {
          content: `Here is the scene:\n\`\`\`json\n${JSON.stringify(LIVING_ROOM_RESPONSE)}\n\`\`\``,
          finishReason: "stop",
        };
      },
    };

    const output = await runScenePipeline(provider, { prompt: "test" });
    expect(output.layout.name).toBe("温馨客厅");
  });

  it("detects overlapping objects as warnings", async () => {
    const overlappingLayout: SceneLayout = {
      ...LIVING_ROOM_RESPONSE,
      objects: [
        { id: "a", label: "Box A", kind: "furniture", position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 2, y: 1, z: 2 } },
        { id: "b", label: "Box B", kind: "furniture", position: { x: 0.5, y: 0, z: 0.5 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 2, y: 1, z: 2 } },
      ],
      cameras: [],
      lights: [],
    };

    const provider = createMockProvider(overlappingLayout);
    const output = await runScenePipeline(provider, { prompt: "test" });

    expect(output.warnings).toBeDefined();
    expect(output.warnings?.some((w) => w.message.includes("重叠"))).toBe(true);
  });

  it("detects missing cameras as warning", async () => {
    const noCamLayout: SceneLayout = {
      ...LIVING_ROOM_RESPONSE,
      cameras: [],
    };

    const provider = createMockProvider(noCamLayout);
    const output = await runScenePipeline(provider, { prompt: "test" });

    expect(output.warnings?.some((w) => w.message.includes("摄像机"))).toBe(true);
  });

  it("provides timing information", async () => {
    const provider = createMockProvider(LIVING_ROOM_RESPONSE);
    const output = await runScenePipeline(provider, { prompt: "test" });

    expect(output.timing.totalMs).toBeGreaterThanOrEqual(0);
    expect(output.timing.planningMs).toBeGreaterThanOrEqual(0);
    expect(output.timing.assemblyMs).toBeGreaterThanOrEqual(0);
    expect(output.timing.validationMs).toBeGreaterThanOrEqual(0);
  });

  it("full pipeline: prompt → layout → validate → assemble → workbench ops", async () => {
    const provider = createMockProvider(LIVING_ROOM_RESPONSE);

    // 1. Generate
    const output = await runScenePipeline(provider, {
      prompt: "建一个温馨的客厅，有沙发、茶几、电视柜和落地灯",
      style: "modern",
    });

    // 2. Validate
    const issues = validateScene(output.layout);
    const errors = issues.filter((i) => i.level === "error");
    expect(errors.length).toBe(0);

    // 3. Assemble
    const plan = assembleScene(output.layout);
    expect(plan.operations.length).toBeGreaterThan(0);

    // 4. Convert to workbench operations
    const workbenchOps = applySceneToStage(plan);
    expect(workbenchOps.length).toBeGreaterThan(0);

    // 5. Summarize
    const summary = summarizePipelineOutput(output);
    expect(summary).toContain("温馨客厅");

    const planSummary = summarizePlan(plan);
    expect(planSummary).toContain("设置房间");

    const wbSummary = summarizeWorkbenchOperations(workbenchOps);
    expect(wbSummary).toContain("创建物体");
    expect(wbSummary).toContain("创建摄像机");
    expect(wbSummary).toContain("创建灯光");
  });
});