import { describe, expect, it } from "vitest";
import { createDefaultDirectorProject } from "../src/directorDefaultProject";
import { applyDirectorAuthoringActions, directorAuthoringActionSchema } from "../src/directorAuthoring";
import { auditDirectorProject } from "../src/directorAudit";

const CASES = [
  { id: "solo-front", count: 1, layout: "side-by-side", angle: "front", height: "eye", shot: "full" },
  { id: "duel-facing", count: 2, layout: "facing", angle: "three-quarter", height: "low", shot: "full" },
  { id: "trio-row", count: 3, layout: "side-by-side", angle: "front", height: "eye", shot: "wide" },
  { id: "depth-line", count: 3, layout: "line", angle: "side", height: "eye", shot: "wide" },
  { id: "hero-behind", count: 4, layout: "behind", angle: "three-quarter", height: "high", shot: "wide" },
  { id: "round-table", count: 5, layout: "circle", angle: "three-quarter", height: "overhead", shot: "wide" },
] as const;

describe("semantic Director blocking compiler", () => {
  it.each(CASES)("grounds, separates, faces, and frames $id", (testCase) => {
    const compose = directorAuthoringActionSchema.parse({
      action: "compose_blocking",
      layout: testCase.layout,
      characters: Array.from({ length: testCase.count }, (_, index) => ({
        id: `${testCase.id}-char-${index + 1}`,
        name: `角色 ${index + 1}`,
        pose_preset_id: index % 2 ? "hands-on-hips" : "stand",
        facing: testCase.layout === "facing" || testCase.layout === "circle" ? "toward" : "camera",
      })),
      camera: {
        id: `${testCase.id}-camera`,
        object_id: `${testCase.id}-camera-rig`,
        name: `${testCase.id} 主机位`,
        angle: testCase.angle,
        height: testCase.height,
        shot: testCase.shot,
        aspect_ratio: "16:9",
      },
    });
    const result = applyDirectorAuthoringActions(createDefaultDirectorProject(), [{ action: "start_scene" }, compose]);
    const characters = result.project.objects.filter((object) => object.kind === "character");

    expect(characters).toHaveLength(testCase.count);
    expect(characters.every((object) => object.transform.position[1] === result.project.scene.groundHeight)).toBe(true);
    expect(result.project.activeCameraId).toBe(`${testCase.id}-camera`);

    for (let left = 0; left < characters.length; left += 1) {
      for (let right = left + 1; right < characters.length; right += 1) {
        const a = characters[left].transform.position;
        const b = characters[right].transform.position;
        expect(Math.hypot(a[0] - b[0], a[2] - b[2])).toBeGreaterThanOrEqual(0.9);
      }
    }

    characters.forEach((character) => {
      if (!character.lookTargetObjectId) return;
      const target = characters.find((candidate) => candidate.id === character.lookTargetObjectId)!;
      const dx = target.transform.position[0] - character.transform.position[0];
      const dz = target.transform.position[2] - character.transform.position[2];
      const distance = Math.hypot(dx, dz);
      const yaw = character.transform.rotation[1];
      const alignment = Math.sin(yaw) * (dx / distance) + Math.cos(yaw) * (dz / distance);
      expect(alignment).toBeGreaterThan(0.99);
    });

    const audit = auditDirectorProject(result.project, {
      camera_id: `${testCase.id}-camera`,
      subject_id: `${testCase.id}-char-1`,
    });
    expect(audit.issues.filter((issue) => issue.severity === "error")).toEqual([]);
  });
});
