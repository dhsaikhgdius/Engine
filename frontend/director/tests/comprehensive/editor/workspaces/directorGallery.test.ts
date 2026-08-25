import { describe, expect, it } from "vitest";
import {
  findDirectorGalleryDuplicateGroups,
  normalizeDirectorGalleryState,
  previewDirectorGalleryBatchRename,
} from "../../../../src/comprehensive/editor/workspaces/directorGallery";

describe("Director Gallery domain", () => {
  it("normalizes folders, breaks cycles, and drops empty media overlays", () => {
    const normalized = normalizeDirectorGalleryState({
      galleryFolders: [
        { id: "a", name: "A", parentId: "b", createdAt: "2026-08-07T00:00:00.000Z" },
        { id: "b", name: "B", parentId: "a", createdAt: "2026-08-07T00:00:00.000Z" },
      ],
      galleryMedia: [
        {
          mediaId: "plain",
          rating: 0,
          tags: [],
          color: "none",
          customName: null,
          notes: "",
          folderId: null,
          addedAt: null,
          trashedAt: null,
        },
        {
          mediaId: "reviewed",
          rating: 9,
          tags: [" hero ", "Hero", "night   exterior"],
          color: "red",
          customName: "  Select  ",
          notes: "Keep",
          folderId: "missing",
          addedAt: "2026-08-07T00:00:00.000Z",
          trashedAt: null,
        },
      ],
    });

    expect(normalized.galleryFolders.some((folder) => folder.parentId === null)).toBe(true);
    expect(normalized.galleryMedia).toEqual([
      expect.objectContaining({
        mediaId: "reviewed",
        rating: 5,
        tags: ["hero", "night exterior"],
        customName: "Select",
        folderId: null,
      }),
    ]);
  });

  it("previews deterministic template and regex batch renames", () => {
    const items = [
      { id: "one", name: "Hero Take.png", kind: "image", createdAt: "2026-08-07T10:00:00.000Z" },
      { id: "two", name: "Hero Wide.png", kind: "image", createdAt: "2026-08-08T10:00:00.000Z" },
    ];
    expect(previewDirectorGalleryBatchRename(items, { mode: "template", template: "shot_{index}_{name}" })).toEqual([
      { id: "one", before: "Hero Take.png", after: "shot_001_Hero Take" },
      { id: "two", before: "Hero Wide.png", after: "shot_002_Hero Wide" },
    ]);
    expect(
      previewDirectorGalleryBatchRename(items, { mode: "regex", pattern: "Hero\\s+", replacement: "", flags: "g" }),
    ).toEqual([
      { id: "one", before: "Hero Take.png", after: "Take.png" },
      { id: "two", before: "Hero Wide.png", after: "Wide.png" },
    ]);
  });

  it("groups content-addressed and equal data-url media", () => {
    expect(
      findDirectorGalleryDuplicateGroups([
        { id: "import:one", kind: "image", sourceUrl: "blob:one", contentHash: "sha256:abc" },
        { id: "import:two", kind: "image", sourceUrl: "blob:two", contentHash: "sha256:abc" },
        { id: "capture:one", kind: "image", sourceUrl: "data:image/png;base64,same" },
        { id: "capture:two", kind: "image", sourceUrl: "data:image/png;base64,same" },
      ]),
    ).toEqual([
      expect.objectContaining({ ids: ["import:one", "import:two"] }),
      expect.objectContaining({ ids: ["capture:one", "capture:two"] }),
    ]);
  });
});
