import { z } from "zod";

/**
 * Build a Zod strict-object schema for a discriminated union variant keyed by `action`.
 *
 * The resulting schema requires exactly the literal `action` value plus the given shape,
 * and rejects unknown keys.
 *
 * @param action - The literal action discriminator value.
 * @param shape - The additional Zod raw shape to merge into the object.
 * @returns A Zod strict-object schema.
 */
export const strictAction = <const Action extends string, const Shape extends z.ZodRawShape>(
  action: Action,
  shape: Shape,
) => z.strictObject({ action: z.literal(action), ...shape });

/**
 * Build a Zod strict-object schema for a discriminated union variant keyed by `op`.
 *
 * The resulting schema requires exactly the literal `op` value plus the given shape,
 * and rejects unknown keys.
 *
 * @param op - The literal operation discriminator value.
 * @param shape - The additional Zod raw shape to merge into the object.
 * @returns A Zod strict-object schema.
 */
export const strictOperation = <const Operation extends string, const Shape extends z.ZodRawShape>(
  op: Operation,
  shape: Shape,
) => z.strictObject({ op: z.literal(op), ...shape });

/**
 * Build a Zod strict-object schema for a discriminated union variant keyed by `kind`.
 *
 * @param kind - The literal kind discriminator value.
 * @param shape - The additional Zod raw shape to merge into the object.
 * @returns A Zod strict-object schema.
 */
export const strictKind = <const Kind extends string, const Shape extends z.ZodRawShape>(kind: Kind, shape: Shape) =>
  z.strictObject({ kind: z.literal(kind), ...shape });

/**
 * Build a Zod strict-object schema for a discriminated union variant keyed by `mode`.
 *
 * @param mode - The literal mode discriminator value.
 * @param shape - The additional Zod raw shape to merge into the object.
 * @returns A Zod strict-object schema.
 */
export const strictMode = <const Mode extends string, const Shape extends z.ZodRawShape>(mode: Mode, shape: Shape) =>
  z.strictObject({ mode: z.literal(mode), ...shape });

/**
 * Build a Zod strict-object schema for a discriminated union variant keyed by `success`.
 *
 * @param success - The literal success discriminator value (boolean).
 * @param shape - The additional Zod raw shape to merge into the object.
 * @returns A Zod strict-object schema.
 */
export const strictSuccess = <const Success extends boolean, const Shape extends z.ZodRawShape>(
  success: Success,
  shape: Shape,
) => z.strictObject({ success: z.literal(success), ...shape });

/**
 * Build a Zod strict-object schema for a discriminated union variant keyed by both `success` and `action`.
 *
 * @param success - The literal success discriminator value (boolean).
 * @param action - The literal action discriminator value.
 * @param shape - The additional Zod raw shape to merge into the object.
 * @returns A Zod strict-object schema.
 */
export const strictSuccessAction = <
  const Success extends boolean,
  const Action extends string,
  const Shape extends z.ZodRawShape,
>(
  success: Success,
  action: Action,
  shape: Shape,
) => z.strictObject({ success: z.literal(success), action: z.literal(action), ...shape });

/**
 * Build a Zod strict-object schema for a discriminated union variant keyed by `type`.
 *
 * @param type - The literal type discriminator value.
 * @param shape - The additional Zod raw shape to merge into the object.
 * @returns A Zod strict-object schema.
 */
export const strictType = <const Type extends string, const Shape extends z.ZodRawShape>(type: Type, shape: Shape) =>
  z.strictObject({ type: z.literal(type), ...shape });
