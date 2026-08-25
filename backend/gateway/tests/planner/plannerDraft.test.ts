import { expect, it } from "vitest";
import agentPlanSchema from "../../agentPlanSchema.json";
import { AGENT_TOOL_NAMES, STAGE_COMMAND_TOOL_NAMES } from "../../../../packages/protocol/src/agentTools";
import {
  createPlannerRetryMessage,
  decodeClaudePlannerOutput,
  decodePlannerDraft,
  DIRECTOR_WORKBENCH_INPUT_JSON_DESCRIPTION,
} from "../../plannerDraft";

const sceneEpoch = "82a6f8c1-7cb8-4d6f-a5f2-a4f5654a0420";

it("decodes input_json and removes the transport-only field", () => {
  expect(
    decodePlannerDraft({
      summary: "检查镜头",
      operations: [{ tool: "stage_read", input_json: '{"op":"critique"}', summary: "检查构图" }],
    }),
  ).toEqual({
    summary: "检查镜头",
    operations: [{ tool: "stage_read", input: { op: "critique" }, summary: "检查构图" }],
  });
});

it("offers only the typed tools to plan generation and never the stage command tools", () => {
  const stageCommandTools = new Set<string>(STAGE_COMMAND_TOOL_NAMES);
  expect(agentPlanSchema.required).toEqual(["summary", "operations"]);
  expect(agentPlanSchema.properties).not.toHaveProperty("verification");
  expect(agentPlanSchema.properties.operations.items.properties.tool.enum).toEqual(
    AGENT_TOOL_NAMES.filter((tool) => !stageCommandTools.has(tool)),
  );
  expect(agentPlanSchema.properties.operations.items.properties.tool.enum).toEqual([
    "director_workbench",
    "director_creative",
    "stage_video",
    "blender_native",
  ]);
});

it("decodes native Blender plans and drops obsolete planner-only fields", () => {
  expect(
    decodePlannerDraft({
      summary: "搭建原生白膜",
      verification: "obsolete transport field",
      operations: [
        {
          tool: "blender_native",
          input_json: JSON.stringify({
            op: "apply",
            expectedSceneEpoch: sceneEpoch,
            expectedRevision: 2,
            operations: [{ op: "create_primitive", primitive: "cube", id: "wall-a" }],
          }),
          summary: "创建墙体",
        },
      ],
    }),
  ).toEqual({
    summary: "搭建原生白膜",
    operations: [
      {
        tool: "blender_native",
        input: {
          op: "apply",
          expectedSceneEpoch: sceneEpoch,
          expectedRevision: 2,
          operations: [{ op: "create_primitive", primitive: "cube", id: "wall-a" }],
        },
        summary: "创建墙体",
      },
    ],
  });
});

it("decodes Claude's structured envelope through the same JSON boundary", () => {
  expect(
    decodeClaudePlannerOutput(
      JSON.stringify({
        structured_output: {
          summary: "检查镜头",
          operations: [],
        },
      }),
    ),
  ).toEqual({ summary: "检查镜头", operations: [] });
});

it("rejects malformed operation envelopes before plan validation", () => {
  expect(() =>
    decodePlannerDraft({
      summary: "坏计划",
      operations: [{ tool: "stage_read", input_json: 42 }],
    }),
  ).toThrow("Plan has no operations array");
});

it("does not reflect malformed input_json contents through its decoder error", () => {
  expect(() =>
    decodePlannerDraft({
      summary: "坏计划",
      operations: [{ tool: "stage_read", input_json: '{"api_key":"model-secret", bad}' }],
    }),
  ).toThrow("Step 1 input_json is not valid JSON");

  try {
    decodePlannerDraft({
      summary: "坏计划",
      operations: [{ tool: "stage_read", input_json: '{"api_key":"model-secret", bad}' }],
    });
  } catch (error) {
    expect(error instanceof Error ? error.message : String(error)).not.toContain("model-secret");
  }
});

it("gives a deterministic repair rule when set_scene is missing patch", () => {
  const message = createPlannerRetryMessage(
    "加一个黑天鹅大战白羊的内容",
    "Plan step 1 cannot execute: director_workbench input invalid: actions.0.patch is missing",
  );

  expect(message).toContain("set_scene is not a create-scene");
  expect(message).toContain("delete the set_scene action entirely");
  expect(message).toContain("at least one supported field");
  expect(DIRECTOR_WORKBENCH_INPUT_JSON_DESCRIPTION).toContain("MUST contain a non-empty patch object");
});

it("points at any missing author-action identity field", () => {
  const message = createPlannerRetryMessage(
    "给新机位设置焦距",
    "Plan step 1 cannot execute: director_workbench input invalid: actions.3.camera_id is missing; update_camera must specify a camera",
  );

  expect(message).toContain("actions.3.camera_id is required");
  expect(message).toContain("Do not use null, empty strings, or guessed placeholders");
});
