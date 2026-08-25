// @vitest-environment node

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AgentProfileRegistry } from "../../agents/agentProfileRegistry";
import type { ModelDriver } from "@director/model-provider/runtime";
import { loadDirectorControlPlaneConfig } from "../../controlPlane/controlPlaneConfig";
import { ReferenceSceneAnalysisError, createReferenceSceneAnalyzer } from "../../reconstruction/referenceSceneAnalyzer";

const imageBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xd9]);
const imageBase64 = imageBytes.toString("base64");
const imageSha256 = createHash("sha256").update(imageBytes).digest("hex");

function registry() {
  const config = loadDirectorControlPlaneConfig("/tmp/director-reference-scene-tests", {
    DIRECTOR_AGENT_PROFILES_JSON: JSON.stringify([
      {
        id: "vision-primary",
        label: "Vision primary",
        driver: "openai",
        model: "vision-test-model",
        capabilities: { vision: true, tools: true, jsonSchema: true },
      },
    ]),
    OPENAI_API_KEY: "test-key",
  });
  return new AgentProfileRegistry(config, { api: true, codex: false, claude: false });
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    projectRevision: `director-project-revision:v1:sha256:${"a".repeat(64)}`,
    prompt: "Block the product podium and practical light.",
    applyMode: "append",
    analysisMode: "auto",
    profileId: "vision-primary",
    maxObjects: 4,
    image: {
      fileName: "reference.jpg",
      mimeType: "image/jpeg",
      base64: imageBase64,
      sha256: imageSha256,
      metrics: {
        width: 1280,
        height: 720,
        palette: ["#17202c", "#e0b77a"],
        meanLuminance: 0.4,
        edgeDensity: 0.2,
        foregroundCoverage: 0.5,
      },
    },
    ...overrides,
  };
}

const visionOutput = {
  summary: "A warm product podium in a dark studio.",
  confidence: 0.82,
  backgroundColor: "#17202c",
  objects: [
    {
      name: "Podium",
      geometryType: "cylinder",
      position: [0, 0.5, 0],
      rotationDegrees: [0, 15, 0],
      scale: [1.8, 1, 1.8],
      grounded: true,
      material: {
        baseColor: "#e0b77a",
        metalness: 0.1,
        roughness: 0.6,
        emissiveColor: "#000000",
        emissiveIntensity: 0,
        opacity: 1,
      },
      confidence: 0.86,
      rationale: "Dominant cylindrical silhouette at frame center.",
    },
  ],
  lights: [
    {
      name: "Warm practical",
      type: "point",
      color: "#ffd39a",
      intensity: 3,
      position: [2, 3, 1],
      target: [0, 0.5, 0],
      castShadow: true,
      rationale: "Warm highlight and falloff in the reference.",
    },
  ],
  warnings: ["Rear geometry is not visible."],
};

function fakeDriver(output = visionOutput): ModelDriver {
  return {
    id: "fake-vision",
    kind: "openai-chat-compatible",
    complete: vi.fn(async () => ({
      id: "completion-1",
      model: "vision-test-model",
      finishReason: "tool-calls" as const,
      rawFinishReason: "tool_calls",
      usage: { inputTokens: 200, outputTokens: 70, totalTokens: 270 },
      message: {
        role: "assistant" as const,
        content: [
          {
            type: "tool-call" as const,
            id: "call-1",
            name: "submit_reference_scene_plan",
            arguments: output,
            rawArguments: JSON.stringify(output),
          },
        ],
      },
    })),
  };
}

describe("reference scene analyzer", () => {
  it("turns strict vision output into an ID-owned, revision-bound plan", async () => {
    const driver = fakeDriver();
    const analyzer = createReferenceSceneAnalyzer({
      profiles: registry(),
      createDriver: () => driver,
      now: () => "2026-08-07T00:00:00.000Z",
      createId: () => "plan-uuid",
    });

    const plan = await analyzer.analyze(request());
    expect(driver.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "vision-test-model",
        toolChoice: { type: "tool", name: "submit_reference_scene_plan" },
      }),
    );
    expect(plan).toMatchObject({
      id: "reference-plan-plan-uuid",
      status: "draft",
      expectedProjectRevision: request().projectRevision,
      analysis: {
        status: "ready",
        mode: "vision",
        profileId: "vision-primary",
        model: "vision-test-model",
        usage: { totalTokens: 270 },
      },
      objects: [
        {
          id: expect.stringContaining("reference-object"),
          geometryType: "cylinder",
          placementMode: "grounded",
          transform: { rotation: [0, expect.closeTo(Math.PI / 12, 4), 0] },
        },
      ],
      lights: [{ type: "point" }],
    });
    expect(JSON.stringify(plan)).not.toContain(imageBase64);
  });

  it("returns an explicit low-confidence local scaffold when local analysis is selected", async () => {
    const analyzer = createReferenceSceneAnalyzer({
      profiles: registry(),
      createDriver: () => fakeDriver(),
      now: () => "2026-08-07T00:00:00.000Z",
      createId: () => "local-plan",
    });
    const plan = await analyzer.analyze(request({ analysisMode: "local", profileId: null, maxObjects: 2 }));

    expect(plan.analysis).toMatchObject({ status: "degraded", mode: "local", confidence: 0.16 });
    expect(plan.objects).toHaveLength(2);
    expect(plan.analysis.warnings.join(" ")).toContain("not an image understanding claim");
  });

  it("rejects tampered image bytes before any model call", async () => {
    const driver = fakeDriver();
    const analyzer = createReferenceSceneAnalyzer({ profiles: registry(), createDriver: () => driver });
    await expect(
      analyzer.analyze(
        request({
          image: { ...(request().image as object), sha256: "0".repeat(64) },
        }),
      ),
    ).rejects.toMatchObject({ code: "image_hash_mismatch", status: 400 });
    expect(driver.complete).not.toHaveBeenCalled();
  });

  it("fails visibly in forced vision mode instead of silently claiming a local reconstruction", async () => {
    const failing: ModelDriver = {
      id: "failing",
      kind: "openai-chat-compatible",
      complete: vi.fn(async () => {
        throw new Error("provider unavailable");
      }),
    };
    const analyzer = createReferenceSceneAnalyzer({ profiles: registry(), createDriver: () => failing });
    const promise = analyzer.analyze(request({ analysisMode: "vision" }));
    await expect(promise).rejects.toBeInstanceOf(ReferenceSceneAnalysisError);
    await expect(promise).rejects.toMatchObject({ code: "vision_failed", status: 502 });
  });
});
