// @director/scene-pipeline — unit tests

import { describe, it, expect } from "vitest";
import type { SceneLayout, ScenePipelineInput } from "../src/types";
import { assembleScene, summarizePlan, computeBounds } from "../src/assembler";
import { validateScene, validateObject } from "../src/validator";
import { runScenePipeline, summarizePipelineOutput } from "../src/pipeline";
import type { ModelProvider } from "@director/model-provider";

// ---- Test fixtures ----

function makeTestLayout(overrides?: Partial<SceneLayout>): SceneLayout {
  return {
    version: 1,
    name: "测试场景",
    description: "一个简单的测试场景",
    room: { width: 8, depth: 8, height: 3 },
    objects: [
      {
        id: "floor",
        label: "地板",
        kind: "floor",
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 8, y: 0.1, z: 8 },
      },
      {
        id: "sofa",
        label: "沙发",
        kind: "furniture",
        position: { x: 0, y: 0.5, z: -2 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 2, y: 0.8, z: 0.8 },
        color: "#8B4513",
      },
      {
        id: "table",
        label: "茶几",
        kind: "furniture",
        position: { x: 0, y: 0.4, z: -1 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 0.4, z: 0.6 },
      },
    ],
    cameras: [
      {
        position: { x: 0, y: 1.6, z: 4 },
        target: { x: 0, y: 1, z: 0 },
        focalLengthMm: 35,
        label: "主视角",
      },
    ],
    lights: [
      { type: "ambient", color: "#ffffff", intensity: 0.3 },
      { type: "directional", color: "#ffffff", intensity: 0.8, direction: { x: 0, y: -1, z: 0 } },
    ],
    ...overrides,
  };
}

// Mock ModelProvider for testing
function createMockProvider(response: unknown): ModelProvider {
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
    async chat() {
      return {
        content: typeof response === "string" ? response : JSON.stringify(response),
        finishReason: "stop",
      };
    },
  };
}

// ---- Assembler tests ----

describe("assembleScene", () => {
  it("converts layout to ordered operations", () => {
    const layout = makeTestLayout();
    const plan = assembleScene(layout);

    expect(plan.operations.length).toBeGreaterThan(0);

    // First operation should be setRoom
    expect(plan.operations[0].op).toBe("setRoom");

    // Structural elements before furniture
    const addOps = plan.operations.filter((o) => o.op === "addObject");
    const floorIndex = addOps.findIndex((o) => (o as any).object?.kind === "floor");
    const furnitureIndex = addOps.findIndex((o) => (o as any).object?.kind === "furniture");
    expect(floorIndex).toBeLessThan(furnitureIndex);
  });

  it("includes room dimensions", () => {
    const layout = makeTestLayout({ room: { width: 12, depth: 10, height: 4 } });
    const plan = assembleScene(layout);
    const setRoom = plan.operations[0];
    expect((setRoom as any).width).toBe(12);
    expect((setRoom as any).depth).toBe(10);
    expect((setRoom as any).height).toBe(4);
  });

  it("estimates cost", () => {
    const layout = makeTestLayout();
    const plan = assembleScene(layout);
    expect(plan.estimatedCost).toBeGreaterThan(0);
  });

  it("handles empty layout", () => {
    const layout = makeTestLayout({ objects: [], cameras: [], lights: [] });
    const plan = assembleScene(layout);
    expect(plan.operations.length).toBe(1); // Just setRoom
  });
});

describe("summarizePlan", () => {
  it("produces Chinese summary", () => {
    const layout = makeTestLayout();
    const plan = assembleScene(layout);
    const summary = summarizePlan(plan);
    expect(summary).toContain("设置房间");
    expect(summary).toContain("添加物体");
    expect(summary).toContain("添加摄像机");
    expect(summary).toContain("添加灯光");
  });
});

describe("computeBounds", () => {
  it("computes bounding box", () => {
    const layout = makeTestLayout();
    const bounds = computeBounds(layout);
    expect(bounds.min.x).toBeLessThan(bounds.max.x);
    expect(bounds.min.y).toBeLessThan(4);
  });
});

