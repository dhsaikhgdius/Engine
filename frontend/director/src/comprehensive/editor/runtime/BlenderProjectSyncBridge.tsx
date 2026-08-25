import { useEffect, useRef } from "react";
import { getBlenderLiveScene, getBlenderLiveStatus } from "../api/blenderLiveClient";
import { buildDirectorBlenderOperations } from "../canvas/BlenderSceneLayer";
import { useDirectorStore } from "../store/directorStore";
import { applyBlenderRuntimeOperations } from "./blenderRuntimeTransactions";
import { useBlenderRuntimeStore } from "./blenderRuntimeStore";

type BlenderSceneVersion = {
  sceneEpoch: string;
  revision: number;
};

function sameVersion(left: BlenderSceneVersion | null, right: BlenderSceneVersion) {
  return left?.sceneEpoch === right.sceneEpoch && left.revision === right.revision;
}

/** Keeps the current Director project synchronized while the 3D Stage is not mounted. */
export function BlenderProjectSyncBridge({
  active,
  pollIntervalMs = 1_000,
}: {
  active: boolean;
  pollIntervalMs?: number;
}) {
  const nativeScene = useDirectorStore((state) => state.project.nativeScene);
  const projectId = nativeScene?.projectId;
  const directorObjects = useDirectorStore((state) => state.project.objects);
  const directorAssets = useDirectorStore((state) => state.project.assets);
  const directorCameras = useDirectorStore((state) => state.project.cameras);
  const directorLights = useDirectorStore((state) => state.project.lights ?? []);
  const activeCameraId = useDirectorStore((state) => state.project.activeCameraId);
  const prepareBlenderSync = useDirectorStore((state) => state.prepareBlenderSync);
  const syncBlenderScene = useDirectorStore((state) => state.syncBlenderScene);
  const publishSnapshot = useBlenderRuntimeStore((state) => state.publishSnapshot);
  const publishStatus = useBlenderRuntimeStore((state) => state.publishStatus);
  const synchronizedVersionRef = useRef<BlenderSceneVersion | null>(null);

  useEffect(() => {
    synchronizedVersionRef.current = null;
    if (!active || !projectId) return;

    const abortController = new AbortController();
    let stopped = false;
    let timer: number | null = null;

    const poll = async () => {
      try {
        const status = await getBlenderLiveStatus({ signal: abortController.signal });
        if (stopped) return;
        publishStatus(status);
        if (!status.available || status.busy || status.projectId !== projectId) return;

        const targetVersion = { sceneEpoch: status.sceneEpoch, revision: status.revision };
        if (sameVersion(synchronizedVersionRef.current, targetVersion)) return;

        const snapshot = await getBlenderLiveScene({ signal: abortController.signal });
        if (stopped || snapshot.projectId !== projectId) return;
        publishSnapshot(snapshot);
        const directorOwnsDiff =
          nativeScene?.sceneEpoch === snapshot.sceneEpoch && nativeScene.revision === snapshot.revision;
        const operations = directorOwnsDiff
          ? buildDirectorBlenderOperations(
              snapshot,
              directorObjects,
              directorAssets,
              new Map(),
              new Set(),
              directorCameras,
              directorLights,
              activeCameraId,
            )
          : [];
        if (operations.length) {
          const result = await applyBlenderRuntimeOperations({
            expectedSceneEpoch: snapshot.sceneEpoch,
            expectedRevision: snapshot.revision,
            operations,
            signal: abortController.signal,
            beforePublish: (transaction) => {
              prepareBlenderSync({
                sceneEpoch: transaction.receipt.sceneEpoch,
                revision: transaction.receipt.revisionAfter,
                origin: "director-projection",
              });
            },
          });
          if (stopped || !result.projectedSnapshot) return;
          syncBlenderScene(result.projectedSnapshot);
          synchronizedVersionRef.current = {
            sceneEpoch: result.projectedSnapshot.sceneEpoch,
            revision: result.projectedSnapshot.revision,
          };
        } else {
          syncBlenderScene(snapshot);
          synchronizedVersionRef.current = {
            sceneEpoch: snapshot.sceneEpoch,
            revision: snapshot.revision,
          };
        }
      } catch {
        // The visible Stage owns user-facing Blender connection status.
      } finally {
        if (!stopped) {
          timer = window.setTimeout(
            () => void poll(),
            document.visibilityState === "visible" ? pollIntervalMs : Math.max(4_000, pollIntervalMs),
          );
        }
      }
    };

    void poll();
    return () => {
      stopped = true;
      abortController.abort();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [
    active,
    activeCameraId,
    directorAssets,
    directorCameras,
    directorLights,
    directorObjects,
    nativeScene,
    pollIntervalMs,
    prepareBlenderSync,
    projectId,
    publishSnapshot,
    publishStatus,
    syncBlenderScene,
  ]);

  return null;
}
