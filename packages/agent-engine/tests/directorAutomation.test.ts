import { describe, expect, it } from "vitest";
import {
  DIRECTOR_AUTOMATION_STORAGE_KEY,
  exportDirectorAutomationLibrary,
  forgetDirectorMemory,
  pinDirectorMemory,
  readDirectorAutomationLibrary,
  recallDirectorMemories,
  removeDirectorMacro,
  resolveDirectorMacroActions,
  saveDirectorMacro,
} from "../src/directorAutomation";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    values,
  };
}

describe("Director automation library", () => {
  it("ships validated, parameterized built-in macros", () => {
    const storage = memoryStorage();
    const library = readDirectorAutomationLibrary(storage);
    const reset = library.macros.find((macro) => macro.id === "reset-transform")!;
    expect(resolveDirectorMacroActions(reset, { object_id: "hero" })).toEqual([
      expect.objectContaining({ action: "update_object", object_id: "hero" }),
    ]);
    const lights = library.macros.find((macro) => macro.id === "warm-three-point-lighting")!;
    expect(resolveDirectorMacroActions(lights, { prefix: "shot-12" })).toEqual([
      expect.objectContaining({ action: "add_light", light: expect.objectContaining({ id: "shot-12-key" }) }),
      expect.objectContaining({ action: "add_light", light: expect.objectContaining({ id: "shot-12-fill" }) }),
      expect.objectContaining({ action: "add_light", light: expect.objectContaining({ id: "shot-12-rim" }) }),
    ]);
  });

  it("validates resolved author actions before persisting a macro", () => {
    const storage = memoryStorage();
    const macro = saveDirectorMacro(
      {
        id: "rename-object",
        name: "Rename object",
        description: "",
        parameters: [
          { name: "object_id", label: "Object", description: "", type: "string", default: "object-id" },
          { name: "name", label: "Name", description: "", type: "string", default: "Hero" },
        ],
        actions: [{ action: "update_object", object_id: { $param: "object_id" }, patch: { name: { $param: "name" } } }],
      },
      { storage, createdBy: "agent" },
    );
    expect(macro.createdBy).toBe("agent");
    expect(resolveDirectorMacroActions(macro, { object_id: "hero", name: "Lead" })).toEqual([
      { action: "update_object", object_id: "hero", patch: { name: "Lead" } },
    ]);
    expect(
      saveDirectorMacro(
        {
          id: "rename-object",
          name: "Rename object",
          description: "",
          parameters: [
            { name: "object_id", label: "Object", description: "", type: "string", default: "object-id" },
            { name: "name", label: "Name", description: "", type: "string", default: "Hero" },
          ],
          actions: [
            { action: "update_object", object_id: { $param: "object_id" }, patch: { name: { $param: "name" } } },
          ],
        },
        { storage, createdBy: "agent" },
      ),
    ).toEqual(macro);
    expect(() => resolveDirectorMacroActions(macro, { missing: "value" })).toThrow("Unknown macro parameter");
    expect(readDirectorAutomationLibrary(storage).macros.some((entry) => entry.id === macro.id)).toBe(true);
    expect(removeDirectorMacro(macro.id, storage)?.id).toBe(macro.id);
  });

  it("keeps explicit memories scoped, searchable, removable, and export-verifiable", () => {
    const storage = memoryStorage();
    pinDirectorMemory(
      {
        id: "memory-global-style",
        text: "Prefer restrained warm highlights.",
        category: "look",
        tags: ["lighting"],
        scope: "global",
        sceneId: null,
        createdBy: "human",
      },
      { storage },
    );
    const sceneMemory = pinDirectorMemory(
      {
        id: "memory-scene-hero",
        text: "The hero always enters from camera left.",
        category: "continuity",
        tags: ["hero"],
        scope: "scene",
        sceneId: "scene-a",
        createdBy: "agent",
      },
      { storage },
    );
    expect(
      pinDirectorMemory(
        {
          id: "memory-scene-hero",
          text: "The hero always enters from camera left.",
          category: "continuity",
          tags: ["hero"],
          scope: "scene",
          sceneId: "scene-a",
          createdBy: "agent",
        },
        { storage },
      ),
    ).toEqual(sceneMemory);
    expect(recallDirectorMemories({ scope: "scene", sceneId: "scene-a", query: "camera" }, storage)).toEqual([
      expect.objectContaining({ id: "memory-scene-hero" }),
    ]);
    expect(recallDirectorMemories({ scope: "global" }, storage)).toHaveLength(1);
    expect(forgetDirectorMemory("memory-global-style", storage)?.id).toBe("memory-global-style");
    const exported = exportDirectorAutomationLibrary(storage);
    expect(exported.contract).toBe("director-automation-export:v1");
    expect(JSON.parse(exported.content)).toMatchObject({ version: 1 });
    expect(storage.values.has(DIRECTOR_AUTOMATION_STORAGE_KEY)).toBe(true);
  });
});
