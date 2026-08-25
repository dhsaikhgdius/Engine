import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultDirectorProject, useDirectorStore } from "../../src/comprehensive/editor/store/directorStore";
import { getDirectorProjectRevision } from "@director/project-schema";
import { resetDirectorWorkbenchRuntimeForTests } from "../../src/agent/directorWorkbenchExecutor";
import {
  executeDirectorStoryboardWorkbenchCommand,
  resetDirectorStoryboardWorkbenchRuntimeForTests,
} from "../../src/agent/directorStoryboardWorkbench";

function prepareStoryboard() {
  const project = createDefaultDirectorProject();
  const cameraId = project.cameras[0]!.id;
  project.storyboard = {
    version: 1,
    title: "Agent 分镜",
    logline: "",
    shots: [
      {
        id: "shot-a",
        title: "建立",
        cameraId,
        frameStart: 0,
        frameEnd: 23,
        shotSize: "wide",
        movement: "static",
        action: "",
      },
      {
        id: "shot-b",
        title: "反应",
        cameraId,
        frameStart: 24,
        frameEnd: 47,
        shotSize: "close-up",
        movement: "pan",
        action: "",
      },
    ],
  };
  useDirectorStore.getState().replaceProject(project);
  return useDirectorStore.getState().project;
}

beforeEach(() => {
  localStorage.clear();
  resetDirectorWorkbenchRuntimeForTests();
  resetDirectorStoryboardWorkbenchRuntimeForTests();
  prepareStoryboard();
});

describe("Agent storyboard artifacts", () => {
  it("captures every missing shot against one immutable revision and commits one atomic storyboard mutation", async () => {
    const before = useDirectorStore.getState().project;
    const revision = getDirectorProjectRevision(before);
    const captureThumbnail = vi.fn(async (_project, shot, _signal) => ({
      mediaId: `creative-media:image:${shot.id}`,
      cameraId: shot.cameraId!,
      frame: shot.frameStart,
      width: 960,
      height: 540,
      capturedAt: "2026-08-07T00:00:00.000Z",
    }));

    const execution = await executeDirectorStoryboardWorkbenchCommand(
      {
        action: "capture_missing",
        expected_revision: revision,
        idempotency_key: "storyboard-capture-missing-v1",
      },
      undefined,
      { scope: "scene-a", dependencies: { captureThumbnail } },
    );

    expect(execution).toMatchObject({
      success: true,
      result: {
        storyboard_artifact: {
          action: "capture_missing",
          captured: 2,
          shot_ids: ["shot-a", "shot-b"],
        },
      },
    });
    expect(captureThumbnail).toHaveBeenCalledTimes(2);
    expect(captureThumbnail.mock.calls.every((call) => call[2] instanceof AbortSignal)).toBe(true);
    expect(useDirectorStore.getState().project.storyboard?.shots).toMatchObject([
      { id: "shot-a", thumbnail: { mediaId: "creative-media:image:shot-a", frame: 0 } },
      { id: "shot-b", thumbnail: { mediaId: "creative-media:image:shot-b", frame: 24 } },
    ]);
    expect(getDirectorProjectRevision(useDirectorStore.getState().project)).not.toBe(revision);
  });

  it("rejects a stale revision before any expensive viewport capture", async () => {
    const captureThumbnail = vi.fn();
    const stale = `director-project-revision:v1:sha256:${"f".repeat(64)}`;
    const execution = await executeDirectorStoryboardWorkbenchCommand(
      {
        action: "capture_thumbnail",
        shot_id: "shot-a",
        expected_revision: stale,
        idempotency_key: "storyboard-capture-stale-v1",
      },
      undefined,
      { dependencies: { captureThumbnail } },
    );
    expect(execution).toMatchObject({ success: false, result: { code: "stale_project_revision" } });
    expect(captureThumbnail).not.toHaveBeenCalled();
  });

  it("returns a bounded package manifest while keeping PDF bytes in the browser", async () => {
    const revision = getDirectorProjectRevision(useDirectorStore.getState().project);
    const result = {
      pdfBytes: Uint8Array.from([1, 2, 3]),
      pages: [],
      manifest: {
        contract: "director-storyboard-pdf-v1",
        pages: [],
        pdf: { path: "director-storyboard.pdf", bytes: 3 },
      },
    };
    const createPdf = vi.fn(async () => result as never);
    const downloadPackage = vi.fn(async () => undefined);

    const execution = await executeDirectorStoryboardWorkbenchCommand(
      {
        action: "export_pdf",
        paper_size: "letter",
        orientation: "portrait",
        columns: 4,
        scope: "selected",
        shot_ids: ["shot-b"],
        include_metadata: false,
        include_action: true,
        artifact: "verification-package",
        download: true,
        expected_revision: revision,
        idempotency_key: "storyboard-export-v1",
      },
      undefined,
      { dependencies: { createPdf, downloadPackage } },
    );

    expect(createPdf).toHaveBeenCalledWith(
      expect.any(Object),
      {
        paperSize: "letter",
        orientation: "portrait",
        columns: 4,
        scope: "selected",
        selectedShotIds: ["shot-b"],
        includeMetadata: false,
        includeAction: true,
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(downloadPackage).toHaveBeenCalledWith(result);
    expect(execution).toMatchObject({
      success: true,
      result: {
        storyboard_artifact: {
          artifact: "verification-package",
          downloaded: true,
          manifest: result.manifest,
        },
      },
    });
    expect(JSON.stringify(execution)).not.toContain("pdfBytes");
  });

  it("replays an exact capture without capturing or committing twice", async () => {
    const revision = getDirectorProjectRevision(useDirectorStore.getState().project);
    const captureThumbnail = vi.fn(async (_project, shot, _signal) => ({
      mediaId: `creative-media:image:${shot.id}`,
      cameraId: shot.cameraId!,
      frame: shot.frameStart,
      width: 960,
      height: 540,
      capturedAt: "2026-08-13T00:00:00.000Z",
    }));
    const command = {
      action: "capture_thumbnail" as const,
      shot_id: "shot-a",
      expected_revision: revision,
      idempotency_key: "storyboard-capture-exact-retry-v1",
    };

    const first = await executeDirectorStoryboardWorkbenchCommand(command, undefined, {
      scope: "scene-a",
      dependencies: { captureThumbnail },
    });
    const second = await executeDirectorStoryboardWorkbenchCommand(command, undefined, {
      scope: "scene-a",
      dependencies: { captureThumbnail },
    });

    expect(first).toMatchObject({ success: true, result: { idempotency_replayed: false } });
    expect(second).toMatchObject({ success: true, result: { idempotency_replayed: true } });
    expect(captureThumbnail).toHaveBeenCalledTimes(1);
  });
});
