import type { CreativeWorkspaceAgentContext } from "../../../agent/creativeWorkspaceAgentContract";
import {
  dispatchCreativeWorkspaceOperations,
  type CreativeWorkspaceOperationInput,
} from "../../../agent/dispatchCreativeWorkspaceOperations";
import {
  persistentCreativeMediaLibrary,
  type PersistentCreativeMediaLibrary,
} from "../media/persistentCreativeMediaStore";

type CaptureImportDependencies = {
  fetchMedia?: typeof fetch;
  library?: Pick<PersistentCreativeMediaLibrary, "importBlob">;
  /** Override the live browser stores (parity harnesses and tests). */
  context?: CreativeWorkspaceAgentContext;
  now?: () => Date;
};

type DirectorDeskCapture = {
  dataUrl: string;
  fileName: string;
};

/** Protocol ceiling for execute_batch steps, mirrored from the creative contract. */
const MAX_BATCH_STEPS = 32;

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
 * Each capture is fetched from its data URL and persisted as a media blob first,
 * then the gallery cataloging and Canvas node placement dispatch as one atomic
 * execute_batch through the shared creative workspace agent contract, so UI
 * capture imports produce the same revision and receipts as agent imports and
 * roll back together when any step is rejected.
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
  const now = dependencies.now ?? (() => new Date());

  // Resolve all async media IO before dispatching, so the batch itself is
  // synchronous and the snapshot guard cannot go stale between steps.
  const imported: { assetId: string; name: string }[] = [];
  for (const capture of captures) {
    const response = await fetchMedia(capture.dataUrl);
    const blob = await response.blob();
    const name = displayName(capture.fileName);
    const asset = await library.importBlob(blob, {
      kind: "image",
      name,
      fileName: capture.fileName,
      source: "director-camera-capture",
    });
    imported.push({ assetId: asset.id, name });
  }

  const addedAt = now().toISOString();
  const operations: CreativeWorkspaceOperationInput[] = imported.flatMap(({ assetId, name }, index) => [
    {
      op: "gallery.media.update",
      media_id: assetId,
      patch: { added_at: addedAt, notes: "来自 Stage 相机截图" },
    },
    {
      op: "canvas.node.add",
      kind: "image",
      title: name,
      body: "Stage camera capture",
      media_id: assetId,
      x: 80 + index * 360,
      y: 80,
      accent: "#45b3d6",
    },
  ]);
  // Each capture contributes two consecutive steps, so slicing by the protocol
  // ceiling keeps catalog/node pairs inside the same atomic dispatch.
  for (let offset = 0; offset < operations.length; offset += MAX_BATCH_STEPS) {
    const receipt = dispatchCreativeWorkspaceOperations(operations.slice(offset, offset + MAX_BATCH_STEPS), {
      context: dependencies.context,
    });
    if (!receipt.ok) throw new Error(receipt.error);
  }

  return imported.length;
}
