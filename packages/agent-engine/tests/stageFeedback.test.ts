import { describe, expect, it } from "vitest";
import { createDefaultScene } from "@director/stage-protocol";
import { executeStageTool } from "../src/commandEngine";
import { createStageFeedback, diffStageScenes } from "../src/stageFeedback";

describe("stage tool feedback", () => {
  it("reports changed entities, compact context, and visible refs", () => {
    const before = createDefaultScene();
    const refs = new Map<string, string>();
    const execution = executeStageTool(
      before,
      "stage_object",
      {
        op: "create",
        ref: "heroBlock",
        kind: "cube",
        name: "Hero block",
      },
      refs,
    );
    const feedback = createStageFeedback({
      before,
      execution,
      toolInput: { op: "create", ref: "heroBlock", kind: "cube", name: "Hero block" },
      refs,
      tool: "stage_object",
    });
    const objectId = refs.get("heroBlock");

    expect(feedback.changed.object_ids).toEqual([objectId]);
    expect(feedback.context.objects).toEqual([{ id: objectId, kind: "cube", name: "Hero block" }]);
    expect(feedback.available_refs).toEqual({ heroBlock: objectId });
    expect(feedback.scene_hint).toMatchObject({ object_count: 4, renderable_object_count: 2 });
    expect(feedback).toMatchObject({
      scene_hint: {
        validation: { ready: true, video_ready: true, error_count: 0 },
      },
    });
    expect(feedback).not.toHaveProperty("readiness");
  });

  it("detects settings, object, and track changes independently", () => {
    const before = createDefaultScene();
    const after = structuredClone(before);
    after.recordAspect = "9:16";
    after.objects["human-1"].position = [1, 0, 0];
    after.show.tracks[0].items = [];
    expect(diffStageScenes(before, after)).toEqual({
      object_ids: ["human-1"],
      track_ids: ["track-camera-1"],
      scene_settings: true,
    });
  });
});
