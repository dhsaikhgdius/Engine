import { Vector2 } from "three";
import { describe, expect, it } from "vitest";
import { linearCastingPointerNdc } from "../../../../../src/comprehensive/editor/player/linearCasting/linearCastingPointer";

describe("linearCastingPointerNdc", () => {
  it("maps the canvas centre to the origin and corners to ±1", () => {
    const bounds = { left: 100, top: 40, width: 800, height: 400 };

    expect(linearCastingPointerNdc(500, 240, bounds).toArray()).toEqual([0, 0]);
    expect(linearCastingPointerNdc(100, 40, bounds).toArray()).toEqual([-1, 1]);
    expect(linearCastingPointerNdc(900, 440, bounds).toArray()).toEqual([1, -1]);
  });

  it("writes into the provided target vector", () => {
    const target = new Vector2(9, 9);
    const result = linearCastingPointerNdc(200, 140, { left: 100, top: 40, width: 200, height: 200 }, target);

    expect(result).toBe(target);
    expect(target.x).toBe(0);
    expect(target.y).toBe(0);
  });
});
