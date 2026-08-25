/**
 * @module Camera focus target helpers for director objects.
 */

import { Euler, Vector3 } from "three";
import { getGroundedLabelY } from "../runtime/mannequin/bodyTypes";
import { getUE4GroundedLabelY } from "../runtime/ue4Mannequin/ue4MannequinRig";
import type { DirectorObject, GeometryPrimitiveType } from "./directorProject";
import { getDirectorPrimitiveMetrics } from "@director/project-schema";

const IMPORTED_MODEL_FOCUS_OFFSET_Y = 1;
const NORMALIZED_MIXAMO_FOCUS_OFFSET_Y = 1.78 / 2;

function roundTuple(vector: Vector3): [number, number, number] {
  return [vector.x, vector.y, vector.z].map((value) => Number(value.toFixed(6))) as [number, number, number];
}

/** Returns whether the given object can be a camera focus target. */
export function isCameraFocusableObject(object: DirectorObject) {
  return object.visible && object.kind !== "camera" && object.kind !== "panorama";
}

/** Returns the vertical offset from the object's origin to its visual focus point. */
export function getDirectorObjectFocusOffsetY(object: DirectorObject) {
  if (object.kind === "character") {
    if (object.characterRig?.rigType === "mixamo") return NORMALIZED_MIXAMO_FOCUS_OFFSET_Y;

    const labelY =
      object.characterRig?.rigType === "ue4-mannequin"
        ? getUE4GroundedLabelY(object.bodyType)
        : getGroundedLabelY(object.bodyType);

    return labelY / 2;
  }

  if (object.assetRefId) {
    return IMPORTED_MODEL_FOCUS_OFFSET_Y;
  }

  if (object.geometryType) {
    return getDirectorPrimitiveMetrics(object.geometryType as GeometryPrimitiveType).center[1];
  }

  return IMPORTED_MODEL_FOCUS_OFFSET_Y;
}

/** Computes the world-space focus target position for a director object. */
export function getDirectorObjectFocusTarget(object: DirectorObject): [number, number, number] {
  const [scaleX, scaleY, scaleZ] = object.transform.scale;
  const offset = new Vector3(0, getDirectorObjectFocusOffsetY(object), 0)
    .multiply(new Vector3(scaleX, scaleY, scaleZ))
    .applyEuler(new Euler(...object.transform.rotation));
  const target = new Vector3(...object.transform.position).add(offset);

  return roundTuple(target);
}
