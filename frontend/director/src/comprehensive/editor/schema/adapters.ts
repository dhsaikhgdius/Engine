/**
 * @module Adapters for converting editor asset kinds to story API asset buckets.
 */

/** Maps a singular asset kind label to its plural story API bucket name. */
export function toStoryAssetKind(kind: "character" | "scene" | "prop") {
  return kind === "character" ? "characters" : kind === "scene" ? "scenes" : "props";
}

/** Builds a story asset payload object from input fields. */
export function buildStoryAssetPayload(input: {
  kind: "character" | "scene" | "prop";
  name: string;
  description: string;
  imageUrl: string;
}) {
  return {
    bucket: toStoryAssetKind(input.kind),
    item: {
      name: input.name,
      description: input.description,
      imageUrl: input.imageUrl,
    },
  };
}
