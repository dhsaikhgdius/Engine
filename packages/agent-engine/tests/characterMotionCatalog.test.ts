import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { localAssetIt } from "../../protocol/tests/localAssetTest";
import {
  DIRECTOR_CHARACTER_MOTION_CATALOG,
  getDirectorCharacterMotion,
  isDirectorCharacterMotionId,
  isDirectorLocomotionMotion,
} from "../src/characterMotionCatalog";

describe("packaged character motion catalog", () => {
  it("exposes a unique, Agent-discoverable core motion set", () => {
    expect(DIRECTOR_CHARACTER_MOTION_CATALOG.map((item) => item.id)).toEqual([
      "idle",
      "walk",
      "walk-back",
      "walk-left",
      "walk-right",
      "run",
      "run-back",
      "run-left",
      "run-right",
      "wave",
      "clap",
      "sit-idle",
      "jump",
      "talk",
    ]);
    expect(new Set(DIRECTOR_CHARACTER_MOTION_CATALOG.map((item) => item.id)).size).toBe(
      DIRECTOR_CHARACTER_MOTION_CATALOG.length,
    );
    expect(isDirectorCharacterMotionId("walk")).toBe(true);
    expect(isDirectorCharacterMotionId("teleport")).toBe(false);
    expect(getDirectorCharacterMotion("wave")).toMatchObject({ category: "gesture", defaultLoop: "once" });
  });

  it("classifies the whole gait family as locomotion so in-place playback grounds the feet", () => {
    const locomotionIds = DIRECTOR_CHARACTER_MOTION_CATALOG.filter((item) => item.category === "locomotion").map(
      (item) => item.id,
    );
    expect(locomotionIds).toEqual([
      "walk",
      "walk-back",
      "walk-left",
      "walk-right",
      "run",
      "run-back",
      "run-left",
      "run-right",
    ]);
    locomotionIds.forEach((clipId) => expect(isDirectorLocomotionMotion(clipId)).toBe(true));
    ["idle", "wave", "sit-idle", "jump", "talk", "teleport"].forEach((clipId) =>
      expect(isDirectorLocomotionMotion(clipId)).toBe(false),
    );
  });

  localAssetIt("keeps every manifest hash synchronized with its packaged GLB", () => {
    for (const item of DIRECTOR_CHARACTER_MOTION_CATALOG) {
      const bytes = readFileSync(resolve(process.cwd(), "assets", "library", item.url.replace(/^\//, "")));
      expect(bytes.subarray(0, 4).toString("utf8")).toBe("glTF");
      expect(bytes.byteLength).toBe(item.byteLength);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(item.sha256);
    }
  });
});
