import { PerspectiveCamera } from "three";
import { describe, expect, it } from "vitest";
import { getVerticalFovFromFocalLength } from "../../../../src/comprehensive/editor/schema/cameraGeometry";
import {
  applyDirectorAnamorphicProjection,
  copyDirectorCameraProjection,
  withDirectorAnamorphicProjection,
} from "../../../../src/comprehensive/editor/schema/cameraProjection";

function matrixValues(camera: PerspectiveCamera) {
  return {
    projection: [...camera.projectionMatrix.elements],
    inverse: [...camera.projectionMatrixInverse.elements],
  };
}

const baseFov = getVerticalFovFromFocalLength(50, "2.39:1", "fullFrame");
const baseInput = {
  fov: baseFov,
  focalLengthMm: 50,
  sensorFormat: "fullFrame" as const,
  aspectRatio: "2.39:1" as const,
  anamorphicSqueeze: 1,
};

describe("applyDirectorAnamorphicProjection", () => {
  it("is a mathematical no-op at a spherical 1x squeeze", () => {
    const camera = new PerspectiveCamera(baseFov, 2.39, 0.1, 1_000);
    camera.updateProjectionMatrix();
    const before = matrixValues(camera);

    const scope = applyDirectorAnamorphicProjection(camera, baseInput);

    expect(scope.metadata.applied).toBe(false);
    expect(scope.metadata.horizontalFovDegreesAfter).toBeCloseTo(scope.metadata.horizontalFovDegreesBefore, 12);
    expect(matrixValues(camera)).toEqual(before);
    scope.restore();
    expect(matrixValues(camera)).toEqual(before);
  });

  it("widens horizontal projection for a squeezed lens and restores exact matrices", () => {
    const camera = new PerspectiveCamera(baseFov, 2.39, 0.1, 1_000);
    camera.updateProjectionMatrix();
    const before = copyDirectorCameraProjection(camera);
    const baseScaleX = camera.projectionMatrix.elements[0];

    const scope = applyDirectorAnamorphicProjection(camera, { ...baseInput, anamorphicSqueeze: 2 });

    expect(scope.metadata).toMatchObject({
      applied: true,
      squeeze: 2,
      sensorFormat: "fullFrame",
      focalLengthMm: 50,
    });
    expect(camera.projectionMatrix.elements[0]).toBeLessThan(baseScaleX);
    expect(camera.projectionMatrix.elements[0] / camera.projectionMatrix.elements[5]).toBeCloseTo(
      1 / camera.aspect,
      12,
    );
    expect(scope.metadata.horizontalFovDegreesAfter).toBeGreaterThan(scope.metadata.horizontalFovDegreesBefore);
    expect(scope.metadata.verticalFovDegreesAfter).toBeGreaterThan(scope.metadata.verticalFovDegreesBefore);
    expect(scope.metadata.compressedGateAspect).toBeCloseTo(2.39 / 2, 12);
    expect(scope.metadata.captureGateWidthMm).toBeLessThanOrEqual(36);
    expect(scope.metadata.effectiveHorizontalGateWidthMm).toBeGreaterThan(36);
    expect(camera.projectionMatrix.clone().multiply(camera.projectionMatrixInverse).elements[0]).toBeCloseTo(1, 10);

    scope.restore();
    scope.restore();
    expect(camera.projectionMatrix.elements).toEqual(before.projectionMatrix.elements);
    expect(camera.projectionMatrixInverse.elements).toEqual(before.projectionMatrixInverse.elements);
  });

  it("restores projection state when a scoped render throws", () => {
    const camera = new PerspectiveCamera(45, 16 / 9, 0.1, 100);
    camera.updateProjectionMatrix();
    const before = matrixValues(camera);

    expect(() =>
      withDirectorAnamorphicProjection(camera, { ...baseInput, anamorphicSqueeze: 1.8 }, () => {
        expect(camera.projectionMatrix.elements[0]).not.toBe(before.projection[0]);
        throw new Error("render interrupted");
      }),
    ).toThrow("render interrupted");

    expect(matrixValues(camera)).toEqual(before);
  });
});
