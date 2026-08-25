import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setDirectorCreativeWorkspaceScope } from "../../../../src/comprehensive/editor/workspaces/directorWorkspaceStore";
import {
  DIRECTOR_MEDIA_REVIEW_STORAGE_PREFIX,
  addDirectorMediaTag,
  clearDirectorMediaReviews,
  getDirectorMediaReviewSnapshot,
  parseDirectorMediaReviewSnapshot,
  removeDirectorMediaTag,
  setDirectorMediaRating,
} from "../../../../src/comprehensive/editor/workspaces/directorMediaReviewStore";

beforeEach(() => {
  setDirectorCreativeWorkspaceScope("media-review-test");
  clearDirectorMediaReviews();
});

afterEach(() => {
  clearDirectorMediaReviews();
  setDirectorCreativeWorkspaceScope("local");
});

describe("Director media review metadata", () => {
  it("normalizes ratings and tags while rejecting malformed persisted data", () => {
    const snapshot = parseDirectorMediaReviewSnapshot(
      JSON.stringify({
        version: 1,
        reviews: {
          "media-1": { rating: 9, tags: [" hero ", "Hero", "night   exterior", 42] },
          "media-2": { rating: "bad", tags: null },
          __proto__: { rating: 5, tags: ["unsafe"] },
        },
      }),
    );

    expect(snapshot).toEqual({
      "media-1": { rating: 5, tags: ["hero", "night exterior"] },
    });
    expect(parseDirectorMediaReviewSnapshot("{broken")).toEqual({});
  });

  it("persists rating and tag changes in the active workspace scope", () => {
    setDirectorMediaRating("capture:hero", 4);
    addDirectorMediaTag("capture:hero", "精选");
    addDirectorMediaTag("capture:hero", " 夜景 ");
    addDirectorMediaTag("capture:hero", "夜景");

    expect(getDirectorMediaReviewSnapshot()["capture:hero"]).toEqual({ rating: 4, tags: ["精选", "夜景"] });
    const serialized = window.localStorage.getItem(`${DIRECTOR_MEDIA_REVIEW_STORAGE_PREFIX}.media-review-test`);
    expect(serialized).toContain('"rating":4');
    expect(serialized).toContain("精选");

    removeDirectorMediaTag("capture:hero", "精选");
    setDirectorMediaRating("capture:hero", 0);
    expect(getDirectorMediaReviewSnapshot()["capture:hero"]).toEqual({ rating: 0, tags: ["夜景"] });
  });

  it("keeps reviews isolated when switching project workspaces", () => {
    setDirectorMediaRating("shot:one", 5);
    setDirectorCreativeWorkspaceScope("media-review-other");
    clearDirectorMediaReviews();

    expect(getDirectorMediaReviewSnapshot()["shot:one"]).toBeUndefined();
    setDirectorMediaRating("shot:one", 2);

    setDirectorCreativeWorkspaceScope("media-review-test");
    expect(getDirectorMediaReviewSnapshot()["shot:one"]?.rating).toBe(5);
  });
});
