import { describe, expect, it } from "vitest";
import { executeStageTool } from "../src/commandEngine";
import { createDefaultScene } from "@director/stage-protocol";
import { parseStageScene } from "@director/stage-protocol";

describe("Agent stage command engine", () => {
  it("reproduces the default scene", () => {
    const result = executeStageTool(createDefaultScene(), "stage_read", { op: "scene_state" });
    expect(result.success).toBe(true);
    expect(Object.values(result.scene.objects).map((object) => object.kind)).toEqual(["humanoid", "target", "camera"]);
    expect(result.scene.show.tracks[0].items[0]).toMatchObject({
      kind: "cam-move",
      move: "orbit",
      durationS: 5,
      angleDeg: 360,
    });
    expect(parseStageScene(result.scene)).toMatchObject({ success: true });
  });

  it("supports a compact observe then targeted inspect loop", () => {
    const scene = createDefaultScene();
    const observed = executeStageTool(scene, "stage_read", { op: "observe" });
    expect(observed.success).toBe(true);
    expect(observed.result).toMatchObject({
      scene_name: "场景 1",
      suggested_camera_id: "camera-1",
      validation: { ready: true },
      objects: expect.arrayContaining([{ id: "human-1", kind: "humanoid", name: "人物 1" }]),
    });
    expect(JSON.stringify(observed.result).length).toBeLessThan(
      JSON.stringify(executeStageTool(scene, "stage_read", { op: "scene_state" }).result).length,
    );

    const inspected = executeStageTool(scene, "stage_read", { op: "inspect", object_id: "camera-1" });
    expect(inspected.result).toMatchObject({
      object: { id: "camera-1", focal_length_mm: 35, target_id: "target-1" },
      tracks: [{ id: "track-camera-1", characterId: "camera-1" }],
    });
  });

  it("makes a failed inspection self-correctable", () => {
    const result = executeStageTool(createDefaultScene(), "stage_read", { op: "inspect", object_id: "missing" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("stage_read observe");
  });

  it("provides deterministic camera composition feedback", () => {
    const result = executeStageTool(createDefaultScene(), "stage_read", {
      op: "critique",
      camera_id: "camera-1",
      subject_id: "human-1",
    });
    expect(result.success).toBe(true);
    expect(result.result).toMatchObject({
      camera_id: "camera-1",
      evaluated_object_count: 1,
      objects: [{ id: "human-1", status: expect.stringMatching(/inside|edge|outside|behind/) }],
    });
  });

  it("uses the requested cinematic aspect when evaluating camera composition", () => {
    const scene = createDefaultScene();
    scene.recordAspect = "2.39:1";
    const result = executeStageTool(scene, "stage_read", {
      op: "critique",
      camera_id: "camera-1",
      subject_id: "human-1",
    });

    expect(result.result).toMatchObject({ aspect: "2.39:1" });
  });

  it("checks the complete subject bounds instead of accepting an in-frame centre point", () => {
    const scene = createDefaultScene();
    scene.objects["human-1"].scale = [5, 5, 5];
    const result = executeStageTool(scene, "stage_read", {
      op: "critique",
      camera_id: "camera-1",
      subject_id: "human-1",
    });
    expect(result.result).toMatchObject({
      objects: [expect.objectContaining({ id: "human-1", status: "edge", frame_bounds: expect.any(Object) })],
      issues: [expect.objectContaining({ code: "subject_clipped" })],
    });
  });

  it("resolves refs inside ordered batches", () => {
    const refs = new Map<string, string>();
    const created = executeStageTool(
      createDefaultScene(),
      "stage_object",
      {
        ops: [
          { op: "create", ref: "hero", kind: "cube", name: "Hero", position: [1, 0, 2] },
          { op: "translate", object_id: "hero", delta: [2, 0, -1] },
        ],
      },
      refs,
    );
    expect(created.success).toBe(true);
    const id = refs.get("hero");
    expect(id).toBeTruthy();
    expect(created.scene.objects[id!].position).toEqual([3, 0, 1]);
    expect(parseStageScene(created.scene)).toMatchObject({ success: true });
  });

  it("persists refs across tool calls", () => {
    const refs = new Map<string, string>();
    const withHuman = executeStageTool(
      createDefaultScene(),
      "stage_object",
      { op: "create", ref: "actor", kind: "humanoid" },
      refs,
    );
    const withTrack = executeStageTool(
      withHuman.scene,
      "stage_show",
      { op: "add_track", ref: "actorTrack", object_id: "actor" },
      refs,
    );
    expect(withTrack.success).toBe(true);
    expect(refs.get("actorTrack")).toBeTruthy();
  });

  it("resets, builds, and validates a white-box scene from zero", () => {
    const reset = executeStageTool(createDefaultScene(), "stage_scene", {
      op: "reset",
      name: "街角白膜",
      aspect: "9:16",
      with_camera: true,
    });
    expect(reset.success).toBe(true);
    expect(reset.scene.show.name).toBe("街角白膜");
    expect(reset.scene.recordAspect).toBe("9:16");

    const built = executeStageTool(reset.scene, "stage_object", {
      ops: [
        { op: "create", kind: "cube", ref: "building", scale: [4, 3, 2] },
        { op: "create", kind: "cylinder", ref: "lamp", position: [2, 0, 1], scale: [0.2, 2.4, 0.2] },
        { op: "create", kind: "cone", ref: "tree", position: [-2, 0, 1] },
      ],
    });
    const audit = executeStageTool(built.scene, "stage_scene", { op: "validate" });
    expect(audit.result).toMatchObject({ ready: true, object_count: 3, camera_count: 1, aspect: "9:16" });
    expect(parseStageScene(audit.scene)).toMatchObject({ success: true });
  });

  it("rolls back an entire ordered batch when one operation fails", () => {
    const source = createDefaultScene();
    const refs = new Map<string, string>();
    const result = executeStageTool(
      source,
      "stage_object",
      {
        ops: [
          { op: "create", kind: "cube", ref: "temporary", name: "不应保留" },
          { op: "translate", object_id: "missing", delta: [1, 0, 0] },
        ],
      },
      refs,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Atomic batch failed");
    expect(result.scene).toEqual(source);
    expect(refs.has("temporary")).toBe(false);
  });
});
