import { describe, expect, it } from "vitest";
import { createDefaultScene } from "@director/stage-protocol";
import { executeStageTool, STAGE_HELP } from "../src/commandEngine";
import { parseStageCommandInput, stageCommandOperationNames } from "../src/stageCommandSchema";

describe("Stage command contract schema", () => {
  it("lists the engine operations from the same Zod contract used at runtime", () => {
    expect(stageCommandOperationNames("stage_object")).toEqual([
      "create",
      "transform",
      "translate",
      "update",
      "delete",
      "group",
      "place",
    ]);
    expect(stageCommandOperationNames("stage_read")).toEqual([
      "scene_state",
      "observe",
      "inspect",
      "critique",
      "help",
      "search_props",
      "look_at_scene",
    ]);
    expect(STAGE_HELP).toContain("stage_camera: add, set_shot, set_target, frame");
  });

  it("rejects malformed vectors and enum values before command execution", () => {
    const malformedTransform = parseStageCommandInput("stage_object", {
      op: "translate",
      object_id: "human-1",
      delta: [1, 0],
    });
    const malformedCamera = parseStageCommandInput("stage_camera", {
      op: "set_shot",
      object_id: "camera-1",
      shake: "violent",
    });

    expect(malformedTransform).toMatchObject({ success: false });
    expect(malformedCamera).toMatchObject({ success: false });
  });

  it("models kind-specific create requirements in the command schema", () => {
    expect(parseStageCommandInput("stage_object", { op: "create", kind: "prop" })).toMatchObject({ success: false });
    expect(parseStageCommandInput("stage_object", { op: "create", kind: "image" })).toMatchObject({ success: false });
    expect(
      parseStageCommandInput("stage_object", {
        op: "create",
        kind: "image",
        image_data_url: "data:image/png;base64,AAAA",
      }),
    ).toMatchObject({ success: true });
  });

  it("rejects an invalid ordered batch atomically before it allocates a ref or mutates the scene", () => {
    const source = createDefaultScene();
    const refs = new Map<string, string>();

    const result = executeStageTool(
      source,
      "stage_object",
      {
        ops: [
          { op: "create", kind: "cube", ref: "temporary" },
          { op: "translate", object_id: "temporary", delta: [1, 0] },
        ],
      },
      refs,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("stage_object input invalid");
    expect(result.scene).toEqual(source);
    expect(refs.has("temporary")).toBe(false);
  });
});
