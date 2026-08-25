import { describe, expect, it } from "vitest";
import { createProductionRunRequestSchema, productionRunSchema } from "../src/multiAgentRunSchema";

const TARGET = {
  token: "target-token",
  client_id: "browser-client",
  instance_id: "director-instance",
  scene_id: "scene-1",
  creative_scope_id: "scope-1",
  contract_version: 2 as const,
};

function validRun() {
  const now = new Date().toISOString();
  return {
    version: 1 as const,
    id: "run-schema-test",
    objective: "Validate one production graph at its durable boundary.",
    provider: "api" as const,
    profileId: "api-default",
    status: "queued" as const,
    target: TARGET,
    createdAt: now,
    updatedAt: now,
    activeNodeId: null,
    nodes: [
      {
        id: "node-01-showrunner",
        roleId: "showrunner" as const,
        sessionId: null,
        status: "pending" as const,
        attempt: 0,
        startedAt: null,
        completedAt: null,
        inputArtifactIds: [],
        outputArtifactIds: [],
        error: null,
      },
    ],
    artifacts: [],
  };
}

describe("multi-agent run schemas", () => {
  it("applies the server-owned API harness defaults at the create boundary", () => {
    expect(
      createProductionRunRequestSchema.parse({ objective: "Direct a verified scene.", target: TARGET }),
    ).toMatchObject({ provider: "api", profileId: "api-default" });
  });

  it("accepts a movie production brief and the complete creative role set", () => {
    const request = createProductionRunRequestSchema.parse({
      objective: "Produce a coherent cinematic short.",
      target: TARGET,
      roles: ["showrunner", "screenwriter", "production-designer", "sound-designer", "editor"],
      brief: {
        workflow: "idea-to-film",
        targetDurationSec: 120,
        aspectRatio: "2.39:1",
        fps: 24,
        language: "zh-CN",
        visualStyle: "grounded science fiction with motivated practical lighting",
        audience: "adult science-fiction audience",
      },
    });

    expect(request.brief).toMatchObject({ targetDurationSec: 120, aspectRatio: "2.39:1" });
    expect(request.roles).toContain("production-designer");
    expect(request.roles).toContain("sound-designer");
  });

  it("accepts strict per-role profile ids without accepting unknown roles or secrets", () => {
    const routed = createProductionRunRequestSchema.parse({
      objective: "Route production roles to purpose-built hosted models.",
      target: TARGET,
      profileByRole: {
        "stage-director": "openai-director",
        cinematographer: "claude-camera",
        "visual-critic": "openai-vision",
        "repair-operator": "claude-repair",
      },
    });
    expect(routed.profileByRole).toEqual({
      "stage-director": "openai-director",
      cinematographer: "claude-camera",
      "visual-critic": "openai-vision",
      "repair-operator": "claude-repair",
    });
    expect(
      createProductionRunRequestSchema.safeParse({
        objective: "Reject unknown routing keys.",
        target: TARGET,
        profileByRole: { director: "not-a-real-role" },
      }).success,
    ).toBe(false);
    expect(
      createProductionRunRequestSchema.safeParse({
        objective: "Reject a secret hidden in the role map.",
        target: TARGET,
        profileByRole: { "stage-director": "openai-director", apiKey: "secret" },
      }).success,
    ).toBe(false);
  });

  it("migrates a durable v1 single-profile run to pinned v2 node profiles", () => {
    const migrated = productionRunSchema.parse(validRun());
    expect(migrated).toMatchObject({
      version: 2,
      profileId: "api-default",
      profileByRole: { showrunner: "api-default" },
      nodes: [{ roleId: "showrunner", profileId: "api-default" }],
    });
  });

  it("rejects unknown request fields instead of silently leaking client configuration", () => {
    expect(
      createProductionRunRequestSchema.safeParse({
        objective: "Direct a verified scene.",
        target: TARGET,
        apiKey: "must-never-cross-this-boundary",
      }).success,
    ).toBe(false);
  });

  it("rejects run ids that could escape the durable snapshot directory", () => {
    expect(productionRunSchema.safeParse({ ...validRun(), id: "../../outside" }).success).toBe(false);
  });

  it("accepts role artifacts with their actual payload", () => {
    expect(
      productionRunSchema.safeParse({
        ...validRun(),
        artifacts: [
          {
            id: "artifact-1",
            kind: "role-report",
            roleId: "showrunner",
            payload: { text: "scene direction" },
            createdAt: new Date().toISOString(),
          },
        ],
      }).success,
    ).toBe(true);
  });
});
