import { describe, expect, it } from "vitest";
import { filterEngineSceneWarningsWithoutTypedEchoes } from "../../../../src/comprehensive/editor/interchange/engines/engineSceneOmittedUi";

describe("filterEngineSceneWarningsWithoutTypedEchoes", () => {
  it("keeps unrelated warnings and drops exact typed-reason echoes", () => {
    const rollReason = "Engine camera roll on Main is not represented by Director's target-based camera model.";
    const hierarchyReason =
      "The 6 engine scene nodes import as one flattened Director scene object; per-node editing requires the planned engine round trip.";
    expect(
      filterEngineSceneWarningsWithoutTypedEchoes(
        [rollReason, "Camera Main focal length was clamped to Director's 12–200 mm range.", hierarchyReason, "  keep me  "],
        {
          omitted: [
            { sourceId: "Main", code: "camera_roll", reason: rollReason },
            { sourceId: "scene", code: "hierarchy_flattened", reason: hierarchyReason },
          ],
        },
      ),
    ).toEqual(["Camera Main focal length was clamped to Director's 12–200 mm range.", "  keep me  "]);
  });

  it("returns warnings unchanged when no typed omissions are present", () => {
    expect(filterEngineSceneWarningsWithoutTypedEchoes(["keep me"], {})).toEqual(["keep me"]);
  });
});
