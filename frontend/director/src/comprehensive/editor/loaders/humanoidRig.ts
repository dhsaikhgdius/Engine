import type { CharacterRigType } from "../schema/directorProject";

/** Canonical token shared by import detection and the runtime Mixamo adapter. */
export function canonicalizeHumanoidBoneName(name: string) {
  const leaf =
    name
      .trim()
      .split(/[|/\\]/)
      .pop() ?? "";
  const withoutNamespace = leaf.replace(/^mixamorig(?:[_\s-]*\d+)?(?:[:._\s-]+)?/i, "");
  return withoutNamespace.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

/**
 * Detects whether a set of bone names belongs to a known humanoid rig family.
 *
 * Checks for the canonical Mixamo rig signature (hips + spine + head)
 * and the VRM signature (jbipchips + jbipchead). Returns null when
 * neither family matches.
 *
 * @param boneNames - The raw bone names from a loaded model.
 * @returns `"mixamo"`, `"vrm"`, or null if no known rig is detected.
 */
export function detectHumanoidRig(boneNames: string[]): CharacterRigType | null {
  const set = new Set(boneNames.map(canonicalizeHumanoidBoneName));

  if (set.has("hips") && set.has("spine") && set.has("head")) return "mixamo";
  if (set.has("jbipchips") && set.has("jbipchead")) return "vrm";
  return null;
}
