import { describe, it } from "vitest";

/**
 * Binary models and media are intentionally not part of the source repository.
 * Keep their acceptance coverage available without making the core test suite
 * depend on a developer's local asset checkout.
 */
export const localAssetDescribe = process.env.DIRECTOR_LOCAL_ASSET_TESTS === "1" ? describe : describe.skip;
export const localAssetIt = process.env.DIRECTOR_LOCAL_ASSET_TESTS === "1" ? it : it.skip;
