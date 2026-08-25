import { describe, expect, it } from "vitest";
import { directorAgentToolExecutionMode, directorToolIsConcurrencySafe, dynamicToolTimeoutMs } from "../src/toolPolicy";

describe("Director DSH tool policy", () => {
  it("treats describe and generation polls as concurrency-safe reads", () => {
    expect(directorAgentToolExecutionMode("director_workbench", { op: "describe", target: "capture" })).toBe(
      "parallel",
    );
    expect(
      directorAgentToolExecutionMode("director_workbench", { op: "generated_3d", command: { action: "get" } }),
    ).toBe("parallel");
    expect(
      directorAgentToolExecutionMode("director_workbench", { op: "generated_3d", command: { action: "submit" } }),
    ).toBe("exclusive");
    expect(directorAgentToolExecutionMode("director_creative", { op: "describe", target: "interchange" })).toBe(
      "parallel",
    );
    expect(directorAgentToolExecutionMode("stage_video", { op: "status", job_id: "job-1" })).toBe("parallel");
    expect(directorToolIsConcurrencySafe("director_model_routes", {})).toBe(true);
    expect(directorToolIsConcurrencySafe("director_workbench", { op: "author" })).toBe(false);
  });

  it("gives blender_native five minutes and creative pipeline-await fifteen", () => {
    expect(dynamicToolTimeoutMs("blender_native", { op: "apply" })).toBe(300_000);
    expect(
      dynamicToolTimeoutMs("director_creative", {
        op: "pipeline",
        request: { action: "start", await_completion: true },
      }),
    ).toBe(15 * 60_000);
    expect(dynamicToolTimeoutMs("director_workbench", { op: "observe" })).toBe(70_000);
  });
});
