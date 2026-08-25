import { describe, expect, it } from "vitest";
import { attachDirectorAgentOutcomes, collectDirectorAgentOutcomes } from "../../agents/agentToolOutcomes";

describe("director agent orthogonal outcomes", () => {
  it("keeps a completed capture and a later scene revision as two outcomes", () => {
    expect(
      collectDirectorAgentOutcomes({
        success: true,
        code: "stale_project_revision",
        result: {
          stale_after_capture: true,
          expected_revision: "rev-1",
          actual_revision: "rev-2",
          capture: { fingerprint: "sha256:abc", locator: "spill://x" },
        },
      }).map((outcome) => outcome.kind),
    ).toEqual(["completed", "stale_revision"]);
  });

  it("keeps an idempotent replay that is now stale as completed plus stale", () => {
    expect(
      collectDirectorAgentOutcomes({
        success: true,
        result: { replay_stale: true, project_revision: "rev-old" },
      }).map((outcome) => outcome.kind),
    ).toEqual(["completed", "stale_revision"]);
  });

  it("does not fold a transport timeout into a generic failure when no work completed", () => {
    expect(
      collectDirectorAgentOutcomes({
        success: false,
        code: "gateway_transport_timeout",
        error: "timed out",
      }).map((outcome) => outcome.kind),
    ).toEqual(["timed_out"]);
  });

  it("reports timeout together with completed work when both are present", () => {
    expect(
      collectDirectorAgentOutcomes({
        success: true,
        code: "command_timeout",
        result: { project_revision: "rev-1", capture: { fingerprint: "sha256:ok" } },
      }).map((outcome) => outcome.kind),
    ).toEqual(["completed", "timed_out"]);
  });

  it("keeps outcome_unknown distinct from failed", () => {
    expect(
      collectDirectorAgentOutcomes({
        success: false,
        code: "outcome_unknown",
        result: { project_committed: "unknown" },
      }).map((outcome) => outcome.kind),
    ).toEqual(["outcome_unknown"]);
  });

  it("reports a stale guard with no evidence as failed plus stale", () => {
    expect(
      collectDirectorAgentOutcomes({
        success: false,
        code: "stale_project_revision",
        error: "Stale project revision",
      }).map((outcome) => outcome.kind),
    ).toEqual(["stale_revision", "failed"]);
  });

  it("attaches outcomes on the envelope without dropping success", () => {
    const attached = attachDirectorAgentOutcomes({
      success: true,
      result: { stale_after_capture: true, label: "机位01" },
    });
    expect(attached.success).toBe(true);
    expect(attached.outcomes.map((outcome) => outcome.kind)).toEqual(["completed", "stale_revision"]);
  });
});
