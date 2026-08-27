/**
 * Numeric primitives shared by every DCC contract. All numbers must be
 * finite: NaN/Infinity survive JSON.stringify as `null` and would otherwise
 * corrupt transforms silently on the other side of the wire.
 */
import { z } from "zod";

/** Schema for a finite floating-point number used throughout DCC contracts. */
export const directorDccFiniteSchema = z.number().finite();

/** Schema for a 3D vector (x, y, z) with finite components. */
export const directorDccVec3Schema = z.tuple([
  directorDccFiniteSchema,
  directorDccFiniteSchema,
  directorDccFiniteSchema,
]);

/** Schema for a unit quaternion (x, y, z, w) with finite components. */
export const directorDccQuaternionSchema = z.tuple([
  directorDccFiniteSchema,
  directorDccFiniteSchema,
  directorDccFiniteSchema,
  directorDccFiniteSchema,
]);

/**
 * A DCC-native transform expressed as location, rotation quaternion, and scale.
 *
 * The quaternion must have a non-zero length and the scale vector must not
 * contain any zero component, enforced by the superRefine. Both rules exist
 * because roundtripping requires invertible matrices: a zero quaternion
 * cannot be normalized to a rotation, and a zero scale axis collapses the
 * matrix so decompose() on the way back cannot recover the original basis.
 */
export const directorDccTransformSchema = z
  .strictObject({
    location: directorDccVec3Schema,
    rotationQuaternion: directorDccQuaternionSchema,
    scale: directorDccVec3Schema,
  })
  .superRefine((transform, context) => {
    const [x, y, z, w] = transform.rotationQuaternion;
    const length = Math.hypot(x, y, z, w);
    if (length < 1e-8) {
      context.addIssue({
        code: "custom",
        path: ["rotationQuaternion"],
        message: "DCC quaternion must have a non-zero length",
      });
    }
    if (transform.scale.some((value) => Math.abs(value) < 1e-8)) {
      context.addIssue({
        code: "custom",
        path: ["scale"],
        message: "DCC transform scale cannot contain zero",
      });
    }
  });

/** Inferred type of a DCC-native transform with location, rotation quaternion, and scale. */
export type DirectorDccTransform = z.infer<typeof directorDccTransformSchema>;
