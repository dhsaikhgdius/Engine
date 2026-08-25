import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BLENDER_LIVE_CONTRACT,
  blenderLiveSceneSnapshotSchema,
  blenderLiveStatusSchema,
} from "@director/protocol/blender-live";
import { BlenderProjectSyncBridge } from "../../../../src/comprehensive/editor/runtime/BlenderProjectSyncBridge";
import { buildDirectorBlenderOperations } from "../../../../src/comprehensive/editor/canvas/BlenderSceneLayer";
import { applyBlenderRuntimeOperations } from "../../../../src/comprehensive/editor/runtime/blenderRuntimeTransactions";
import { useBlenderRuntimeStore } from "../../../../src/comprehensive/editor/runtime/blenderRuntimeStore";
import { useDirectorStore } from "../../../../src/comprehensive/editor/store/directorStore";
import { getBlenderLiveScene, getBlenderLiveStatus } from "../../../../src/comprehensive/editor/api/blenderLiveClient";

vi.mock("../../../../src/comprehensive/editor/api/blenderLiveClient", () => ({
  getBlenderLiveScene: vi.fn(),
  getBlenderLiveStatus: vi.fn(),
}));
vi.mock("../../../../src/comprehensive/editor/canvas/BlenderSceneLayer", () => ({
  buildDirectorBlenderOperations: vi.fn(),
}));
vi.mock("../../../../src/comprehensive/editor/runtime/blenderRuntimeTransactions", () => ({
  applyBlenderRuntimeOperations: vi.fn(),
}));

const projectId = "director-project";
const sceneEpoch = "82a6f8c1-7cb8-4d6f-a5f2-a4f5654a0420";
const originalDirectorState = useDirectorStore.getState();
const originalRuntimeState = useBlenderRuntimeStore.getState();

const status = blenderLiveStatusSchema.parse({
  available: true,
  ok: true,
  contract: BLENDER_LIVE_CONTRACT,
  projectId,
  sceneEpoch,
  blenderVersion: "5.1.2",
  revision: 4,
  busy: false,
});

const snapshot = blenderLiveSceneSnapshotSchema.parse({
  contract: BLENDER_LIVE_CONTRACT,
  projectId,
  sceneEpoch,
  revision: 4,
  sceneName: "Scene",
  frame: 1,
  unit: "meter",
  coordinateSystem: "right-handed-y-up-negative-z-forward",
  objects: [],
  cameras: [],
});

const otherProjectStatus = blenderLiveStatusSchema.parse({
  available: true,
  ok: true,
  contract: BLENDER_LIVE_CONTRACT,
  projectId: "another-project",
  sceneEpoch,
  blenderVersion: "5.1.2",
  revision: 4,
  busy: false,
});

describe("BlenderProjectSyncBridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDirectorStore.setState({
      project: {
        ...originalDirectorState.project,
        nativeScene: { engine: "blender", projectId },
      },
      prepareBlenderSync: vi.fn(),
      syncBlenderScene: vi.fn(),
    });
    useBlenderRuntimeStore.setState({
      publishSnapshot: vi.fn(),
      publishStatus: vi.fn(),
    });
    vi.mocked(getBlenderLiveStatus).mockResolvedValue(status);
    vi.mocked(getBlenderLiveScene).mockResolvedValue(snapshot);
    vi.mocked(buildDirectorBlenderOperations).mockReturnValue([]);
  });

  afterEach(() => {
    useDirectorStore.setState({
      project: originalDirectorState.project,
      prepareBlenderSync: originalDirectorState.prepareBlenderSync,
      syncBlenderScene: originalDirectorState.syncBlenderScene,
    });
    useBlenderRuntimeStore.setState({
      publishSnapshot: originalRuntimeState.publishSnapshot,
      publishStatus: originalRuntimeState.publishStatus,
    });
  });

  it("projects a changed Blender revision while the Stage is not mounted", async () => {
    const { unmount } = render(<BlenderProjectSyncBridge active pollIntervalMs={60_000} />);

    await waitFor(() => expect(getBlenderLiveScene).toHaveBeenCalledTimes(1));
    expect(buildDirectorBlenderOperations).not.toHaveBeenCalled();
    expect(useDirectorStore.getState().syncBlenderScene).toHaveBeenCalledWith(snapshot);
    expect(useBlenderRuntimeStore.getState().publishSnapshot).toHaveBeenCalledWith(snapshot);
    unmount();
  });

  it("does not project a Blender scene owned by another Director project", async () => {
    vi.mocked(getBlenderLiveStatus).mockResolvedValue(otherProjectStatus);
    const { unmount } = render(<BlenderProjectSyncBridge active pollIntervalMs={60_000} />);

    await waitFor(() => expect(getBlenderLiveStatus).toHaveBeenCalledTimes(1));
    expect(getBlenderLiveScene).not.toHaveBeenCalled();
    expect(useDirectorStore.getState().syncBlenderScene).not.toHaveBeenCalled();
    unmount();
  });

  it("pushes Director deletions before stale Blender objects can return off-stage", async () => {
    const projectedSnapshot = { ...snapshot, revision: 5 };
    useDirectorStore.setState((state) => ({
      project: {
        ...state.project,
        nativeScene: { engine: "blender", projectId, sceneEpoch, revision: 4 },
      },
    }));
    vi.mocked(buildDirectorBlenderOperations).mockReturnValue([{ op: "delete_object", id: "deleted-root" }]);
    vi.mocked(applyBlenderRuntimeOperations).mockImplementation(async (options) => {
      options.beforePublish?.({
        receipt: { sceneEpoch, revisionAfter: 5 },
      } as Parameters<NonNullable<typeof options.beforePublish>>[0]);
      return { projectedSnapshot } as Awaited<ReturnType<typeof applyBlenderRuntimeOperations>>;
    });

    const { unmount } = render(<BlenderProjectSyncBridge active pollIntervalMs={60_000} />);

    await waitFor(() => expect(applyBlenderRuntimeOperations).toHaveBeenCalledTimes(1));
    expect(applyBlenderRuntimeOperations).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedSceneEpoch: sceneEpoch,
        expectedRevision: 4,
        operations: [{ op: "delete_object", id: "deleted-root" }],
      }),
    );
    expect(useDirectorStore.getState().syncBlenderScene).not.toHaveBeenCalledWith(snapshot);
    expect(useDirectorStore.getState().syncBlenderScene).toHaveBeenCalledWith(projectedSnapshot);
    expect(useDirectorStore.getState().prepareBlenderSync).toHaveBeenCalledWith({
      sceneEpoch,
      revision: 5,
      origin: "director-projection",
    });
    unmount();
  });
});