// ---- Validator tests ----

describe("validateScene", () => {
  it("validates a correct layout", () => {
    const layout = makeTestLayout();
    const issues = validateScene(layout);
    expect(issues.filter((i) => i.level === "error")).toHaveLength(0);
  });

  it("detects missing cameras", () => {
    const layout = makeTestLayout({ cameras: [] });
    const issues = validateScene(layout);
    expect(issues.some((i) => i.message.includes("摄像机"))).toBe(true);
  });

  it("detects missing lights", () => {
    const layout = makeTestLayout({ lights: [] });
    const issues = validateScene(layout);
    expect(issues.some((i) => i.message.includes("灯光"))).toBe(true);
  });

  it("detects duplicate ids", () => {
    const layout = makeTestLayout({
      objects: [
        { id: "a", label: "A", kind: "prop", position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
        { id: "a", label: "B", kind: "prop", position: { x: 1, y: 0, z: 1 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
      ],
      cameras: [],
      lights: [],
    });
    const issues = validateScene(layout);
    expect(issues.some((i) => i.message.includes("重复"))).toBe(true);
  });

  it("detects objects below floor", () => {
    const layout = makeTestLayout({
      objects: [
        { id: "a", label: "A", kind: "prop", position: { x: 0, y: -1, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
      ],
      cameras: [],
      lights: [],
    });
    const issues = validateScene(layout);
    expect(issues.some((i) => i.message.includes("地板下方"))).toBe(true);
  });

  it("detects overlapping objects", () => {
    const layout = makeTestLayout({
      objects: [
        { id: "a", label: "A", kind: "prop", position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 2, y: 1, z: 2 } },
        { id: "b", label: "B", kind: "prop", position: { x: 0.5, y: 0, z: 0.5 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 2, y: 1, z: 2 } },
      ],
      cameras: [],
      lights: [],
    });
    const issues = validateScene(layout);
    expect(issues.some((i) => i.message.includes("重叠"))).toBe(true);
  });
});

describe("validateObject", () => {
  it("validates a correct object", () => {
    const obj = { id: "a", label: "A", kind: "prop" as const, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
    expect(validateObject(obj, 0)).toHaveLength(0);
  });

  it("detects zero scale", () => {
    const obj = { id: "a", label: "A", kind: "prop" as const, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 0, y: 1, z: 1 } };
    const issues = validateObject(obj, 0);
    expect(issues.some((i) => i.level === "error")).toBe(true);
  });
});

// ---- Pipeline tests ----

describe("runScenePipeline", () => {
  it("runs with a mock provider", async () => {
    const layout = makeTestLayout();
    const provider = createMockProvider(layout);

    const output = await runScenePipeline(provider, {
      prompt: "建一个温馨的客厅",
      style: "modern",
    });

    expect(output.layout.name).toBe("测试场景");
    expect(output.timing.totalMs).toBeGreaterThanOrEqual(0);
    expect(output.layout.objects.length).toBeGreaterThan(0);
  });

  it("handles empty response gracefully", async () => {
    const provider = createMockProvider("not json");
    // Should throw because the mock returns non-JSON
    await expect(
      runScenePipeline(provider, { prompt: "test" }),
    ).rejects.toThrow();
  });

  it("runs collaborative pipeline", async () => {
    const layout = makeTestLayout();
    const planner = createMockProvider(layout);
    const validator = createMockProvider(layout);

    const output = await runScenePipeline(planner, { prompt: "test" });
    expect(output.layout).toBeDefined();
  });
});

describe("summarizePipelineOutput", () => {
  it("generates Markdown summary", async () => {
    const layout = makeTestLayout();
    const provider = createMockProvider(layout);
    const output = await runScenePipeline(provider, { prompt: "test" });
    const summary = summarizePipelineOutput(output);

    expect(summary).toContain("# 测试场景");
    expect(summary).toContain("沙发");
    expect(summary).toContain("茶几");
    expect(summary).toContain("性能");
    expect(summary).toContain("ms");
  });
});