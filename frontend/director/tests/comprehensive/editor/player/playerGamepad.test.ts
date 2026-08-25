import { describe, expect, it } from "vitest";
import {
  applyPlayerGamepadDeadzone,
  createEmptyPlayerGamepadFrame,
  createPlayerGamepadTracker,
  PLAYER_GAMEPAD_STICK_DEADZONE,
  readPlayerGamepadFrame,
  selectActivePlayerGamepad,
} from "../../../../src/comprehensive/editor/player/playerGamepad";

type TestGamepad = {
  axes: number[];
  buttons: { pressed: boolean; value: number }[];
  connected: boolean;
  mapping: string;
};

function createGamepad(overrides: Partial<TestGamepad> = {}): TestGamepad {
  return {
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
    connected: true,
    mapping: "standard",
    ...overrides,
  };
}

describe("applyPlayerGamepadDeadzone", () => {
  it("zeroes deflection inside the deadzone and rescales smoothly past it", () => {
    expect(applyPlayerGamepadDeadzone(0.1, 0.05)).toEqual([0, 0]);

    const justPast = applyPlayerGamepadDeadzone(PLAYER_GAMEPAD_STICK_DEADZONE + 0.01, 0);
    expect(justPast[0]).toBeGreaterThan(0);
    expect(justPast[0]).toBeLessThan(0.05);

    const [fullX, fullY] = applyPlayerGamepadDeadzone(0, 1);
    expect(fullX).toBe(0);
    expect(fullY).toBeCloseTo(1, 6);
  });
});

describe("readPlayerGamepadFrame", () => {
  it("maps stick-up to +forward and preserves partial analog magnitude", () => {
    const tracker = createPlayerGamepadTracker();
    const gamepad = createGamepad({ axes: [0, -1, 0, 0] });

    const frame = readPlayerGamepadFrame(gamepad, tracker);
    expect(frame.connected).toBe(true);
    expect(frame.moveForwardAxis).toBeCloseTo(1, 6);
    expect(frame.sprint).toBe(true);

    gamepad.axes = [0, -0.6, 0, 0];
    const partial = readPlayerGamepadFrame(gamepad, tracker);
    expect(partial.moveForwardAxis).toBeGreaterThan(0.3);
    expect(partial.moveForwardAxis).toBeLessThan(0.7);
    expect(partial.sprint).toBe(false);
  });

  it("fires button edges exactly once per physical press", () => {
    const tracker = createPlayerGamepadTracker();
    const gamepad = createGamepad();
    gamepad.buttons[0] = { pressed: true, value: 1 };

    const first = readPlayerGamepadFrame(gamepad, tracker);
    expect(first.jump).toBe(true);
    expect(first.jumpPressed).toBe(true);

    const held = readPlayerGamepadFrame(gamepad, tracker);
    expect(held.jump).toBe(true);
    expect(held.jumpPressed).toBe(false);

    gamepad.buttons[0] = { pressed: false, value: 0 };
    readPlayerGamepadFrame(gamepad, tracker);
    gamepad.buttons[0] = { pressed: true, value: 1 };
    const repress = readPlayerGamepadFrame(gamepad, tracker);
    expect(repress.jumpPressed).toBe(true);
  });

  it("maps holds, toggles, triggers and the emote D-pad", () => {
    const tracker = createPlayerGamepadTracker();
    const gamepad = createGamepad();
    gamepad.buttons[1] = { pressed: true, value: 1 };
    gamepad.buttons[2] = { pressed: true, value: 1 };
    gamepad.buttons[3] = { pressed: true, value: 1 };
    gamepad.buttons[4] = { pressed: true, value: 1 };
    gamepad.buttons[5] = { pressed: true, value: 1 };
    gamepad.buttons[6] = { pressed: false, value: 0.8 };
    gamepad.buttons[7] = { pressed: false, value: 0.8 };
    gamepad.buttons[14] = { pressed: true, value: 1 };

    const frame = readPlayerGamepadFrame(gamepad, tracker);
    expect(frame.crouch).toBe(true);
    expect(frame.dashPressed).toBe(true);
    expect(frame.viewTogglePressed).toBe(true);
    expect(frame.slowWalkTogglePressed).toBe(true);
    expect(frame.flightTogglePressed).toBe(true);
    expect(frame.descend).toBe(true);
    expect(frame.aim).toBe(true);
    expect(frame.emotePressedIndex).toBe(2);
  });

  it("returns an inert frame and resets edges when the pad disconnects", () => {
    const tracker = createPlayerGamepadTracker();
    const gamepad = createGamepad();
    gamepad.buttons[0] = { pressed: true, value: 1 };
    readPlayerGamepadFrame(gamepad, tracker);

    const empty = readPlayerGamepadFrame(null, tracker);
    expect(empty).toEqual(createEmptyPlayerGamepadFrame());

    // The same physical press after a reconnect is a fresh edge.
    const reconnect = readPlayerGamepadFrame(gamepad, tracker);
    expect(reconnect.jumpPressed).toBe(true);
  });
});

describe("selectActivePlayerGamepad", () => {
  it("prefers a standard-mapping pad but falls back to any connected pad", () => {
    const nonStandard = createGamepad({ mapping: "" });
    const standard = createGamepad();
    expect(selectActivePlayerGamepad([null, nonStandard, standard])).toBe(standard);
    expect(selectActivePlayerGamepad([null, nonStandard])).toBe(nonStandard);
    expect(selectActivePlayerGamepad([null])).toBe(null);
  });
});
