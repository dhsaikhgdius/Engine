import { expect, it } from "vitest";
import { DEFAULT_DIRECTOR_GALLERY_PREFS, createDefaultDirectorGalleryMediaRecord } from "../../../../src/comprehensive/editor/workspaces/directorGallery";
import { selectDirectorGalleryItems } from "../../../../src/comprehensive/editor/workspaces/directorGalleryView";
import type { DirectorMediaItem } from "../../../../src/comprehensive/editor/workspaces/directorMediaLibrary";

const items: DirectorMediaItem[] = [
  {
    id: "one",
    kind: "image",
    collection: "imports",
    name: "Morning",
    subtitle: "PNG",
    thumbnailUrl: "data:image/png;base64,same",
    sourceUrl: "data:image/png;base64,same",
    durationSec: 3,
    cameraId: null,
    frameStart: null,
    frameEnd: null,
    createdAt: "2026-08-07T00:00:00.000Z",
    embeddedMetadata: { prompt: '{"1":{"class_type":"CLIPTextEncode","inputs":{"text":"golden sunrise"}}}' },
  },
  {
    id: "two",
    kind: "image",
    collection: "captures",
    name: "Copy",
    subtitle: "PNG",
    thumbnailUrl: "data:image/png;base64,same",
    sourceUrl: "data:image/png;base64,same",
    durationSec: 3,
    cameraId: null,
    frameStart: null,
    frameEnd: null,
    createdAt: "2026-08-08T00:00:00.000Z",
  },
];

it("filters metadata, folders, trash, and duplicate groups with persisted sorting", () => {
  const first = {
    ...createDefaultDirectorGalleryMediaRecord("one"),
    rating: 5,
    tags: ["hero"],
    color: "green" as const,
    folderId: "folder-a",
    addedAt: "2026-08-07T00:00:00.000Z",
  };
  const second = {
    ...createDefaultDirectorGalleryMediaRecord("two"),
    trashedAt: "2026-08-08T00:00:00.000Z",
  };
  const filters = {
    query: "sunrise",
    kind: "all" as const,
    collection: "all" as const,
    minimumRating: 4,
    tag: "hero",
    color: "green" as const,
    duplicatesOnly: true,
  };
  expect(
    selectDirectorGalleryItems(
      items,
      [first, second],
      [{ id: "folder-a", name: "A", parentId: null, createdAt: "2026-08-07T00:00:00.000Z" }],
      { ...DEFAULT_DIRECTOR_GALLERY_PREFS, activeFolderId: "folder-a" },
      filters,
    ).map((entry) => entry.item.id),
  ).toEqual(["one"]);

  expect(
    selectDirectorGalleryItems(
      items,
      [first, second],
      [],
      { ...DEFAULT_DIRECTOR_GALLERY_PREFS, showTrash: true },
      { ...filters, query: "", minimumRating: 0, tag: null, color: "all", duplicatesOnly: false },
    ).map((entry) => entry.item.id),
  ).toEqual(["two"]);
});
