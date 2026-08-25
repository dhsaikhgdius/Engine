import { describe, expect, it } from "vitest";
import { createDefaultScene } from "../src/defaultScene";
import { parseStageScene } from "../src/sceneSchema";

describe("stage scene runtime schema", () => {
  it("accepts the canonical scene document", () => {
    const result = parseStageScene(createDefaultScene());

    expect(result).toMatchObject({ success: true, scene: { recordAspect: "16:9" } });
  });

  it("accepts every camera aspect supported by the Director workbench", () => {
    for (const recordAspect of ["16:9", "9:16", "1:1", "4:3", "1.85:1", "2.39:1"] as const) {
      expect(parseStageScene({ ...createDefaultScene(), recordAspect })).toMatchObject({
        success: true,
        scene: { recordAspect },
      });
    }
  });

  it("accepts legacy persisted documents that still carry a version field", () => {
    const result = parseStageScene({ ...createDefaultScene(), v: 5 });

    expect(result).toMatchObject({ success: true, scene: { recordAspect: "16:9" } });
    if (result.success) expect("v" in result.scene).toBe(false);
  });

  it("rejects malformed HTTP scene data instead of accepting its version alone", () => {
    const result = parseStageScene({ v: 5, objects: "not-an-object", show: {} });

    expect(result).toMatchObject({ success: false });
    if (!result.success) expect(result.error).toContain("objects");
  });

  it("rejects malformed nested objects and timeline items", () => {
    const scene = createDefaultScene();
    const malformedScene = {
      ...scene,
      objects: {
        ...scene.objects,
        "human-1": { ...scene.objects["human-1"], position: [0, 0] },
      },
    };

    const result = parseStageScene(malformedScene);

    expect(result).toMatchObject({ success: false });
    if (!result.success) expect(result.error).toContain("position");
  });
});
