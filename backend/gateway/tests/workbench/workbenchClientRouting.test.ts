import { describe, expect, it } from "vitest";
import { rankUntargetedWorkbenchClients, workbenchOperationRequiresCapture } from "../../workbenchClientRouting";

describe("untargeted Workbench browser routing", () => {
  const canvas = {
    visible: true,
    lastSeenAt: 300,
    workspace: "canvas" as const,
    captureReady: false,
  };
  const captureReadyCanvas = {
    visible: true,
    lastSeenAt: 350,
    workspace: "canvas" as const,
    captureReady: true,
  };
  const hiddenStage = {
    visible: false,
    lastSeenAt: 100,
    workspace: "stage" as const,
    captureReady: true,
  };
  const mountingStage = {
    visible: true,
    lastSeenAt: 400,
    workspace: "stage" as const,
    captureReady: false,
  };

  it("prefers a capture-ready Stage over a newer visible Canvas for preflight observe", () => {
    expect(
      rankUntargetedWorkbenchClients(
        [
          ["canvas", canvas],
          ["stage", hiddenStage],
          ["mounting", mountingStage],
        ],
        { op: "observe" },
      ),
    ).toEqual(["stage", "mounting", "canvas"]);
  });

  it.each(["capture", "shot_package", "deliver", "storyboard_artifact"] as const)(
    "filters %s to capture-ready Stage clients before an exact lease exists",
    (op) => {
      expect(
        rankUntargetedWorkbenchClients(
          [
            ["canvas", canvas],
            ["stage", hiddenStage],
            ["mounting", mountingStage],
            ["agent-host", captureReadyCanvas],
          ],
          { op },
        ),
      ).toEqual(["agent-host", "stage"]);
      expect(workbenchOperationRequiresCapture({ op })).toBe(true);
    },
  );

  it("retains visibility and recency ordering between equally capable Stage tabs", () => {
    expect(
      rankUntargetedWorkbenchClients(
        [
          ["hidden-new", { ...hiddenStage, lastSeenAt: 500 }],
          ["visible-old", { ...hiddenStage, visible: true, lastSeenAt: 50 }],
          ["visible-new", { ...hiddenStage, visible: true, lastSeenAt: 60 }],
        ],
        { op: "observe" },
      ),
    ).toEqual(["visible-new", "visible-old", "hidden-new"]);
  });
});
