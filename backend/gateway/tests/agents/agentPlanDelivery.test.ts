// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { DirectorProject } from "@director/project-schema";
import { getDirectorProjectRevision } from "@director/project-schema";
import { buildAutomaticDeliveryOperation } from "../../agentPlanDelivery";

const revision = getDirectorProjectRevision({ version: 1 } as DirectorProject);

describe("automatic Agent plan delivery", () => {
  it("uses the revision returned by author for an explicit delivery", () => {
    expect(
      buildAutomaticDeliveryOperation(
        {
          op: "author",
          actions: [{ action: "delete_objects", object_ids: ["obsolete"] }],
          camera_id: "camera-hero",
          subject_id: "hero",
        },
        { project_revision: revision },
      ),
    ).toEqual({
      success: true,
      operation: {
        op: "deliver",
        expected_revision: revision,
        quality_profile: "cinematic",
        camera_id: "camera-hero",
        subject_id: "hero",
        width: 1280,
        height: 720,
        render_passes: ["clean", "depth", "normal", "object-id", "mask"],
      },
    });
  });

  it("fails closed when author does not return a committed revision", () => {
    expect(
      buildAutomaticDeliveryOperation(
        {
          op: "author",
          actions: [{ action: "delete_objects", object_ids: ["obsolete"] }],
        },
        { changed: true },
      ),
    ).toMatchObject({ success: false });
  });

  it("derives automatic delivery settings from the author request", () => {
    expect(
      buildAutomaticDeliveryOperation(
        {
          op: "author",
          actions: [{ action: "delete_objects", object_ids: ["obsolete"] }],
          delivery: {
            quality_profile: "blocking",
            width: 960,
            height: 540,
            render_passes: ["clean", "normal"],
          },
        },
        { project_revision: revision },
      ),
    ).toEqual({
      success: true,
      operation: {
        op: "deliver",
        expected_revision: revision,
        quality_profile: "blocking",
        width: 960,
        height: 540,
        render_passes: ["clean", "normal"],
      },
    });
  });
});
