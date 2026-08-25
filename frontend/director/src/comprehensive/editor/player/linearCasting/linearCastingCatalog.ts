import { ELEMENT_META, ELEMENTS } from "./vendor/config/settings.js";

/** Supported skillshot element types available in the linear casting system. */
export type LinearCastingElement = "ice" | "thunder" | "meteor" | "beam" | "snare" | "glacier";

/** Ordered catalog of casting elements, indexed by ability slot. */
export const LINEAR_CASTING_ELEMENTS = ELEMENTS as readonly LinearCastingElement[];

/** Human-readable Chinese labels for each casting element. */
export const LINEAR_CASTING_LABELS: Record<LinearCastingElement, string> = {
  ice: "霜矛",
  thunder: "雷枪",
  meteor: "烬陨",
  beam: "新星束",
  snare: "伏特陷阱",
  glacier: "冰川冠",
};

/**
 * Ability hotkeys live on 5–0 so they never steal roam follow keys
 * (WASD / Q E R F V C / emotes 1–4).
 */
export const LINEAR_CASTING_SLOT_KEYS = ["5", "6", "7", "8", "9", "0"] as const;

/**
 * Maps browser KeyboardEvent codes to zero-based ability slot indices.
 * Used to resolve which ability a hotkey press targets.
 */
export const LINEAR_CASTING_ABILITY_CODES: Record<string, number> = {
  Digit5: 0,
  Digit6: 1,
  Digit7: 2,
  Digit8: 3,
  Digit9: 4,
  Digit0: 5,
};

/** Keyboard code that toggles the in-world casting ability editor. */
export const LINEAR_CASTING_EDITOR_CODE = "KeyG";

/** Keyboard code that pauses or resumes the casting session. */
export const LINEAR_CASTING_PAUSE_CODE = "KeyP";

/** Keyboard code that clears all active casting effects. */
export const LINEAR_CASTING_CLEAR_CODE = "KeyB";

/**
 * Resolves a browser KeyboardEvent code to the corresponding ability slot index.
 *
 * @param code - The `event.code` string from a keyboard event.
 * @returns The zero-based slot index, or `null` when the code is not an ability key.
 */
export function linearCastingSlotForCode(code: string) {
  return Object.prototype.hasOwnProperty.call(LINEAR_CASTING_ABILITY_CODES, code)
    ? LINEAR_CASTING_ABILITY_CODES[code]
    : null;
}

/**
 * Returns display metadata for a casting element, with the slot key overridden
 * to match the canonical hotkey layout rather than the vendor default.
 *
 * @param element - The casting element to look up.
 * @returns Vendor metadata merged with the canonical slot key.
 */
export function linearCastingElementMeta(element: LinearCastingElement) {
  const vendor = ELEMENT_META[element] as {
    label: string;
    accent: string;
    key: string;
    hint: string;
    cast?: "line" | "zone";
  };
  const slot = LINEAR_CASTING_ELEMENTS.indexOf(element);
  return {
    ...vendor,
    key: LINEAR_CASTING_SLOT_KEYS[slot] ?? vendor.key,
  };
}

/**
 * Returns whether a keyboard event code is consumed by the linear casting system.
 *
 * @param code - The `event.code` string from a keyboard event.
 * @returns `true` when the code maps to an ability slot, escape, or a casting control key.
 */
export function isLinearCastingHotkey(code: string) {
  return (
    linearCastingSlotForCode(code) !== null ||
    code === "Escape" ||
    code === LINEAR_CASTING_EDITOR_CODE ||
    code === LINEAR_CASTING_PAUSE_CODE ||
    code === LINEAR_CASTING_CLEAR_CODE
  );
}
