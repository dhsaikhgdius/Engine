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
  it("teaches the white-box workflow instead of primitive assembly", () => {
    const guidance = capturedGuidance();
    expect(guidance).toContain("geometry_type are rejected");
    expect(guidance).toContain("create_blockout");
    expect(guidance).toContain("create_opening");
    expect(guidance).toContain("floor/wall/room/corridor/stairs");
    expect(guidance).toContain('modelNormalization "preserve"');
    expect(guidance).toContain("grounded:true");
    expect(guidance).toContain("never a darker box");
    expect(guidance).toContain("35-65mm");
  });

  it("keeps visual acceptance separate from structural audit", () => {
    const guidance = capturedGuidance();
    expect(guidance).toContain("capture or author.evidence");
    expect(guidance).toContain("audit ready=true is structural validation only");
  });
});
