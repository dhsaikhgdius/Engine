import { getDirectorCharacterMotion } from "@director/agent-engine/character-motions";
import {
  DIRECTOR_CHARACTER_EMOTE_CLIP_IDS,
  type DirectorCharacterEmoteClipId,
} from "../runtime/mixamo/mixamoLocomotionRuntime";

export type PlayerEmoteDefinition = {
  /** The packaged motion clip to play. */
  clipId: DirectorCharacterEmoteClipId;
  /** KeyboardEvent.code that starts this emote while roam control is active. */
  code: string;
  /** Keycap label shown by the HUD. */
  hotkeyLabel: string;
  /** Playback duration in seconds, floored at 0.1. */
  durationS: number;
  /** Whether the emote plays once or loops until interrupted. */
  loop: "once" | "repeat";
  /** Source-locale display name; pass through t() when rendering. */
  name: string;
};

/**
 * Roam emote roster in HUD/hotkey order. Duration and loop come from the
 * packaged motion catalog so playback always matches the shipped clips.
 */
export const PLAYER_ROAM_EMOTES: readonly PlayerEmoteDefinition[] = DIRECTOR_CHARACTER_EMOTE_CLIP_IDS.map(
  (clipId, index) => {
    const motion = getDirectorCharacterMotion(clipId);
    return {
      clipId,
      code: `Digit${index + 1}`,
      hotkeyLabel: String(index + 1),
      durationS: Math.max(0.1, motion?.durationS ?? 1),
      loop: motion?.defaultLoop === "repeat" ? "repeat" : "once",
      name: motion?.nameZh ?? clipId,
    };
  },
);

const emotesByCode = new Map(PLAYER_ROAM_EMOTES.map((emote) => [emote.code, emote]));
const emotesByClipId = new Map(PLAYER_ROAM_EMOTES.map((emote) => [emote.clipId as string, emote]));

/**
 * Looks up an emote definition by its keyboard code.
 *
 * @param code - A KeyboardEvent.code string (e.g. "Digit1").
 * @returns The matching emote definition, or null when no emote is bound to that key.
 */
export function getPlayerEmoteByCode(code: string) {
  return emotesByCode.get(code) ?? null;
}

/**
 * Looks up an emote definition by its packaged motion clip id.
 *
 * @param clipId - The motion clip identifier from the character catalog.
 * @returns The matching emote definition, or null when the clip is not in the roam roster.
 */
export function getPlayerEmoteByClipId(clipId: string) {
  return emotesByClipId.get(clipId) ?? null;
}
