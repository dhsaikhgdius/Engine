// @vitest-environment node

import { describe, expect, it } from "vitest";
import { registerDirectorWorkbenchPlugin, type DirectorWorkbenchPluginContext } from "../src/register";

function capturedGuidance(): string {
  const sections: { name: string; order: number; text: string }[] = [];
  const context: DirectorWorkbenchPluginContext = {
    tools: { register: () => {} },
    get: (service: string) =>
      service === "systemPrompt"
        ? {
            section(section: { name: string; order: number; text: string }) {
              sections.push(section);
              return () => {};
            },
          }
        : undefined,
  };
  registerDirectorWorkbenchPlugin(context);
  const guidance = sections.find((section) => section.name === "director:workbench");
  if (!guidance) throw new Error("Director workbench guidance section was not registered");
  return guidance.text;
}

describe("Director DSH agent guidance", () => {
  it("declares the canonical source order and points at describe for exact vocabulary", () => {
    const guidance = capturedGuidance();
    expect(guidance).toContain("Canonical source order");
    expect(guidance).toContain("describe wins");
    expect(guidance).toContain('{"op":"describe","target":"author.add_object"}');
    expect(guidance).toContain('{"op":"describe","target":"create_blockout"}');
    expect(guidance).toContain('{"op":"describe","target":"interchange"}');
    expect(guidance).toContain("director_game");
  });

  it("teaches the white-box principles instead of primitive assembly", () => {
    const guidance = capturedGuidance();
    expect(guidance).toContain("geometry_type are rejected");
    expect(guidance).toContain("create_blockout");
    expect(guidance).toContain("create_opening");
    expect(guidance).toContain("never a darker box");
    expect(guidance).toContain("35-65mm");
  });

  it("keeps visual acceptance separate from structural audit", () => {
    const guidance = capturedGuidance();
    expect(guidance).toContain("capture or author.evidence");
    expect(guidance).toContain("audit ready=true is structural validation only");
  });

  it("stays principles and pointers instead of a second parameter vocabulary", () => {
    const guidance = capturedGuidance();
    // Exact parameter vocabulary is canonical only in capabilities/describe
    // (channel 1). The system-prompt channel must not re-grow field-level
    // spellings that drift when the contract changes.
    for (const vocabulary of [
      "floor/wall/room/corridor/stairs",
      "wallThickness",
      "grounded:true",
      "createIfMissing",
      '"preserve"',
      "sillHeight",
    ]) {
      expect(guidance).not.toContain(vocabulary);
    }
    expect(guidance.length).toBeLessThan(4600);
  });
});
