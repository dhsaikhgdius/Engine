import { describe, expect, it } from "vitest";
import { filterDccReturnWarningsWithoutTypedEchoes } from "../../../../src/comprehensive/editor/interchange/dccReturnOmittedUi";

describe("filterDccReturnWarningsWithoutTypedEchoes", () => {
  it("keeps unrelated warnings and drops exact typed-reason echoes", () => {
    const opticsReason = "Camera cam-1 sensor format omitted (warn-and-omit).";
    const additionReason = "New DCC object awaits opt-in.";
    expect(
      filterDccReturnWarningsWithoutTypedEchoes(
        [opticsReason, "focal length baked", additionReason, "  focal length baked  "],
        {
          omittedOptics: [
            {
              directorId: "cam-1",
              code: "sensor_format",
              reason: opticsReason,
            },
          ],
          omittedAdditions: [
            {
              directorId: "lamp",
              name: "Lamp",
              meshFile: "meshes/lamp.glb",
              code: "opt_in_required",
              reason: additionReason,
            },
          ],
        },
      ),
    ).toEqual(["focal length baked", "  focal length baked  "]);
  });

  it("returns warnings unchanged when no typed omissions are present", () => {
    expect(filterDccReturnWarningsWithoutTypedEchoes(["keep me"], {})).toEqual(["keep me"]);
  });
});
