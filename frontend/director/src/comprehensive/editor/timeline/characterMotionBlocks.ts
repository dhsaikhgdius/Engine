import type {
  DirectorCharacterMotionBlock,
  DirectorCharacterMotionState,
  DirectorEntityAnimation,
} from "../schema/directorProject";
import { getDirectorCharacterMotion } from "@director/agent-engine/character-motions";

type MotionBlockRange = Pick<DirectorCharacterMotionBlock, "frameStart" | "frameEnd">;

function sortMotionBlocks(blocks: readonly DirectorCharacterMotionBlock[]) {
  return [...blocks].sort(
    (left, right) =>
      left.frameStart - right.frameStart || left.frameEnd - right.frameEnd || left.id.localeCompare(right.id),
  );
}

function overlaps(blocks: readonly DirectorCharacterMotionBlock[]) {
  const sorted = sortMotionBlocks(blocks);
  return sorted.some((block, index) => index > 0 && block.frameStart <= sorted[index - 1]!.frameEnd);
}

/**
 * Creates a new character motion block from a clip id.
 *
 * @param params - The block id, clip id, and frame range.
 * @returns A new motion block with default blend and speed settings.
 * @throws If the clip id is not a known packaged character motion.
 */
export function createDirectorCharacterMotionBlock({
  id,
  clipId,
  frameStart,
  frameEnd,
}: {
  id: string;
  clipId: string;
  frameStart: number;
  frameEnd: number;
}): DirectorCharacterMotionBlock {
  const motion = getDirectorCharacterMotion(clipId);
  if (!motion) throw new Error(`Unknown packaged character motion: ${clipId}`);
  return {
    id,
    clipId,
    enabled: true,
    frameStart,
    frameEnd,
    loop: motion.defaultLoop,
    speed: 1,
    weight: 1,
    blendInS: 0.12,
    blendOutS: 0.12,
    rootMotion: "in-place",
  };
}

/**
 * Inserts a motion block into an entity animation, validating no overlaps.
 *
 * @param animation - The existing animation, or undefined to create a new one.
 * @param block - The block to insert.
 * @returns The updated animation, or null if the insertion would create an invalid state.
 */
export function insertDirectorCharacterMotionBlock(
  animation: DirectorEntityAnimation | undefined,
  block: DirectorCharacterMotionBlock,
) {
  const blocks = [...(animation?.motionBlocks ?? []), block];
  if (
    block.frameEnd < block.frameStart ||
    new Set(blocks.map((item) => item.id)).size !== blocks.length ||
    overlaps(blocks)
  ) {
    return null;
  }
  return {
    ...(animation ?? { version: 1 as const, keyframes: [] }),
    enabled: animation?.enabled ?? true,
    motionBlocks: sortMotionBlocks(blocks),
  } satisfies DirectorEntityAnimation;
}

/**
 * Updates an existing motion block by id.
 *
 * @param animation - The animation containing the block.
 * @param blockId - The id of the block to update.
 * @param patch - Partial properties to apply.
 * @returns The updated animation, or null if the block doesn't exist or the update is invalid.
 */
export function updateDirectorCharacterMotionBlock(
  animation: DirectorEntityAnimation,
  blockId: string,
  patch: Partial<Omit<DirectorCharacterMotionBlock, "id">>,
) {
  if (!animation.motionBlocks?.some((block) => block.id === blockId)) return null;
  const blocks = animation.motionBlocks.map((block) => (block.id === blockId ? { ...block, ...patch } : block));
  if (blocks.some((block) => block.frameEnd < block.frameStart) || overlaps(blocks)) return null;
  return { ...animation, motionBlocks: sortMotionBlocks(blocks) } satisfies DirectorEntityAnimation;
}

/**
 * Removes a motion block from an animation.
 *
 * @param animation - The animation containing the block.
 * @param blockId - The id of the block to remove.
 * @returns The updated animation, with motionBlocks cleared if the last block was removed.
 */
export function removeDirectorCharacterMotionBlock(animation: DirectorEntityAnimation, blockId: string) {
  const motionBlocks = animation.motionBlocks?.filter((block) => block.id !== blockId) ?? [];
  return {
    ...animation,
    motionBlocks: motionBlocks.length ? motionBlocks : undefined,
  } satisfies DirectorEntityAnimation;
}

/**
 * Finds the active motion block at a given frame.
 *
 * @param animation - The entity animation, or undefined.
 * @param frame - The frame number.
 * @returns The active block, or null if none is active at this frame.
 */
export function getDirectorCharacterMotionBlockAtFrame(animation: DirectorEntityAnimation | undefined, frame: number) {
  if (!animation || animation.enabled === false) return null;
  return (
    animation.motionBlocks?.find((block) => block.enabled && frame >= block.frameStart && frame <= block.frameEnd) ??
    null
  );
}

/**
 * Resolves the motion state at a frame, including crossfade blending.
 *
 * @param animation - The entity animation, or undefined.
 * @param frame - The frame number.
 * @param fps - The frame rate for blend calculations.
 * @returns The resolved motion state with blend-adjusted weight, or null.
 */
export function getTimelineCharacterMotionBlock(
  animation: DirectorEntityAnimation | undefined,
  frame: number,
  fps: number,
): DirectorCharacterMotionState | null {
  const block = getDirectorCharacterMotionBlockAtFrame(animation, frame);
  if (!block) return null;
  const safeFps = Math.max(1, fps);
  const fadeInFrames = block.blendInS * safeFps;
  const fadeOutFrames = block.blendOutS * safeFps;
  const fadeIn = fadeInFrames <= 0 ? 1 : Math.min(1, (frame - block.frameStart + 1) / fadeInFrames);
  const fadeOut = fadeOutFrames <= 0 ? 1 : Math.min(1, (block.frameEnd - frame + 1) / fadeOutFrames);
  return {
    clipId: block.clipId,
    enabled: block.enabled,
    loop: block.loop,
    speed: block.speed,
    weight: block.weight * Math.min(fadeIn, fadeOut),
    startFrame: block.frameStart,
    blendInS: 0,
    blendOutS: 0,
    rootMotion: block.rootMotion,
  };
}

/**
 * Clamps a motion block's frame range to bounds based on the edit mode.
 *
 * @param range - The current block range.
 * @param bounds - The allowed bounds.
 * @param mode - "move" clamps the start, "trim-start" clamps the start edge, "trim-end" clamps the end edge.
 * @returns The clamped range.
 */
export function clampDirectorCharacterMotionBlockRange(
  range: MotionBlockRange,
  bounds: MotionBlockRange,
  mode: "move" | "trim-start" | "trim-end",
) {
  const duration = Math.max(0, range.frameEnd - range.frameStart);
  if (mode === "move") {
    const frameStart = Math.max(bounds.frameStart, Math.min(bounds.frameEnd - duration, Math.round(range.frameStart)));
    return { frameStart, frameEnd: frameStart + duration };
  }
  if (mode === "trim-start") {
    return {
      frameStart: Math.max(bounds.frameStart, Math.min(range.frameEnd, Math.round(range.frameStart))),
      frameEnd: range.frameEnd,
    };
  }
  return {
    frameStart: range.frameStart,
    frameEnd: Math.max(range.frameStart, Math.min(bounds.frameEnd, Math.round(range.frameEnd))),
  };
}
