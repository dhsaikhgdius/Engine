import { z } from "zod";

/** A finite (non-NaN, non-infinite) number. */
export const directorDccFiniteSchema = z.number().finite();
/** A 3D vector as a tuple of three finite numbers. */
export const directorDccVec3Schema = z.tuple([
  directorDccFiniteSchema,
  directorDccFiniteSchema,
  directorDccFiniteSchema,
]);
/** A quaternion as a tuple of four finite numbers [x, y, z, w]. */
export const directorDccQuaternionSchema = z.tuple([
  directorDccFiniteSchema,
  directorDccFiniteSchema,
  directorDccFiniteSchema,
  directorDccFiniteSchema,
]);

/**
 * DCC transform: location, rotation quaternion, and scale.
 *
 * Enforces that the quaternion has non-zero length and that no scale
 * component is zero — degenerate transforms are rejected at the schema
 * boundary.
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

/** Inferred TypeScript type for a validated DCC transform. */
export type DirectorDccTransform = z.infer<typeof directorDccTransformSchema>;
