import { create } from "zustand";
import type {
  BlenderLiveSceneSnapshot,
  BlenderLiveStatus,
  BlenderObjectInspection,
} from "../../../../../../packages/protocol/src/blenderLiveProtocol";

export interface BlenderNativeRigCapability {
  rootObjectId: string;
  status: "checking" | "ready" | "unsupported" | "error";
  compatible: boolean;
  reason?: string;
  missingBoneRoles: string[];
  mappedBoneCount: number;
  sceneEpoch?: string;
  revision?: number;
  inspection?: BlenderObjectInspection;
}

interface BlenderRuntimeState {
  snapshot: BlenderLiveSceneSnapshot | null;
  status: BlenderLiveStatus | null;
  previewActive: boolean;
  refreshRequestId: number;
  refreshCompletedId: number;
  nativeRigCapabilities: Record<string, BlenderNativeRigCapability>;
  publishSnapshot: (snapshot: BlenderLiveSceneSnapshot) => void;
  publishStatus: (status: BlenderLiveStatus) => void;
  publishPreviewActive: (active: boolean) => void;
  publishNativeRigCapability: (capability: BlenderNativeRigCapability) => void;
  requestRefresh: () => number;
  completeRefresh: (requestId: number) => void;
  reset: () => void;
}

function sameStatus(left: BlenderLiveStatus | null, right: BlenderLiveStatus) {
  if (!left || left.available !== right.available) return false;
  if (!left.available || !right.available) return !left.available && !right.available && left.reason === right.reason;
  return (
    left.projectId === right.projectId &&
    left.sceneEpoch === right.sceneEpoch &&
    left.revision === right.revision &&
    left.contentRevision === right.contentRevision &&
    left.busy === right.busy &&
    left.blenderVersion === right.blenderVersion
  );
}

function sameSnapshot(left: BlenderLiveSceneSnapshot | null, right: BlenderLiveSceneSnapshot) {
  if (!left) return false;
  return (
    left.projectId === right.projectId &&
    left.sceneEpoch === right.sceneEpoch &&
    left.revision === right.revision &&
    left.contentRevision === right.contentRevision &&
    left.frame === right.frame &&
    left.activeObjectId === right.activeObjectId &&
    left.selectedObjectIds.length === right.selectedObjectIds.length &&
    left.selectedObjectIds.every((id, index) => id === right.selectedObjectIds[index])
  );
}

function olderSceneRevision(
  left: BlenderLiveSceneSnapshot | BlenderLiveStatus | null,
  right: BlenderLiveSceneSnapshot | BlenderLiveStatus,
) {
  return (
    left !== null &&
    "sceneEpoch" in left &&
    "sceneEpoch" in right &&
    left.sceneEpoch === right.sceneEpoch &&
    "revision" in left &&
    "revision" in right &&
    right.revision < left.revision
  );
}

const INITIAL_STATE = {
  snapshot: null,
  status: null,
  previewActive: false,
  refreshRequestId: 0,
  refreshCompletedId: 0,
  nativeRigCapabilities: {},
};

/** Shared, transient evidence from the one live Blender scene poller. */
export const useBlenderRuntimeStore = create<BlenderRuntimeState>((set) => ({
  ...INITIAL_STATE,
  publishSnapshot: (snapshot) =>
    set((state) =>
      olderSceneRevision(state.snapshot, snapshot) || sameSnapshot(state.snapshot, snapshot) ? state : { snapshot },
    ),
  publishStatus: (status) =>
    set((state) => (olderSceneRevision(state.status, status) || sameStatus(state.status, status) ? state : { status })),
  publishPreviewActive: (previewActive) =>
    set((state) => (state.previewActive === previewActive ? state : { previewActive })),
  publishNativeRigCapability: (capability) =>
    set((state) => ({
      nativeRigCapabilities: {
        ...state.nativeRigCapabilities,
        [capability.rootObjectId]: capability,
      },
    })),
  requestRefresh: () => {
    let requestId = 0;
    set((state) => {
      requestId = state.refreshRequestId + 1;
      return { refreshRequestId: requestId };
    });
    return requestId;
  },
  completeRefresh: (requestId) =>
    set((state) => (requestId <= state.refreshCompletedId ? state : { refreshCompletedId: requestId })),
  reset: () => set(INITIAL_STATE),
}));
