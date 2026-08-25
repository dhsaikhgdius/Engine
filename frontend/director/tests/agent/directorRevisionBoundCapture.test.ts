import { beforeEach, describe, expect, it } from "vitest";
import { createDefaultDirectorProject, useDirectorStore } from "../../src/comprehensive/editor/store/directorStore";
import { getDirectorProjectRevision } from "@director/project-schema";
import {
  DirectorProjectRevisionConflictError,
  runWithDirectorProjectRevision,
} from "../../src/agent/directorRevisionBoundCapture";

describe("revision-bound Director capture", () => {
  beforeEach(() => {
    useDirectorStore.getState().replaceProject(createDefaultDirectorProject());
  });

  it("provides an immutable snapshot when the revision remains current", async () => {
    const expectedRevision = getDirectorProjectRevision(useDirectorStore.getState().project);
    const capturedColor = await runWithDirectorProjectRevision(expectedRevision, async ({ project, signal }) => {
      expect(signal.aborted).toBe(false);
      expect(project).not.toBe(useDirectorStore.getState().project);
      return project.scene.backgroundColor;
    });
    expect(capturedColor).toBe(useDirectorStore.getState().project.scene.backgroundColor);
  });

  it("rejects before capture when the observed revision is stale", async () => {
    const staleRevision = getDirectorProjectRevision(useDirectorStore.getState().project);
    useDirectorStore.getState().replaceProject({
      ...useDirectorStore.getState().project,
      scene: { ...useDirectorStore.getState().project.scene, backgroundColor: "#112233" },
    });
    let called = false;

    await expect(
      runWithDirectorProjectRevision(staleRevision, async () => {
        called = true;
      }),
    ).rejects.toMatchObject({
      code: "stale_project_revision",
      expectedRevision: staleRevision,
    });
    expect(called).toBe(false);
  });

  it("ignores UI-only store updates that keep the immutable project reference", async () => {
    const expectedRevision = getDirectorProjectRevision(useDirectorStore.getState().project);
    const result = await runWithDirectorProjectRevision(expectedRevision, async ({ signal }) => {
      useDirectorStore.setState({ selectedObjectId: "hero" });
      expect(signal.aborted).toBe(false);
      return "captured";
    });
    expect(result).toBe("captured");
  });

  it("aborts and rejects the complete evidence set when the project changes in flight", async () => {
    const expectedRevision = getDirectorProjectRevision(useDirectorStore.getState().project);
    await expect(
      runWithDirectorProjectRevision(expectedRevision, async ({ signal }) => {
        useDirectorStore.getState().replaceProject({
          ...useDirectorStore.getState().project,
          scene: { ...useDirectorStore.getState().project.scene, backgroundColor: "#334455" },
        });
        expect(signal.aborted).toBe(true);
        throw signal.reason;
      }),
    ).rejects.toBeInstanceOf(DirectorProjectRevisionConflictError);
  });

  it("keeps completed evidence when the live project changes after capture returns", async () => {
    const expectedRevision = getDirectorProjectRevision(useDirectorStore.getState().project);
    const frame = await runWithDirectorProjectRevision(expectedRevision, async () => "frame");
    useDirectorStore.getState().replaceProject({
      ...useDirectorStore.getState().project,
      scene: { ...useDirectorStore.getState().project.scene, backgroundColor: "#445566" },
    });
    expect(frame).toBe("frame");
    expect(getDirectorProjectRevision(useDirectorStore.getState().project)).not.toBe(expectedRevision);
  });

  it("forwards an external gateway cancellation to the active capture", async () => {
    const expectedRevision = getDirectorProjectRevision(useDirectorStore.getState().project);
    const controller = new AbortController();
    const capture = runWithDirectorProjectRevision(
      expectedRevision,
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      controller.signal,
    );

    controller.abort(new DOMException("gateway timeout", "AbortError"));
    await expect(capture).rejects.toMatchObject({ name: "AbortError" });
  });
});
