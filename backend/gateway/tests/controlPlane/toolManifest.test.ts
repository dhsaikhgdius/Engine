import { describe, expect, it } from "vitest";
import {
  buildDirectorToolManifest,
  DIRECTOR_TOOL_MANIFEST_CONTRACT,
  directorToolManifestSchema,
} from "../../controlPlane/toolManifest";

describe("director tool manifest", () => {
  const manifest = buildDirectorToolManifest(new Date("2026-08-25T00:00:00.000Z"));
  const byName = new Map(manifest.tools.map((tool) => [tool.name, tool]));

  it("validates against its own wire schema", () => {
    expect(manifest.contract).toBe(DIRECTOR_TOOL_MANIFEST_CONTRACT);
    expect(manifest.generated_at).toBe("2026-08-25T00:00:00.000Z");
    expect(() => directorToolManifestSchema.parse(manifest)).not.toThrow();
  });

  it("lists typed tools on both surfaces with POST /api/tools bindings", () => {
    for (const name of ["director_workbench", "director_creative", "stage_video", "blender_native", "director_dcc"]) {
      expect(byName.get(name)).toMatchObject({
        surface: "both",
        http: { method: "POST", path: `/api/tools/${name}` },
      });
      expect(byName.get(name)?.legacy).toBeUndefined();
    }
    expect(byName.get("director_workbench")?.category).toBe("targeted");
    expect(byName.get("director_workbench")?.operations).toContain("author");
    expect(byName.get("director_creative")?.operations).toEqual(
      expect.arrayContaining(["interchange", "collaboration", "execute", "execute_batch"]),
    );
    expect(byName.get("blender_native")?.operations).toContain("apply");
  });

  it("marks stage_* commands as legacy HTTP-only compatibility routes", () => {
    for (const name of ["stage_read", "stage_scene", "stage_object", "stage_camera", "stage_show"]) {
      expect(byName.get(name)).toMatchObject({
        surface: "http",
        category: "stage",
        legacy: true,
        http: { method: "POST", path: `/api/tools/${name}` },
      });
    }
  });

  it("does not pretend MCP-only tools have a POST /api/tools binding", () => {
    expect(byName.get("director_film")).toMatchObject({ surface: "mcp", http: null });
    expect(byName.get("director_film")?.operations).toEqual(
      expect.arrayContaining(["create", "list", "status", "resume", "cancel", "approve"]),
    );
    expect(byName.get("director_production")).toMatchObject({ surface: "mcp", http: null });
    expect(byName.get("director_production")?.operations).toContain("promote");
  });

  it("contains no credential-shaped values", () => {
    const serialized = JSON.stringify(manifest);
    for (const marker of ["API_KEY", "TOKEN", "SECRET", "Bearer ", "sk-"]) {
      expect(serialized).not.toContain(marker);
    }
  });
});
