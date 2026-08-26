/**
 * Deterministic sequential id and display-name allocation shared by the Stage
 * DirectorStore and the Agent authoring engine. UI paste and the authoring
 * `duplicate_objects` reducer must allocate identical ids and names for the
 * same project state, so this logic lives in one place.
 */

/** Padded Stage display name for sequentially numbered characters / cameras. */
export function formatSceneItemName(prefix: "角色" | "机位", index: number) {
  return `${prefix}${String(index).padStart(2, "0")}`;
}

/**
 * Returns `${prefix}${n}` where `n` is one past the highest purely numeric
 * suffix among `existingIds` (at least `minimumIndex`).
 */
export function getNextSequentialId(existingIds: string[], prefix: string, minimumIndex = 1) {
  let maxIndex = minimumIndex - 1;
  for (const id of existingIds) {
    if (!id.startsWith(prefix)) continue;
    const suffix = id.slice(prefix.length);
    if (!/^\d+$/.test(suffix)) continue;
    maxIndex = Math.max(maxIndex, Number.parseInt(suffix, 10));
  }
  return `${prefix}${maxIndex + 1}`;
}
