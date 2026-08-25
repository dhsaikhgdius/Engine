import { Box3, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import {
  DIRECTOR_IMPORTED_MODEL_TARGET_MAX_SIZE,
  getImportedModelNormalization,
  getNormalizedImportedModelLocalBounds,
} from "../../../../src/comprehensive/editor/runtime/importedModelGeometry";

function bounds(size: [number, number, number], minY = 0) {
  return new Box3(new Vector3(-size[0] / 2, minY, -size[2] / 2), new Vector3(size[0] / 2, minY + size[1], size[2] / 2));
}

describe("getImportedModelNormalization", () => {
  it("keeps the legacy display normalization for assets without a metric size", () => {
    const normalization = getImportedModelNormalization(bounds([10, 4, 2]));
    expect(normalization.scale).toBeCloseTo(DIRECTOR_IMPORTED_MODEL_TARGET_MAX_SIZE / 10);
  });

  it("scales the largest dimension to the declared real-world size in meters", () => {
    const cat = getImportedModelNormalization(bounds([0.2, 4, 1]), undefined, "auto", false, 0.8);
    expect(cat.scale).toBeCloseTo(0.8 / 4);

    const building = getImportedModelNormalization(bounds([2, 1, 1]), undefined, "auto", true, 15);
    expect(building.scale).toBeCloseTo(15 / 2);
  });

  it("ignores non-finite or non-positive metric sizes", () => {
    expect(getImportedModelNormalization(bounds([4, 4, 4]), undefined, "auto", false, 0).scale).toBeCloseTo(
      DIRECTOR_IMPORTED_MODEL_TARGET_MAX_SIZE / 4,
    );
    expect(getImportedModelNormalization(bounds([4, 4, 4]), undefined, "auto", false, Number.NaN).scale).toBeCloseTo(
      DIRECTOR_IMPORTED_MODEL_TARGET_MAX_SIZE / 4,
    );
  });

  it("preserve mode keeps authored metric scale regardless of a declared size", () => {
    const normalization = getImportedModelNormalization(bounds([3, 3, 3]), undefined, "preserve", false, 10);
    expect(normalization.scale).toBe(1);
  });

  it("reports the exact normalized local bounds used by the viewport", () => {
    const source = new Box3(new Vector3(2, -3, -4), new Vector3(12, 2, 2));
    const normalization = getImportedModelNormalization(source, 2);

    const measured = getNormalizedImportedModelLocalBounds(source, normalization)!;
    measured.min.forEach((value, axis) => expect(value).toBeCloseTo([-1, 0, -0.6][axis]!));
    measured.max.forEach((value, axis) => expect(value).toBeCloseTo([1, 1, 0.6][axis]!));
  });
});
