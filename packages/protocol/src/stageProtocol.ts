import { z } from "zod";

/** The set of built-in 3D geometry primitives that can be placed on stage. */
export const STAGE_GEOMETRY_KINDS = ["cube", "sphere", "cylinder", "cone", "plane", "torus", "pyramid"] as const;

/** Named camera movement operations that the stage can perform in a single command. */
export const STAGE_CAMERA_MOVES = ["orbit", "dolly", "truck", "crane", "pan"] as const;

/** Zod schema that validates a value against the known set of stage geometry kinds. */
export const stageGeometryKindSchema = z.enum(STAGE_GEOMETRY_KINDS);

/** Zod schema that validates a stage object creation kind, including humanoids, props, images, and geometry primitives. */
export const stageObjectCreateKindSchema = z.enum(["humanoid", "prop", "image", ...STAGE_GEOMETRY_KINDS]);

/** Zod schema that validates a camera movement command. */
export const stageCameraMoveSchema = z.enum(STAGE_CAMERA_MOVES);

/** Zod schema that validates a camera action, which may be a movement, a still, a follow, a manual operation, or a raw transform. */
export const stageCameraActionSchema = z.enum([...STAGE_CAMERA_MOVES, "still", "follow", "manual", "transform"]);

/** Zod schema for camera shake intensity levels. */
export const stageCameraShakeSchema = z.enum(["off", "subtle", "medium", "heavy"]);

/** Zod schema for turn direction: clockwise or counter-clockwise. */
export const stageTurnDirectionSchema = z.enum(["cw", "ccw"]);

/** Zod schema for locomotion gait speeds. */
export const stageLocomotionGaitSchema = z.enum(["walk", "jog", "sprint"]);
