import { describe, expect, it } from "vitest";
import { buildScriptToCanvasPlan } from "../../../../src/comprehensive/editor/assistant/scriptToProductionPipeline";

const SAMPLE_FOUNTAIN = `
Title: Test Scene

. INT. ALLEY - NIGHT

Rain hits the pavement.

. EXT. ROOFTOP - NIGHT

City lights stretch to the horizon.
`.trim();

describe("scriptToProductionPipeline", () => {
  it("builds canvas sections and storyboard nodes from Fountain text", () => {
    const plan = buildScriptToCanvasPlan(SAMPLE_FOUNTAIN);
    expect(plan.sections).toHaveLength(4);
    expect(plan.storyboardShotCount).toBe(2);
    expect(plan.nodes).toHaveLength(2);
    expect(plan.nodes[0]).toMatchObject({
      kind: "note",
      sectionId: plan.sections[0]!.id,
      productionJobId: null,
      productionJobStatus: null,
    });
  });

  it("keeps workflow sections when Fountain has no shots", () => {
    const plan = buildScriptToCanvasPlan("Title: Empty\n\nJust dialogue.");
    expect(plan.storyboardShotCount).toBe(0);
    expect(plan.nodes).toHaveLength(1);
    expect(plan.warnings.some((warning) => warning.includes("未解析出分镜"))).toBe(true);
  });
});
