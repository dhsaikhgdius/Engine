import { Vector2 } from "three";

/**
 * Map a pointer onto the live canvas in Normalized Device Coordinates (NDC).
 * Full-window maths miss the stage frame, so this uses the supplied DOM bounds
 * to compute coordinates relative to the actual canvas area.
 *
 * @param clientX - The `clientX` value from a pointer event.
 * @param clientY - The `clientY` value from a pointer event.
 * @param bounds - The stage canvas element's bounding rectangle.
 * @param target - Optional output vector; a new `Vector2` is allocated when omitted.
 * @returns The `target` vector with NDC x in [-1, 1] and y in [-1, 1].
 */
export function linearCastingPointerNdc(
  clientX: number,
  clientY: number,
  bounds: Pick<DOMRect, "left" | "top" | "width" | "height">,
  target = new Vector2(),
) {
  const width = Math.max(1, bounds.width);
  const height = Math.max(1, bounds.height);
  return target.set(((clientX - bounds.left) / width) * 2 - 1, -((clientY - bounds.top) / height) * 2 + 1);
}
