import {
  persistentCreativeMediaLibrary,
  type PersistentCreativeMediaLibrary,
} from "../media/persistentCreativeMediaStore";
import {
  useDirectorCreativeWorkspaceStore,
  type DirectorCreativeWorkspaceState,
} from "../workspaces/directorWorkspaceStore";

type CaptureWorkspace = Pick<
  DirectorCreativeWorkspaceState,
  "addBoardNode" | "beginHistoryBatch" | "endHistoryBatch" | "updateGalleryMedia"
>;

type CaptureImportDependencies = {
  fetchMedia?: typeof fetch;
  library?: Pick<PersistentCreativeMediaLibrary, "importBlob">;
  workspace?: CaptureWorkspace;
  now?: () => Date;
};

type DirectorDeskCapture = {
  dataUrl: string;
  fileName: string;
};

function readCaptureBatch(message: unknown): DirectorDeskCapture[] {
  if (!message || typeof message !== "object") return [];
  const candidate = message as { type?: unknown; payload?: { captures?: unknown } };
  if (candidate.type !== "storyai:director-desk-captures-sent" || !Array.isArray(candidate.payload?.captures)) {
    return [];
  }

  return candidate.payload.captures.flatMap((capture, index) => {
    if (!capture || typeof capture !== "object") return [];
    const item = capture as { dataUrl?: unknown; fileName?: unknown };
    const dataUrl = typeof item.dataUrl === "string" ? item.dataUrl.trim() : "";
    if (!dataUrl.startsWith("data:image/")) return [];
    const fileName =
      typeof item.fileName === "string" && item.fileName.trim()
        ? item.fileName.trim()
        : `director-camera-capture-${index + 1}.png`;
    return [{ dataUrl, fileName }];
  });
}

function displayName(fileName: string) {
  const lastDot = fileName.lastIndexOf(".");
  return (lastDot > 0 ? fileName.slice(0, lastDot) : fileName).trim() || "Stage camera capture";
}

/**
 * Imports Director Desk captures received via postMessage into the local creative workspace.
 *
 * Each capture is fetched from its data URL, persisted as a media blob, added to the gallery,
 * and placed as a board node on the Canvas. All mutations are wrapped in a single history batch.
 *
 * @param message - The postMessage event data, expected to be a "storyai:director-desk-captures-sent" message.
 * @param dependencies - Injectable dependencies for testing; defaults to the real implementations.
 * @returns The number of captures successfully imported.
 */
export async function importLocalDirectorDeskCaptures(message: unknown, dependencies: CaptureImportDependencies = {}) {
  const captures = readCaptureBatch(message);
  if (!captures.length) return 0;

  const fetchMedia = dependencies.fetchMedia ?? globalThis.fetch;
  const library = dependencies.library ?? persistentCreativeMediaLibrary;
  const workspace = dependencies.workspace ?? useDirectorCreativeWorkspaceStore.getState();
  const now = dependencies.now ?? (() => new Date());

  workspace.beginHistoryBatch();
  try {
    for (const [index, capture] of captures.entries()) {
      const response = await fetchMedia(capture.dataUrl);
      const blob = await response.blob();
      const name = displayName(capture.fileName);
      const asset = await library.importBlob(blob, {
        kind: "image",
        name,
        fileName: capture.fileName,
        source: "director-camera-capture",
      });
      workspace.updateGalleryMedia(asset.id, {
        addedAt: now().toISOString(),
        notes: "来自 Stage 相机截图",
      });
      workspace.addBoardNode({
        kind: "image",
        title: name,
        body: "Stage camera capture",
        mediaId: asset.id,
        x: 80 + index * 360,
        y: 80,
        accent: "#45b3d6",
      });
    }
  } finally {
    workspace.endHistoryBatch();
  }

  return captures.length;
}
