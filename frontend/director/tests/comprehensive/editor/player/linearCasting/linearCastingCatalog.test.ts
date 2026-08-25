import { describe, expect, it } from "vitest";
import { PLAYER_ROAM_EMOTES } from "../../../../../src/comprehensive/editor/player/playerEmotes";
import { isPlayerMovementKey, PLAYER_CONTROLLER_RESERVED_CODES, PLAYER_VEHICLE_TOGGLE_CODE } from "../../../../../src/comprehensive/editor/player/playerInput";
import {
  LINEAR_CASTING_ABILITY_CODES,
  LINEAR_CASTING_CLEAR_CODE,
  LINEAR_CASTING_EDITOR_CODE,
  LINEAR_CASTING_ELEMENTS,
  LINEAR_CASTING_LABELS,
  LINEAR_CASTING_PAUSE_CODE,
  LINEAR_CASTING_SLOT_KEYS,
  isLinearCastingHotkey,
  linearCastingElementMeta,
  linearCastingSlotForCode,
} from "../../../../../src/comprehensive/editor/player/linearCasting/linearCastingCatalog";

describe("linearCastingCatalog", () => {
  it("keeps the six abilities in slot order with Chinese labels", () => {
    expect(LINEAR_CASTING_ELEMENTS).toEqual(["ice", "thunder", "meteor", "beam", "snare", "glacier"]);
    expect(LINEAR_CASTING_LABELS.ice).toBe("霜矛");
    expect(LINEAR_CASTING_LABELS.glacier).toBe("冰川冠");
    expect(linearCastingElementMeta("snare").cast).toBe("zone");
    expect(linearCastingElementMeta("ice").key).toBe("5");
    expect(LINEAR_CASTING_SLOT_KEYS).toEqual(["5", "6", "7", "8", "9", "0"]);
  });

  it("maps 5–0 onto the six abilities without LoL-style roam collisions", () => {
    expect(linearCastingSlotForCode("Digit5")).toBe(0);
    expect(linearCastingSlotForCode("Digit0")).toBe(5);
    expect(linearCastingSlotForCode("KeyQ")).toBeNull();
    expect(linearCastingSlotForCode("KeyE")).toBeNull();
    expect(linearCastingSlotForCode("KeyR")).toBeNull();
    expect(linearCastingSlotForCode("KeyF")).toBeNull();
    expect(linearCastingSlotForCode("KeyV")).toBeNull();
    expect(linearCastingSlotForCode("Digit1")).toBeNull();
    expect(linearCastingSlotForCode("KeyW")).toBeNull();
  });

  it("treats arm, cancel, editor, pause, and clear as casting hotkeys", () => {
    expect(isLinearCastingHotkey("Digit5")).toBe(true);
    expect(isLinearCastingHotkey("Escape")).toBe(true);
    expect(isLinearCastingHotkey(LINEAR_CASTING_EDITOR_CODE)).toBe(true);
    expect(isLinearCastingHotkey(LINEAR_CASTING_PAUSE_CODE)).toBe(true);
    expect(isLinearCastingHotkey(LINEAR_CASTING_CLEAR_CODE)).toBe(true);
    expect(isLinearCastingHotkey("KeyC")).toBe(false);
    expect(isLinearCastingHotkey("KeyW")).toBe(false);
  });

  it("does not overlap character-follow roam keys", () => {
    const emoteCodes = new Set(PLAYER_ROAM_EMOTES.map((emote) => emote.code));
    const castingCodes = [
      ...Object.keys(LINEAR_CASTING_ABILITY_CODES),
      LINEAR_CASTING_EDITOR_CODE,
      LINEAR_CASTING_PAUSE_CODE,
      LINEAR_CASTING_CLEAR_CODE,
    ];

    for (const code of castingCodes) {
      expect(isPlayerMovementKey(code), code).toBe(false);
      expect(PLAYER_CONTROLLER_RESERVED_CODES.has(code), code).toBe(false);
      expect(code).not.toBe(PLAYER_VEHICLE_TOGGLE_CODE);
      expect(emoteCodes.has(code), code).toBe(false);
    }
  });
});
