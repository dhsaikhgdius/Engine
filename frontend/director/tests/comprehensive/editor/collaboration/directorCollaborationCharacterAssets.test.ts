import * as Y from "yjs";
import { createDefaultDirectorProject } from "../../../../src/comprehensive/editor/store/directorStore";
import {
  DirectorCollaborationSession,
  type DirectorSharedState,
} from "../../../../src/comprehensive/editor/collaboration/directorCollaboration";

const IDENTITY = { id: "asset-auditor", name: "Asset Auditor", color: "#118ab2" };

function sharedState(): DirectorSharedState {
  return {
    stage: createDefaultDirectorProject(),
    creative: {
      boardNodes: [],
      boardEdges: [],
      editTracks: [],
      editSettings: {
        aspectRatio: "16 / 9",
        fps: 24,
        snapEnabled: true,
        exportQuality: "preview",
      },
    },
  };
}

describe("Director collaboration character asset boundary", () => {
  it("rejects an assetless character before writing it to Yjs", () => {
    const session = new DirectorCollaborationSession({ scopeId: "asset-boundary", identity: IDENTITY });
    const state = sharedState();
    delete state.stage.objects.find((object) => object.kind === "character")!.assetRefId;

    expect(() => session.setSharedState(state)).toThrow("协作工程人物资产绑定无效");
    session.destroy();
  });

  it("does not expose an assetless character injected by a remote Yjs update", () => {
    const doc = new Y.Doc();
    const session = new DirectorCollaborationSession({ scopeId: "asset-boundary", identity: IDENTITY, doc });
    session.setSharedState(sharedState());

    const shared = doc.getMap("director.shared.v1");
    const stage = shared.get("stage") as Y.Map<unknown>;
    const objects = stage.get("objects") as Y.Array<Y.Map<unknown>>;
    const character = objects.toArray().find((object) => object.get("kind") === "character")!;
    character.delete("assetRefId");

    expect(session.getSharedState()).toBeNull();
    session.destroy();
  });
});
