import { AnimationClip } from "three";

export interface PhysicalRuntimeRootTranslationOptions {
  clip: AnimationClip;
  rootBoneName: string;
  restPosition: readonly [number, number, number];
}

/**
 * Give the physical character motor sole ownership of runtime translation.
 *
 * Director's play-mode jump already moves the outer character object through
 * the locomotion motor. Mixamo jump clips also animate the Hips position, so
 * preserving that track would apply the vertical displacement twice while the
 * collider, labels, and follow camera only observe the physical root. Keep all
 * rotational and child-bone performance, but pin the retargeted Hips position
 * to its target rest position for that runtime-only clip.
 *
 * Timeline sampling deliberately does not use this helper: migrated authored
 * root-motion scenes remain readable until root extraction is implemented.
 */
export function stripPhysicalRuntimeRootTranslation({
  clip,
  rootBoneName,
  restPosition,
}: PhysicalRuntimeRootTranslationOptions) {
  const positionTrackName = `${rootBoneName}.position`;
  const rootTrack = clip.tracks.find((track) => track.name === positionTrackName);
  if (!rootTrack || rootTrack.values.length % 3 !== 0) return clip;

  const stripped = clip.clone();
  const strippedRootTrack = stripped.tracks.find((track) => track.name === positionTrackName);
  if (!strippedRootTrack) return clip;

  for (let offset = 0; offset < strippedRootTrack.values.length; offset += 3) {
    strippedRootTrack.values[offset] = restPosition[0];
    strippedRootTrack.values[offset + 1] = restPosition[1];
    strippedRootTrack.values[offset + 2] = restPosition[2];
  }

  return stripped;
}
